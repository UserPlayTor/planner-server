/**
 * protocol.js
 * Pure message-handling logic for the BlockPlan WebSocket protocol.
 *
 * Deliberately has ZERO dependency on the `ws` library itself — every
 * function here only needs a duck-typed `ws` object with `.send(string)`
 * and `.readyState`, plus a `RoomManager` instance. This means the entire
 * protocol can be unit-tested without installing `ws`/`express`, and the
 * real server.js just wires these handlers up to real WebSocket connections.
 *
 * Message types handled:
 *   join    { room, userId, username, color }
 *   sync    { state, target? }            (target = send only to one userId)
 *   update  { state }                     (broadcast a live edit to the room)
 *   cursor  { x, y, layer }               (optional lightweight presence ping)
 *   ping    {}                            -> replies with { type: 'pong' }
 *
 * Server -> client messages produced:
 *   roster  { room, users }               (sent to a user right after they join)
 *   join    { userId, username, color }   (broadcast to others when someone joins)
 *   leave   { userId }                    (broadcast when someone disconnects)
 *   sync    { state, userId?, target? }
 *   update  { state, userId }
 *   error   { message }
 */

export const MAX_USERS_PER_ROOM_DEFAULT = 50;

export function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      return false;
    }
  }
  return false;
}

export function sanitizeRoomCode(code) {
  if (typeof code !== 'string') return null;
  const cleaned = code.trim().toUpperCase().slice(0, 16);
  return /^[A-Z0-9_-]{1,16}$/.test(cleaned) ? cleaned : null;
}

export function sanitizeUserId(id) {
  if (typeof id !== 'string') return null;
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id) ? id : null;
}

export function sanitizeUsername(name) {
  if (typeof name !== 'string') return 'Player';
  const cleaned = name.slice(0, 24).replace(/[<>]/g, '');
  return cleaned || 'Player';
}

export function sanitizeColor(color) {
  if (typeof color !== 'string') return '#8b7ef8';
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#8b7ef8';
}

/**
 * Creates a bound set of handlers around a given RoomManager instance.
 * This is the function server.js actually calls.
 */
export function createProtocolHandlers(rooms, opts = {}) {
  const maxUsersPerRoom = opts.maxUsersPerRoom ?? MAX_USERS_PER_ROOM_DEFAULT;

  function handleJoin(ws, msg) {
    const room = sanitizeRoomCode(msg.room);
    const userId = sanitizeUserId(msg.userId);
    const username = sanitizeUsername(msg.username);
    const color = sanitizeColor(msg.color);

    if (!room || !userId) {
      safeSend(ws, { type: 'error', message: 'join requires valid "room" and "userId"' });
      return { ok: false, reason: 'invalid_params' };
    }

    const existing = rooms.get(room);
    if (existing && existing.users.size >= maxUsersPerRoom) {
      safeSend(ws, { type: 'error', message: 'Room is full' });
      return { ok: false, reason: 'room_full' };
    }

    // If this socket was already in a different room, leave it first
    if (ws.meta && ws.meta.room && ws.meta.room !== room) {
      handleLeave(ws);
    }

    ws.meta = { userId, room, username };
    rooms.addUser(room, userId, { ws, username, color });

    // Tell everyone else in the room (the joiner's own client ignores its
    // own join broadcast by checking userId !== myUserId, so it's fine to include them)
    rooms.broadcast(room, { type: 'join', userId, username, color });

    // Send the new joiner the current roster so their UI can populate immediately
    safeSend(ws, { type: 'roster', room, users: rooms.listUsers(room) });

    // If we already have known state for this room, send it right away so a
    // late joiner doesn't have to wait for another user's next edit.
    const roomObj = rooms.get(room);
    if (roomObj && roomObj.state) {
      safeSend(ws, { type: 'sync', state: roomObj.state, target: userId });
    }

    return { ok: true, room, userId };
  }

  function handleSync(ws, msg) {
    const meta = ws.meta || {};
    if (!meta.userId || !meta.room) {
      safeSend(ws, { type: 'error', message: 'Must join a room before syncing' });
      return { ok: false, reason: 'not_joined' };
    }
    if (!msg.state || typeof msg.state !== 'object') {
      safeSend(ws, { type: 'error', message: 'sync requires a "state" object' });
      return { ok: false, reason: 'missing_state' };
    }

    try {
      rooms.setState(meta.room, msg.state);
    } catch (err) {
      safeSend(ws, { type: 'error', message: err.message });
      return { ok: false, reason: 'state_rejected', error: err.message };
    }

    if (msg.target) {
      const targetId = sanitizeUserId(msg.target);
      if (targetId) {
        rooms.sendTo(meta.room, targetId, { type: 'sync', state: msg.state, userId: meta.userId });
      }
    } else {
      rooms.broadcast(meta.room, { type: 'sync', state: msg.state, userId: meta.userId }, meta.userId);
    }
    return { ok: true };
  }

  function handleUpdate(ws, msg) {
    const meta = ws.meta || {};
    if (!meta.userId || !meta.room) {
      safeSend(ws, { type: 'error', message: 'Must join a room before updating' });
      return { ok: false, reason: 'not_joined' };
    }
    if (!msg.state || typeof msg.state !== 'object') {
      safeSend(ws, { type: 'error', message: 'update requires a "state" object' });
      return { ok: false, reason: 'missing_state' };
    }

    try {
      rooms.setState(meta.room, msg.state);
    } catch (err) {
      safeSend(ws, { type: 'error', message: err.message });
      return { ok: false, reason: 'state_rejected', error: err.message };
    }

    rooms.broadcast(meta.room, { type: 'update', state: msg.state, userId: meta.userId }, meta.userId);
    return { ok: true };
  }

  function handleCursor(ws, msg) {
    const meta = ws.meta || {};
    if (!meta.userId || !meta.room) return { ok: false, reason: 'not_joined' };
    rooms.broadcast(
      meta.room,
      {
        type: 'cursor',
        userId: meta.userId,
        x: typeof msg.x === 'number' ? msg.x : null,
        y: typeof msg.y === 'number' ? msg.y : null,
        layer: typeof msg.layer === 'number' ? msg.layer : null,
      },
      meta.userId
    );
    return { ok: true };
  }

  function handleLeave(ws) {
    const meta = ws.meta || {};
    if (!meta.userId || !meta.room) return { ok: false, reason: 'not_joined' };
    rooms.removeUser(meta.room, meta.userId);
    rooms.broadcast(meta.room, { type: 'leave', userId: meta.userId });
    const left = { room: meta.room, userId: meta.userId };
    ws.meta = { userId: null, room: null, username: null };
    return { ok: true, ...left };
  }

  /**
   * Top-level dispatcher — call this from the real `ws.on('message', ...)` handler.
   */
  function handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch (err) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON' });
      return { ok: false, reason: 'invalid_json' };
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      safeSend(ws, { type: 'error', message: 'Message must have a string "type"' });
      return { ok: false, reason: 'missing_type' };
    }

    switch (msg.type) {
      case 'join':
        return handleJoin(ws, msg);
      case 'sync':
        return handleSync(ws, msg);
      case 'update':
        return handleUpdate(ws, msg);
      case 'cursor':
        return handleCursor(ws, msg);
      case 'ping':
        safeSend(ws, { type: 'pong' });
        return { ok: true };
      default:
        safeSend(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
        return { ok: false, reason: 'unknown_type' };
    }
  }

  return { handleJoin, handleSync, handleUpdate, handleCursor, handleLeave, handleMessage };
}

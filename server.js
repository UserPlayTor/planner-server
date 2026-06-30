/**
 * server.js
 * BlockPlan multiplayer server.
 *
 * Provides:
 *   - WebSocket endpoint for real-time collaborative editing (matches the
 *     protocol already spoken by the BlockPlan HTML client: join / sync / update / leave)
 *   - HTTP health check + stats endpoint
 *   - Optional REST endpoints to fetch/store a room's last known state
 *     (handy for "rejoin and get current state" without round-tripping through WS)
 *
 * Run:
 *   npm install
 *   npm start
 *
 * Environment variables:
 *   PORT            - port to listen on (default 3000)
 *   ALLOWED_ORIGIN  - CORS origin to allow for the REST endpoints (default "*")
 *   MAX_USERS_PER_ROOM - safety cap (default 50)
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import RoomManager from './test-room-manager.js';

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_USERS_PER_ROOM = parseInt(process.env.MAX_USERS_PER_ROOM || '50', 10);
const HEARTBEAT_INTERVAL_MS = 30000;

const rooms = new RoomManager();

/* ─────────────────────────────────────────────
   HTTP app (health check + small REST surface)
───────────────────────────────────────────── */
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '8mb' }));

app.get('/', (_req, res) => {
  res.json({
    name: 'BlockPlan multiplayer server',
    status: 'ok',
    websocket: '/ws',
    docs: 'See README.md for the message protocol.',
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), ...rooms.stats() });
});

// Create a fresh room code (purely a convenience endpoint; the client can
// also just generate one locally, this just guarantees no collision server-side)
app.post('/rooms', (_req, res) => {
  let code;
  do {
    code = nanoid(6).toUpperCase().replace(/[^A-Z0-9]/g, '0');
  } while (rooms.get(code));
  rooms.getOrCreate(code);
  res.json({ code });
});

// Fetch a room's last known state (e.g. for a client rejoining after a refresh)
app.get('/rooms/:code/state', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code: room.code, state: room.state, users: rooms.listUsers(room.code) });
});

app.get('/rooms/:code/users', (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ code, users: rooms.listUsers(code) });
});

const server = http.createServer(app);

/* ─────────────────────────────────────────────
   WebSocket server
───────────────────────────────────────────── */
const wss = new WebSocketServer({ server, path: '/ws' });

function safeSend(ws, obj) {
  if (ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      console.error('Failed to send WS message:', err.message);
    }
  }
}

function sanitizeRoomCode(code) {
  if (typeof code !== 'string') return null;
  const cleaned = code.trim().toUpperCase().slice(0, 16);
  return /^[A-Z0-9_-]{1,16}$/.test(cleaned) ? cleaned : null;
}

function sanitizeUserId(id) {
  if (typeof id !== 'string') return null;
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id) ? id : null;
}

function sanitizeUsername(name) {
  if (typeof name !== 'string') return 'Player';
  return name.slice(0, 24).replace(/[<>]/g, '') || 'Player';
}

function sanitizeColor(color) {
  if (typeof color !== 'string') return '#8b7ef8';
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#8b7ef8';
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.meta = { userId: null, room: null, username: null };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return safeSend(ws, { type: 'error', message: 'Invalid JSON' });
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return safeSend(ws, { type: 'error', message: 'Message must have a string "type"' });
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
        return safeSend(ws, { type: 'pong' });
      default:
        return safeSend(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    handleLeave(ws);
  });

  ws.on('error', (err) => {
    console.error('WS connection error:', err.message);
  });
});

function handleJoin(ws, msg) {
  const room = sanitizeRoomCode(msg.room);
  const userId = sanitizeUserId(msg.userId);
  const username = sanitizeUsername(msg.username);
  const color = sanitizeColor(msg.color);

  if (!room || !userId) {
    return safeSend(ws, { type: 'error', message: 'join requires valid "room" and "userId"' });
  }

  const existing = rooms.get(room);
  if (existing && existing.users.size >= MAX_USERS_PER_ROOM) {
    return safeSend(ws, { type: 'error', message: 'Room is full' });
  }

  // If this socket was already in a different room, leave it first
  if (ws.meta.room && ws.meta.room !== room) {
    handleLeave(ws);
  }

  ws.meta = { userId, room, username };
  rooms.addUser(room, userId, { ws, username, color });

  // Tell everyone else (including the new user gets echoed their own join too,
  // which the client ignores since it checks userId !== myUserId)
  rooms.broadcast(room, { type: 'join', userId, username, color });

  // Send the new joiner the current roster so their UI can populate immediately
  safeSend(ws, {
    type: 'roster',
    room,
    users: rooms.listUsers(room),
  });

  // If we already have a known state for this room (e.g. someone synced earlier),
  // send it straight away so a late joiner doesn't have to wait on another user's sync.
  const roomObj = rooms.get(room);
  if (roomObj && roomObj.state) {
    safeSend(ws, { type: 'sync', state: roomObj.state, target: userId });
  }
}

function handleSync(ws, msg) {
  const { userId, room } = ws.meta;
  if (!userId || !room) {
    return safeSend(ws, { type: 'error', message: 'Must join a room before syncing' });
  }
  if (!msg.state || typeof msg.state !== 'object') {
    return safeSend(ws, { type: 'error', message: 'sync requires a "state" object' });
  }

  try {
    rooms.setState(room, msg.state);
  } catch (err) {
    return safeSend(ws, { type: 'error', message: err.message });
  }

  if (msg.target) {
    // Targeted sync: e.g. an existing user pushing full state to one new joiner
    const targetId = sanitizeUserId(msg.target);
    if (targetId) rooms.sendTo(room, targetId, { type: 'sync', state: msg.state, userId });
  } else {
    rooms.broadcast(room, { type: 'sync', state: msg.state, userId }, userId);
  }
}

function handleUpdate(ws, msg) {
  const { userId, room } = ws.meta;
  if (!userId || !room) {
    return safeSend(ws, { type: 'error', message: 'Must join a room before updating' });
  }
  if (!msg.state || typeof msg.state !== 'object') {
    return safeSend(ws, { type: 'error', message: 'update requires a "state" object' });
  }

  try {
    rooms.setState(room, msg.state);
  } catch (err) {
    return safeSend(ws, { type: 'error', message: err.message });
  }

  rooms.broadcast(room, { type: 'update', state: msg.state, userId }, userId);
}

function handleCursor(ws, msg) {
  // Optional: lightweight cursor/selection broadcast for "who's editing where"
  const { userId, room } = ws.meta;
  if (!userId || !room) return;
  rooms.broadcast(
    room,
    {
      type: 'cursor',
      userId,
      x: typeof msg.x === 'number' ? msg.x : null,
      y: typeof msg.y === 'number' ? msg.y : null,
      layer: typeof msg.layer === 'number' ? msg.layer : null,
    },
    userId
  );
}

function handleLeave(ws) {
  const { userId, room } = ws.meta || {};
  if (!userId || !room) return;
  rooms.removeUser(room, userId);
  rooms.broadcast(room, { type: 'leave', userId });
  ws.meta = { userId: null, room: null, username: null };
}

/* ─────────────────────────────────────────────
   Heartbeat — drop dead connections so rooms
   don't accumulate ghost users after a hard
   network drop (no clean close frame received).
───────────────────────────────────────────── */
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleLeave(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(heartbeat));

/* ─────────────────────────────────────────────
   Start
───────────────────────────────────────────── */
server.listen(PORT, () => {
  console.log(`BlockPlan server listening on port ${PORT}`);
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  WebSocket: ws://localhost:${PORT}/ws`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  clearInterval(heartbeat);
  wss.close(() => {
    server.close(() => process.exit(0));
  });
});

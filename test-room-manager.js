/**
 * test-room-manager.js
 * Zero-dependency sanity tests for RoomManager, run directly with Node.
 * (Doesn't need `ws`/`express` installed since RoomManager has no external deps.)
 *
 *   node test/test-room-manager.js
 */
import assert from 'node:assert/strict';
import RoomManager from '../src/room-manager.js';

function fakeWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
  };
}

function run() {
  let passed = 0;
  const fail = [];

  function test(name, fn) {
    try {
      fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail.push({ name, err });
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    }
  }

  console.log('RoomManager tests\n');

  test('getOrCreate makes a new room on first access', () => {
    const rm = new RoomManager();
    const room = rm.getOrCreate('ABC123');
    assert.equal(room.code, 'ABC123');
    assert.equal(room.users.size, 0);
  });

  test('addUser adds a user and room becomes non-empty', () => {
    const rm = new RoomManager();
    const ws = fakeWs();
    rm.addUser('ROOM1', 'user1', { ws, username: 'Alice', color: '#ff0000' });
    const room = rm.get('ROOM1');
    assert.equal(room.users.size, 1);
    assert.equal(room.users.get('user1').username, 'Alice');
  });

  test('removeUser returns true when room becomes empty', () => {
    const rm = new RoomManager();
    rm.addUser('ROOM1', 'user1', { ws: fakeWs(), username: 'Alice' });
    const isEmpty = rm.removeUser('ROOM1', 'user1');
    assert.equal(isEmpty, true);
  });

  test('removeUser returns false when other users remain', () => {
    const rm = new RoomManager();
    rm.addUser('ROOM1', 'user1', { ws: fakeWs(), username: 'Alice' });
    rm.addUser('ROOM1', 'user2', { ws: fakeWs(), username: 'Bob' });
    const isEmpty = rm.removeUser('ROOM1', 'user1');
    assert.equal(isEmpty, false);
    assert.equal(rm.get('ROOM1').users.size, 1);
  });

  test('broadcast sends to all users except excluded sender', () => {
    const rm = new RoomManager();
    const wsA = fakeWs();
    const wsB = fakeWs();
    rm.addUser('ROOM1', 'A', { ws: wsA, username: 'A' });
    rm.addUser('ROOM1', 'B', { ws: wsB, username: 'B' });
    const sentCount = rm.broadcast('ROOM1', { type: 'update', foo: 'bar' }, 'A');
    assert.equal(sentCount, 1);
    assert.equal(wsA.sent.length, 0);
    assert.equal(wsB.sent.length, 1);
    assert.equal(wsB.sent[0].foo, 'bar');
  });

  test('broadcast skips users with closed sockets', () => {
    const rm = new RoomManager();
    const wsOpen = fakeWs();
    const wsClosed = fakeWs();
    wsClosed.readyState = 3; // CLOSED
    rm.addUser('ROOM1', 'open', { ws: wsOpen, username: 'Open' });
    rm.addUser('ROOM1', 'closed', { ws: wsClosed, username: 'Closed' });
    const sentCount = rm.broadcast('ROOM1', { type: 'ping' });
    assert.equal(sentCount, 1);
    assert.equal(wsClosed.sent.length, 0);
  });

  test('sendTo delivers only to the targeted user', () => {
    const rm = new RoomManager();
    const wsA = fakeWs();
    const wsB = fakeWs();
    rm.addUser('ROOM1', 'A', { ws: wsA, username: 'A' });
    rm.addUser('ROOM1', 'B', { ws: wsB, username: 'B' });
    const ok = rm.sendTo('ROOM1', 'B', { type: 'sync', state: { hello: 'world' } });
    assert.equal(ok, true);
    assert.equal(wsA.sent.length, 0);
    assert.equal(wsB.sent.length, 1);
    assert.equal(wsB.sent[0].state.hello, 'world');
  });

  test('setState stores state and rejects oversized payloads', () => {
    const rm = new RoomManager();
    rm.setState('ROOM1', { layers: [[[null]]], W: 1, H: 1 });
    assert.deepEqual(rm.get('ROOM1').state.W, 1);

    const huge = { blob: 'x'.repeat(9 * 1024 * 1024) }; // > 8MB guard
    assert.throws(() => rm.setState('ROOM1', huge), /too large/);
  });

  test('listUsers returns userId, username, color (not raw ws objects)', () => {
    const rm = new RoomManager();
    rm.addUser('ROOM1', 'u1', { ws: fakeWs(), username: 'Carl', color: '#00ff00' });
    const list = rm.listUsers('ROOM1');
    assert.equal(list.length, 1);
    assert.equal(list[0].userId, 'u1');
    assert.equal(list[0].username, 'Carl');
    assert.equal(list[0].color, '#00ff00');
    assert.equal(list[0].ws, undefined);
  });

  test('stats reports room and user counts accurately', () => {
    const rm = new RoomManager();
    rm.addUser('R1', 'a', { ws: fakeWs() });
    rm.addUser('R1', 'b', { ws: fakeWs() });
    rm.addUser('R2', 'c', { ws: fakeWs() });
    const stats = rm.stats();
    assert.equal(stats.activeRooms, 2);
    assert.equal(stats.totalConnectedUsers, 3);
  });

  console.log(`\n${passed} passed, ${fail.length} failed\n`);
  if (fail.length > 0) process.exit(1);
}

run();

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const Redis = require('ioredis');
const path = require('path');

// ----- Redis (with Pub/Sub) -----
const redisPub = new Redis({
  host: 'prime-chamois-162864.upstash.io',
  port: 6379,
  password: 'gQAAAAAAAnwwAAIgcDE4NTA1NTY4ZjI4NTI0ZTVhOWEwOWY0ODc3MzJiNTA0NQ',
  tls: {}
});

const redisSub = new Redis({
  host: 'prime-chamois-162864.upstash.io',
  port: 6379,
  password: 'gQAAAAAAAnwwAAIgcDE4NTA1NTY4ZjI4NTI0ZTVhOWEwOWY0ODc3MzJiNTA0NQ',
  tls: {}
});

// ----- Express & WebSocket Server -----
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

// ----- WebSocket Logic -----
wss.on('connection', async (ws) => {
  let username = 'Anonymous';
  let currentRoom = 'Lobby';

  // Send last 50 messages from the default room
  const roomKey = `room:Lobby:messages`;
  try {
    const rawMessages = await redisPub.lrange(roomKey, 0, 49);
    const messages = rawMessages.map(msg => JSON.parse(msg)).reverse();
    ws.send(JSON.stringify({ type: 'init', messages, room: 'Lobby' }));
  } catch (e) {
    console.error('Failed to fetch history:', e);
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'set_username') {
        username = data.username;
        return;
      }
      if (data.type === 'join_room') {
        currentRoom = data.room || 'Lobby';
        const roomKey = `room:${currentRoom}:messages`;
        const rawMessages = await redisPub.lrange(roomKey, 0, 49);
        const messages = rawMessages.map(msg => JSON.parse(msg)).reverse();
        ws.send(JSON.stringify({ type: 'init', messages, room: currentRoom }));
        return;
      }
      if (data.type === 'message') {
        const msg = {
          id: Date.now().toString(),
          username,
          text: data.text,
          timestamp: Date.now(),
          room: currentRoom
        };
        const roomKey = `room:${currentRoom}:messages`;
        await redisPub.lpush(roomKey, JSON.stringify(msg));
        await redisPub.ltrim(roomKey, 0, 999);

        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'message', message: msg, room: currentRoom }));
          }
        });
      }
    } catch (e) {}
  });
});

// ----- Start Server -----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

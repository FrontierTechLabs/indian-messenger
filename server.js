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

// ----- Subscribe to Redis channel for cross‑instance broadcast -----
const CHANNEL = 'chat:messages';

redisSub.subscribe(CHANNEL);
redisSub.on('message', (channel, message) => {
  const msg = JSON.parse(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'message', message: msg }));
    }
  });
});

// ----- WebSocket Logic -----
wss.on('connection', (ws) => {
  let username = 'Anonymous';

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'set_username') {
        username = data.username;
        return;
      }
      if (data.type === 'message') {
        const msg = {
          id: Date.now().toString(),
          username,
          text: data.text,
          timestamp: Date.now()
        };
        // Store in Redis (persistence)
        await redisPub.lpush('messages', JSON.stringify(msg));
        await redisPub.ltrim('messages', 0, 999);

        // Publish to all instances via Redis Pub/Sub
        await redisPub.publish(CHANNEL, JSON.stringify(msg));
      }
    } catch (e) {}
  });
});

// ----- Start Server -----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

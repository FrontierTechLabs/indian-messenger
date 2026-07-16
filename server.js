const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const Redis = require('ioredis');
const path = require('path');

const redis = new Redis({
  host: 'prime-chamois-162864.upstash.io',
  port: 6379,
  password: 'gQAAAAAAAnwwAAIgcDE4NTA1NTY4ZjI4NTI0ZTVhOWEwOWY0ODc3MzJiNTA0NQ',
  tls: {}
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

wss.on('connection', (ws) => {
  let username = 'Anonymous';
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'set_username') { username = data.username; return; }
      if (data.type === 'message') {
        const msg = { id: Date.now().toString(), username, text: data.text, timestamp: Date.now() };
        await redis.lpush('messages', JSON.stringify(msg));
        await redis.ltrim('messages', 0, 999);
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'message', message: msg }));
          }
        });
      }
    } catch (e) {}
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

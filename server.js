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
const cors = require("cors");
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(__dirname));

// ----- Pub/Sub for cross‑instance broadcast -----
const CHANNEL = 'aether:events';
redisSub.subscribe(CHANNEL);
redisSub.on('message', (channel, message) => {
  const event = JSON.parse(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'event', event }));
    }
  });
});

// ----- API Endpoints -----

// Create a post
app.post('/api/posts', async (req, res) => {
  const { did, text, location } = req.body;
  if (!did || !text) return res.status(400).json({ error: 'Missing DID or text' });

  const post = {
    id: Date.now().toString(),
    did,
    text,
    location: location || '',
    timestamp: Date.now(),
    likes: 0,
    replies: 0,
    image: req.body.image || null,
    parentId: null
  };

  await redisPub.lpush('aether:posts', JSON.stringify(post));
  await redisPub.ltrim('aether:posts', 0, 999);
  await redisPub.publish(CHANNEL, JSON.stringify({ type: 'new_post', post }));
  res.json(post);
});

// Get feed (chronological)
app.get('/api/feed', async (req, res) => {
  const raw = await redisPub.lrange('aether:posts', 0, 49);
  const posts = raw.map(p => JSON.parse(p)).reverse();
  res.json(posts);
});

// Like a post
app.post('/api/like', async (req, res) => {
  const { postId, did } = req.body;
  if (!postId || !did) return res.status(400).json({ error: 'Missing postId or DID' });

  const raw = await redisPub.lrange('aether:posts', 0, 999);
  let updated = false;
  for (const item of raw) {
    const post = JSON.parse(item);
    if (post.id === postId) {
      // In a real system, track per-user likes. For MVP, we just increment.
      post.likes = (post.likes || 0) + 1;
      // Remove old and add updated
      await redisPub.lrem('aether:posts', 0, item);
      await redisPub.rpush('aether:posts', JSON.stringify(post));
      updated = true;
      await redisPub.publish(CHANNEL, JSON.stringify({ type: 'like_update', postId, likes: post.likes }));
      break;
    }
  }
  res.json({ success: updated });
});

// Reply to a post
app.post('/api/reply', async (req, res) => {
  const { parentId, did, text } = req.body;
  if (!parentId || !did || !text) return res.status(400).json({ error: 'Missing fields' });

  const reply = {
    id: Date.now().toString(),
    did,
    text,
    timestamp: Date.now(),
    parentId,
    likes: 0,
    replies: 0
  };

  await redisPub.lpush('aether:posts', JSON.stringify(reply));
  await redisPub.ltrim('aether:posts', 0, 999);
  await redisPub.publish(CHANNEL, JSON.stringify({ type: 'new_reply', reply }));
  res.json(reply);
});

// ----- WebSocket Logic (for real‑time updates) -----
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      // For now, just echo
    } catch (e) {}
  });
});

// ----- Start Server -----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Aether backend running on port ${PORT}`);
});

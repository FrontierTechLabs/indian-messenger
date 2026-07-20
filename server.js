const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const Redis = require('ioredis');
const path = require('path');
const cors = require('cors');

// ----- Redis -----
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

// ----- Express & WebSocket -----
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ----- Redis Pub/Sub for cross-instance broadcast -----
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

// ----- Helper: Get approximate city from IP (simple fallback) -----
function getCityFromIP(req) {
  // In production, use a geo-IP service. For now, default to "Earth"
  return 'Earth';
}

// ----- API Endpoints -----

// 1. Register / Update Username
app.post('/api/set-username', async (req, res) => {
  const { did, username } = req.body;
  if (!did || !username) return res.status(400).json({ error: 'Missing DID or username' });

  // Check if username is already taken
  const existing = await redisPub.get(`username:${username.toLowerCase()}`);
  if (existing && existing !== did) {
    return res.status(400).json({ error: 'Username already taken' });
  }

  // Store mapping: username -> DID
  await redisPub.set(`username:${username.toLowerCase()}`, did);
  // Store user profile
  await redisPub.hset(`user:${did}`, 'username', username);
  await redisPub.hset(`user:${did}`, 'city', req.body.city || 'Earth');
  await redisPub.hset(`user:${did}`, 'displayName', username);

  res.json({ success: true, username });
});

// 2. Get user profile
app.get('/api/user/:did', async (req, res) => {
  const did = req.params.did;
  const data = await redisPub.hgetall(`user:${did}`);
  if (!data || !data.username) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ did, ...data });
});

// 3. Search users (by username or DID)
app.get('/api/search', async (req, res) => {
  const q = req.query.q?.toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);

  // Search by username prefix (simple scan)
  const keys = await redisPub.keys('username:*');
  const results = [];
  for (const key of keys) {
    const username = key.replace('username:', '');
    if (username.includes(q)) {
      const did = await redisPub.get(key);
      const user = await redisPub.hgetall(`user:${did}`);
      if (user && user.username) {
        results.push({ did, username: user.username, city: user.city || 'Earth' });
      }
    }
  }
  // Also search by DID prefix
  const didKeys = await redisPub.keys('user:*');
  for (const key of didKeys) {
    const did = key.replace('user:', '');
    if (did.includes(q)) {
      const user = await redisPub.hgetall(key);
      if (user && user.username && !results.find(r => r.did === did)) {
        results.push({ did, username: user.username, city: user.city || 'Earth' });
      }
    }
  }
  res.json(results.slice(0, 20));
});

// 4. Follow / Unfollow
app.post('/api/follow', async (req, res) => {
  const { did, targetDid } = req.body;
  if (!did || !targetDid) return res.status(400).json({ error: 'Missing did or targetDid' });
  if (did === targetDid) return res.status(400).json({ error: 'Cannot follow yourself' });

  await redisPub.sadd(`following:${did}`, targetDid);
  await redisPub.sadd(`followers:${targetDid}`, did);
  res.json({ success: true });
});

app.post('/api/unfollow', async (req, res) => {
  const { did, targetDid } = req.body;
  if (!did || !targetDid) return res.status(400).json({ error: 'Missing did or targetDid' });

  await redisPub.srem(`following:${did}`, targetDid);
  await redisPub.srem(`followers:${targetDid}`, did);
  res.json({ success: true });
});

app.get('/api/following/:did', async (req, res) => {
  const did = req.params.did;
  const following = await redisPub.smembers(`following:${did}`);
  res.json(following);
});

// 5. Create a post (with username, city, timestamp)
app.post('/api/posts', async (req, res) => {
  const { did, text, image, location } = req.body;
  if (!did || !text) return res.status(400).json({ error: 'Missing DID or text' });

  // Get user profile
  const user = await redisPub.hgetall(`user:${did}`);
  const username = user.username || did.substring(0, 8);
  const city = location || user.city || 'Earth';

  const post = {
    id: Date.now().toString(),
    did,
    username,
    text,
    image: image || null,
    city,
    timestamp: Date.now(),
    likes: 0,
    replies: 0,
    parentId: null
  };

  await redisPub.lpush('aether:posts', JSON.stringify(post));
  await redisPub.ltrim('aether:posts', 0, 999);
  await redisPub.publish(CHANNEL, JSON.stringify({ type: 'new_post', post }));
  res.json(post);
});

// 6. Get feed (chronological)
app.get('/api/feed', async (req, res) => {
  const raw = await redisPub.lrange('aether:posts', 0, 99);
  const posts = raw.map(p => JSON.parse(p)).reverse();
  res.json(posts);
});

// 7. Like a post
app.post('/api/like', async (req, res) => {
  const { postId, did } = req.body;
  if (!postId || !did) return res.status(400).json({ error: 'Missing postId or DID' });

  const raw = await redisPub.lrange('aether:posts', 0, 999);
  let updated = false;
  for (const item of raw) {
    const post = JSON.parse(item);
    if (post.id === postId) {
      post.likes = (post.likes || 0) + 1;
      await redisPub.lrem('aether:posts', 0, item);
      await redisPub.rpush('aether:posts', JSON.stringify(post));
      updated = true;
      await redisPub.publish(CHANNEL, JSON.stringify({ type: 'like_update', postId, likes: post.likes }));
      break;
    }
  }
  res.json({ success: updated });
});

// 8. Reply to a post
app.post('/api/reply', async (req, res) => {
  const { parentId, did, text } = req.body;
  if (!parentId || !did || !text) return res.status(400).json({ error: 'Missing fields' });

  const user = await redisPub.hgetall(`user:${did}`);
  const username = user.username || did.substring(0, 8);
  const city = user.city || 'Earth';

  const reply = {
    id: Date.now().toString(),
    did,
    username,
    text,
    image: null,
    city,
    timestamp: Date.now(),
    likes: 0,
    replies: 0,
    parentId
  };

  await redisPub.lpush('aether:posts', JSON.stringify(reply));
  await redisPub.ltrim('aether:posts', 0, 999);
  await redisPub.publish(CHANNEL, JSON.stringify({ type: 'new_reply', reply }));
  res.json(reply);
});

// ----- WebSocket (for real-time updates) -----
wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
    } catch (e) {}
  });
});

// ----- Start Server -----
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ Aether backend running on port ${PORT}`);
});

// ----- Get user by username -----
app.get('/api/user/:username', async (req, res) => {
  const username = req.params.username.toLowerCase().trim();
  if (!username) return res.status(400).json({ error: 'Username required' });

  try {
    const did = await redisPub.get(`username:${username}`);
    if (!did) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userData = await redisPub.hgetall(`user:${did}`);
    res.json({ did, ...userData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const express = require('express');
const cors = require('cors');
const Redis = require('ioredis');
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const redisPub = new Redis(process.env.REDIS_URL);
const redisSub = new Redis(process.env.REDIS_URL);

// In-memory user store (for demo)
const users = {};        // did -> { username, did, following: [] }
const posts = [];        // array of post objects
const likes = {};        // postId -> Set of dids (as array)
const comments = {};     // postId -> [ { did, username, text, timestamp } ]

// ----- User registration / login (accepts username or email) -----
app.get('/api/user/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  let user = null;
  if (identifier.startsWith('did:mesh:')) {
    user = users[identifier] || null;
  } else {
    for (const did in users) {
      if (users[did].username.toLowerCase() === identifier.toLowerCase()) {
        user = users[did];
        break;
      }
    }
  }
  if (user) {
    res.json({ did: user.did, username: user.username });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

app.post('/api/set-username', (req, res) => {
  const { did, username } = req.body;
  if (!did || !username) return res.status(400).json({ error: 'Missing fields' });
  if (users[did]) return res.status(409).json({ error: 'DID already registered' });
  users[did] = { did, username, following: [] };
  res.json({ success: true });
});

// ----- Follow / Unfollow -----
app.post('/api/follow', (req, res) => {
  const { did, targetDid } = req.body;
  if (!users[did] || !users[targetDid]) return res.status(404).json({ error: 'User not found' });
  if (!users[did].following.includes(targetDid)) {
    users[did].following.push(targetDid);
  }
  res.json({ success: true });
});

app.post('/api/unfollow', (req, res) => {
  const { did, targetDid } = req.body;
  if (users[did]) {
    users[did].following = users[did].following.filter(id => id !== targetDid);
  }
  res.json({ success: true });
});

app.get('/api/following/:did', (req, res) => {
  const user = users[req.params.did];
  res.json(user ? user.following : []);
});

// ----- Search users -----
app.get('/api/search', (req, res) => {
  const q = req.query.q.toLowerCase();
  const results = Object.values(users).filter(u => u.username.toLowerCase().includes(q));
  res.json(results);
});

// ----- Feed: only broadcast posts, filter by location -----
app.get('/api/feed', async (req, res) => {
  const type = req.query.type || 'all';
  const location = req.query.location || '';
  
  // Get posts from Redis (aether:posts) or from in-memory fallback
  let rawPosts = [];
  try {
    const raw = await redisPub.lrange('aether:posts', 0, 199);
    rawPosts = raw.map(p => JSON.parse(p)).reverse();
  } catch (e) {
    // Fallback to in-memory posts if Redis fails
    rawPosts = posts.slice().reverse();
  }

  let result = rawPosts;
  if (type === 'broadcast') {
    result = result.filter(p => p.type === 'broadcast');
  } else if (type === 'social') {
    result = result.filter(p => p.type !== 'broadcast');
  }
  if (location) {
    result = result.filter(p => (p.location || '').toLowerCase().includes(location.toLowerCase()));
  }
  res.json(result);
});

// ----- Create a broadcast post (video) -----
app.post('/api/posts', (req, res) => {
  const { did, text, location, image, isVideo, videoData, type } = req.body;
  if (!did || !users[did]) return res.status(401).json({ error: 'Invalid user' });
  const post = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
    did,
    username: users[did].username,
    text: text || '',
    location: location || 'Earth',
    image: image || null,
    isVideo: isVideo || false,
    videoData: videoData || null,
    type: type || 'broadcast',
    timestamp: Date.now(),
    likes: 0,
    comments: 0
  };
  posts.push(post);
  likes[post.id] = [];
  comments[post.id] = [];
  // Also push to Redis for persistence
  try {
    redisPub.rpush('aether:posts', JSON.stringify(post));
  } catch (e) {}
  res.json(post);
});

// ----- Like / Unlike -----
app.post('/api/like', (req, res) => {
  const { postId, did } = req.body;
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!likes[postId]) likes[postId] = [];
  const idx = likes[postId].indexOf(did);
  if (idx === -1) {
    likes[postId].push(did);
  } else {
    likes[postId].splice(idx, 1);
  }
  post.likes = likes[postId].length;
  res.json({ likes: post.likes, liked: idx === -1 });
});

// ----- Add comment -----
app.post('/api/comment', (req, res) => {
  const { postId, did, text } = req.body;
  const post = posts.find(p => p.id === postId);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (!users[did]) return res.status(401).json({ error: 'Invalid user' });
  if (!comments[postId]) comments[postId] = [];
  const comment = {
    did,
    username: users[did].username,
    text,
    timestamp: Date.now()
  };
  comments[postId].push(comment);
  post.comments = comments[postId].length;
  res.json({ success: true, comment });
});

app.get('/api/comments/:postId', (req, res) => {
  res.json(comments[req.params.postId] || []);
});

// ----- Serve static frontend (if built) -----
app.use(express.static('../truth-broadcast/out'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Truth Broadcast backend on port ${PORT}`));

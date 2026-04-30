const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = 'owner';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subs.json');

// ─── METERED.CA CONFIG ────────────────────────────────────────────────────────
const METERED_API_KEY = 'oyqLSsOHS1mm26Lx2i4SXNKYvZfwfyP84YA-gYXwjX6yeRAP';
const METERED_APP_NAME = 'nexuschat';

// ─── INIT DIRS ────────────────────────────────────────────────────────────────
[DATA_DIR, UPLOADS_DIR, MESSAGES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');
if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, '{}');
if (!fs.existsSync(PUSH_SUBS_FILE)) fs.writeFileSync(PUSH_SUBS_FILE, '{}');

// ─── DATA HELPERS ─────────────────────────────────────────────────────────────
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getMessages(key) {
  const f = path.join(MESSAGES_DIR, key + '.json');
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function saveMessages(key, msgs) {
  const f = path.join(MESSAGES_DIR, key + '.json');
  fs.writeFileSync(f, JSON.stringify(msgs, null, 2));
}
function dmKey(a, b) { return [a, b].sort().join('__'); }

// ─── FILE UPLOAD (chat attachments) ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── AVATAR UPLOAD ────────────────────────────────────────────────────────────
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, 'avatar_' + uuidv4() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
    cb(null, true);
  }
});

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SESSION MIDDLEWARE ───────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.cookies?.session || req.headers['x-session'];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const sessions = readJSON(SESSIONS_FILE);
  const username = sessions[token];
  if (!username) return res.status(401).json({ error: 'Invalid session' });
  // Read isAdmin from the persisted user record — single source of truth
  const users = readJSON(USERS_FILE);
  const userRecord = users[username];
  if (!userRecord) return res.status(401).json({ error: 'User no longer exists' });
  req.username = username;
  req.isAdmin = userRecord.isAdmin === true; // must be explicitly true in DB
  next();
}

// ─── ADMIN MIDDLEWARE ─────────────────────────────────────────────────────────
// Stacks on top of authMiddleware — rejects non-admins with 403 at the route level
function adminMiddleware(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Forbidden: admin only' });
  next();
}

// ─── ONLINE TRACKING ──────────────────────────────────────────────────────────
const onlineUsers = new Map(); // username -> Set of ws clients

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be 3+ chars' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be 4+ chars' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Username: letters, numbers, _ only' });
  const users = readJSON(USERS_FILE);
  if (users[username]) return res.status(400).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { password: hash, created: Date.now(), isAdmin: username === ADMIN_USERNAME, avatar: null };
  writeJSON(USERS_FILE, users);
  const token = uuidv4();
  const sessions = readJSON(SESSIONS_FILE);
  sessions[token] = username;
  writeJSON(SESSIONS_FILE, sessions);
  // FIX: 1-year maxAge ensures accounts persist across browser restarts
  res.cookie('session', token, { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, username, isAdmin: username === ADMIN_USERNAME, avatar: null });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  const users = readJSON(USERS_FILE);
  const user = users[username];
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
  const token = uuidv4();
  const sessions = readJSON(SESSIONS_FILE);
  sessions[token] = username;
  writeJSON(SESSIONS_FILE, sessions);
  // FIX: 1-year maxAge ensures sessions survive browser restarts
  res.cookie('session', token, { httpOnly: true, maxAge: 365 * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, username, isAdmin: username === ADMIN_USERNAME, avatar: user.avatar || null });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    const sessions = readJSON(SESSIONS_FILE);
    delete sessions[token];
    writeJSON(SESSIONS_FILE, sessions);
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.username] || {};
  res.json({ username: req.username, isAdmin: req.isAdmin, avatar: user.avatar || null });
});

// ─── USERS ROUTE ──────────────────────────────────────────────────────────────
app.get('/api/users', authMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE);
  const list = Object.keys(users)
    // Admin account is completely invisible to regular users in all public lists
    .filter(u => req.isAdmin || users[u].isAdmin !== true)
    .map(u => ({
      username: u,
      online: onlineUsers.has(u),
      isAdmin: users[u].isAdmin === true,
      avatar: users[u].avatar || null
    }));
  res.json(list);
});

// ─── PROFILE ROUTES ───────────────────────────────────────────────────────────

// Upload / update avatar
app.post('/api/profile/avatar', authMiddleware, avatarUpload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const users = readJSON(USERS_FILE);
  if (!users[req.username]) return res.status(404).json({ error: 'User not found' });

  // Remove previous avatar file
  const oldAvatar = users[req.username].avatar;
  if (oldAvatar) {
    const oldPath = path.join(UPLOADS_DIR, path.basename(oldAvatar));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }

  const avatarUrl = '/uploads/' + req.file.filename;
  users[req.username].avatar = avatarUrl;
  writeJSON(USERS_FILE, users);

  // Broadcast so every connected client refreshes this user's avatar in real-time
  broadcast({ type: 'profile_update', username: req.username, avatar: avatarUrl });
  res.json({ ok: true, avatar: avatarUrl });
});

// Change username
app.post('/api/profile/username', authMiddleware, async (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername) return res.status(400).json({ error: 'Missing newUsername' });
  if (newUsername.length < 3) return res.status(400).json({ error: 'Username must be 3+ chars' });
  if (!/^[a-zA-Z0-9_]+$/.test(newUsername)) return res.status(400).json({ error: 'Letters, numbers, _ only' });
  if (newUsername === req.username) return res.json({ ok: true, username: req.username });
  if (req.username === ADMIN_USERNAME) return res.status(403).json({ error: 'Admin username cannot be changed' });

  const users = readJSON(USERS_FILE);
  if (users[newUsername]) return res.status(400).json({ error: 'Username already taken' });

  // Move user record to new key
  users[newUsername] = { ...users[req.username] };
  delete users[req.username];
  writeJSON(USERS_FILE, users);

  // Remap all session tokens
  const sessions = readJSON(SESSIONS_FILE);
  for (const token of Object.keys(sessions)) {
    if (sessions[token] === req.username) sessions[token] = newUsername;
  }
  writeJSON(SESSIONS_FILE, sessions);

  // Notify all clients so user lists refresh
  broadcast({ type: 'username_changed', oldUsername: req.username, newUsername });
  res.json({ ok: true, username: newUsername });
});

// Change password (current password required)
app.post('/api/profile/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be 4+ chars' });

  const users = readJSON(USERS_FILE);
  const user = users[req.username];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const ok = await bcrypt.compare(currentPassword, user.password);
  if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

  users[req.username].password = await bcrypt.hash(newPassword, 10);
  writeJSON(USERS_FILE, users);
  res.json({ ok: true });
});

// Public profile lookup (for viewing other users) — admin profile is not publicly visible
app.get('/api/profile/:username', authMiddleware, (req, res) => {
  const users = readJSON(USERS_FILE);
  const user = users[req.params.username];
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Non-admins cannot look up the admin profile
  if (user.isAdmin === true && !req.isAdmin) return res.status(404).json({ error: 'User not found' });
  res.json({
    username: req.params.username,
    avatar: user.avatar || null,
    isAdmin: user.isAdmin === true,
    created: user.created
  });
});

// ─── HIDDEN ADMIN GATE ────────────────────────────────────────────────────────
// Access the admin login page ONLY via: /nx-admin-gate?key=<GATE_KEY>
// This URL is never linked anywhere in the UI. Keep GATE_KEY private.
const GATE_KEY = 'nx-gate-7f3k9qm2wvb';   // ← change this to your own secret
const GATE_COOKIE = 'nx_gate';

app.get('/nx-admin-gate', (req, res) => {
  if (req.query.key !== GATE_KEY) {
    // Return a generic 404 — reveals nothing about the gate's existence
    return res.status(404).send('Not found');
  }
  // Set a short-lived gate cookie (10 minutes), then redirect to admin login
  res.cookie(GATE_COOKIE, GATE_KEY, { httpOnly: true, maxAge: 10 * 60 * 1000 });
  res.redirect('/admin-login.html');
});

// Serve admin login page only when the gate cookie is present
app.get('/admin-login.html', (req, res) => {
  if (req.cookies?.[GATE_COOKIE] !== GATE_KEY) return res.status(404).send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});


// Frontend fetches this before every call to get fresh TURN credentials
app.get('/api/ice-servers', authMiddleware, async (req, res) => {
  try {
    const response = await fetch(
      `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`
    );
    if (!response.ok) throw new Error('Metered API responded with ' + response.status);
    const iceServers = await response.json();
    res.json({ iceServers });
  } catch (err) {
    console.warn('[Metered] ICE fetch failed, using fallback STUN:', err.message);
    // Fallback keeps calls working even if Metered is temporarily unreachable
    res.json({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    });
  }
});

// ─── MESSAGES ROUTES ──────────────────────────────────────────────────────────
app.get('/api/messages/general', authMiddleware, (req, res) => {
  res.json(getMessages('general'));
});

app.get('/api/messages/dm/:user', authMiddleware, (req, res) => {
  const other = req.params.user;
  const users = readJSON(USERS_FILE);
  if (!users[other]) return res.status(404).json({ error: 'User not found' });
  const k = dmKey(req.username, other);
  res.json(getMessages(k));
});

// Admin: view any DM
app.get('/api/admin/dm', authMiddleware, adminMiddleware, (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'Need a and b params' });
  res.json(getMessages(dmKey(a, b)));
});

// Admin: list all conversations
app.get('/api/admin/conversations', authMiddleware, adminMiddleware, (req, res) => {
  const files = fs.readdirSync(MESSAGES_DIR).filter(f => f.endsWith('.json'));
  const convos = files.map(f => {
    const key = f.replace('.json', '');
    const msgs = getMessages(key);
    const last = msgs[msgs.length - 1] || null;
    if (key === 'general') return { key, type: 'general', participants: ['general'], msgCount: msgs.length, last };
    const parts = key.split('__');
    return { key, type: 'dm', participants: parts, msgCount: msgs.length, last };
  });
  res.json(convos);
});

// ─── FILE UPLOAD ROUTE ────────────────────────────────────────────────────────
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// ─── PUSH SUBSCRIPTION ───────────────────────────────────────────────────────
app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Missing subscription' });
  const subs = readJSON(PUSH_SUBS_FILE);
  if (!subs[req.username]) subs[req.username] = [];
  // Avoid duplicates
  const endpoint = subscription.endpoint;
  subs[req.username] = subs[req.username].filter(s => s.endpoint !== endpoint);
  subs[req.username].push(subscription);
  writeJSON(PUSH_SUBS_FILE, subs);
  res.json({ ok: true });
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(cookieHeader.split(';').map(c => {
    const [k, ...v] = c.trim().split('=');
    return [k, v.join('=')];
  }));
  const token = cookies.session;
  const sessions = readJSON(SESSIONS_FILE);
  const username = sessions[token];
  if (!username) { ws.close(1008, 'Unauthorized'); return; }

  ws.username = username;
  if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
  onlineUsers.get(username).add(ws);

  broadcast({ type: 'online_update', users: getOnlineList() });

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // ── CHAT MESSAGES ────────────────────────────────────────────────────────
    if (data.type === 'message') {
      const msg = {
        id: uuidv4(),
        sender: username,
        ts: Date.now(),
        type: data.msgType || 'text',
        content: data.content || '',
        fileUrl: data.fileUrl || null,
        fileName: data.fileName || null,
        fileSize: data.fileSize || null,
        mimeType: data.mimeType || null,
      };
      if (data.channel === 'general') {
        const msgs = getMessages('general');
        msgs.push(msg);
        saveMessages('general', msgs);
        broadcast({ type: 'message', channel: 'general', msg });
      } else if (data.channel === 'dm' && data.to) {
        const key = dmKey(username, data.to);
        const msgs = getMessages(key);
        msgs.push(msg);
        saveMessages(key, msgs);
        broadcastToDM(username, data.to, { type: 'message', channel: 'dm', to: data.to, from: username, msg });
      }
    }

    // ── WEBRTC SIGNALING ─────────────────────────────────────────────────────
    if (data.type === 'call_offer') {
      const { to, offer, callType, callId } = data;
      sendToUser(to, { type: 'call_offer', from: username, offer, callType, callId });
    }
    if (data.type === 'call_answer') {
      const { to, answer, callId } = data;
      sendToUser(to, { type: 'call_answer', from: username, answer, callId });
    }
    if (data.type === 'ice_candidate') {
      const { to, candidate, callId } = data;
      sendToUser(to, { type: 'ice_candidate', from: username, candidate, callId });
    }
    if (data.type === 'call_decline' || data.type === 'call_end' || data.type === 'call_timeout') {
      const { to, callId } = data;
      sendToUser(to, { type: data.type, from: username, callId });
    }
  });

  ws.on('close', () => {
    const set = onlineUsers.get(username);
    if (set) {
      set.delete(ws);
      if (set.size === 0) onlineUsers.delete(username);
    }
    broadcast({ type: 'online_update', users: getOnlineList() });
  });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(str); });
}

function broadcastToDM(a, b, data) {
  const str = JSON.stringify(data);
  const users = readJSON(USERS_FILE);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      const u = c.username;
      const isAdmin = users[u]?.isAdmin === true;
      if (u === a || u === b || isAdmin) c.send(str);
    }
  });
}

function sendToUser(username, data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.username === username) c.send(str);
  });
}

function getOnlineList() {
  return [...onlineUsers.keys()];
}

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n⚡ Nexus Chat running at http://localhost:${PORT}`);
  console.log(`👑 Admin username: ${ADMIN_USERNAME}`);
  console.log(`📁 Data stored in: ${DATA_DIR}\n`);
});

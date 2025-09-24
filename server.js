require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');

// Routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

// Socket handler
const initSocket = require('./utils/socketHandler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/whatsapp_videocall';
mongoose.connect(MONGO_URI).then(() => console.log('MongoDB connected')).catch(err => console.error('MongoDB error', err));

// Trust proxy (needed for secure cookies behind reverse proxies)
app.set('trust proxy', 1);

// Session store
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
});

// --- LiveKit token endpoint ---
// Returns { url, token } for the given room and the current session user identity
try {
  const { AccessToken } = require('livekit-server-sdk');
  app.get('/lk/token', (req, res) => {
    try {
      const url = process.env.LIVEKIT_URL;
      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;
      if (!url || !apiKey || !apiSecret) {
        return res.status(500).json({ error: 'LiveKit env not configured' });
      }
      const roomName = (req.query.room || '').toString().slice(0, 128) || 'default';
      const identity = (req.session?.user?.name || req.session?.user?._id || 'guest') + '-' + (req.session.id || Math.random().toString(36).slice(2));
      const at = new AccessToken(apiKey, apiSecret, {
        identity,
        ttl: '10m'
      });
      at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
      const token = at.toJwt();
      return res.json({ url, token, identity, room: roomName });
    } catch (e) {
      console.error('livekit token error', e);
      return res.status(500).json({ error: 'token_failed' });
    }
  });
} catch (e) {
  console.warn('[livekit] server sdk not installed, /lk/token disabled');
}

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(sessionMiddleware);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// Auth guard middleware helpers
function ensureAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/auth/login');
}

function ensureGuest(req, res, next) {
  if (!req.session || !req.session.user) return next();
  return res.redirect('/home');
}

// Routes
app.get('/', (req, res) => res.redirect('/home'));
// Health check - used by Render
app.get('/healthz', (req, res) => res.status(200).send('ok'));
app.get('/home', ensureAuth, (req, res) => {
  const user = req.session.user;
  res.render('pages/home', { user });
});

app.use('/auth', (req, res, next) => { req.ensureGuest = ensureGuest; next(); }, authRoutes(ensureGuest));
app.use('/users', ensureAuth, userRoutes);

// Auth pages direct
app.get('/auth/login', ensureGuest, (req, res) => res.render('pages/login', { error: null }));
app.get('/auth/register', ensureGuest, (req, res) => res.render('pages/register', { error: null }));

// Socket.IO with session sharing
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

initSocket(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// --- ICE (Xirsys) proxy endpoint ---
// Avoid exposing TURN credentials to the client bundle; fetch at runtime server-side
const https = require('https');
let cachedIce = { stamp: 0, data: null };

app.get('/ice', async (req, res) => {
  try {
    // Cache for 5 minutes
    if (cachedIce.data && (Date.now() - cachedIce.stamp < 5 * 60 * 1000)) {
      return res.json({ iceServers: cachedIce.data });
    }

    const X_HOST = process.env.XIRSYS_HOST || 'global.xirsys.net';
    const X_PATH = process.env.XIRSYS_PATH || '/_turn/MyFirstApp';
    const X_IDENT = process.env.XIRSYS_IDENT; // username
    const X_SECRET = process.env.XIRSYS_SECRET; // secret/API key
    if (!X_IDENT || !X_SECRET) {
      return res.status(500).json({ error: 'XIRSYS credentials not configured' });
    }

    const body = JSON.stringify({ format: 'urls' });
    const options = {
      host: X_HOST,
      path: X_PATH,
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${X_IDENT}:${X_SECRET}`).toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const payload = await new Promise((resolve, reject) => {
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', (ch) => data += ch);
        r.on('end', () => resolve({ status: r.statusCode, data }));
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (payload.status !== 200) {
      console.error('Xirsys error status:', payload.status, payload.data);
      return res.status(502).json({ error: 'Failed to fetch ICE from Xirsys' });
    }
    let parsed;
    try { parsed = JSON.parse(payload.data); } catch { parsed = null; }
    let iceServers = parsed?.v?.iceServers || parsed?.iceServers || parsed?.d || [];
    // Xirsys sometimes returns an object: { username, credential, urls: [] }
    if (!Array.isArray(iceServers) && iceServers && typeof iceServers === 'object') {
      iceServers = [{
        urls: iceServers.urls || [],
        username: iceServers.username,
        credential: iceServers.credential
      }];
    }
    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      console.error('Xirsys malformed response:', payload.data);
      return res.status(502).json({ error: 'No ICE servers returned' });
    }
    cachedIce = { stamp: Date.now(), data: iceServers };
    return res.json({ iceServers });
  } catch (e) {
    console.error('ICE endpoint error:', e);
    return res.status(500).json({ error: 'ICE endpoint failed' });
  }
});

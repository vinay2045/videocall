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

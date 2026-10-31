const express = require('express');
const session = require('express-session');
const path = require('path');
const config = require('./config');
const authRoutes = require('./routes/auth.routes');
const gameRoutes = require('./routes/game.routes');

const app = express();

app.use(express.json());

// Session cookie: httpOnly (not readable by JS), sameSite (basic CSRF defence),
// secure only in production because it needs HTTPS.
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: 1000 * 60 * 60,
  },
}));

app.use(express.static(path.join(__dirname, '..', '..', 'frontend')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);
app.use('/api/game', gameRoutes);

module.exports = app;
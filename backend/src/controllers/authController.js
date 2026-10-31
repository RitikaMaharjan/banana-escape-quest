const bcrypt = require('bcrypt');
const db = require('../db/database');

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

// Used so login takes about the same time whether or not the username exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

const findUser = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const insertUser = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

async function register(req, res) {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8-72 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = insertUser.run(username, hash);

    await regenerateSession(req);
    req.session.userId = Number(result.lastInsertRowid);
    req.session.username = username;

    res.status(201).json({ username });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That username is already taken' });
    }
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Could not create the account' });
  }
}

async function login(req, res) {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = findUser.get(username);
    const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !matches) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.username = user.username;

    res.json({ username: user.username });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Could not log in' });
  }
}

function logout(req, res) {
  req.session.destroy((err) => {
    res.clearCookie('connect.sid');
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.json({ ok: true });
  });
}

function me(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json({ username: req.session.username });
}

module.exports = { register, login, logout, me };

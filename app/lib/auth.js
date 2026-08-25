'use strict';

const crypto = require('crypto');
const store = require('./store');
const { id, now, HttpError, bad, str } = require('./util');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 32).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email };
}

function findUserByEmail(email) {
  const db = store.data();
  const needle = String(email || '').trim().toLowerCase();
  return db.users.find((u) => u.email === needle) || null;
}

function register({ name, email, password }) {
  const db = store.data();
  const cleanName = str(name, 'name', { max: 60 });
  const cleanEmail = str(email, 'email', { max: 120 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) throw bad('Некорректный email');
  if (typeof password !== 'string' || password.length < 6) {
    throw bad('Пароль должен быть не короче 6 символов');
  }
  if (findUserByEmail(cleanEmail)) throw new HttpError(409, 'Пользователь с таким email уже существует');

  const { salt, hash } = hashPassword(password);
  const user = {
    id: id('usr'),
    name: cleanName,
    email: cleanEmail,
    salt,
    hash,
    createdAt: now()
  };
  db.users.push(user);
  store.persist();
  return user;
}

function login({ email, password }) {
  const user = findUserByEmail(email);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.salt, user.hash)) {
    throw new HttpError(401, 'Неверный email или пароль');
  }
  return user;
}

function createSession(userId) {
  const db = store.data();
  const session = {
    token: crypto.randomBytes(24).toString('hex'),
    userId,
    createdAt: now(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
  };
  db.sessions.push(session);
  store.persist();
  return session;
}

function destroySession(token) {
  const db = store.data();
  const i = db.sessions.findIndex((s) => s.token === token);
  if (i >= 0) {
    db.sessions.splice(i, 1);
    store.persist();
  }
}

function userFromToken(token) {
  if (!token) return null;
  const db = store.data();
  const session = db.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) < Date.now()) {
    destroySession(token);
    return null;
  }
  return db.users.find((u) => u.id === session.userId) || null;
}

function tokenFromRequest(req) {
  const header = req.headers['authorization'];
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  const cookie = req.headers['cookie'];
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === 'splitpay_token') return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

function requireUser(req) {
  const user = userFromToken(tokenFromRequest(req));
  if (!user) throw new HttpError(401, 'Требуется авторизация');
  return user;
}

module.exports = {
  register,
  login,
  createSession,
  destroySession,
  requireUser,
  publicUser,
  findUserByEmail,
  tokenFromRequest
};

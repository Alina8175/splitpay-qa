'use strict';

const crypto = require('crypto');

function id(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('hex');
}

function now() {
  return new Date().toISOString();
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function bad(message, details) {
  return new HttpError(400, message, details);
}

// ---- money -----------------------------------------------------------
// Everything is stored as an integer number of minor units (kopecks/cents)
// so that splitting never accumulates floating point drift.

function toMinor(value, field) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw bad(`Поле "${field}" не является числом`);
    return Math.round(value * 100);
  }
  if (typeof value !== 'string') throw bad(`Поле "${field}" обязательно`);
  const cleaned = value.trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw bad(`Поле "${field}" должно быть числом с не более чем 2 знаками после запятой`);
  }
  return Math.round(parseFloat(cleaned) * 100);
}

function fromMinor(minor) {
  return (minor / 100).toFixed(2);
}

// Split `total` minor units into `count` parts as evenly as possible.
// The remainder of 1 minor unit is handed out to the first parts.
function splitEvenly(total, count) {
  if (count <= 0) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / count);
  let rest = abs - base * count;
  const out = [];
  for (let i = 0; i < count; i++) {
    let part = base;
    if (rest > 0) {
      part += 1;
      rest -= 1;
    }
    out.push(part * sign);
  }
  return out;
}

// Distribute `total` by weights (percentages), largest-remainder method so the
// parts always add up to exactly `total`.
function splitByWeights(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw bad('Сумма долей должна быть больше нуля');
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  let k = 0;
  while (rest > 0 && order.length) {
    out[order[k % order.length].i] += 1;
    rest -= 1;
    k += 1;
  }
  return out;
}

// ---- misc ------------------------------------------------------------

function str(value, field, { max = 200, required = true, min = 1 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`Поле "${field}" обязательно`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`Поле "${field}" должно быть строкой`);
  const v = value.trim();
  if (required && v.length < min) throw bad(`Поле "${field}" обязательно`);
  if (v.length > max) throw bad(`Поле "${field}" длиннее ${max} символов`);
  return v;
}

function currencyCode(value, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback) return fallback;
    throw bad('Поле "currency" обязательно');
  }
  const v = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(v)) throw bad('Валюта должна быть кодом из 3 букв, например RUB или EUR');
  return v;
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

module.exports = {
  id,
  now,
  HttpError,
  bad,
  toMinor,
  fromMinor,
  splitEvenly,
  splitByWeights,
  str,
  currencyCode,
  uniq
};

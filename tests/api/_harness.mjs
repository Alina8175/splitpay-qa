// Общая оснастка API-проверок SplitPay.
//
// Требования проекта, которые она обслуживает:
//  * набор запускается ОДНОЙ командой `node --test tests/api/` — поэтому оснастка
//    сама поднимает приложение и сама его гасит; предварительных шагов у проверяющего нет;
//  * внешних зависимостей нет — только стандартная библиотека Node.js (реестр npm
//    недоступен из обеих сред, риск Р-2);
//  * app/ не правится: файл данных уводится в каталог временных файлов ШТАТНОЙ
//    переменной окружения приложения SPLITPAY_DATA, объявленной в app/README.md;
//  * каждый тестовый файл поднимает СВОЙ процесс на СВОЁМ порту и со СВОИМ файлом
//    данных — node --test исполняет файлы параллельно, общее состояние недопустимо.
//
// Соглашение С-5 / С-C1 (правка аудита D-23, D-24): имена полей и путей взяты из
// фактического контракта приложения. Несовпадение имён само по себе находкой
// не является — находкой является поведение.

import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
const SERVER = path.join(REPO, 'app', 'server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Поднимает отдельный экземпляр приложения. Возвращает управляющий объект. */
export async function startApp() {
  const port = await freePort();
  const dataFile = path.join(
    os.tmpdir(),
    `splitpay-qa-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`
  );
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SPLITPAY_DATA: dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`приложение не поднялось (код ${child.exitCode})\n${stdout}\n${stderr}`);
    }
    try {
      await fetch(base + '/', { method: 'GET' });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`приложение не ответило за 15 с\n${stdout}\n${stderr}`);
      }
      await sleep(80);
    }
  }

  return {
    base,
    port,
    dataFile,
    child,
    get stdout() { return stdout; },
    /** Останавливает процесс; при needRestart=false удаляет файл данных. */
    async stop({ keepData = false } = {}) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const t = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < t) await sleep(40);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      if (!keepData) { try { fs.unlinkSync(dataFile); } catch {} }
    },
  };
}

/** Перезапуск процесса на ТОМ ЖЕ файле данных — для проверки SP-007. */
export async function restartApp(app) {
  await app.stop({ keepData: true });
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SPLITPAY_DATA: app.dataFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try { await fetch(base + '/'); break; }
    catch { if (Date.now() > deadline) throw new Error('перезапуск не поднялся'); await sleep(80); }
  }
  return {
    base, port, dataFile: app.dataFile, child,
    async stop({ keepData = false } = {}) {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const t = Date.now() + 5000;
        while (child.exitCode === null && Date.now() < t) await sleep(40);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      if (!keepData) { try { fs.unlinkSync(app.dataFile); } catch {} }
    },
  };
}

/**
 * Один HTTP-запрос. Ничего не бросает на ошибочных статусах — статус есть предмет проверки.
 * headers передаётся как есть: кейсы про заголовок идентификации подают его буквально.
 */
export async function api(app, method, p, { body, token, headers = {}, rawBody } = {}) {
  const h = { ...headers };
  if (rawBody !== undefined || body !== undefined) {
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json';
    }
  }
  if (token) h['Authorization'] = 'Bearer ' + token;
  const res = await fetch(app.base + p, {
    method,
    headers: h,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text.length ? JSON.parse(text) : null; } catch { json = null; }
  return {
    status: res.status,
    ct: res.headers.get('content-type'),
    headers: res.headers,
    text,
    json,
    body: json,
  };
}

let seq = 0;
export function uniqEmail(prefix = 'qa') {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq}@qa.local`;
}

/** Регистрирует пользователя. Участник группы у этого приложения — учётная запись. */
export async function newUser(app, name, prefix = 'u') {
  const email = uniqEmail(prefix);
  const r = await api(app, 'POST', '/api/auth/register', {
    body: { name, email, password: 'passw0rd-qa-123' },
  });
  if (!r.json || !r.json.token) {
    throw new Error(`регистрация не удалась: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { name, email, token: r.json.token, id: r.json.user.id };
}

/** Группа с владельцем и участниками в заданном порядке добавления (SP-006). */
export async function newGroup(app, owner, name, currency, members = []) {
  const r = await api(app, 'POST', '/api/groups', {
    token: owner.token,
    body: { name, currency, memberEmails: members.map((m) => m.email) },
  });
  if (!r.json || !r.json.group) {
    throw new Error(`группа не создана: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return r.json.group;
}

/** Создание расхода по фактическому контракту (см. С-5). */
export function expenseBody({ payerId, amount, currency = 'RUB', category, description = '', splitType = 'equal', participants, splits }) {
  const b = { description, amount, currency, payerId, splitType };
  if (category !== undefined) b.category = category;
  if (splitType === 'equal') b.participants = participants;
  else b.splits = splits;
  return b;
}

export async function addExpense(app, token, gid, spec) {
  return api(app, 'POST', `/api/groups/${gid}/expenses`, { token, body: expenseBody(spec) });
}

/** Балансы и долги: у приложения они приходят одним ответом, сгруппированные по валюте. */
export async function balances(app, token, gid, currency = 'RUB') {
  const r = await api(app, 'GET', `/api/groups/${gid}/balances`, { token });
  const block = (r.json && Array.isArray(r.json.balances))
    ? r.json.balances.find((b) => b.currency === currency)
    : null;
  return { res: r, block, rows: block ? block.balances : null, debts: block ? block.debts : null };
}

export function balanceOf(rows, userId) {
  const row = (rows || []).find((r) => r.userId === userId);
  return row ? row.balance : undefined;
}

/** Сумма всех балансов — центральный инвариант SP-081. */
export function balanceSum(rows) {
  return (rows || []).reduce((a, r) => a + r.balance, 0);
}

export function fmt(minor) {
  const s = Math.abs(minor).toString().padStart(3, '0');
  return (minor < 0 ? '-' : '') + s.slice(0, -2) + '.' + s.slice(-2);
}

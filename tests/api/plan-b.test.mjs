// ЗОНА B — балансы (SP-080…SP-084), долги (SP-090…SP-096), погашения
// и пересчёт (SP-160…SP-173), удаление расхода как триггер пересчёта (SP-057).
// План: tests/plan-B.md, включая § «Правки по результатам аудита (сессия 3)».
//
// Правила набора: тест, нашедший дефект, остаётся КРАСНЫМ; xfail не используется;
// денежные ожидания до копейки; app/ не правится.
//
// Соглашение по контракту (правка D-23/D-24): долги приходят полем debts[] внутри
// GET /api/groups/{id}/balances, сгруппированные по валюте; отдельного пути /debts
// у приложения нет. Отметка оплаты — POST /api/groups/{id}/settlements с телом
// {fromUserId, toUserId, amount, currency}. Несовпадение ИМЁН находкой не является;
// отсутствие пути и отсутствие поля — является.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startApp, api, newUser, newGroup, addExpense, balances, balanceOf, balanceSum, fmt,
} from './_harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const CAT = 'Транспорт';

function fixtureOk(res, what) {
  assert.ok(res.status >= 200 && res.status < 300,
    `шаг фикстуры «${what}» не прошёл: ${res.status} ${res.text.slice(0, 300)}`);
}

/** F1 — «Поездка», RUB, Аня → Борис → Вера строго в этом порядке добавления. */
async function F1(name = 'Поездка') {
  const A = await newUser(app, 'Аня', 'pa');
  const B = await newUser(app, 'Борис', 'pb');
  const V = await newUser(app, 'Вера', 'pv');
  const g = await newGroup(app, A, name, 'RUB', [B, V]);
  const [pA, pB, pV] = g.members.map((m) => m.id);
  return { A, B, V, g, pA, pB, pV, token: A.token };
}
/** F3 — «Квартира», RUB, Аня → Борис. */
async function F3(name = 'Квартира') {
  const A = await newUser(app, 'Аня', 'qa');
  const B = await newUser(app, 'Борис', 'qb');
  const g = await newGroup(app, A, name, 'RUB', [B]);
  const [qA, qB] = g.members.map((m) => m.id);
  return { A, B, g, qA, qB, token: A.token };
}

async function expense(f, { payer, amount, participants, splitType = 'equal', splits, description = 'расход' }) {
  const r = await addExpense(app, f.token, f.g.id, {
    payerId: payer, amount, category: CAT, description, splitType,
    participants, splits,
  });
  fixtureOk(r, `расход ${amount}`);
  return r.json.expense;
}

/** Отметка долга оплаченным. SP-165: погашение на полную сумму текущего остатка. */
async function pay(f, from, to, amountText, currency = 'RUB') {
  return api(app, 'POST', `/api/groups/${f.g.id}/settlements`, {
    token: f.token,
    body: { fromUserId: from, toUserId: to, amount: amountText, currency },
  });
}

async function state(f) {
  const b = await balances(app, f.token, f.g.id);
  return b;
}
function debtBetween(debts, from, to) {
  return (debts || []).find((d) => (d.from || d.fromId || d.fromUserId) === from
    && (d.to || d.toId || d.toUserId) === to);
}
function debtMinor(d) { return d && (d.amountMinor !== undefined ? d.amountMinor : d.amount); }
function pendingDebts(debts) {
  return (debts || []).filter((d) => d.status === undefined || d.status === 'pending');
}

// ───────────────────────────── Часть 1. Балансы ─────────────────────────────

test('B-01 · SP-080,SP-081: балансы после неделимого расхода', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const s = await state(f);
  assert.equal(s.res.status, 200, 'SP-084: балансы обязаны читаться');
  assert.equal(balanceOf(s.rows, f.pA), 6666, 'SP-080: Аня заплатила 10000, начислено 3334 → +6666');
  assert.equal(balanceOf(s.rows, f.pB), -3333, 'SP-080: Борису начислено 3333, заплатил 0 → −3333');
  assert.equal(balanceOf(s.rows, f.pV), -3333, 'SP-080: Вере начислено 3333, заплатила 0 → −3333');
  assert.equal(balanceSum(s.rows), 0, 'SP-081: сумма балансов всех участников обязана быть равна нулю ВСЕГДА');
});

test('B-02 · SP-082,SP-083,SP-096: группа без расходов даёт нули, а не пустоту', async () => {
  const f = await F1('Пустая');
  const s = await state(f);
  assert.equal(s.res.status, 200);
  assert.notEqual(s.rows, null,
    'SP-083: группа без расходов обязана возвращать нулевые балансы для всех участников, а не пустой список');
  assert.equal(s.rows.length, 3, 'SP-082: балансы обязаны возвращаться для ВСЕХ участников, включая нулевых');
  for (const id of [f.pA, f.pB, f.pV]) {
    assert.equal(balanceOf(s.rows, id), 0, 'SP-083: баланс обязан быть ровно 0');
  }
  assert.equal(pendingDebts(s.debts).length, 0,
    'SP-096: группа с нулевыми балансами обязана возвращать пустой список долгов pending');
});

test('B-03 · SP-082: участник, не задетый ни одним расходом, присутствует в балансах', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB] });
  const s = await state(f);
  const vera = (s.rows || []).find((r) => r.userId === f.pV);
  assert.ok(vera, 'SP-082: Вера не участвует в расходе, но обязана присутствовать в балансах');
  assert.equal(vera.balance, 0, 'SP-082: её баланс обязан быть ровно 0');
  assert.equal(balanceSum(s.rows), 0, 'SP-081');
});

// ─────────────────── Часть 2. Долги: состав, полнота, число ───────────────────

test('B-04 · SP-091,SP-163: состав записи долга — стороны, сумма, валюта, статус', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const s = await state(f);
  const d = debtBetween(s.debts, f.pB, f.pA);
  assert.ok(d, 'SP-090: долг Борис → Аня обязан присутствовать');
  assert.equal(debtMinor(d), 3333, 'SP-091: сумма долга до копейки');
  assert.equal(d.currency, 'RUB', 'SP-091: валюта долга');
  assert.equal(d.status, 'pending',
    'SP-091 + SP-163: каждый долг обязан содержать СТАТУС; остаток больше нуля → pending');
});

test('B-05 · SP-090,SP-094: долги гасят балансы без остатка в копейку', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const s = await state(f);
  const net = new Map((s.rows || []).map((r) => [r.userId, r.balance]));
  for (const d of pendingDebts(s.debts)) {
    const from = d.from || d.fromUserId, to = d.to || d.toUserId;
    net.set(from, net.get(from) + debtMinor(d));
    net.set(to, net.get(to) - debtMinor(d));
  }
  for (const [id, v] of net) {
    assert.equal(v, 0, `SP-094: применение всех долгов обязано обнулять балансы полностью, у ${id} остаток ${v}`);
  }
});

test('B-06 · SP-090,SP-161: взаимозачёт встречных долгов, двое участников', async () => {
  const f = await F3();
  await expense(f, { payer: f.qA, amount: '100.00', participants: [f.qA, f.qB], description: 'Аня платит' });
  await expense(f, { payer: f.qB, amount: '40.00', participants: [f.qA, f.qB], description: 'Борис платит' });
  // Аня: 10000 − 5000 − 2000 = +3000; Борис: 4000 − 5000 − 2000 = −3000
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.qA), 3000, 'SP-080: баланс Ани');
  assert.equal(balanceOf(s.rows, f.qB), -3000, 'SP-080: баланс Бориса');
  const p = pendingDebts(s.debts);
  assert.equal(p.length, 1,
    'SP-090 + SP-161: встречные долги обязаны быть взаимозачтены в ОДИН долг, а не перечислены по расходам');
  assert.equal(debtMinor(p[0]), 3000, 'SP-090: долг равен разнице, 30.00');
});

test('B-07 · SP-093: взаимозачёт по кругу, трое участников', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Аня' });
  await expense(f, { payer: f.pB, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Борис' });
  await expense(f, { payer: f.pV, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Вера' });
  const s = await state(f);
  for (const id of [f.pA, f.pB, f.pV]) {
    assert.equal(balanceOf(s.rows, id), 0, 'SP-080: три равных расхода по кругу обнуляют всех');
  }
  assert.equal(pendingDebts(s.debts).length, 0,
    'SP-093 + SP-096: нулевые балансы — долгов pending быть не должно; перечисление начислений по расходам дало бы записи');
});

test('B-08 · SP-093: две независимые пары не дробятся на четыре долга', async () => {
  const A = await newUser(app, 'А', 'x'); const B = await newUser(app, 'Б', 'x');
  const C = await newUser(app, 'В', 'x'); const D = await newUser(app, 'Г', 'x');
  const g = await newGroup(app, A, 'Четверо', 'RUB', [B, C, D]);
  const [a, b, c, d] = g.members.map((m) => m.id);
  const f = { g, token: A.token };
  await expense(f, { payer: a, amount: '20.00', participants: [a, b], description: 'пара 1' });
  await expense(f, { payer: c, amount: '20.00', participants: [c, d], description: 'пара 2' });
  const s = await state(f);
  assert.equal(balanceOf(s.rows, a), 1000);
  assert.equal(balanceOf(s.rows, b), -1000);
  assert.equal(balanceOf(s.rows, c), 1000);
  assert.equal(balanceOf(s.rows, d), -1000);
  const p = pendingDebts(s.debts);
  assert.equal(p.length, 2,
    'SP-093: участников с ненулевым балансом четверо → долгов не более трёх; независимые пары дают ровно два');
  assert.equal(balanceSum(s.rows), 0, 'SP-081');
});

test('B-09 · SP-093: верхняя граница n−1 не превышается', async () => {
  const A = await newUser(app, 'П1', 'y');
  const rest = [];
  for (let i = 2; i <= 5; i++) rest.push(await newUser(app, 'П' + i, 'y'));
  const g = await newGroup(app, A, 'Пятеро', 'RUB', rest);
  const ids = g.members.map((m) => m.id);
  const f = { g, token: A.token };
  await expense(f, { payer: ids[0], amount: '100.00', participants: ids, description: 'один за всех' });
  const s = await state(f);
  const nonZero = (s.rows || []).filter((r) => r.balance !== 0).length;
  assert.equal(pendingDebts(s.debts).length <= nonZero - 1, true,
    `SP-093: долгов pending обязано быть не больше ${nonZero - 1}, получено ${pendingDebts(s.debts).length}`);
});

test('B-10 · SP-095: долга самому себе нет', async () => {
  const f = await F1();
  await expense(f, {
    payer: f.pA, amount: '100.00', splitType: 'manual', description: 'целиком на себя',
    splits: [{ userId: f.pA, value: '100.00', amount: '100.00' }],
  });
  const s = await state(f);
  for (const d of s.debts || []) {
    const from = d.from || d.fromUserId, to = d.to || d.toUserId;
    assert.notEqual(from, to, 'SP-095: долг, где отправитель и получатель совпадают, обязан отсутствовать');
  }
  assert.equal(pendingDebts(s.debts).length, 0, 'SP-092: нулевых и вырожденных pending быть не должно');
});

test('B-11 · SP-167: отметка оплаченным вырожденной пары «сам себе» → NOT_FOUND', async () => {
  const f = await F1();
  const r = await pay(f, f.pA, f.pA, '10.00');
  assert.equal(r.status, 404,
    `SP-167: отметка оплаченным по паре без задолженности обязана возвращать NOT_FOUND; получено ${r.status} ${r.text.slice(0, 200)}`);
});

test('B-12 · SP-164: пара с нулевым остатком и без погашений в списке отсутствует', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Аня' });
  await expense(f, { payer: f.pB, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Борис' });
  await expense(f, { payer: f.pV, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'Вера' });
  const s = await state(f);
  assert.equal((s.debts || []).length, 0,
    'SP-164: пара, по которой не было ни задолженности, ни погашения, обязана в списке отсутствовать');
});

test('B-13 · SP-162,SP-163: три состояния пары в одном списке — pending, paid, отсутствие', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const before = await state(f);
  const d = debtBetween(before.debts, f.pB, f.pA);
  assert.ok(d, 'предусловие: долг Борис → Аня существует');
  const paid = await pay(f, f.pB, f.pA, fmt(debtMinor(d)));
  fixtureOk(paid, 'погашение Борис → Аня');
  const s = await state(f);
  const dPaid = debtBetween(s.debts, f.pB, f.pA);
  assert.ok(dPaid,
    'SP-162: список долгов обязан включать и pending, и paid — погашенная пара обязана остаться в списке');
  assert.equal(dPaid.status, 'paid',
    'SP-163: остаток по паре ноль и по ней было погашение → статус обязан быть paid');
  const dPending = debtBetween(s.debts, f.pV, f.pA);
  assert.ok(dPending, 'SP-163: у второй пары остаток больше нуля');
  assert.equal(dPending.status, 'pending', 'SP-163: остаток больше нуля → pending');
  assert.equal(debtBetween(s.debts, f.pB, f.pV), undefined, 'SP-164: третья пара в списке отсутствует');
});

// ───────────────────────────── Часть 3. Погашения ─────────────────────────────

test('B-14 · SP-165,SP-168: погашение на полный остаток меняет ровно две стороны', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const before = await state(f);
  const veraBefore = balanceOf(before.rows, f.pV);
  const d = debtBetween(before.debts, f.pB, f.pA);
  const r = await pay(f, f.pB, f.pA, fmt(debtMinor(d)));
  fixtureOk(r, 'погашение');
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.pA), 6666 - 3333,
    'SP-168: баланс получателя обязан измениться ровно на сумму погашения');
  assert.equal(balanceOf(s.rows, f.pB), 0,
    'SP-168: баланс должника обязан измениться ровно на сумму погашения');
  assert.equal(balanceOf(s.rows, f.pV), veraBefore,
    'SP-168: погашение меняет РОВНО две стороны — баланс Веры обязан остаться прежним');
  assert.equal(balanceSum(s.rows), 0, 'SP-169: сумма балансов обязана остаться нулём после погашения');
  const after = debtBetween(s.debts, f.pB, f.pA);
  assert.ok(after,
    'SP-162: список долгов обязан включать и pending, и paid — после погашения пара обязана остаться '
    + 'в списке со статусом paid, а не исчезнуть из него');
  assert.equal(debtMinor(after), 0,
    'SP-168: после отметки оплаченным остаток по паре обязан стать нулевым');
});

test('B-15 · SP-081,SP-169: сумма балансов ровно ноль при неделимых суммах и погашении', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '0.01', participants: [f.pA, f.pB, f.pV], description: 'копейка' });
  await expense(f, { payer: f.pB, amount: '10.10', participants: [f.pA, f.pB, f.pV], description: 'неделимое' });
  const mid = await state(f);
  assert.equal(balanceSum(mid.rows), 0, 'SP-081: ноль при неделимых суммах');
  const d = pendingDebts(mid.debts)[0];
  if (d) {
    const r = await pay(f, d.from || d.fromUserId, d.to || d.toUserId, fmt(debtMinor(d)));
    fixtureOk(r, 'погашение неделимого остатка');
  }
  const s = await state(f);
  assert.equal(balanceSum(s.rows), 0, 'SP-169: сумма балансов обязана оставаться нулём после любого числа погашений');
});

test('B-16 · SP-166: повторная отметка уже оплаченного долга → 409 CONFLICT', async () => {
  const f = await F3();
  await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const before = await state(f);
  const d = debtBetween(before.debts, f.qB, f.qA);
  assert.ok(d, 'предусловие: есть долг Борис → Аня на 20.00');
  const first = await pay(f, f.qB, f.qA, fmt(debtMinor(d)));
  fixtureOk(first, 'первое погашение');
  const second = await pay(f, f.qB, f.qA, fmt(debtMinor(d)));
  assert.equal(second.status, 409,
    `SP-166: повторная отметка уже оплаченного долга обязана отклоняться со статусом 409; получено ${second.status} ${second.text.slice(0, 200)}`);
  const code = second.json && second.json.error && second.json.error.code;
  assert.equal(code, 'CONFLICT', 'SP-105: конфликт состояния обязан нести код CONFLICT в форме SP-101');
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.qA), 0, 'после отказа балансы обязаны остаться прежними');
  assert.equal(balanceOf(s.rows, f.qB), 0);
});

test('B-17 · SP-167: отметка оплаченным пары без задолженности → 404 NOT_FOUND', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  // Пары Вера → Борис не существует: у обоих отрицательный баланс.
  const r = await pay(f, f.pV, f.pB, '10.00');
  assert.equal(r.status, 404,
    `SP-167: по паре, у которой нет задолженности, отметка обязана возвращать NOT_FOUND; получено ${r.status} ${r.text.slice(0, 200)}`);
});

test('B-18 · SP-170: погашение необратимо — отмены не предусмотрено', async () => {
  const f = await F3();
  await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const before = await state(f);
  const d = debtBetween(before.debts, f.qB, f.qA);
  const r = await pay(f, f.qB, f.qA, fmt(debtMinor(d)));
  fixtureOk(r, 'погашение');
  const sid = r.json && (r.json.settlement ? r.json.settlement.id : r.json.id);
  assert.ok(sid, 'предусловие: погашение создано и имеет идентификатор');
  const undo = await api(app, 'DELETE', `/api/groups/${f.g.id}/settlements/${sid}`, { token: f.token });
  assert.ok(undo.status === 404 || undo.status === 405,
    `SP-170: погашение обязано быть необратимым в этой итерации — путь отмены не предусмотрен; получено ${undo.status} ${undo.text.slice(0, 200)}`);
});

// ──────────────── Часть 4. Пересчёт после изменения расхода ────────────────

async function editExpense(f, e, patch) {
  return api(app, 'PUT', `/api/groups/${f.g.id}/expenses/${e.id}`, {
    token: f.token,
    body: {
      description: e.description, amount: e.amountText || e.amountFormatted, currency: e.currency,
      category: e.category, payerId: e.payerId, splitType: 'equal',
      participants: (e.shares || e.split || []).map((s) => s.userId || s.participantId),
      ...patch,
    },
  });
}

test('B-19 · SP-172,SP-084: пересчёт после изменения суммы, погашение переживает пересчёт', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const d0 = debtBetween((await state(f)).debts, f.qB, f.qA);
  fixtureOk(await pay(f, f.qB, f.qA, fmt(debtMinor(d0))), 'погашение 20.00');
  const put = await editExpense(f, e, { amount: '100.00' });
  fixtureOk(put, 'изменение суммы на 100.00');
  const s = await state(f);
  // Аня: 10000 − 5000 − 2000(отдано? нет, получено) ; считаем по SP-080:
  // заплатила 10000, получила погашениями 2000, начислено 5000 → 10000 − 2000 − 5000 = +3000
  assert.equal(balanceOf(s.rows, f.qA), 3000,
    'SP-172: после изменения расхода долги обязаны пересчитаться, а ранее проведённое погашение — сохраниться и учитываться');
  assert.equal(balanceOf(s.rows, f.qB), -3000, 'SP-172: баланс должника после пересчёта');
  assert.equal(balanceSum(s.rows), 0, 'SP-169');
});

test('B-20 · SP-163,SP-172: оплаченный долг снова становится pending после изменения расхода', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const d0 = debtBetween((await state(f)).debts, f.qB, f.qA);
  fixtureOk(await pay(f, f.qB, f.qA, fmt(debtMinor(d0))), 'погашение 20.00');
  fixtureOk(await editExpense(f, e, { amount: '100.00' }), 'увеличение расхода');
  const s = await state(f);
  const d = debtBetween(s.debts, f.qB, f.qA);
  assert.ok(d, 'SP-172: пара обязана остаться в списке');
  assert.equal(debtMinor(d), 3000, 'SP-161: остаток вычисляется из балансов с учётом проведённого погашения');
  assert.equal(d.status, 'pending',
    'SP-163: остаток снова больше нуля → статус обязан вернуться в pending');
});

test('B-21 · SP-173: смена направления долга после изменения плательщика', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  fixtureOk(await editExpense(f, e, { payerId: f.qB }), 'смена плательщика');
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.qA), -2000, 'SP-172: Аня стала должником');
  assert.equal(balanceOf(s.rows, f.qB), 2000, 'SP-172: Борис стал кредитором');
  const d = debtBetween(s.debts, f.qA, f.qB);
  assert.ok(d, 'SP-173: задолженность обязана появиться как долг ПРОТИВОПОЛОЖНОГО направления');
  assert.equal(debtMinor(d), 2000, 'SP-173: на 20.00');
  assert.equal(d.status, 'pending', 'SP-173: со статусом pending');
});

test('B-22 · SP-171,SP-173: смена направления при сохранённом погашении', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const d0 = debtBetween((await state(f)).debts, f.qB, f.qA);
  fixtureOk(await pay(f, f.qB, f.qA, fmt(debtMinor(d0))), 'погашение 20.00');
  fixtureOk(await editExpense(f, e, { payerId: f.qB, amount: '40.00' }), 'смена плательщика на Бориса');
  // Борис заплатил 4000, начислено 2000, получил погашениями 2000 → 4000 − 2000 − 2000 = 0? нет:
  // SP-080: заплатил + отдано погашениями − начислено − получено погашениями.
  // Борис: 4000 + 2000 − 2000 − 0 = +4000. Аня: 0 + 0 − 2000 − 2000 = −4000.
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.qB), 4000,
    'SP-080 + SP-171: погашение обязано сохраниться и продолжать учитываться в расчёте');
  assert.equal(balanceOf(s.rows, f.qA), -4000, 'SP-080: обратная сторона');
  assert.equal(balanceSum(s.rows), 0, 'SP-169');
  const d = debtBetween(s.debts, f.qA, f.qB);
  assert.ok(d && debtMinor(d) === 4000,
    'SP-173: долг обратного направления на 40.00 — сумма расхода плюс сохранённое погашение');
});

// ──────────────── Часть 5. Пересчёт после удаления расхода ────────────────

test('B-23 · SP-057,SP-171: пересчёт после удаления, погашение переживает', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const d0 = debtBetween((await state(f)).debts, f.qB, f.qA);
  fixtureOk(await pay(f, f.qB, f.qA, fmt(debtMinor(d0))), 'погашение 20.00');
  const del = await api(app, 'DELETE', `/api/groups/${f.g.id}/expenses/${e.id}`, { token: f.token });
  assert.ok(del.status >= 200 && del.status < 300, `удаление расхода: ${del.status}`);
  const s = await state(f);
  // Расхода нет, погашение осталось: Борис отдал 2000, Аня получила 2000.
  assert.equal(balanceOf(s.rows, f.qB), 2000,
    'SP-171: ранее проведённое погашение обязано сохраниться и продолжать учитываться после удаления расхода');
  assert.equal(balanceOf(s.rows, f.qA), -2000, 'SP-171: обратная сторона');
  const d = debtBetween(s.debts, f.qA, f.qB);
  assert.ok(d && debtMinor(d) === 2000, 'SP-173: долг сменил направление после удаления расхода');
});

test('B-24 · SP-057,SP-084,SP-096: удаление единственного расхода обнуляет балансы', async () => {
  const f = await F1();
  const e = await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const del = await api(app, 'DELETE', `/api/groups/${f.g.id}/expenses/${e.id}`, { token: f.token });
  assert.ok(del.status >= 200 && del.status < 300, `удаление расхода: ${del.status}`);
  const s = await state(f);
  assert.equal(s.rows ? s.rows.length : 0, 3,
    'SP-082: после удаления расхода балансы обязаны возвращаться для всех участников, а не исчезать');
  for (const id of [f.pA, f.pB, f.pV]) {
    assert.equal(balanceOf(s.rows, id), 0, 'SP-057: удаление обязано отражаться в балансах немедленно');
  }
  assert.equal(pendingDebts(s.debts).length, 0, 'SP-096: долгов pending не остаётся');
});

// ─────── Часть 6. Оплата долга, исчезнувшего или изменившегося после пересчёта ───────

test('B-25 · SP-167,SP-172: оплата долга, исчезнувшего после изменения расхода', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const seen = debtBetween((await state(f)).debts, f.qB, f.qA);
  assert.ok(seen, 'предусловие: долг Борис → Аня виден');
  fixtureOk(await editExpense(f, e, { payerId: f.qB }), 'смена плательщика — долг разворачивается');
  const r = await pay(f, f.qB, f.qA, fmt(debtMinor(seen)));
  assert.equal(r.status, 404,
    `SP-167: долга Борис → Аня больше нет, отметка обязана вернуть NOT_FOUND, а не провести погашение по устаревшему представлению; получено ${r.status} ${r.text.slice(0, 200)}`);
});

test('B-26 · SP-167,SP-171,SP-113: оплата долга, исчезнувшего после удаления расхода', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '40.00', participants: [f.qA, f.qB] });
  const seen = debtBetween((await state(f)).debts, f.qB, f.qA);
  const del = await api(app, 'DELETE', `/api/groups/${f.g.id}/expenses/${e.id}`, { token: f.token });
  assert.ok(del.status >= 200 && del.status < 300, `удаление: ${del.status}`);
  const r = await pay(f, f.qB, f.qA, fmt(debtMinor(seen)));
  assert.equal(r.status, 404,
    `SP-167: после удаления расхода задолженности нет, отметка обязана вернуть NOT_FOUND; получено ${r.status}`);
  const after = await state(f);
  assert.equal(after.res.status, 200, 'SP-113: следующий корректный запрос обязан обслуживаться нормально');
  assert.equal(balanceSum(after.rows), 0, 'SP-081');
});

test('B-27 · SP-165: погашается текущий остаток, а не увиденный ранее', async () => {
  const f = await F3();
  const e = await expense(f, { payer: f.qA, amount: '100.00', participants: [f.qA, f.qB] });
  const seen = debtBetween((await state(f)).debts, f.qB, f.qA);
  assert.equal(debtMinor(seen), 5000, 'предусловие: увиденный долг 50.00');
  fixtureOk(await editExpense(f, e, { amount: '40.00' }), 'расход уменьшен до 40.00');
  // Текущий остаток пары — 20.00. Клиент отмечает оплаченным по устаревшему представлению.
  const r = await pay(f, f.qB, f.qA, '50.00');
  const s = await state(f);
  assert.equal(balanceSum(s.rows), 0, 'SP-169: сумма балансов обязана остаться нулём');
  assert.equal(balanceOf(s.rows, f.qA), 0,
    'SP-165: отметка оплаченным обязана создавать погашение на полную сумму ТЕКУЩЕГО остатка (20.00), '
    + 'а не на увиденную ранее (50.00); переплата оставила бы Аню в минусе');
  assert.equal(balanceOf(s.rows, f.qB), 0, 'SP-165: обратная сторона');
});

// ──────────── Часть 7. Отказанное изменение как отсутствие пересчёта ────────────

test('B-28 · SP-156,SP-084: отклонённое изменение не трогает балансы и долги', async () => {
  const f = await F1();
  const e = await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const before = await state(f);
  const put = await api(app, 'PUT', `/api/groups/${f.g.id}/expenses/${e.id}`, {
    token: f.token,
    body: {
      description: 'ручное с недобором', amount: '100.00', currency: 'RUB', category: CAT,
      payerId: f.pA, splitType: 'manual',
      splits: [
        { userId: f.pA, value: '50.00', amount: '50.00' },
        { userId: f.pB, value: '30.00', amount: '30.00' },
        { userId: f.pV, value: '19.99', amount: '19.99' },
      ],
    },
  });
  assert.equal(put.status, 400,
    `SP-071 + SP-152: сумма ручных частей 99.99 ≠ 100.00 обязана отклоняться и при изменении; получено ${put.status}`);
  const after = await state(f);
  assert.deepEqual(
    (after.rows || []).map((r) => [r.userId, r.balance]).sort(),
    (before.rows || []).map((r) => [r.userId, r.balance]).sort(),
    'SP-156: после отказа балансы обязаны остаться в точности прежними');
});

test('B-29 · SP-154: изменение несуществующего расхода не трогает балансы', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '100.00', participants: [f.pA, f.pB, f.pV] });
  const before = await state(f);
  const put = await api(app, 'PUT', `/api/groups/${f.g.id}/expenses/exp_нет-такого`, {
    token: f.token,
    body: { description: 'х', amount: '10.00', currency: 'RUB', category: CAT, payerId: f.pA, splitType: 'equal', participants: [f.pA, f.pB] },
  });
  assert.equal(put.status, 404,
    `SP-154: изменение несуществующего расхода обязано возвращать NOT_FOUND; получено ${put.status}`);
  const after = await state(f);
  assert.equal(balanceOf(after.rows, f.pA), balanceOf(before.rows, f.pA), 'балансы не тронуты');
  assert.equal(balanceSum(after.rows), 0, 'SP-081');
});

test('B-30 · SP-155,SP-151,SP-093: изменение сохраняет идентификатор и позицию и не удваивает учёт', async () => {
  const f = await F1();
  const e1 = await expense(f, { payer: f.pA, amount: '30.00', participants: [f.pA, f.pB, f.pV], description: 'E1' });
  const e2 = await expense(f, { payer: f.pB, amount: '60.00', participants: [f.pA, f.pB, f.pV], description: 'E2' });
  const e3 = await expense(f, { payer: f.pV, amount: '90.00', participants: [f.pA, f.pB, f.pV], description: 'E3' });
  const put = await api(app, 'PUT', `/api/groups/${f.g.id}/expenses/${e2.id}`, {
    token: f.token,
    body: {
      description: 'Такси', amount: '120.00', currency: 'RUB', category: CAT,
      payerId: f.pB, splitType: 'equal', participants: [f.pA, f.pB, f.pV],
    },
  });
  assert.ok(put.status >= 200 && put.status < 300, `SP-150: изменение расхода: ${put.status} ${put.text.slice(0, 200)}`);

  const list = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.token });
  const arr = list.json.expenses || list.json;
  assert.equal(arr.length, 3, 'SP-155: новых расходов появиться не должно');
  assert.deepEqual([...arr.map((x) => x.id)].sort(), [e1.id, e2.id, e3.id].sort(),
    'SP-155: изменение обязано СОХРАНЯТЬ идентификатор расхода — набор идентификаторов не меняется');
  // Позиция сверяется относительно самого списка: направление сортировки — предмет SP-056
  // и зоны A, и подмешивать его в вердикт по SP-155 нельзя, иначе получится ложная находка.
  assert.equal(arr.findIndex((x) => x.id === e2.id), 1,
    'SP-155: изменённый расход обязан сохранить свою позицию — вторым из трёх при любом направлении сортировки');
  const changed = arr.find((x) => x.id === e2.id);
  assert.equal(changed.description, 'Такси',
    'SP-151 (правка D-02): изменению обязаны подлежать все поля, включая описание');

  const s = await state(f);
  // Начислено каждому 1000 + 4000 + 3000 = 8000.
  assert.equal(balanceOf(s.rows, f.pA), 3000 - 8000, 'SP-153: пересчёт балансов после изменения');
  assert.equal(balanceOf(s.rows, f.pB), 12000 - 8000, 'SP-153: удвоения учёта быть не должно');
  assert.equal(balanceOf(s.rows, f.pV), 9000 - 8000, 'SP-153');
  assert.equal(balanceSum(s.rows), 0, 'SP-081');
  assert.equal(pendingDebts(s.debts).length, 2, 'SP-093: трое с ненулевым балансом → не более двух долгов');
});

test('B-31 · SP-092,SP-064: долг в одну копейку и отсутствие нулевых pending', async () => {
  const f = await F1();
  await expense(f, { payer: f.pA, amount: '0.01', participants: [f.pA, f.pB, f.pV], description: 'копейка' });
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.pA), 0,
    'SP-064 + SP-080: Аня заплатила 1 копейку и ей же начислена 1 копейка → баланс 0');
  assert.equal(balanceOf(s.rows, f.pB), 0, 'SP-064: Борису начислено 0');
  assert.equal(balanceOf(s.rows, f.pV), 0, 'SP-064: Вере начислено 0');
  for (const d of pendingDebts(s.debts)) {
    assert.equal(debtMinor(d) > 0, true, 'SP-092: сумма каждого долга pending обязана быть строго больше нуля');
  }
  assert.equal(balanceSum(s.rows), 0, 'SP-081');
});

// ─────────── Новый кейс правки D-03: percent доходит до балансов и долгов ───────────

test('B-38 · SP-081,SP-090,SP-094: percent доходит до балансов и долгов', async () => {
  const f = await F1();
  const e = await expense(f, {
    payer: f.pA, amount: '1.00', splitType: 'percent', description: 'проценты до балансов',
    splits: [
      { userId: f.pA, value: '70.00', percent: '70.00' },
      { userId: f.pB, value: '14.99', percent: '14.99' },
      { userId: f.pV, value: '15.01', percent: '15.01' },
    ],
  });
  // 100 копеек: целые 70 / 14 / 15 = 99; одна копейка — наибольшей дробной части (.99 у Бориса).
  assert.deepEqual((e.shares || e.split || []).map((s) => (s.amountMinor !== undefined ? s.amountMinor : s.amount)),
    [70, 15, 15], 'SP-067: метод наибольшего остатка на процентах');
  const s = await state(f);
  assert.equal(balanceOf(s.rows, f.pA), 30,
    'SP-080 при splitType percent: Аня заплатила 100, начислено 70 → +30 копеек');
  assert.equal(balanceOf(s.rows, f.pB), -15, 'SP-080 при percent: Борису начислено 15');
  assert.equal(balanceOf(s.rows, f.pV), -15, 'SP-080 при percent: Вере начислено 15');
  assert.equal(balanceSum(s.rows), 0,
    'SP-081: сумма балансов ноль при ЛЮБОМ способе распределения — именно этот элемент требования '
    + 'до правки D-03 не проверял ни один из 125 кейсов');
  const p = pendingDebts(s.debts);
  assert.equal(p.length, 2, 'SP-090: два долга по 0.15');
  assert.equal(p.reduce((a, d) => a + debtMinor(d), 0), 30, 'SP-094: долги гасят балансы без остатка');
});

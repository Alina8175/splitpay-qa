// ЗОНА C — доступ и идентификация (SP-140…SP-148), группы (SP-030…SP-035),
// участники (SP-040…SP-047), протокол и ошибки (SP-100…SP-117, SP-120…SP-121),
// модель данных и перезапуск (SP-001…SP-007), история операций (SP-180…SP-184).
// План: tests/plan-C.md, включая § XII (правки по аудиту сессии 3).
//
// Правила набора (те же, что в зонах A и B):
//  * тест, нашедший дефект, остаётся КРАСНЫМ; xfail не используется;
//  * ожидания выведены из SPEC.md, а не списаны с поведения приложения;
//  * app/ не правится и не читается: контракт снят зондированием и по app/README.md;
//  * каждый кейс разворачивает СВОЮ фикстуру в свежесозданной группе (правка D-36).
//
// Соглашение С-C1 (правки D-23, D-24). Схема запросов переписана под фактический
// контракт: идентификация — Bearer-токен, участник группы — зарегистрированный
// пользователь (POST .../members по email), история — GET .../activity, долги —
// поле debts[] внутри GET .../balances, отметка оплаты — POST .../settlements.
// Несовпадение ИМЁН находкой не является. Отсутствие ПУТИ — является, и фиксируется
// ровно один раз, в C-31 (обход таблицы SP-120).
//
// Соглашение С-C2 (вводится здесь, по образцу теста A-20-NAMES плана A).
// Приложение отвечает на ошибку плоским телом {"error":"текст"} — без объекта с полями
// code и message. Это ОДНО расхождение с SP-101/SP-102. Если проверять форму тела
// в каждом кейсе, одна находка покрасит собой три десятка тестов и отчёт перестанет
// показывать, сколько дефектов найдено. Поэтому:
//   * форма тела ошибки и набор кодов SP-102 проверяются РОВНО ОДИН РАЗ — в C-25;
//   * во всех остальных кейсах проверяется поведение: HTTP-статус, содержательность
//     сообщения (SP-108) и отсутствие утечки (SP-117).
// Статус ответа при этом расхождением по словарю не является: SP-109, SP-116, SP-104
// называют числа прямо, и там, где кейс написан ПРО статус, статус проверяется точно.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, restartApp, api, newUser, newGroup, addExpense } from './_harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const CAT = 'Транспорт';
const CAT_HOUSING = 'Жильё';

// ───────────────────────────── оснастка кейсов ─────────────────────────────

const GET = (token, p) => api(app, 'GET', p, { token });
const POST = (token, p, body) => api(app, 'POST', p, { token, body });
const DEL = (token, p) => api(app, 'DELETE', p, { token });

/** Денежная величина по смыслу, независимо от именования (С-5 / С-C1). */
function money(o, base) {
  if (!o) return { minor: undefined, text: undefined };
  const minor = o[base + 'Minor'] !== undefined ? o[base + 'Minor'] : o[base];
  const text = o[base + 'Formatted'] !== undefined ? o[base + 'Formatted'] : o[base + 'Text'];
  return { minor, text };
}

/** Шаг фикстуры или средства: предмет проверки не здесь, годится любой 2xx. */
function ok2xx(res, what) {
  assert.ok(res.status >= 200 && res.status < 300,
    `шаг «${what}» не прошёл: ${res.status} ${res.text.slice(0, 300)}`);
  return res;
}

/** Текст сообщения об ошибке, в какой бы форме оно ни пришло (С-C2). */
function msgOf(res) {
  const e = res.json && res.json.error;
  if (typeof e === 'string') return e;
  if (e && typeof e.message === 'string') return e.message;
  return res.text || '';
}

/** SP-108: сообщение обязано называть поле или причину, а не быть словом «ошибка». */
function assertNamesReason(res, re, what) {
  const m = msgOf(res);
  assert.ok(m.trim().length > 0, `SP-108: ${what} — сообщение об ошибке пустое`);
  assert.doesNotMatch(m, /^\s*(ошибка|error|bad request)\s*$/i,
    `SP-108: ${what} — сообщение «${m}» не называет ни поля, ни причины`);
  assert.match(m, re, `SP-108: ${what} — сообщение «${m}» не называет причину отказа`);
}

/** SP-117: ни одной строки чужой группы ни в теле, ни в заголовках. */
function assertNoLeak(res, forbidden, what) {
  const hay = res.text + '\n' + [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
  const found = forbidden.filter((s) => s && hay.includes(String(s)));
  assert.deepEqual(found, [],
    `SP-117: ${what} — в ответе раскрыто содержимое чужой группы: ${found.join(', ')}`);
}

const members = (g) => (g && g.members) || [];
const memberIds = (g) => members(g).map((m) => m.id);
const memberNames = (g) => members(g).map((m) => m.name);

async function readGroup(token, gid) {
  const r = await GET(token, '/api/groups/' + gid);
  return { res: r, group: r.json && r.json.group, body: r.json };
}

async function settle(token, gid, fromId, toId, amount, currency = 'RUB') {
  return POST(token, `/api/groups/${gid}/settlements`, {
    fromUserId: fromId, toUserId: toId, amount, currency,
  });
}

async function activityOf(token, gid, query = '') {
  const r = await GET(token, `/api/groups/${gid}/activity${query}`);
  const list = r.json && (r.json.activity || r.json.transactions || r.json.items);
  return { res: r, list: Array.isArray(list) ? list : (Array.isArray(r.json) ? r.json : null) };
}

async function balancesOf(token, gid, currency = 'RUB') {
  const r = await GET(token, `/api/groups/${gid}/balances`);
  const blocks = r.json && r.json.balances;
  const block = Array.isArray(blocks) ? blocks.find((b) => b.currency === currency) : null;
  return {
    res: r,
    blocks: Array.isArray(blocks) ? blocks : null,
    rows: block ? block.balances : null,
    debts: block ? block.debts : null,
  };
}

/**
 * Фикстура F1 — своя группа. Владелец добавляется в состав самим приложением
 * первым, поэтому порядок участников: Аня (владелец), Борис, Виктор.
 */
async function F1(a = app, { withSettlement = true, name = 'Поездка' } = {}) {
  const alice = await newUser(a, 'Аня', 'alice');
  const boris = await newUser(a, 'Борис', 'boris');
  const viktor = await newUser(a, 'Виктор', 'viktor');
  const g = await newGroup(a, alice, name, 'RUB', [boris, viktor]);
  const [p1, p2, p3] = g.members.map((m) => m.id);
  const e = await addExpense(a, alice.token, g.id, {
    payerId: p1, amount: '300.00', currency: 'RUB', category: CAT,
    description: 'Бензин', splitType: 'equal', participants: [p1, p2, p3],
  });
  ok2xx(e, 'F1: расход 300.00');
  let s = null;
  if (withSettlement) {
    const r = await api(a, 'POST', `/api/groups/${g.id}/settlements`, {
      token: alice.token,
      body: { fromUserId: p2, toUserId: p1, amount: '100.00', currency: 'RUB' },
    });
    ok2xx(r, 'F1: погашение Борис → Аня 100.00');
    s = r.json && r.json.settlement;
  }
  return { alice, boris, viktor, g, p1, p2, p3, e: e.json && e.json.expense, s };
}

/** Фикстура F2 — чужая группа. Маркеры подобраны так, чтобы не встречаться в F1. */
async function F2(a = app) {
  const bob = await newUser(a, 'Боб', 'bob');
  const zhenya = await newUser(a, 'Женя', 'zhenya');
  const zoya = await newUser(a, 'Зоя', 'zoya');
  const g = await newGroup(a, bob, 'Дача', 'EUR', [zhenya, zoya]);
  const ids = g.members.map((m) => m.id);
  const [, pB1, pB2] = ids;
  const e = await addExpense(a, bob.token, g.id, {
    payerId: pB1, amount: '150.00', currency: 'EUR', category: CAT_HOUSING,
    description: 'Дрова', splitType: 'equal', participants: [pB1, pB2],
  });
  ok2xx(e, 'F2: расход 150.00');
  const s = await api(a, 'POST', `/api/groups/${g.id}/settlements`, {
    token: bob.token,
    body: { fromUserId: pB2, toUserId: pB1, amount: '75.00', currency: 'EUR' },
  });
  ok2xx(s, 'F2: погашение Зоя → Женя 75.00');
  return { bob, zhenya, zoya, g, pB1, pB2, eB1: e.json && e.json.expense };
}

/** Список запрещённых строк утечки F2 (список L плана). */
function listL(f2) {
  return ['Дача', 'Женя', 'Зоя', 'Дрова', 'EUR', '150.00', '15000', '75.00', '7500',
    f2.pB1, f2.pB2, f2.eB1 && f2.eB1.id];
}

// ═══════════════════════════ I. Доступ и идентификация ═══════════════════════════

test('C-01 · SP-145,SP-116,SP-117: чужая группа по прямому идентификатору — корень группы', async () => {
  const f2 = await F2();
  const f1 = await F1();
  const r = await GET(f1.alice.token, '/api/groups/' + f2.g.id);

  assert.equal(r.ct, 'application/json; charset=utf-8', 'SP-100: ответ обязан быть JSON с charset');
  assertNoLeak(r, listL(f2), 'отказ по чужой группе');
  assert.ok(!r.json || !r.json.group,
    'SP-145: обращение к чужой группе обязано отказывать, а не возвращать данные группы');
  assertNamesReason(r, /групп|доступ|запрещ|найден/i, 'отказ по чужой группе');
  assert.equal(r.status, 403,
    'SP-116: обращение к группе чужого владельца обязано возвращать 403 FORBIDDEN; '
    + `получено ${r.status}. 404 скрывает факт существования группы — это безопаснее, `
    + 'но расходится с оракулом (спорное место 1 плана C)');
});

test('C-02 · SP-146: чужая группа — все вложенные ЧИТАЮЩИЕ пути', async () => {
  const f2 = await F2();
  const f1 = await F1();
  const t = f1.alice.token;
  const paths = [
    `/api/groups/${f2.g.id}/expenses`,
    `/api/groups/${f2.g.id}/balances`,
    `/api/groups/${f2.g.id}/activity`,
    `/api/groups/${f2.g.id}`,
  ];
  const L = listL(f2);
  const statuses = [];
  for (const p of paths) {
    const r = await GET(t, p);
    statuses.push(r.status);
    assertNoLeak(r, L, `чтение ${p}`);
    const arr = r.json && (r.json.expenses || r.json.activity || r.json.balances);
    assert.ok(!Array.isArray(arr) || arr.length === 0 ? true : false,
      `SP-146: ${p} отдал массив записей чужой группы`);
    assert.ok(!(r.status === 200 && Array.isArray(arr)),
      `SP-146: ${p} — требуется отказ, а не «пустой чужой»: пустой массив со статусом 200 засчитывается как провал`);
  }
  assert.deepEqual(statuses, [403, 403, 403, 403],
    'SP-146: проверка владения обязана применяться ко ВСЕМ вложенным путям с кодом 403 (SP-116); '
    + `фактические статусы ${statuses.join(', ')}`);
});

test('C-03 · SP-146: чужая группа — все вложенные ИЗМЕНЯЮЩИЕ пути', async () => {
  const f2 = await F2();
  const f1 = await F1();
  const t = f1.alice.token;
  const gid = f2.g.id;
  const L = listL(f2);

  const attempts = [
    ['POST members', await POST(t, `/api/groups/${gid}/members`, { email: f1.viktor.email })],
    ['DELETE members', await DEL(t, `/api/groups/${gid}/members/${f2.pB2}`)],
    ['POST expenses', await api(app, 'POST', `/api/groups/${gid}/expenses`, {
      token: t,
      body: {
        payerId: f2.pB1, amount: '10.00', currency: 'EUR', category: CAT_HOUSING,
        description: 'взлом', splitType: 'equal', participants: [f2.pB1, f2.pB2],
      },
    })],
    ['PUT expense', await api(app, 'PUT', `/api/groups/${gid}/expenses/${f2.eB1.id}`, {
      token: t,
      body: {
        payerId: f2.pB1, amount: '1.00', currency: 'EUR', category: CAT_HOUSING,
        description: 'подмена', splitType: 'equal', participants: [f2.pB1, f2.pB2],
      },
    })],
    ['DELETE expense', await DEL(t, `/api/groups/${gid}/expenses/${f2.eB1.id}`)],
    ['POST settlements', await POST(t, `/api/groups/${gid}/settlements`, {
      fromUserId: f2.pB1, toUserId: f2.pB2, amount: '1.00', currency: 'EUR',
    })],
  ];
  for (const [what, r] of attempts) {
    assert.ok(r.status >= 400,
      `SP-146: изменяющий запрос ${what} к чужой группе прошёл со статусом ${r.status} — чужие данные изменены посторонним`);
    assertNoLeak(r, L, `изменение ${what}`);
  }

  // Контроль от владельца: чужие данные целы.
  const own = await readGroup(f2.bob.token, gid);
  assert.equal(own.res.status, 200, 'контроль: владелец обязан видеть свою группу');
  assert.deepEqual(memberNames(own.group), ['Боб', 'Женя', 'Зоя'],
    'SP-146: состав чужой группы изменён посторонним');
  const exps = await GET(f2.bob.token, `/api/groups/${gid}/expenses`);
  const list = exps.json.expenses;
  assert.equal(list.length, 1, 'SP-146: число расходов чужой группы изменено посторонним');
  assert.equal(money(list[0], 'amount').minor, 15000, 'SP-146: сумма расхода чужой группы подменена');
  assert.equal(list[0].description, 'Дрова', 'SP-146: описание расхода чужой группы подменено');

  const statuses = attempts.map(([, r]) => r.status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 403],
    `SP-116: отказ по чужой группе обязан быть 403 FORBIDDEN; фактические статусы ${statuses.join(', ')}`);
});

test('C-04 · SP-117: содержимое отказа по чужой группе не раскрывает данные', async () => {
  const f2 = await F2();
  const f1 = await F1();
  const r = await GET(f1.alice.token, `/api/groups/${f2.g.id}/activity`);

  assertNoLeak(r, [...listL(f2), f2.bob.id, f2.bob.email], 'отказ на истории чужой группы');
  const top = r.json && typeof r.json === 'object' ? Object.keys(r.json) : [];
  assert.deepEqual(top, ['error'],
    `SP-101: тело отказа обязано состоять ровно из объекта error; поля верхнего уровня: ${top.join(', ') || '—'}`);
  assertNamesReason(r, /групп|доступ|запрещ|найден/i, 'отказ на истории чужой группы');
  assert.equal(r.status, 403, `SP-116: ожидался 403 FORBIDDEN, получено ${r.status}`);
});

test('C-05 · SP-116 против SP-104: чужая существующая против несуществующей', async () => {
  const f2 = await F2();
  const f1 = await F1();
  const t = f1.alice.token;
  const foreign = await GET(t, '/api/groups/' + f2.g.id);
  const missing = await GET(t, '/api/groups/grp-does-not-exist-0000');
  const foreignB = await GET(t, `/api/groups/${f2.g.id}/balances`);
  const missingB = await GET(t, '/api/groups/grp-does-not-exist-0000/balances');

  assert.equal(missing.status, 404, 'SP-104: несуществующая группа обязана давать 404 NOT_FOUND');
  assert.equal(missingB.status, 404, 'SP-104: несуществующая группа на вложенном пути обязана давать 404');
  assertNoLeak(foreign, listL(f2), 'отказ по чужой существующей группе');

  assert.notEqual(foreign.status, missing.status,
    'SP-116 против SP-104: чужая существующая группа (403) и несуществующая (404) обязаны различаться статусом. '
    + `Здесь оба ответа — ${foreign.status}. Это безопаснее (факт существования не раскрывается) `
    + 'и прямо описано в app/README.md как решение автора, но расходится с оракулом; '
    + 'см. спорное место 1 плана C.');
  assert.equal(foreign.status, 403, 'SP-116: чужая существующая группа обязана давать 403 FORBIDDEN');
  assert.equal(foreignB.status, 403, 'SP-116: то же на вложенном пути балансов');
});

test('C-06 · SP-148,SP-147: идентификатор участника не даёт доступа, неизвестный пользователь обслуживается', async () => {
  const f2 = await F2();
  // Фактический механизм идентификации — токен. Подставляем идентификатор участника
  // чужой группы туда, где приложение ждёт токен: это и есть проверка SP-148 на факте.
  const asMember = (p) => api(app, 'GET', p, { token: f2.pB1 });

  const root = await asMember('/api/groups/' + f2.g.id);
  const act = await asMember(`/api/groups/${f2.g.id}/activity`);
  assert.ok(root.status >= 400,
    'SP-148: идентификатор участника, поданный как идентификация, не обязан давать доступ к группе');
  assertNoLeak(root, listL(f2), 'обращение по идентификатору участника');
  assertNoLeak(act, listL(f2), 'история по идентификатору участника');

  const list = await asMember('/api/groups');
  assert.equal(list.status, 200,
    'SP-147: ранее не встречавшийся идентификатор пользователя обязан обслуживаться как обычный — '
    + `у него просто нет групп; получено ${list.status}. Приложение ввело регистрацию, которой оракул не предусматривал: `
    + 'неизвестная идентификация отвергается, а не обслуживается пустым списком');
  assert.deepEqual(list.json.groups, [], 'SP-144: у неизвестного пользователя не обязано быть ни одной группы');
});

test('C-07 · SP-035,SP-144,SP-147: список групп — изоляция владельцев и новый пользователь', async () => {
  const f1 = await F1();
  const f2 = await F2();
  const carol = await newUser(app, 'Кэрол', 'carol');

  const la = await GET(f1.alice.token, '/api/groups');
  const lb = await GET(f2.bob.token, '/api/groups');
  const lc = await GET(carol.token, '/api/groups');
  assert.equal(lc.status, 200, 'SP-147: новый пользователь обязан обслуживаться, а не получать отказ');
  assert.deepEqual(lc.json.groups, [], 'SP-147: у нового пользователя групп нет');

  const namesA = la.json.groups.map((g) => g.name);
  const namesB = lb.json.groups.map((g) => g.name);
  assert.deepEqual(namesA, ['Поездка'], `SP-144: в списке владельца F1 обязана быть ровно его группа; получено ${namesA.join(', ')}`);
  assert.deepEqual(namesB, ['Дача'], `SP-144: в списке владельца F2 обязана быть ровно его группа; получено ${namesB.join(', ')}`);

  ok2xx(await POST(carol.token, '/api/groups', { name: 'Обед', currency: 'RUB' }), 'создание группы новым пользователем');
  const lc2 = await GET(carol.token, '/api/groups');
  assert.deepEqual(lc2.json.groups.map((g) => g.name), ['Обед'], 'SP-143: созданная группа обязана принадлежать создателю');
  const la2 = await GET(f1.alice.token, '/api/groups');
  assert.deepEqual(la2.json.groups.map((g) => g.name), ['Поездка'],
    'SP-144: чужая группа не обязана появляться в списке другого пользователя');
});

test('C-08 · SP-140,SP-141,SP-142,SP-115,SP-114: идентификация отсутствует, пуста, из пробелов; health', async () => {
  const f1 = await F1();

  // Фактический механизм — Authorization: Bearer. Кейс исполняется над ним.
  const noHeader = await api(app, 'GET', '/api/groups');
  const emptyBearer = await api(app, 'GET', '/api/groups', { headers: { Authorization: 'Bearer ' } });
  const spaces = await api(app, 'GET', '/api/groups', { headers: { Authorization: 'Bearer    ' } });
  const postNo = await api(app, 'POST', '/api/groups', { body: { name: 'Аноним', currency: 'RUB' } });
  const nestedNo = await api(app, 'GET', `/api/groups/${f1.g.id}/activity`);
  for (const [what, r] of [['без заголовка', noHeader], ['пустой', emptyBearer],
    ['из пробелов', spaces], ['POST без заголовка', postNo], ['вложенный путь', nestedNo]]) {
    assert.equal(r.status, 401, `SP-115: запрос ${what} обязан возвращать 401 UNAUTHORIZED, получено ${r.status}`);
    assert.equal(r.ct, 'application/json; charset=utf-8', `SP-100: ответ ${what} обязан быть JSON`);
  }

  // Контроль живучести и отсутствия побочного эффекта (SP-113).
  const alive = await GET(f1.alice.token, '/api/groups');
  assert.equal(alive.status, 200, 'SP-113: после отказов процесс обязан обслуживать корректный запрос');
  const g = await readGroup(f1.alice.token, f1.g.id);
  assert.deepEqual(memberNames(g.group), ['Аня', 'Борис', 'Виктор'],
    'состав группы не обязан меняться от анонимных запросов');

  // SP-140 и SP-114 — самостоятельные расхождения, фиксируются здесь по одному разу.
  const xUserId = await api(app, 'GET', '/api/groups', { headers: { 'X-User-Id': f1.alice.id } });
  assert.equal(xUserId.status, 200,
    'SP-140: оракул требует идентификации заголовком X-User-Id. Приложение его не обслуживает — '
    + `идентификация построена на регистрации и Bearer-токене (получено ${xUserId.status}). `
    + 'Расхождение с оракулом, фиксируется один раз; сам механизм разграничения при этом работает');
  const health = await api(app, 'GET', '/api/health');
  assert.equal(health.status, 200,
    `SP-114: GET /api/health обязан отвечать 200 без идентификации; получено ${health.status} — пути нет вовсе`);
});

test('C-09 · SP-143,SP-110: владелец фиксируется при создании и неизменяем', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const bob = await newUser(app, 'Боб', 'bob');
  const r = await POST(alice.token, '/api/groups', {
    name: 'Смена', currency: 'RUB', ownerId: bob.id, owner: bob.id, userId: bob.id,
  });
  ok2xx(r, 'создание группы с попыткой подмены владельца');
  const gs = r.json.group;
  assert.equal(gs.ownerId, alice.id,
    'SP-143,SP-110: владельцем обязан стать отправитель запроса; поля ownerId/owner/userId из тела обязаны игнорироваться');

  const lb = await GET(bob.token, '/api/groups');
  assert.deepEqual(lb.json.groups.map((g) => g.name), [],
    'SP-144: группа не обязана попадать в список пользователя, чей идентификатор был подставлен в тело');
  const la = await GET(alice.token, '/api/groups');
  assert.ok(la.json.groups.some((g) => g.id === gs.id), 'SP-143: группа обязана быть у своего создателя');

  const foreign = await readGroup(bob.token, gs.id);
  assert.ok(foreign.res.status >= 400, 'SP-116: чужому пользователю группа не обязана открываться');
  assertNoLeak(foreign.res, ['Смена'], 'отказ по группе «Смена»');
});

// ═════════════════════════════════ II. Группы ═════════════════════════════════

test('C-10 · SP-030,SP-001,SP-109: создание группы — код, поля, состав', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const r = await POST(alice.token, '/api/groups', { name: 'Поездка', currency: 'RUB' });
  assert.equal(r.ct, 'application/json; charset=utf-8', 'SP-100');
  const g = r.json && r.json.group;
  assert.ok(g, 'SP-030: создание группы обязано возвращать созданную группу');
  assert.equal(typeof g.id, 'string', 'SP-005: идентификатор обязан быть строкой');
  assert.equal(g.name, 'Поездка', 'SP-001: название');
  assert.equal(g.currency, 'RUB', 'SP-001: валюта');
  assert.equal(g.ownerId, alice.id, 'SP-001: владелец');
  assert.ok(Array.isArray(g.members), 'SP-001: список участников обязан быть массивом');
  assert.ok(g.createdAt && String(g.createdAt).length > 0, 'SP-001: момент создания обязан быть непустым');

  const back = await readGroup(alice.token, g.id);
  assert.equal(back.res.status, 200, 'SP-109: успешное чтение — 200');
  assert.equal(back.group.createdAt, g.createdAt, 'SP-001: момент создания обязан читаться тем же');

  assert.equal(r.status, 201,
    `SP-109: успешное создание обязано возвращать 201; получено ${r.status}. `
    + 'Приложение отвечает 200 на все успешные создания — расхождение с оракулом, '
    + 'вердикт по SP-109 даёт C-29');
});

test('C-11 · SP-031,SP-032,SP-033: название группы — длина, пробелы, обрезка', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const K = (await GET(alice.token, '/api/groups')).json.groups.length;
  const mk = (name) => POST(alice.token, '/api/groups', { name, currency: 'RUB' });

  ok2xx(await mk('A'), 'название из 1 символа');
  ok2xx(await mk('Ы'.repeat(60)), 'название из 60 символов');
  const trimmed = await mk('  Поездка  ');
  ok2xx(trimmed, 'название с крайними пробелами');
  assert.equal(trimmed.json.group.name, 'Поездка', 'SP-033: название обязано сохраняться без крайних пробелов');
  ok2xx(await mk('  ' + 'Ы'.repeat(59) + '  '), 'SP-031: длина считается после обрезки');

  const blank = await mk('   ');
  assert.equal(blank.status, 400, 'SP-032: название из одних пробелов обязано отклоняться');
  assertNamesReason(blank, /name|назван/i, 'название из пробелов');
  const empty = await mk('');
  assert.equal(empty.status, 400, 'SP-032: пустое название обязано отклоняться');

  const over = await mk('Ы'.repeat(61));
  assert.equal(over.status, 400,
    `SP-031: название длиннее 60 символов обязано отклоняться; получено ${over.status} — верхней границы длины нет`);
  assertNamesReason(over, /name|назван|длин/i, 'название из 61 символа');

  const after = (await GET(alice.token, '/api/groups')).json.groups;
  assert.equal(after.length, K + 4,
    `SP-031,SP-032: у пользователя обязано стать K+4 групп (правка D-38); получено ${after.length} при K=${K}`);
});

test('C-12 · SP-034,SP-104: запрос несуществующей группы', async () => {
  const f1 = await F1();
  const t = f1.alice.token;
  const missing = await GET(t, '/api/groups/grp-zzzz-0000');
  assert.equal(missing.status, 404, 'SP-034,SP-104: несуществующая группа обязана давать 404');
  assertNamesReason(missing, /групп|найден/i, 'несуществующая группа');

  const nearMiss = await GET(t, '/api/groups/' + f1.g.id + 'x');
  assert.equal(nearMiss.status, 404,
    'SP-034: идентификатор с лишним символом обязан давать 404, а не совпадать с существующим');

  // Шаг 3, правка D-14: при 200 состав списка сверяется поэлементно.
  const slash = await GET(t, '/api/groups/');
  assert.ok(!/^\s*<!DOCTYPE|<html/i.test(slash.text), 'SP-121: под /api/ обязан отдаваться JSON, а не HTML');
  if (slash.status === 200) {
    const plain = await GET(t, '/api/groups');
    assert.deepEqual(
      slash.json.groups.map((g) => g.id),
      plain.json.groups.map((g) => g.id),
      'SP-144 (правка D-14): если путь со слэшем трактуется как список групп, состав обязан совпадать с GET /api/groups поэлементно');
  } else {
    assert.equal(slash.status, 404, 'SP-121: иначе — 404 NOT_FOUND');
  }
});

test('C-13 · SP-002: валюта группы задаётся при создании и неизменяема', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const r = ok2xx(await POST(alice.token, '/api/groups', { name: 'Евро', currency: 'EUR' }), 'создание EUR-группы');
  const g = r.json.group;
  assert.equal(g.currency, 'EUR', 'SP-002: валюта обязана задаваться при создании');

  // Путь изменения группы по фактическому контракту — PATCH (С-C1).
  const patched = await api(app, 'PATCH', '/api/groups/' + g.id, {
    token: alice.token, body: { name: 'Евро', currency: 'RUB' },
  });
  const after1 = await readGroup(alice.token, g.id);
  assert.equal(after1.group.currency, 'EUR',
    `SP-002: валюта группы обязана быть неизменяемой после создания; PATCH вернул ${patched.status} и валюта стала ${after1.group.currency}`);

  // Лишнее поле в теле добавления участника обязано игнорироваться (SP-110).
  ok2xx(await POST(alice.token, `/api/groups/${g.id}/members`, { email: boris.email, currency: 'RUB' }),
    'добавление участника с лишним полем currency');
  const after2 = await readGroup(alice.token, g.id);
  assert.equal(after2.group.currency, 'EUR', 'SP-110: поле currency в чужом теле обязано игнорироваться');

  // Пути PUT /api/groups/{gid} в таблице SP-120 нет.
  const put = await api(app, 'PUT', '/api/groups/' + g.id, { token: alice.token, body: { name: 'Х' } });
  assert.ok(put.status === 405 || put.status === 404,
    `SP-107/SP-121: путь вне таблицы обязан давать 405 либо 404; получено ${put.status}`);
});

// ═══════════════════════════════ III. Участники ═══════════════════════════════

test('C-14 · SP-040,SP-003,SP-005,SP-006: добавление участников — ответ, порядок, идентификаторы', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const viktor = await newUser(app, 'Виктор', 'viktor');
  const g0 = ok2xx(await POST(alice.token, '/api/groups', { name: 'Состав', currency: 'RUB' }), 'группа').json.group;

  const r1 = await POST(alice.token, `/api/groups/${g0.id}/members`, { email: boris.email });
  const r2 = await POST(alice.token, `/api/groups/${g0.id}/members`, { email: viktor.email });
  ok2xx(r1, 'добавление Бориса'); ok2xx(r2, 'добавление Виктора');

  const g = (await readGroup(alice.token, g0.id)).group;
  const ids = memberIds(g);
  assert.equal(new Set(ids).size, ids.length, 'SP-005: идентификаторы участников обязаны быть попарно различны');
  assert.ok(!ids.includes(g.id), 'SP-005: идентификатор участника не обязан совпадать с идентификатором группы');
  ids.forEach((id) => assert.equal(typeof id, 'string', 'SP-005: идентификатор обязан быть строкой'));
  assert.deepEqual(memberNames(g), ['Аня', 'Борис', 'Виктор'],
    'SP-006: порядок участников обязан совпадать с порядком добавления');

  // Расход, где плательщик — третий участник, порядок менять не обязан.
  ok2xx(await addExpense(app, alice.token, g.id, {
    payerId: ids[2], amount: '300.00', currency: 'RUB', category: CAT,
    description: 'Бензин', splitType: 'equal', participants: ids,
  }), 'расход с третьим плательщиком');
  const g2 = (await readGroup(alice.token, g0.id)).group;
  assert.deepEqual(memberNames(g2), ['Аня', 'Борис', 'Виктор'],
    'SP-006: добавление расхода не обязано менять порядок участников');

  assert.equal(r1.status, 201, `SP-109: добавление участника — успешное создание, обязан быть 201; получено ${r1.status}`);
});

test('C-15 · SP-041: длина имени участника — границы 1 и 40', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = await newGroup(app, alice, 'Имена', 'RUB', []);
  // Имя участника у этого приложения приходит из учётной записи (С-C1),
  // поэтому граница проверяется там, где имя вводится, — при регистрации.
  const reg = (name) => api(app, 'POST', '/api/auth/register', {
    body: { name, email: `len-${Math.random().toString(36).slice(2, 10)}@qa.local`, password: 'passw0rd-qa-123' },
  });

  ok2xx(await reg('Я'), 'имя из 1 символа');
  ok2xx(await reg('Ю'.repeat(40)), 'имя ровно из 40 символов');
  const trimmed = await reg('  ' + 'Щ'.repeat(39) + '  ');
  ok2xx(trimmed, 'имя с крайними пробелами');
  assert.equal(trimmed.json.user.name, 'Щ'.repeat(39),
    'SP-041: имя обязано сохраняться с отброшенными крайними пробелами');

  const blank = await reg('   ');
  assert.equal(blank.status, 400, 'SP-041: имя из одних пробелов обязано отклоняться (после обрезки длина 0)');
  const over = await reg('Э'.repeat(41));
  assert.equal(over.status, 400,
    `SP-041: имя длиннее 40 символов обязано отклоняться; получено ${over.status} — верхней границы длины имени нет`);
  assertNamesReason(over, /name|имя|длин/i, 'имя из 41 символа');
  assert.ok(g.id, 'группа фикстуры создана');
});

test('C-16 · SP-042: уникальность имён участников БЕЗ УЧЁТА РЕГИСТРА', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = await newGroup(app, alice, 'Регистр', 'RUB', []);
  const lower = await newUser(app, 'аня', 'l');
  const upper = await newUser(app, 'АНЯ', 'u');
  const mixed = await newUser(app, 'аНя', 'm');
  const other = await newUser(app, 'Аnya', 'o');

  const add = (u) => POST(alice.token, `/api/groups/${g.id}/members`, { email: u.email });
  const rl = await add(lower);
  const ru = await add(upper);
  const rm = await add(mixed);
  const ro = await add(other);

  ok2xx(ro, 'SP-042: другое имя обязано добавляться — сравнение не обязано быть слишком грубым');

  const g2 = (await readGroup(alice.token, g.id)).group;
  const statuses = [rl.status, ru.status, rm.status];
  assert.ok(statuses.every((s) => s === 409 || s === 400),
    'SP-042: имена участников обязаны быть уникальны в пределах группы без учёта регистра; '
    + `«аня», «АНЯ», «аНя» при уже существующей «Аня» дали ${statuses.join(', ')} — все приняты. `
    + 'Приложение проверяет уникальность по email учётной записи, а не по имени');
  assert.deepEqual(memberNames(g2), ['Аня', 'Аnya'],
    `SP-042: в группе обязаны остаться ровно два участника; фактический состав: ${memberNames(g2).join(', ')}`);
});

test('C-17 · SP-042,SP-041: уникальность имён БЕЗ УЧЁТА КРАЙНИХ ПРОБЕЛОВ', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = await newGroup(app, alice, 'Пробелы', 'RUB', []);
  const pad = await newUser(app, ' Аня ', 'p');
  const tail = await newUser(app, 'Аня ', 't');
  const both = await newUser(app, '   аня   ', 'b');
  const inner = await newUser(app, 'Аня Б', 'i');

  const add = (u) => POST(alice.token, `/api/groups/${g.id}/members`, { email: u.email });
  const r1 = await add(pad);
  const r2 = await add(tail);
  const r3 = await add(both);
  ok2xx(await add(inner), 'SP-042: внутренний пробел делает имя другим — отказ здесь был бы провалом');

  const g2 = (await readGroup(alice.token, g.id)).group;
  const names = memberNames(g2);
  assert.ok(!names.some((n) => n !== n.trim()),
    `SP-041: имя обязано храниться без крайних пробелов; в составе есть имена с пробелами: ${JSON.stringify(names)}`);
  const statuses = [r1.status, r2.status, r3.status];
  assert.ok(statuses.every((s) => s === 409 || s === 400),
    'SP-042: имена, различающиеся только крайними пробелами и регистром, обязаны отвергаться как занятые; '
    + `получено ${statuses.join(', ')}`);
  assert.deepEqual(names, ['Аня', 'Аня Б'], `SP-042: ожидался состав «Аня», «Аня Б»; получено ${names.join(', ')}`);
});

test('C-18 · SP-043: предел в 20 участников', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = await newGroup(app, alice, 'Двадцать', 'RUB', []);
  // Владелец уже в составе, поэтому добавляем ещё девятнадцать до предела в 20.
  const added = [];
  for (let i = 2; i <= 20; i++) {
    const u = await newUser(app, 'P' + String(i).padStart(2, '0'), 'p' + i);
    ok2xx(await POST(alice.token, `/api/groups/${g.id}/members`, { email: u.email }), `участник ${i}`);
    added.push(u);
  }
  const g20 = (await readGroup(alice.token, g.id)).group;
  assert.equal(members(g20).length, 20, 'SP-043: группа обязана вмещать ровно 20 участников');

  const extra = await newUser(app, 'P21', 'p21');
  const over = await POST(alice.token, `/api/groups/${g.id}/members`, { email: extra.email });
  const gAfter = (await readGroup(alice.token, g.id)).group;
  assert.ok(over.status === 409 || over.status === 400,
    `SP-043: добавление двадцать первого участника обязано быть ошибкой; получено ${over.status} — предела нет`);
  assert.equal(members(gAfter).length, 20, 'SP-043: после отказа в группе обязано остаться 20 участников');

  // Освобождение места обязано снова разрешать добавление.
  const last = added[added.length - 1];
  ok2xx(await DEL(alice.token, `/api/groups/${g.id}/members/${last.id}`), 'удаление свободного участника');
  ok2xx(await POST(alice.token, `/api/groups/${g.id}/members`, { email: extra.email }),
    'SP-043: после освобождения места добавление обязано проходить — учитываются текущие, а не когда-либо созданные');
});

test('C-19 · SP-044,SP-109,SP-047: удаление свободного участника', async () => {
  const f1 = await F1(app, { withSettlement: false });
  const galya = await newUser(app, 'Галя', 'galya');
  ok2xx(await POST(f1.alice.token, `/api/groups/${f1.g.id}/members`, { email: galya.email }), 'добавление Гали');

  const del = await DEL(f1.alice.token, `/api/groups/${f1.g.id}/members/${galya.id}`);
  const g = (await readGroup(f1.alice.token, f1.g.id)).group;
  assert.deepEqual(memberNames(g), ['Аня', 'Борис', 'Виктор'],
    'SP-006: порядок оставшихся участников не обязан меняться после удаления');

  const again = await DEL(f1.alice.token, `/api/groups/${f1.g.id}/members/${galya.id}`);
  assert.equal(again.status, 404, 'SP-047: повторное удаление обязано давать 404 NOT_FOUND');

  const exps = await GET(f1.alice.token, `/api/groups/${f1.g.id}/expenses`);
  assert.equal(exps.json.expenses.length, 1, 'удаление свободного участника не обязано трогать расходы');
  assert.equal(money(exps.json.expenses[0], 'amount').minor, 30000, 'сумма расхода не обязана меняться');

  // Правка D-07: участник, освободившийся после удаления расхода, обязан удаляться.
  ok2xx(await DEL(f1.alice.token, `/api/groups/${f1.g.id}/expenses/${f1.e.id}`), 'SP-057: удаление расхода');
  const freed = await DEL(f1.alice.token, `/api/groups/${f1.g.id}/members/${f1.p2}`);
  assert.ok(freed.status >= 200 && freed.status < 300,
    'SP-044 (правка D-07): условие сформулировано как состояние, а не как история — '
    + `после удаления единственного расхода участник обязан удаляться; получено ${freed.status}`);

  assert.equal(del.status, 204,
    `SP-109: успешное удаление обязано возвращать 204 с пустым телом; получено ${del.status}`);
  assert.equal(del.text, '', 'SP-109: тело ответа на удаление обязано быть пустым');
});

test('C-20 · SP-045,SP-105: удаление участника с непогашенными долгами', async () => {
  const f1 = await F1(app, { withSettlement: false });
  const t = f1.alice.token;
  const d1 = await DEL(t, `/api/groups/${f1.g.id}/members/${f1.p1}`); // плательщик
  const d2 = await DEL(t, `/api/groups/${f1.g.id}/members/${f1.p2}`); // должник
  const d3 = await DEL(t, `/api/groups/${f1.g.id}/members/${f1.p3}`); // должник

  const g = (await readGroup(t, f1.g.id)).group;
  assert.deepEqual(memberNames(g), ['Аня', 'Борис', 'Виктор'],
    'SP-045: участник с непогашенным долгом не обязан удаляться — состав обязан остаться прежним');
  const exps = await GET(t, `/api/groups/${f1.g.id}/expenses`);
  const e = exps.json.expenses[0];
  assert.equal(money(e, 'amount').minor, 30000, 'SP-045: расход обязан остаться целым');
  assert.equal((e.shares || []).length, 3,
    'SP-045: состав распределения не обязан молча терять участника');

  const galya = await newUser(app, 'Галя', 'galya');
  ok2xx(await POST(t, `/api/groups/${f1.g.id}/members`, { email: galya.email }),
    'SP-113: процесс обязан обслуживать корректные запросы после отказов');

  const statuses = [d1.status, d2.status, d3.status];
  assert.deepEqual(statuses, [409, 409, 409],
    `SP-045,SP-105: конфликт состояния обязан возвращать 409 CONFLICT; получено ${statuses.join(', ')}`);
  assertNamesReason(d2, /баланс|долг|расход|рассчит|участ/i, 'удаление должника');
});

test('C-21 · SP-045,SP-044: удаление участника — стороны погашения', async () => {
  const f1 = await F1(); // с погашением Борис → Аня на 100.00
  const t = f1.alice.token;
  const galya = await newUser(app, 'Галя', 'galya');
  ok2xx(await POST(t, `/api/groups/${f1.g.id}/members`, { email: galya.email }), 'добавление свободной Гали');

  const dFrom = await DEL(t, `/api/groups/${f1.g.id}/members/${f1.p2}`); // отправитель погашения
  const dTo = await DEL(t, `/api/groups/${f1.g.id}/members/${f1.p1}`);   // получатель погашения
  const dFree = await DEL(t, `/api/groups/${f1.g.id}/members/${galya.id}`);

  assert.ok(dFree.status >= 200 && dFree.status < 300,
    'контроль: свободный участник обязан удаляться, иначе отказы выше ничего не доказывают');
  const g = (await readGroup(t, f1.g.id)).group;
  assert.deepEqual(memberNames(g), ['Аня', 'Борис', 'Виктор'],
    'SP-045 (редакция 1.1): стороны проведённого погашения не обязаны удаляться');

  const act = await activityOf(t, f1.g.id);
  assert.ok(act.list.some((x) => /Борис/.test(x.text || '') && /Аня/.test(x.text || '')),
    'SP-180: запись погашения обязана остаться в истории');

  const statuses = [dFrom.status, dTo.status];
  assert.deepEqual(statuses, [409, 409],
    `SP-045,SP-105: отказ по сторонам погашения обязан быть 409 CONFLICT; получено ${statuses.join(', ')}`);
});

test('C-22 · SP-046,SP-047,SP-104: «не найдено» на несуществующем участнике и группе', async () => {
  const f1 = await F1();
  const f2 = await F2();
  const t = f1.alice.token;
  const dima = await newUser(app, 'Дима', 'dima');
  const g1b = await newGroup(app, f1.alice, 'Вторая', 'RUB', [dima]);

  const addToMissing = await POST(t, '/api/groups/grp-zzzz-0000/members', { email: dima.email });
  assert.equal(addToMissing.status, 404, 'SP-046: добавление участника в несуществующую группу обязано давать 404');

  const delMissing = await DEL(t, `/api/groups/${f1.g.id}/members/prt-zzzz-0000`);
  assert.equal(delMissing.status, 404, 'SP-047: удаление несуществующего участника обязано давать 404');

  const delOther = await DEL(t, `/api/groups/${f1.g.id}/members/${dima.id}`);
  assert.equal(delOther.status, 404,
    'SP-003: участник принадлежит ровно одной группе — удаление по чужой группе того же пользователя обязано давать 404');

  const delForeign = await DEL(t, `/api/groups/${f1.g.id}/members/${f2.pB1}`);
  assert.ok(delForeign.status === 404 || delForeign.status === 403,
    `SP-047,SP-116: удаление участника чужой группы обязано отвергаться; получено ${delForeign.status}`);
  assertNoLeak(delForeign, listL(f2), 'удаление участника чужой группы');

  const g1bAfter = (await readGroup(t, g1b.id)).group;
  assert.ok(memberNames(g1bAfter).includes('Дима'), 'участник другой группы обязан остаться на месте');
});

// ═══════════════════════════ IV. Краевые составы группы ═══════════════════════════

test('C-23 · SP-030,SP-083,SP-180: группа без расходов — пустые списки, а не отказы', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = ok2xx(await POST(alice.token, '/api/groups', { name: 'Пустая', currency: 'RUB' }), 'пустая группа').json.group;
  const t = alice.token;

  // Состав группы без участников недостижим: приложение добавляет владельца само.
  assert.equal(members(g).length, 1,
    'наблюдение по С-C1: группа не бывает пустой — владелец включается в состав приложением');

  const parts = await GET(t, `/api/groups/${g.id}/participants`);
  assert.ok(parts.status === 404 || parts.status === 405,
    `SP-120,SP-121 (правка D-13): пути /participants в таблице нет, ожидается 404 либо 405; получено ${parts.status}`);

  const exps = await GET(t, `/api/groups/${g.id}/expenses`);
  assert.equal(exps.status, 200, 'SP-121: список расходов пустой группы обязан читаться');
  assert.deepEqual(exps.json.expenses, [], 'расходов нет — обязан быть пустой список');

  const bal = await balancesOf(t, g.id);
  assert.equal(bal.res.status, 200, 'SP-082: балансы обязаны читаться и на пустой группе');

  const act = await activityOf(t, g.id);
  assert.equal(act.res.status, 200, 'SP-180: история обязана читаться и на пустой группе');
  assert.deepEqual(act.list, [],
    'SP-180: история — это расходы и погашения в одном списке. На группе без расходов и погашений она обязана быть пуста; '
    + `фактически в ней ${act.list.length} записи вида ${JSON.stringify((act.list[0] || {}).type)} — `
    + 'приложение ведёт журнал действий пользователя, а не историю операций');
});

test('C-24 · SP-082,SP-083,SP-095: группа из одного участника — нули, а не пустой список', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const g = ok2xx(await POST(alice.token, '/api/groups', { name: 'Одна', currency: 'RUB' }), 'группа').json.group;
  const t = alice.token;
  const s1 = memberIds(g)[0];

  const before = await balancesOf(t, g.id);
  assert.equal(before.res.status, 200, 'SP-082: балансы обязаны читаться до расходов');

  ok2xx(await addExpense(app, t, g.id, {
    payerId: s1, amount: '50.00', currency: 'RUB', category: CAT,
    description: 'Кофе', splitType: 'equal', participants: [s1],
  }), 'расход 50.00 на одного');

  const after = await balancesOf(t, g.id);
  assert.ok(Array.isArray(after.rows) && after.rows.length === 1,
    `SP-083: нулевые балансы обязаны возвращаться ДЛЯ ВСЕХ участников, а не пустым списком; получено ${JSON.stringify(after.blocks)}`);
  assert.equal(after.rows[0].userId, s1, 'SP-082: список балансов — по участникам');
  assert.equal(money(after.rows[0], 'balance').minor, 0,
    'SP-083: единственный участник заплатил 50.00 и ему начислено 50.00 — баланс обязан быть нулевым');
  assert.deepEqual(after.debts, [], 'SP-095: долга самому себе быть не обязано');

  const act = await activityOf(t, g.id);
  const spent = act.list.filter((x) => /расход/i.test(x.text || '') || /expense/.test(x.type || ''));
  assert.equal(spent.length, 1, 'SP-181: расход обязан быть в истории ровно одной записью');
});

// ══════════════════════════════ V. Протокол и ошибки ══════════════════════════════

test('C-25 · SP-100,SP-101,SP-102,SP-108: форма ответа и тело ошибки (единственная проверка формы)', async () => {
  const f1 = await F1();
  const t = f1.alice.token;

  const health = await api(app, 'GET', '/api/health');
  const list = await GET(t, '/api/groups');
  const noName = await POST(t, '/api/groups', { currency: 'RUB' });
  const missing = await GET(t, '/api/groups/grp-zzzz-0000');
  const dupMember = await POST(t, `/api/groups/${f1.g.id}/members`, { email: f1.boris.email });

  for (const [what, r] of [['список групп', list], ['без названия', noName],
    ['несуществующая группа', missing], ['повторный участник', dupMember]]) {
    assert.equal(r.ct, 'application/json; charset=utf-8', `SP-100: ${what} — Content-Type обязан быть application/json; charset=utf-8`);
  }

  assert.equal(noName.status, 400, 'SP-103: ошибка проверки данных обязана давать 400');
  assert.equal(missing.status, 404, 'SP-104: отсутствующая сущность обязана давать 404');
  assertNamesReason(noName, /name|назван/i, 'создание без названия');
  assertNamesReason(missing, /групп|найден/i, 'несуществующая группа');
  assertNamesReason(dupMember, /групп|занят|уже/i, 'повторное добавление участника');

  const shape = (r) => r.json && typeof r.json.error === 'object' && r.json.error !== null
    && typeof r.json.error.code === 'string' && typeof r.json.error.message === 'string';
  const CODES = ['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'MALFORMED_JSON',
    'METHOD_NOT_ALLOWED', 'UNAUTHORIZED', 'FORBIDDEN'];

  const bad = [['без названия', noName], ['несуществующая группа', missing], ['повторный участник', dupMember]]
    .filter(([, r]) => !shape(r)).map(([w, r]) => `${w}: ${r.text.slice(0, 80)}`);
  assert.deepEqual(bad, [],
    'SP-101: тело ошибки обязано иметь вид {"error":{"code":"...","message":"..."}}. '
    + 'Приложение отвечает плоским {"error":"текст"} — кода ошибки нет вовсе. '
    + 'Это ОДНО расхождение, и по соглашению С-C2 оно фиксируется здесь один раз, '
    + 'а не красит собой каждый кейс зоны');
  const codes = [noName, missing, dupMember].map((r) => r.json.error.code);
  assert.ok(codes.every((c) => CODES.includes(c)), `SP-102: коды обязаны быть из набора; получено ${codes.join(', ')}`);
  assert.equal(health.status, 200, 'SP-114: health обязан отвечать 200');
});

test('C-26 · SP-106,SP-113: некорректный JSON и живучесть процесса', async () => {
  const f1 = await F1();
  const t = f1.alice.token;
  const raw = (p, body) => api(app, 'POST', p, { token: t, rawBody: body });

  const cut = await raw('/api/groups', '{"name":');
  const notJson = await raw('/api/groups', 'не json вовсе');
  const alive1 = await GET(t, '/api/groups');
  assert.equal(alive1.status, 200, 'SP-113: после битого тела процесс обязан обслуживать корректный запрос');

  const arr = await raw(`/api/groups/${f1.g.id}/members`, '[1,2,3]');
  const galya = await newUser(app, 'Галя', 'galya');
  const alive2 = await POST(t, `/api/groups/${f1.g.id}/members`, { email: galya.email });
  ok2xx(alive2, 'SP-113: процесс обязан обслуживать запись после некорректного тела');

  const empty = await raw('/api/groups', '');
  const g = (await readGroup(t, f1.g.id)).group;
  assert.deepEqual(memberNames(g), ['Аня', 'Борис', 'Виктор', 'Галя'],
    'SP-113: состав группы обязан быть предсказуемым после серии некорректных запросов');

  for (const [what, r] of [['оборванный JSON', cut], ['не JSON вовсе', notJson],
    ['массив вместо объекта', arr], ['пустое тело', empty]]) {
    assert.equal(r.status, 400, `SP-106,SP-112: ${what} обязан давать 400, получено ${r.status}`);
    assert.ok(r.status !== 500, `SP-106: ${what} не обязан приводить к 500`);
  }
  assert.match(msgOf(cut), /JSON/i, 'SP-106: сообщение обязано называть причину — тело не является корректным JSON');
});

test('C-27 · SP-107,SP-120: неподдерживаемый метод на существующем пути', async () => {
  const f1 = await F1();
  const t = f1.alice.token;
  const calls = {
    'DELETE /api/groups': await DEL(t, '/api/groups'),
    'PUT /api/groups': await api(app, 'PUT', '/api/groups', { token: t, body: { name: 'Х' } }),
    'POST /api/health': await api(app, 'POST', '/api/health', { body: {} }),
    'POST .../balances': await POST(t, `/api/groups/${f1.g.id}/balances`, {}),
    'GET .../settlements': await GET(t, `/api/groups/${f1.g.id}/settlements`),
  };
  const del = await DEL(t, '/api/groups/' + f1.g.id);

  const g = await readGroup(t, f1.g.id);
  assert.equal(g.res.status, 200,
    `SP-120: DELETE /api/groups/{gid} в таблице путей отсутствует — группа не обязана удаляться этим методом (ответ ${del.status})`);
  assert.deepEqual(memberNames(g.group), ['Аня', 'Борис', 'Виктор'], 'SP-113: группа обязана остаться целой');

  const wrong = Object.entries(calls).filter(([, r]) => r.status !== 405)
    .map(([k, r]) => `${k} → ${r.status}`);
  assert.deepEqual(wrong, [],
    'SP-107: обращение к существующему пути неподдерживаемым методом обязано возвращать 405 METHOD_NOT_ALLOWED. '
    + 'Приложение отвечает 404 «Метод API не найден»: маршрутизация не различает «путь есть, метод не тот» '
    + 'и «пути нет»');
});

test('C-28 · SP-110,SP-111,SP-112: неизвестные поля, отсутствующие поля, неверные типы', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const g = await newGroup(app, alice, 'Типы', 'RUB', []);
  const t = alice.token;

  const extra = await POST(t, '/api/groups', {
    name: 'Лишние', currency: 'RUB', color: 'red', id: 'мой-id',
    createdAt: '2020-01-01', members: [{ name: 'Взлом' }],
  });
  ok2xx(extra, 'SP-110: неизвестные поля обязаны игнорироваться, а не приводить к отказу');
  const gx = extra.json.group;
  assert.notEqual(gx.id, 'мой-id', 'SP-005,SP-110: идентификатор из тела обязан игнорироваться');
  assert.notEqual(String(gx.createdAt).slice(0, 10), '2020-01-01', 'SP-110: момент создания из тела обязан игнорироваться');
  assert.deepEqual(memberNames(gx), ['Аня'], 'SP-110: состав участников из тела обязан игнорироваться');

  const noName = await POST(t, '/api/groups', {});
  const alive1 = await GET(t, '/api/groups');
  const numName = await POST(t, `/api/groups/${g.id}/members`, { email: 42 });
  const alive2 = await POST(t, `/api/groups/${g.id}/members`, { email: boris.email });
  const arrName = await POST(t, `/api/groups/${g.id}/members`, { email: ['x@qa.local'] });
  const nullName = await POST(t, '/api/groups', { name: null, currency: 'RUB' });

  for (const [what, r] of [['без обязательного поля', noName], ['число вместо строки', numName],
    ['массив вместо строки', arrName], ['null вместо строки', nullName]]) {
    assert.equal(r.status, 400, `SP-111,SP-112: ${what} обязано давать 400 VALIDATION_ERROR, получено ${r.status}`);
    assertNamesReason(r, /name|email|назван|поле|строк/i, what);
  }
  assert.equal(alive1.status, 200, 'SP-113: процесс жив');
  ok2xx(alive2, 'SP-113: процесс обслуживает запись');
  const gAfter = (await readGroup(t, g.id)).group;
  assert.deepEqual(memberNames(gAfter), ['Аня', 'Борис'], 'SP-112: участники с некорректными значениями не обязаны создаваться');
});

test('C-29 · SP-109: коды успешных ответов 201 / 200 / 204 (вердикт по SP-109)', async () => {
  const user = await newUser(app, 'Коды', 'codes');
  const other = await newUser(app, 'Другой', 'other');
  const t = user.token;

  const create = await POST(t, '/api/groups', { name: 'Коды', currency: 'RUB' });
  const gid = create.json.group.id;
  const list = await GET(t, '/api/groups');
  const one = await GET(t, '/api/groups/' + gid);
  const addMember = await POST(t, `/api/groups/${gid}/members`, { email: other.email });
  const bal = await GET(t, `/api/groups/${gid}/balances`);
  const act = await GET(t, `/api/groups/${gid}/activity`);
  const del = await DEL(t, `/api/groups/${gid}/members/${other.id}`);

  assert.deepEqual([list.status, one.status, bal.status, act.status], [200, 200, 200, 200],
    'SP-109: успешное чтение обязано возвращать 200');
  for (const r of [list, one, bal, act, create, addMember]) {
    assert.equal(r.ct, 'application/json; charset=utf-8', 'SP-100: у ответов 200/201 обязан быть JSON Content-Type');
  }
  // Правка D-11: у ответов 204 Content-Type не проверяется (объявленное сужение, Н-3-Б).

  assert.deepEqual([create.status, addMember.status], [201, 201],
    `SP-109: успешное создание обязано возвращать 201; получено ${create.status} и ${addMember.status} — `
    + 'приложение отвечает 200 на все создания');
  assert.equal(del.status, 204, `SP-109: успешное удаление обязано возвращать 204; получено ${del.status}`);
  assert.equal(del.text, '', 'SP-109: тело ответа на удаление обязано быть пустым');
});

test('C-30 · SP-121: неизвестный путь под /api/ — JSON, а не HTML', async () => {
  const f1 = await F1();
  const t = f1.alice.token;
  const paths = [
    '/api/nonexistent',
    `/api/groups/${f1.g.id}/unknown`,
    `/api/groups/${f1.g.id}/expenses/${f1.e.id}/extra`,
    '/api/api/groups',
    '/api/',
  ];
  for (const p of paths) {
    const r = await GET(t, p);
    assert.equal(r.status, 404, `SP-121,SP-104: неизвестный путь ${p} обязан давать 404; получено ${r.status}`);
    assert.equal(r.ct, 'application/json; charset=utf-8', `SP-100: ${p} обязан отвечать JSON`);
    assert.doesNotMatch(r.text, /^\s*<!DOCTYPE|<html/i, `SP-121: ${p} отдал HTML вместо ответа API`);
  }
});

test('C-31 · SP-120: таблица путей отвечает целиком', async () => {
  const f1 = await F1(); // включая погашение Борис → Аня на 100.00
  const t = f1.alice.token;
  const galya = await newUser(app, 'Галя', 'galya');
  const gid = f1.g.id;

  const exp2 = await addExpense(app, t, gid, {
    payerId: f1.p1, amount: '10.00', currency: 'RUB', category: 'Прочее',
    description: 'второй', splitType: 'equal', participants: [f1.p1, f1.p2],
  });
  const e2 = exp2.json && exp2.json.expense;

  const rows = [
    ['GET /api/health', await api(app, 'GET', '/api/health')],
    ['POST /api/groups', await POST(t, '/api/groups', { name: 'Пути', currency: 'RUB' })],
    ['GET /api/groups', await GET(t, '/api/groups')],
    ['GET /api/groups/{gid}', await GET(t, '/api/groups/' + gid)],
    ['POST /api/groups/{gid}/participants', await POST(t, `/api/groups/${gid}/participants`, { name: 'Галя' })],
    ['POST .../members (фактический путь)', await POST(t, `/api/groups/${gid}/members`, { email: galya.email })],
    ['DELETE /api/groups/{gid}/participants/{pid}', await DEL(t, `/api/groups/${gid}/participants/${galya.id}`)],
    ['DELETE .../members/{id} (фактический путь)', await DEL(t, `/api/groups/${gid}/members/${galya.id}`)],
    ['POST /api/groups/{gid}/expenses', exp2],
    ['GET /api/groups/{gid}/expenses', await GET(t, `/api/groups/${gid}/expenses`)],
    ['PUT /api/groups/{gid}/expenses/{eid}', await api(app, 'PUT', `/api/groups/${gid}/expenses/${e2.id}`, {
      token: t,
      body: {
        payerId: f1.p1, amount: '12.00', currency: 'RUB', category: 'Прочее',
        description: 'второй', splitType: 'equal', participants: [f1.p1, f1.p2],
      },
    })],
    ['DELETE /api/groups/{gid}/expenses/{eid}', await DEL(t, `/api/groups/${gid}/expenses/${e2.id}`)],
    ['GET /api/groups/{gid}/balances', await GET(t, `/api/groups/${gid}/balances`)],
    ['GET /api/groups/{gid}/debts', await GET(t, `/api/groups/${gid}/debts`)],
    ['POST /api/groups/{gid}/debts/{from}/{to}/pay', await POST(t, `/api/groups/${gid}/debts/${f1.p3}/${f1.p1}/pay`, {})],
    ['POST .../settlements (фактический путь)', await settle(t, gid, f1.p3, f1.p1, '100.00')],
    ['GET /api/groups/{gid}/transactions', await GET(t, `/api/groups/${gid}/transactions`)],
    ['GET .../activity (фактический путь)', await GET(t, `/api/groups/${gid}/activity`)],
  ];

  const root = await api(app, 'GET', '/');
  assert.equal(root.status, 200, 'SP-120: GET / обязан отдавать страницу');
  assert.match(String(root.ct), /^text\/html/, 'SP-120: GET / обязан отдавать text/html');

  for (const [what, r] of rows) {
    assert.ok(r.status !== 501 && r.status < 600, `SP-113: ${what} не обязан обрывать соединение или давать 501`);
  }

  const missing = rows.filter(([what, r]) => !/фактический путь/.test(what) && r.status === 404
    && /Метод API не найден/.test(r.text)).map(([what]) => what);
  assert.deepEqual(missing, [],
    'SP-120: приложение обязано обслуживать все пути таблицы. Не обслуживаются вовсе (ни одним методом): '
    + missing.join('; ') + '. Функции при этом есть — они живут по другим путям '
    + '(участники → /members, история → /activity, отметка оплаты → /settlements, долги → поле debts[] '
    + 'внутри /balances), кроме /api/health, у которого замены нет. '
    + 'Расхождение с оракулом по именам путей плюс отсутствующая проверка живости; '
    + 'по соглашению С-C1 фиксируется здесь один раз за весь набор');
});

// ═══════════════════════ VI. Модель данных и перезапуск ═══════════════════════

test('C-32 · SP-005,SP-003: идентификаторы — строки, уникальные, не переиспользуются', async () => {
  const own = await startApp();
  try {
    const alice = await newUser(own, 'Аня', 'alice');
    const one = await newUser(own, 'Один', 'one');
    const two = await newUser(own, 'Один', 'two'); // то же имя, другая учётная запись
    const ga = await newGroup(own, alice, 'A', 'RUB', []);
    const gb = await newGroup(own, alice, 'B', 'RUB', []);
    assert.notEqual(ga.id, gb.id, 'SP-005: идентификаторы групп обязаны различаться');
    assert.equal(typeof ga.id, 'string', 'SP-005: идентификатор обязан быть строкой');

    const ra = await api(own, 'POST', `/api/groups/${ga.id}/members`, { token: alice.token, body: { email: one.email } });
    const rb = await api(own, 'POST', `/api/groups/${gb.id}/members`, { token: alice.token, body: { email: two.email } });
    ok2xx(ra, 'участник в группе A'); ok2xx(rb, 'участник в группе B');
    const pa = memberIds(ra.json.group)[1];
    const pb = memberIds(rb.json.group)[1];
    assert.notEqual(pa, pb, 'SP-003: одно и то же имя в разных группах обязано давать разных участников');

    ok2xx(await api(own, 'DELETE', `/api/groups/${ga.id}/members/${pa}`, { token: alice.token }), 'удаление участника');
    const rc = await api(own, 'POST', `/api/groups/${ga.id}/members`, { token: alice.token, body: { email: one.email } });
    ok2xx(rc, 'повторное добавление');
    const pc = memberIds(rc.json.group)[1];
    assert.notEqual(pc, pa,
      'SP-005: идентификатор удалённого участника не обязан выдаваться заново — иначе ссылки на старого участника '
      + 'начнут указывать на нового. Приложение отождествляет участника с учётной записью, '
      + 'поэтому после удаления и повторного добавления идентификатор тот же');
  } finally { await own.stop(); }
});

test('C-33 · SP-007: данные переживают перезапуск процесса, включая погашения', async () => {
  const own = await startApp();
  let app2 = null;
  try {
    const f1 = await F1(own);
    const f2 = await F2(own);
    const before1 = await api(own, 'GET', '/api/groups/' + f1.g.id, { token: f1.alice.token });
    const before2 = await api(own, 'GET', '/api/groups/' + f2.g.id, { token: f2.bob.token });
    const beforeBal = await api(own, 'GET', `/api/groups/${f1.g.id}/balances`, { token: f1.alice.token });

    app2 = await restartApp(own);

    const after1 = await api(app2, 'GET', '/api/groups/' + f1.g.id, { token: f1.alice.token });
    assert.equal(after1.status, 200, 'SP-007: группа обязана читаться после перезапуска тем же токеном');
    const g1 = after1.json.group;
    assert.equal(g1.id, f1.g.id, 'SP-007: идентификатор группы обязан сохраниться');
    assert.equal(g1.name, 'Поездка', 'SP-007: название');
    assert.equal(g1.currency, 'RUB', 'SP-007: валюта');
    assert.equal(g1.ownerId, f1.alice.id, 'SP-143: владелец обязан сохраниться');
    assert.equal(g1.createdAt, before1.json.group.createdAt, 'SP-004: момент создания не обязан меняться');
    assert.deepEqual(memberNames(g1), ['Аня', 'Борис', 'Виктор'], 'SP-006: порядок участников обязан сохраниться');
    assert.deepEqual(memberIds(g1), memberIds(before1.json.group), 'SP-005: идентификаторы участников обязаны сохраниться');

    const e = after1.json.expenses[0];
    assert.equal(e.id, f1.e.id, 'SP-007: идентификатор расхода');
    assert.equal(money(e, 'amount').minor, 30000, 'SP-007: сумма расхода');
    assert.equal(money(e, 'amount').text, '300.00', 'SP-021: сумма строкой с двумя знаками');
    assert.equal(e.currency, 'RUB', 'SP-028: валюта расхода');
    assert.equal(e.category, CAT, 'SP-004: категория');
    assert.equal(e.description, 'Бензин', 'SP-004: описание');

    assert.equal((after1.json.settlements || []).length, 1,
      'SP-007 (редакция 1.1): проведённое погашение обязано пережить перезапуск');
    const afterBal = await api(app2, 'GET', `/api/groups/${f1.g.id}/balances`, { token: f1.alice.token });
    assert.deepEqual(afterBal.json.balances, beforeBal.json.balances,
      'SP-007: балансы и долги после перезапуска обязаны совпадать с теми, что были до него');

    assert.equal(after1.json.activity.length, before1.json.activity.length,
      'SP-007,SP-180: история обязана сохраниться целиком');

    const after2 = await api(app2, 'GET', '/api/groups/' + f2.g.id, { token: f2.bob.token });
    assert.equal(after2.status, 200, 'SP-007: данные второго пользователя обязаны быть целы');
    assert.deepEqual(memberNames(after2.json.group), ['Боб', 'Женя', 'Зоя'], 'SP-007: состав чужой группы');
    assert.equal(money(after2.json.expenses[0], 'amount').minor, 15000, 'SP-007: сумма расхода второй группы');
    assert.equal((after2.json.settlements || []).length, 1, 'SP-007: погашение второй группы');

    const fresh = await api(app2, 'POST', '/api/groups', { token: f1.alice.token, body: { name: 'После', currency: 'RUB' } });
    ok2xx(fresh, 'создание группы после перезапуска');
    assert.notEqual(fresh.json.group.id, f1.g.id, 'SP-005: новый идентификатор не обязан совпадать с существующим');
  } finally {
    if (app2) await app2.stop(); else await own.stop();
  }
});

// ══════════════════════════════ VII. История операций ══════════════════════════════

test('C-34 · SP-180,SP-181: состав записи истории — расход и погашение в одном списке', async () => {
  const f1 = await F1();
  const { res, list } = await activityOf(f1.alice.token, f1.g.id);
  assert.equal(res.status, 200, 'SP-180: история обязана читаться');
  assert.equal(res.ct, 'application/json; charset=utf-8', 'SP-100');
  assert.ok(Array.isArray(list), 'SP-180: история обязана быть одним списком');

  const kinds = list.map((x) => String(x.type || ''));
  const isExpense = (x) => /^expense/.test(String(x.type || ''));
  const isSettle = (x) => /^settlement/.test(String(x.type || ''));
  assert.equal(list.filter(isExpense).length, 1, `SP-180: ровно одна запись расхода; типы записей: ${kinds.join(', ')}`);
  assert.equal(list.filter(isSettle).length, 1, `SP-180: ровно одна запись погашения; типы записей: ${kinds.join(', ')}`);

  const ex = list.find(isExpense);
  const st = list.find(isSettle);
  assert.ok(ex.createdAt && String(ex.createdAt).length > 0, 'SP-181: момент записи обязан быть непустым');

  const exMoney = money(ex, 'amount');
  const stMoney = money(st, 'amount');
  assert.equal(exMoney.minor, 30000,
    'SP-181: запись истории обязана иметь СУММУ отдельным полем. У записи есть только человекочитаемый text '
    + `(«${ex.text}»), суммы, валюты и сторон операции полями нет — запись истории неразбираема программно`);
  assert.equal(exMoney.text, '300.00', 'SP-021: сумма строкой ровно с двумя знаками');
  assert.equal(ex.currency, 'RUB', 'SP-028: валюта записи истории');
  assert.equal(stMoney.minor, 10000, 'SP-181: сумма записи погашения');
  assert.equal(st.fromUserId || st.from, f1.p2, 'SP-181: стороны погашения — направление от должника к получателю');
  assert.equal(st.toUserId || st.to, f1.p1, 'SP-181: получатель погашения');
  assert.equal(list.length, 2,
    `SP-180: история — это расходы и погашения; фактически записей ${list.length}, включая служебные (${kinds.join(', ')})`);
});

test('C-35 · SP-182,SP-056: порядок истории — от новых к старым, поимённо', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const viktor = await newUser(app, 'Виктор', 'viktor');
  const g = await newGroup(app, alice, 'Порядок', 'RUB', [boris, viktor]);
  const [h1, h2, h3] = memberIds(g);
  const t = alice.token;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const mk = (payer, amount, description) => addExpense(app, t, g.id, {
    payerId: payer, amount, currency: 'RUB', category: CAT, description,
    splitType: 'equal', participants: [h1, h2, h3],
  });
  ok2xx(await mk(h1, '30.00', 'Первый'), 'T1'); await sleep(1100);
  ok2xx(await mk(h2, '60.00', 'Второй'), 'T2'); await sleep(1100);
  // T3, правка D-19: из балансов единственная пара — {h3} → {h2} на 3000.
  ok2xx(await settle(t, g.id, h3, h2, '30.00'), 'T3: погашение Виктор → Борис'); await sleep(1100);
  ok2xx(await mk(h3, '90.00', 'Третий'), 'T4');

  const { list } = await activityOf(t, g.id);
  const ops = list.filter((x) => /^expense|^settlement/.test(String(x.type || '')));
  const label = (x) => `${x.type}:${(x.text || '').slice(0, 40)}`;
  assert.equal(ops.length, 4, `SP-180: операций обязано быть ровно четыре; получено ${ops.length}`);
  assert.match(String(ops[0].text), /Третий/, `SP-182: сверху обязана быть самая новая запись; получено ${label(ops[0])}`);
  assert.match(String(ops[1].type), /^settlement/, `SP-182: второй сверху обязана быть запись погашения; получено ${label(ops[1])}`);
  assert.match(String(ops[2].text), /Второй/, `SP-182: третьей сверху; получено ${label(ops[2])}`);
  assert.match(String(ops[3].text), /Первый/, `SP-182: снизу обязана быть самая старая запись; получено ${label(ops[3])}`);

  const exps = await GET(t, `/api/groups/${g.id}/expenses`);
  assert.deepEqual(exps.json.expenses.map((e) => e.description), ['Первый', 'Второй', 'Третий'],
    'SP-056: список расходов обязан идти от старых к новым — противоположно порядку истории');
});

test('C-36 · SP-183,SP-058: удалённый расход исчезает из истории', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const g = await newGroup(app, alice, 'Удаление', 'RUB', [boris]);
  const [d1, d2] = memberIds(g);
  const t = alice.token;
  const mk = (amount, description) => addExpense(app, t, g.id, {
    payerId: d1, amount, currency: 'RUB', category: CAT, description,
    splitType: 'equal', participants: [d1, d2],
  });
  const y1 = ok2xx(await mk('20.00', 'Раз'), 'Раз').json.expense;
  const y2 = ok2xx(await mk('40.00', 'Два'), 'Два').json.expense;
  const y3 = ok2xx(await mk('60.00', 'Три'), 'Три').json.expense;

  const before = await activityOf(t, g.id);
  const opsOf = (l) => l.filter((x) => /^expense/.test(String(x.type || '')));
  assert.equal(opsOf(before.list).length, 3, 'SP-180: до удаления в истории обязано быть три расхода');

  ok2xx(await DEL(t, `/api/groups/${g.id}/expenses/${y2.id}`), 'SP-057: удаление расхода');

  const after = await activityOf(t, g.id);
  const texts = after.list.map((x) => String(x.text || ''));
  assert.ok(!texts.some((s) => /«Два»/.test(s) || /\b40\.00\b/.test(s)),
    'SP-183: удалённый расход обязан исчезать из истории — ни записью с пометкой, ни с нулевой суммой. '
    + `В истории остались строки: ${texts.filter((s) => /Два|40\.00/.test(s)).join(' | ')}`);
  const ops = opsOf(after.list);
  assert.equal(ops.length, 2, `SP-183: после удаления в истории обязано остаться два расхода; получено ${ops.length}`);

  const again = await DEL(t, `/api/groups/${g.id}/expenses/${y2.id}`);
  assert.equal(again.status, 404, 'SP-058: повторное удаление расхода обязано давать 404 NOT_FOUND');

  const list = await GET(t, `/api/groups/${g.id}/expenses`);
  assert.deepEqual(list.json.expenses.map((e) => e.description), ['Раз', 'Три'], 'SP-056: порядок оставшихся расходов');
  assert.ok(y1.id && y3.id, 'идентификаторы расходов получены');
});

test('C-37 · SP-184,SP-110: параметры фильтрации истории игнорируются, а не отвергаются', async () => {
  const f1 = await F1();
  const t = f1.alice.token;
  const base = await activityOf(t, f1.g.id);
  const ids = (l) => l.map((x) => x.id);

  const variants = [
    ['?type=expense', await activityOf(t, f1.g.id, '?type=expense')],
    ['?category=Транспорт', await activityOf(t, f1.g.id, '?category=' + encodeURIComponent(CAT))],
    [`?participantId=${f1.p3}`, await activityOf(t, f1.g.id, `?participantId=${f1.p3}`)],
    ['?from=2020-01-01&to=2020-01-02', await activityOf(t, f1.g.id, '?from=2020-01-01&to=2020-01-02')],
    ['?unknown=да&limit=1&sort=asc', await activityOf(t, f1.g.id, '?unknown=да&limit=1&sort=asc')],
  ];
  for (const [q, r] of variants) {
    assert.equal(r.res.status, 200, `SP-184: параметр ${q} не обязан приводить к отказу; получено ${r.res.status}`);
  }
  const broken = variants.filter(([, r]) => ids(r.list).join(',') !== ids(base.list).join(','))
    .map(([q, r]) => `${q} → ${r.list.length} записей вместо ${base.list.length}`);
  assert.deepEqual(broken, [],
    'SP-184,SP-110: фильтрация истории вне рамок итерации — переданные параметры обязаны игнорироваться. '
    + 'Приложение обслуживает limit (объявлен в app/README.md): ' + broken.join('; ')
    + '. Функционально это «больше, чем просили», но оракул выносит фильтрацию за рамки');
});

test('C-38 · SP-180,SP-181,SP-182: сверка истории с балансами и долгами', async () => {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const viktor = await newUser(app, 'Виктор', 'viktor');
  const g = await newGroup(app, alice, 'Сверка', 'RUB', [boris, viktor]);
  const [r1, r2, r3] = memberIds(g);
  const t = alice.token;

  const z1 = ok2xx(await addExpense(app, t, g.id, {
    payerId: r1, amount: '300.00', currency: 'RUB', category: CAT, description: 'z1',
    splitType: 'equal', participants: [r1, r2, r3],
  }), 'расход 300.00').json.expense;
  const z2 = ok2xx(await addExpense(app, t, g.id, {
    payerId: r2, amount: '60.00', currency: 'RUB', category: CAT, description: 'z2',
    splitType: 'equal', participants: [r1, r2, r3],
  }), 'расход 60.00').json.expense;
  ok2xx(await settle(t, g.id, r3, r1, '120.00'), 'погашение Виктор → Аня на 120.00');

  const { list } = await activityOf(t, g.id);
  const exps = (await GET(t, `/api/groups/${g.id}/expenses`)).json.expenses;
  const bal = await balancesOf(t, g.id);
  const byId = new Map((bal.rows || []).map((x) => [x.userId, money(x, 'balance').minor]));

  // Сверка 3 (история ↔ балансы) — считается независимо от формы записей истории.
  assert.equal(byId.get(r1), 6000, 'Сверка 3: баланс Ани обязан быть 30000 − 12000 − 12000 = +6000');
  assert.equal(byId.get(r2), -6000, 'Сверка 3: баланс Бориса обязан быть 6000 − 12000 = −6000');
  assert.equal(byId.get(r3), 0, 'Сверка 3: баланс Виктора обязан быть 0 + 12000 − 12000 = 0');
  assert.equal([...byId.values()].reduce((a, b) => a + b, 0), 0, 'SP-081: сумма балансов обязана быть нулём');

  // Сверка 4 (история ↔ долги). Величина у записи paid — объявленная неоднозначность Н-3-А.
  const debts = bal.debts || [];
  const pending = debts.find((d) => d.from === r2 && d.to === r1);
  assert.ok(pending, `Сверка 4: пара Борис → Аня обязана присутствовать в долгах; получено ${JSON.stringify(debts)}`);
  assert.equal(money(pending, 'amount').minor, 6000, 'Сверка 4: непогашенный долг Борис → Аня обязан быть 6000');
  assert.ok(!debts.some((d) => d.from === r3 && d.to === r2), 'Сверка 4: пары Виктор → Борис быть не обязано');

  // Сверка 1 (история ↔ список расходов).
  // Порядок списка расходов (SP-056) — предмет C-35 и C-36; здесь сверяется только состав.
  assert.deepEqual([...exps.map((e) => e.id)].sort(), [z1.id, z2.id].sort(),
    'Сверка 1: список расходов обязан содержать оба расхода');
  assert.equal(exps.reduce((a, e) => a + money(e, 'amount').minor, 0), 36000, 'Сверка 1: сумма расходов 36000');
  const histExp = list.filter((x) => /^expense/.test(String(x.type || '')));
  assert.equal(histExp.length, 2, 'Сверка 1: записей расхода в истории обязано быть ровно две');
  assert.deepEqual(
    histExp.map((x) => money(x, 'amount').minor).sort((a, b) => a - b),
    [6000, 30000],
    'Сверка 1: суммы записей истории обязаны совпадать со списком расходов один в один. '
    + 'У записей истории поля суммы нет — сверить историю со сводками программно нельзя');

  // Сверка 2 (история ↔ проведённые погашения), правка D-26.
  const histSet = list.filter((x) => /^settlement/.test(String(x.type || '')));
  assert.equal(histSet.length, 1, 'Сверка 2: запись погашения обязана быть ровно одна');
  assert.equal(money(histSet[0], 'amount').minor, 12000,
    'Сверка 2: сумма записей settlement обязана равняться сумме фактически проведённых погашений — 12000');
});

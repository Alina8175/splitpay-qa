// ЗОНА A — деньги и валюта (SP-010…SP-028), расходы (SP-050…SP-059),
// способы распределения и категория (SP-060…SP-076).
// План: tests/plan-A.md, включая § XII (правки по аудиту сессии 3).
//
// Правила набора:
//  * тест, нашедший дефект, остаётся КРАСНЫМ; xfail не используется;
//  * денежные ожидания до копейки, не «примерно»;
//  * app/ не правится: находка фиксируется тестом, а не фиксом;
//  * ожидания выведены из SPEC.md, а не списаны с поведения приложения.
//
// Соглашение С-5: имена полей взяты из фактического контракта приложения,
// несовпадение имён само по себе находкой не является. Исключение —
// SP-020 и SP-028, где имена названы спекой прямо: они проверяются буквально
// и ровно один раз (тест A-20-NAMES), чтобы одно расхождение не красило
// собой сорок тестов.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, restartApp, api, newUser, newGroup, addExpense } from './_harness.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

// Категория фикстур взята из фактического набора приложения (GET /api/meta):
// в фикстурах SP-072 не проверяется, у него свои тесты A-40 и A-41.
const CAT = 'Транспорт';

/** Денежная величина по смыслу, независимо от именования (С-5). */
function money(o, base) {
  const minor = o[base + 'Minor'] !== undefined ? o[base + 'Minor'] : o[base];
  const text = o[base + 'Formatted'] !== undefined ? o[base + 'Formatted'] : o[base + 'Text'];
  return { minor, text };
}
function sharesOf(e) { return e.shares || e.split || e.splits || []; }
function shareMinor(s) { return money(s, 'amount').minor; }

/** Шаг фикстуры: любой 2xx годится, предмет проверки не здесь. */
function fixtureOk(res, what) {
  assert.ok(res.status >= 200 && res.status < 300,
    `шаг фикстуры «${what}» не прошёл: ${res.status} ${res.text.slice(0, 300)}`);
}

async function fixture3(name = 'Поездка', currency = 'RUB') {
  const a = await newUser(app, 'Аня', 'a');
  const b = await newUser(app, 'Борис', 'b');
  const v = await newUser(app, 'Вера', 'v');
  const g = await newGroup(app, a, name, currency, [b, v]);
  return { a, b, v, g, ids: g.members.map((m) => m.id) };
}

function pct(ids, values) {
  return ids.map((id, i) => ({ userId: id, participantId: id, value: values[i], percent: values[i] }));
}
function man(ids, values) {
  return ids.map((id, i) => ({ userId: id, participantId: id, value: values[i], amount: values[i] }));
}

// ───────────────────────── I. Распределение поровну ─────────────────────────

test('A-01 · SP-061,SP-062,SP-063: 100.00 на троих — копейка первому добавленному', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'Бензин',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r, 'создание расхода 100.00');
  const sh = sharesOf(r.json.expense);
  assert.equal(sh.length, 3, 'начислений должно быть ровно три');
  assert.deepEqual(sh.map(shareMinor), [3334, 3333, 3333],
    'SP-062: неделимый остаток раздаётся по одной копейке в порядке ДОБАВЛЕНИЯ участников, начиная с первого');
  assert.equal(sh.reduce((a, s) => a + shareMinor(s), 0), 10000,
    'SP-063: сумма начислений обязана в точности равняться сумме расхода');
});

test('A-02 · SP-062: тот же расход дважды даёт то же распределение', async () => {
  const f = await fixture3();
  const spec = {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'дубль',
    splitType: 'equal', participants: f.ids,
  };
  const r1 = await addExpense(app, f.a.token, f.g.id, spec);
  const r2 = await addExpense(app, f.a.token, f.g.id, spec);
  fixtureOk(r1, 'первый расход'); fixtureOk(r2, 'второй расход');
  assert.deepEqual(
    sharesOf(r2.json.expense).map(shareMinor),
    sharesOf(r1.json.expense).map(shareMinor),
    'раздача остатка обязана быть детерминированной, а не зависеть от момента');
});

test('A-03 · SP-007,SP-062: распределение переживает перезапуск процесса', async () => {
  const own = await startApp();
  try {
    const a = await newUser(own, 'Аня', 'a');
    const b = await newUser(own, 'Борис', 'b');
    const v = await newUser(own, 'Вера', 'v');
    const g = await newGroup(own, a, 'Перезапуск', 'RUB', [b, v]);
    const ids = g.members.map((m) => m.id);
    const r = await addExpense(own, a.token, g.id, {
      payerId: ids[0], amount: '100.00', category: CAT, description: 'до перезапуска',
      splitType: 'equal', participants: ids,
    });
    fixtureOk(r, 'расход до перезапуска');
    const before2 = sharesOf(r.json.expense).map(shareMinor);
    const app2 = await restartApp(own);
    try {
      const list = await api(app2, 'GET', `/api/groups/${g.id}/expenses`, { token: a.token });
      assert.equal(list.status, 200, 'SP-007: после перезапуска расходы обязаны читаться');
      const arr = list.json.expenses || list.json;
      assert.equal(arr.length, 1, 'SP-007: расход обязан пережить перезапуск');
      assert.deepEqual(sharesOf(arr[0]).map(shareMinor), before2,
        'SP-007: начисления после перезапуска обязаны быть теми же');
    } finally { await app2.stop(); }
  } finally { await own.stop(); }
});

test('A-04 · SP-062: порядок в запросе обратный порядку добавления — копейка всё равно первому добавленному', async () => {
  const f = await fixture3();
  const reversed = [...f.ids].reverse();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'обратный порядок',
    splitType: 'equal', participants: reversed,
  });
  fixtureOk(r, 'расход с обратным порядком состава');
  const byId = new Map(sharesOf(r.json.expense).map((s) => [s.userId || s.participantId, shareMinor(s)]));
  assert.equal(byId.get(f.ids[0]), 3334,
    'SP-062: остаток раздаётся по порядку добавления в группу, а не по порядку в запросе');
  assert.equal(byId.get(f.ids[1]), 3333);
  assert.equal(byId.get(f.ids[2]), 3333);
});

test('A-05 · SP-064,SP-019: одна копейка на троих → 0.01 / 0.00 / 0.00', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '0.01', category: CAT, description: 'копейка',
    splitType: 'equal', participants: f.ids,
  });
  assert.ok(r.status >= 200 && r.status < 300,
    `SP-019: минимальная сумма "0.01" обязана приниматься, получено ${r.status} ${r.text.slice(0, 200)}`);
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [1, 0, 0],
    'SP-064: расход в одну копейку на троих обязан начислить 0.01, 0.00, 0.00');
});

test('A-06 · SP-062: остаток больше единицы раздаётся по одной, а не целиком первому', async () => {
  const a = await newUser(app, 'Уч1', 'm');
  const rest = [];
  for (let i = 2; i <= 7; i++) rest.push(await newUser(app, 'Уч' + i, 'm'));
  const g = await newGroup(app, a, 'Семеро', 'RUB', rest);
  const ids = g.members.map((m) => m.id);
  assert.equal(ids.length, 7, 'фикстура: семь участников');
  const r = await addExpense(app, a.token, g.id, {
    payerId: ids[0], amount: '100.00', category: CAT, description: 'на семерых',
    splitType: 'equal', participants: ids,
  });
  fixtureOk(r, 'расход на семерых');
  // 10000 / 7 = 1428 каждому = 9996, остаток 4 копейки — первым четырём по одной.
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor),
    [1429, 1429, 1429, 1429, 1428, 1428, 1428],
    'SP-062: четыре копейки остатка раздаются ПО ОДНОЙ первым четырём, а не 1432 + 1428×6');
});

test('A-07 · SP-062: состав — подмножество группы, порядок считается по группе', async () => {
  const a = await newUser(app, 'Ася', 's');
  const b = await newUser(app, 'Боря', 's');
  const c = await newUser(app, 'Витя', 's');
  const d = await newUser(app, 'Гена', 's');
  const g = await newGroup(app, a, 'Квартира', 'RUB', [b, c, d]);
  const ids = g.members.map((m) => m.id);
  const r = await addExpense(app, a.token, g.id, {
    payerId: ids[0], amount: '100.00', category: CAT, description: 'подмножество',
    splitType: 'equal', participants: [ids[3], ids[1], ids[2]],
  });
  fixtureOk(r, 'расход на подмножество');
  const byId = new Map(sharesOf(r.json.expense).map((s) => [s.userId || s.participantId, shareMinor(s)]));
  assert.equal(byId.get(ids[1]), 3334,
    'SP-062: копейка достаётся тому, кто раньше ДОБАВЛЕН В ГРУППУ, среди входящих в состав');
  assert.equal(byId.get(ids[2]), 3333);
  assert.equal(byId.get(ids[3]), 3333);
});

// ───────────────────── II. Сумма расхода: формат и границы ─────────────────────

async function rejects(f, amount, why) {
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount, category: CAT, description: 'граница',
    splitType: 'equal', participants: f.ids,
  });
  assert.equal(r.status, 400, `${why}: ожидается 400, получено ${r.status} ${r.text.slice(0, 200)}`);
  const code = r.json && r.json.error && r.json.error.code;
  assert.equal(code, 'VALIDATION_ERROR',
    `${why}: статус 400 получен ВЕРНО, требование по сумме соблюдено. Красным тест делает форма тела ошибки: `
    + `SP-101 требует {"error":{"code","message"}}, SP-103 — код VALIDATION_ERROR; получено ${r.text.slice(0, 200)}`);
}

test('A-08 · SP-016: нулевая сумма "0" и "0.00" отклоняется', async () => {
  const f = await fixture3();
  await rejects(f, '0', 'SP-016: "0"');
  await rejects(f, '0.00', 'SP-016: "0.00"');
});

test('A-09 · SP-017: отрицательная сумма отклоняется', async () => {
  const f = await fixture3();
  await rejects(f, '-1.00', 'SP-017: "-1.00"');
});

test('A-10 · SP-012: больше двух знаков после точки отклоняется', async () => {
  const f = await fixture3();
  await rejects(f, '100.005', 'SP-012: "100.005"');
  await rejects(f, '0.001', 'SP-012: "0.001"');
});

test('A-11 · SP-013: крайние пробелы в сумме отбрасываются', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: ' 100.00 ', category: CAT, description: 'пробелы',
    splitType: 'equal', participants: f.ids,
  });
  assert.ok(r.status >= 200 && r.status < 300,
    `SP-013: " 100.00 " эквивалентно "100.00" и обязано приниматься; получено ${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(money(r.json.expense, 'amount').minor, 10000, 'SP-013: сумма обязана быть 10000 копеек');
});

test('A-12 · SP-014,SP-015,SP-112: запятая, экспонента, число вместо строки', async () => {
  const f = await fixture3();
  await rejects(f, '100,00', 'SP-014: запятая как разделитель');
  await rejects(f, '1e3', 'SP-015: экспоненциальная запись');
  await rejects(f, 100, 'SP-112: число вместо строки (SP-011 требует строку)');
});

test('A-13 · SP-018: верхняя граница суммы 10000000.00', async () => {
  const f = await fixture3();
  const okRes = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '10000000.00', category: CAT, description: 'предел',
    splitType: 'equal', participants: f.ids,
  });
  assert.ok(okRes.status >= 200 && okRes.status < 300,
    `SP-018: "10000000.00" — верхняя граница включительно, обязана приниматься; получено ${okRes.status}`);
  assert.equal(money(okRes.json.expense, 'amount').minor, 1000000000);
  await rejects(f, '10000000.01', 'SP-018: превышение предела');
});

test('A-14 · SP-021: нормализация представления — "100.5" и "1"', async () => {
  const f = await fixture3();
  const r1 = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.5', category: CAT, description: 'один знак',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r1, 'сумма "100.5"');
  assert.equal(money(r1.json.expense, 'amount').minor, 10050, 'SP-011: "100.5" — это 10050 копеек');
  assert.equal(money(r1.json.expense, 'amount').text, '100.50',
    'SP-021: строковое представление обязано содержать ровно два знака после точки всегда');
  const r2 = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '1', category: CAT, description: 'без точки',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r2, 'сумма "1"');
  assert.equal(money(r2.json.expense, 'amount').minor, 100);
  assert.equal(money(r2.json.expense, 'amount').text, '1.00',
    'SP-021: 100 копеек обязаны изображаться как "1.00", не "1" и не "1.0"');
});

test('A-15 · SP-010,SP-076: целочисленность арифметики — три ловушки плавающей точки', async () => {
  const f = await fixture3();
  for (const amount of ['0.30', '1234567.89', '10.10']) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount, category: CAT, description: 'ловушка ' + amount,
      splitType: 'equal', participants: f.ids,
    });
    fixtureOk(r, 'расход ' + amount);
    const e = r.json.expense;
    const total = money(e, 'amount').minor;
    const sum = sharesOf(e).reduce((a, s) => a + shareMinor(s), 0);
    assert.equal(sum, total,
      `SP-076: сумма начислений обязана в ТОЧНОСТИ равняться сумме расхода (${amount})`);
    for (const s of sharesOf(e)) {
      assert.equal(Number.isInteger(shareMinor(s)), true,
        `SP-010: величины обязаны быть целыми копейками, получено ${shareMinor(s)} (${amount})`);
    }
  }
});

// ───────────────────────── III. Распределение по процентам ─────────────────────────

test('A-16 · SP-068,SP-076: проценты 33/33/34 на 100.00', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'проценты',
    splitType: 'percent', splits: pct(f.ids, ['33.00', '33.00', '34.00']),
  });
  fixtureOk(r, 'расход по процентам 33/33/34');
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [3300, 3300, 3400],
    'SP-068: начисления по процентам от 100.00 — 33.00 / 33.00 / 34.00');
});

test('A-17 · SP-067: те же проценты на сумму, которая на них не делится', async () => {
  const f = await fixture3();
  // 333 копейки: 33% → 109.89 (целая 109, дробная .89); 33% → то же; 34% → 113.22 (113, .22).
  // Целых 331, остаток 2 → двум наибольшим дробным частям (.89 и .89) по порядку добавления.
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '3.33', category: CAT, description: 'наибольший остаток',
    splitType: 'percent', splits: pct(f.ids, ['33.00', '33.00', '34.00']),
  });
  fixtureOk(r, 'расход 3.33 по процентам');
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [110, 110, 113],
    'SP-067: метод наибольшего остатка — две копейки уходят участникам с дробными частями .89');
  assert.equal(sharesOf(r.json.expense).reduce((a, s) => a + shareMinor(s), 0), 333, 'SP-068');
});

test('A-18 · SP-067: остаток по наибольшей дробной части, а не первому по порядку', async () => {
  const f = await fixture3();
  // 100 копеек: 33.33% → 33 (.33); 33.33% → 33 (.33); 33.34% → 33 (.34).
  // Целых 99, остаток 1 → наибольшая дробная часть .34 у третьего.
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '1.00', category: CAT, description: 'равные дроби',
    splitType: 'percent', splits: pct(f.ids, ['33.33', '33.33', '33.34']),
  });
  fixtureOk(r, 'расход 1.00 по процентам 33.33/33.33/33.34');
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [33, 33, 34],
    'SP-067: копейка уходит участнику с наибольшей дробной частью (.34), а не первому по порядку');
});

test('A-19 · SP-067: остаток уходит не к наибольшей доле и не к крайнему участнику', async () => {
  const f = await fixture3();
  // 100 копеек: 70% → 70.00 (.00); 14.99% → 14.99 (14, .99); 15.01% → 15.01 (15, .01).
  // Целых 99, остаток 1 → наибольшая дробная часть .99 у ВТОРОГО участника.
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '1.00', category: CAT, description: 'остаток середине',
    splitType: 'percent', splits: pct(f.ids, ['70.00', '14.99', '15.01']),
  });
  fixtureOk(r, 'расход 1.00 по процентам 70/14.99/15.01');
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [70, 15, 15],
    'SP-067: копейка уходит по наибольшей ДРОБНОЙ части (.99 у второго), а не к наибольшей доле и не крайнему');
});

test('A-20 · SP-066: проценты, не дающие ровно 100.00, отклоняются', async () => {
  const f = await fixture3();
  for (const values of [['33.33', '33.33', '33.33'], ['33.34', '33.33', '33.34']]) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '100.00', category: CAT, description: 'сумма процентов',
      splitType: 'percent', splits: pct(f.ids, values),
    });
    assert.equal(r.status, 400,
      `SP-066: сумма процентов ${values.join(' + ')} ≠ 100.00; расхождение хотя бы в сотую обязано отклоняться; получено ${r.status}`);
  }
});

test('A-21 · SP-065: формат и диапазон отдельного процента — шесть отказов и один приём', async () => {
  const f = await fixture3();
  const rows = [
    [['33,33', '33.33', '33.34'], 'запятая'],
    [['33.333', '33.333', '33.334'], 'три знака после точки'],
    [['100.00', '0.00', '0.00'], 'процент ниже нижней границы "0.01"'],
    [['-10.00', '60.00', '50.00'], 'отрицательный процент при сумме ровно 100.00'],
    [[33.33, 33.33, 33.34], 'число вместо строки'],
    [['150.00', '-25.00', '-25.00'], 'значение выше верхней границы "100.00" при сумме ровно 100.00 (правка D-06)'],
  ];
  for (const [values, why] of rows) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '100.00', category: CAT, description: 'формат процента',
      splitType: 'percent', splits: pct(f.ids, values),
    });
    assert.equal(r.status, 400, `SP-065: ${why} — ожидается 400, получено ${r.status} ${r.text.slice(0, 160)}`);
  }
  const one = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'весь процент одному',
    splitType: 'percent', splits: pct([f.ids[0]], ['100.00']),
  });
  assert.ok(one.status >= 200 && one.status < 300,
    `SP-052: состав из одного участника непуст и допустим; получено ${one.status}`);
  assert.equal(sharesOf(one.json.expense).reduce((a, s) => a + shareMinor(s), 0), 10000, 'SP-068');
});

// ───────────────────────── IV. Ручное распределение ─────────────────────────

test('A-22 · SP-069,SP-071: ручное распределение, сумма частей совпадает', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'вручную',
    splitType: 'manual', splits: man(f.ids, ['50.00', '30.00', '20.00']),
  });
  fixtureOk(r, 'ручное распределение 50/30/20');
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [5000, 3000, 2000],
    'SP-069: каждому задана точная сумма, она и обязана быть начислена');
});

test('A-23 · SP-071: расхождение ручных частей в одну копейку отклоняется', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'недобор копейки',
    splitType: 'manual', splits: man(f.ids, ['50.00', '30.00', '19.99']),
  });
  assert.equal(r.status, 400,
    `SP-071: расхождение хотя бы в одну минимальную единицу обязано отклоняться; получено ${r.status}`);
});

test('A-24 · SP-070: ручной ноль допускается', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'ноль допустим',
    splitType: 'manual', splits: man(f.ids, ['100.00', '0.00', '0.00']),
  });
  assert.ok(r.status >= 200 && r.status < 300,
    `SP-070: ноль допускается; получено ${r.status} ${r.text.slice(0, 200)}`);
  assert.deepEqual(sharesOf(r.json.expense).map(shareMinor), [10000, 0, 0], 'SP-070');
});

test('A-25 · SP-070: отрицательная часть при верной общей сумме отклоняется', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'минус в части',
    splitType: 'manual', splits: man(f.ids, ['120.00', '-10.00', '-10.00']),
  });
  assert.equal(r.status, 400,
    `SP-070: отрицательная заданная сумма обязана отклоняться, даже когда общая сходится; получено ${r.status}`);
});

test('A-26 · SP-069,SP-012,SP-014: формат ручной части', async () => {
  const f = await fixture3();
  for (const values of [['50,00', '30.00', '20.00'], ['50.005', '29.995', '20.00']]) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '100.00', category: CAT, description: 'формат части',
      splitType: 'manual', splits: man(f.ids, values),
    });
    assert.equal(r.status, 400,
      `SP-069: часть задаётся в том же формате, что и сумма расхода (${values[0]}); получено ${r.status}`);
  }
});

// ───────────────────────── V. Валюта ─────────────────────────

test('A-27 · SP-026: расход в валюте, отличной от валюты группы, отклоняется', async () => {
  const f = await fixture3('Рублёвая', 'RUB');
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', currency: 'USD', category: CAT, description: 'чужая валюта',
    splitType: 'equal', participants: f.ids,
  });
  assert.equal(r.status, 400,
    `SP-026: валюта расхода обязана совпадать с валютой группы, конвертация не выполняется; получено ${r.status} ${r.text.slice(0, 200)}`);
});

test('A-28 · SP-024,SP-027: валюта по умолчанию у группы и у расхода', async () => {
  const d = await newUser(app, 'Дима', 'r');
  const e = await newUser(app, 'Егор', 'r');
  const created = await api(app, 'POST', '/api/groups', {
    token: d.token, body: { name: 'Без валюты', memberEmails: [e.email] },
  });
  fixtureOk(created, 'группа без поля валюты');
  const g = created.json.group;
  assert.equal(g.currency, 'RUB', 'SP-024: при отсутствии валюты в запросе обязана подставляться RUB');
  const ids = g.members.map((m) => m.id);
  const r = await api(app, 'POST', `/api/groups/${g.id}/expenses`, {
    token: d.token,
    body: { description: 'без валюты', amount: '10.00', category: CAT, payerId: ids[0], splitType: 'equal', participants: ids },
  });
  fixtureOk(r, 'расход без поля валюты');
  assert.equal(r.json.expense.currency, 'RUB',
    'SP-027: при отсутствии поля валюты у расхода обязана подставляться валюта группы');
});

test('A-29 · SP-022,SP-023: код валюты вне набора и в нижнем регистре', async () => {
  const u = await newUser(app, 'Кто-то', 'c');
  const gbp = await api(app, 'POST', '/api/groups', { token: u.token, body: { name: 'Фунты', currency: 'GBP' } });
  assert.equal(gbp.status, 400,
    `SP-023: код вне набора RUB/USD/EUR обязан отклоняться, включая заведомо существующие валюты; получено ${gbp.status}`);
  const low = await api(app, 'POST', '/api/groups', { token: u.token, body: { name: 'строчные', currency: 'rub' } });
  assert.equal(low.status, 400,
    `SP-022: код валюты обязан приниматься только в верхнем регистре; получено ${low.status}`);
});

test('A-30 · SP-028: код валюты сопровождает каждую денежную величину ответа', async () => {
  const f = await fixture3('Валютная', 'USD');
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', currency: 'USD', category: CAT, description: 'валюта в ответе',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r, 'расход в USD');
  const e = r.json.expense;
  assert.equal(e.currency, 'USD', 'SP-028: у суммы расхода обязан быть код валюты');
  for (const s of sharesOf(e)) {
    assert.equal(s.currency, 'USD',
      'SP-028: КАЖДАЯ денежная величина в ответах API обязана сопровождаться кодом валюты — начисления тоже');
  }
});

test('A-20-NAMES · SP-020: денежная величина в двух видах — суффиксы Minor и Formatted', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'имена полей',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r, 'расход для проверки имён');
  const e = r.json.expense;
  assert.equal(typeof e.amountMinor, 'number',
    'SP-020: сумма обязана присутствовать целым числом минимальных единиц в поле с суффиксом Minor');
  assert.equal(e.amountFormatted, '100.00',
    'SP-020: и строкой с ровно двумя знаками после точки в поле с суффиксом Formatted');
});

// ───────────────── VI. Расход: состав, участники, жизненный цикл ─────────────────

test('A-31 · SP-051: плательщик — участник другой группы', async () => {
  const f = await fixture3();
  const other = await fixture3('Чужая');
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: other.ids[1], amount: '10.00', category: CAT, description: 'чужой плательщик',
    splitType: 'equal', participants: f.ids,
  });
  assert.equal(r.status, 400,
    `SP-051: плательщик обязан быть участником той же группы; получено ${r.status} ${r.text.slice(0, 200)}`);
});

test('A-32 · SP-052: чужой участник, пустой состав, несуществующий идентификатор', async () => {
  const f = await fixture3();
  const other = await fixture3('Чужая-2');
  const cases = [
    [[f.ids[0], other.ids[1]], 'участник другой группы в составе'],
    [[], 'пустой состав распределения'],
    [['usr_нет-такого'], 'несуществующий идентификатор в составе'],
  ];
  for (const [participants, why] of cases) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '10.00', category: CAT, description: 'состав',
      splitType: 'equal', participants,
    });
    assert.equal(r.status, 400,
      `SP-052: ${why} — состав обязан быть непустым и только из участников этой группы; получено ${r.status}`);
  }
});

test('A-33 · SP-053: повтор участника в составе отклоняется', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '10.00', category: CAT, description: 'повтор',
    splitType: 'equal', participants: [f.ids[0], f.ids[1], f.ids[0]],
  });
  assert.equal(r.status, 400,
    `SP-053: повторение одного участника в составе распределения обязано отклоняться; получено ${r.status}`);
});

test('A-34 · SP-054: длина описания 140 / 141 / пустое, счёт относительный (правка D-39)', async () => {
  const f = await fixture3();
  const before2 = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  const N = (before2.json.expenses || before2.json || []).length;
  const base = { payerId: f.ids[0], amount: '10.00', category: CAT, splitType: 'equal', participants: f.ids };

  const r140 = await addExpense(app, f.a.token, f.g.id, { ...base, description: 'п'.repeat(140) });
  assert.ok(r140.status >= 200 && r140.status < 300,
    `SP-054: описание длиной ровно 140 обязано приниматься; получено ${r140.status}`);
  assert.equal(r140.json.expense.description.length, 140,
    'SP-054: описание обязано сохраняться целиком, без усечения');

  const r141 = await addExpense(app, f.a.token, f.g.id, { ...base, description: 'п'.repeat(141) });
  assert.equal(r141.status, 400, `SP-054: описание длиной 141 обязано отклоняться; получено ${r141.status}`);

  const rEmpty = await addExpense(app, f.a.token, f.g.id, { ...base, description: '' });
  assert.ok(rEmpty.status >= 200 && rEmpty.status < 300,
    `SP-054: пустое описание допускается; получено ${rEmpty.status}`);

  const after2 = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  assert.equal((after2.json.expenses || after2.json || []).length, N + 2,
    'SP-054: добавились ровно два расхода — из шагов 1 и 3; расход со 141 символом создан быть не должен');
});

test('A-35 · SP-055: плательщик не обязан входить в состав распределения', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '100.00', category: CAT, description: 'платил за других',
    splitType: 'equal', participants: [f.ids[1], f.ids[2]],
  });
  assert.ok(r.status >= 200 && r.status < 300,
    `SP-055: допустима ситуация, когда один заплатил за других; получено ${r.status} ${r.text.slice(0, 200)}`);
  const sh = sharesOf(r.json.expense);
  assert.equal(sh.length, 2, 'SP-055: начисления только на состав, плательщика в нём нет');
  assert.deepEqual(sh.map(shareMinor), [5000, 5000]);
});

test('A-36 · SP-056: список расходов возвращается от старых к новым', async () => {
  const f = await fixture3();
  const made = [];
  for (const d of ['первый', 'второй', 'третий']) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '10.00', category: CAT, description: d,
      splitType: 'equal', participants: f.ids,
    });
    fixtureOk(r, 'расход ' + d);
    made.push(r.json.expense.id);
  }
  const list = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  assert.equal(list.status, 200);
  const arr = list.json.expenses || list.json;
  assert.deepEqual(arr.map((e) => e.id), made,
    'SP-056: расходы обязаны возвращаться в порядке добавления, от старых к новым');
});

test('A-37 · SP-057,SP-058,SP-109: удаление расхода и повторное удаление', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '10.00', category: CAT, description: 'на удаление',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(r, 'расход на удаление');
  const eid = r.json.expense.id;
  const del1 = await api(app, 'DELETE', `/api/groups/${f.g.id}/expenses/${eid}`, { token: f.a.token });
  assert.equal(del1.status, 204,
    `SP-109: успешное удаление обязано возвращать 204; получено ${del1.status}`);
  assert.equal(del1.text, '', 'SP-109: тело ответа 204 обязано быть пустым');
  const list = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  assert.equal((list.json.expenses || list.json || []).find((e) => e.id === eid), undefined,
    'SP-057: удалённый расход обязан исчезнуть из группы');
  const del2 = await api(app, 'DELETE', `/api/groups/${f.g.id}/expenses/${eid}`, { token: f.a.token });
  assert.equal(del2.status, 404,
    `SP-058: повторное удаление уже удалённого расхода обязано возвращать «не найдено»; получено ${del2.status}`);
});

test('A-38 · SP-059: расход в несуществующую группу — «не найдено»', async () => {
  const f = await fixture3();
  const r = await api(app, 'POST', '/api/groups/grp-нет-такой/expenses', {
    token: f.a.token,
    body: { description: 'в никуда', amount: '10.00', currency: 'RUB', category: CAT, payerId: f.ids[0], splitType: 'equal', participants: f.ids },
  });
  assert.equal(r.status, 404,
    `SP-059: добавление расхода в несуществующую группу обязано возвращать 404; получено ${r.status}`);
});

test('A-39 · SP-060,SP-111: неизвестный способ распределения и его отсутствие', async () => {
  const f = await fixture3();
  const r1 = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '10.00', category: CAT, description: 'shares',
    splitType: 'shares', splits: man(f.ids, ['4', '3', '3']),
  });
  assert.equal(r1.status, 400,
    `SP-060: поддерживаются ровно equal/percent/manual, иной способ обязан отклоняться; получено ${r1.status}`);
  const r2 = await api(app, 'POST', `/api/groups/${f.g.id}/expenses`, {
    token: f.a.token,
    body: { description: 'без способа', amount: '10.00', currency: 'RUB', category: CAT, payerId: f.ids[0], participants: f.ids },
  });
  assert.equal(r2.status, 400,
    `SP-111: отсутствие обязательного поля обязано возвращать VALIDATION_ERROR; получено ${r2.status}`);
});

// ───────────────────────── VII. Категория ─────────────────────────

test('A-40 · SP-072,SP-074,SP-075: набор категорий, значение по умолчанию, возврат при чтении', async () => {
  const f = await fixture3();
  for (const category of ['food', 'transport', 'housing', 'entertainment', 'other']) {
    const r = await addExpense(app, f.a.token, f.g.id, {
      payerId: f.ids[0], amount: '10.00', category, description: 'категория ' + category,
      splitType: 'equal', participants: f.ids,
    });
    assert.ok(r.status >= 200 && r.status < 300,
      `SP-072: категория «${category}» входит в фиксированный набор и обязана приниматься; получено ${r.status} ${r.text.slice(0, 160)}`);
    assert.equal(r.json.expense.category, category, 'SP-075: категория обязана возвращаться в составе расхода');
  }
  const noCat = await api(app, 'POST', `/api/groups/${f.g.id}/expenses`, {
    token: f.a.token,
    body: { description: 'без категории', amount: '10.00', currency: 'RUB', payerId: f.ids[0], splitType: 'equal', participants: f.ids },
  });
  assert.ok(noCat.status >= 200 && noCat.status < 300, `создание без категории: ${noCat.status}`);
  assert.equal(noCat.json.expense.category, 'other',
    'SP-074: при отсутствии поля категории обязана подставляться other');
});

test('A-41 · SP-073: категория вне набора отклоняется', async () => {
  const f = await fixture3();
  const r = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '10.00', category: 'groceries', description: 'вне набора',
    splitType: 'equal', participants: f.ids,
  });
  assert.equal(r.status, 400,
    `SP-073: категория вне набора обязана отклоняться с VALIDATION_ERROR; получено ${r.status}`);
});

// ───────── Новые кейсы по правкам аудита: A-47, A-48…A-52, A-53 ─────────

test('A-47 · SP-004,SP-110: полный состав полей расхода и игнорирование неизвестных полей', async () => {
  const f = await fixture3();
  const r = await api(app, 'POST', `/api/groups/${f.g.id}/expenses`, {
    token: f.a.token,
    body: {
      description: 'полный состав', amount: '10.00', currency: 'RUB', category: CAT,
      payerId: f.ids[0], splitType: 'equal', participants: [f.ids[0], f.ids[1]],
      id: 'мой-id', createdAt: '2020-01-01T00:00:00.000Z',
    },
  });
  assert.ok(r.status >= 200 && r.status < 300,
    `SP-110: неизвестное поле обязано игнорироваться, а не приводить к ошибке; получено ${r.status} ${r.text.slice(0, 200)}`);
  const e = r.json.expense;
  assert.notEqual(e.id, 'мой-id', 'SP-110: идентификатор обязан выдаваться приложением, а не браться из запроса');
  const created = e.createdAt || e.date;
  assert.ok(created, 'SP-004: расход обязан иметь момент создания');
  assert.notEqual(created, '2020-01-01T00:00:00.000Z', 'SP-110: момент создания обязан ставиться приложением');
  assert.equal(e.groupId, f.g.id, 'SP-004: расход обязан иметь ссылку на свою группу');
  assert.ok(e.payerId, 'SP-004: плательщик');
  assert.ok(e.currency, 'SP-004: валюта');
  assert.ok(e.splitType, 'SP-004: способ распределения');
  assert.ok(sharesOf(e).length > 0, 'SP-004: состав распределения');
  assert.equal(typeof e.description, 'string', 'SP-004: описание');
  assert.ok('category' in e, 'SP-004: категория');
});

// Матрица D-01 — те же правила проверки при PUT, что при создании (SP-152),
// с контролем SP-156: отклонённое изменение не трогает расход.
async function putMatrix(name, patch, requirement) {
  const f = await fixture3();
  const created = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '90.00', category: CAT, description: 'исходный',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(created, 'исходный расход для PUT');
  const e0 = created.json.expense;
  const body = {
    description: 'изменённый', amount: '90.00', currency: 'RUB', category: CAT,
    payerId: f.ids[0], splitType: 'equal', participants: f.ids, ...patch,
  };
  const put = await api(app, 'PUT', `/api/groups/${f.g.id}/expenses/${e0.id}`, { token: f.a.token, body });
  assert.equal(put.status, 400,
    `${requirement} + SP-152: к изменяемому расходу обязаны применяться те же правила проверки, что при создании (${name}); получено ${put.status} ${put.text.slice(0, 200)}`);

  const back = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  const e1 = (back.json.expenses || back.json).find((x) => x.id === e0.id);
  assert.ok(e1, 'SP-156: расход обязан остаться на месте после отклонённого изменения');
  assert.equal(money(e1, 'amount').minor, money(e0, 'amount').minor, 'SP-156: сумма не изменилась');
  assert.equal(e1.currency, e0.currency, 'SP-156: валюта не изменилась');
  assert.equal(e1.category, e0.category, 'SP-156: категория не изменилась');
  assert.equal(e1.splitType, e0.splitType, 'SP-156: способ распределения не изменился');
  assert.deepEqual(sharesOf(e1).map(shareMinor), sharesOf(e0).map(shareMinor), 'SP-156: начисления не изменились');
}

test('A-48 · SP-026,SP-152: PUT с валютой, отличной от валюты группы', async () => {
  await putMatrix('currency USD в рублёвой группе', { currency: 'USD' }, 'SP-026');
});

test('A-49 · SP-073,SP-152: PUT с категорией вне набора', async () => {
  await putMatrix('category groceries', { category: 'groceries' }, 'SP-073');
});

test('A-50 · SP-060,SP-152: PUT с неизвестным способом распределения', async () => {
  await putMatrix('splitType shares', { splitType: 'shares' }, 'SP-060');
});

test('A-51 · SP-052,SP-152: PUT с чужим участником в составе', async () => {
  const other = await fixture3('Чужая-для-PUT');
  await putMatrix('состав с участником другой группы', { participants: [other.ids[0], other.ids[1]] }, 'SP-052');
});

test('A-52 · SP-066,SP-152: PUT с процентами, не дающими 100.00', async () => {
  const f = await fixture3();
  const created = await addExpense(app, f.a.token, f.g.id, {
    payerId: f.ids[0], amount: '90.00', category: CAT, description: 'исходный',
    splitType: 'equal', participants: f.ids,
  });
  fixtureOk(created, 'исходный расход');
  const e0 = created.json.expense;
  const put = await api(app, 'PUT', `/api/groups/${f.g.id}/expenses/${e0.id}`, {
    token: f.a.token,
    body: {
      description: 'проценты', amount: '90.00', currency: 'RUB', category: CAT, payerId: f.ids[0],
      splitType: 'percent', splits: pct(f.ids, ['33.33', '33.33', '33.33']),
    },
  });
  assert.equal(put.status, 400,
    `SP-066 + SP-152: сумма процентов 99.99 обязана отклоняться и при изменении; получено ${put.status} ${put.text.slice(0, 200)}`);
  const back = await api(app, 'GET', `/api/groups/${f.g.id}/expenses`, { token: f.a.token });
  const e1 = (back.json.expenses || back.json).find((x) => x.id === e0.id);
  assert.equal(e1.splitType, 'equal', 'SP-156: отклонённое изменение не трогает расход');
});

test('A-53 · SP-150,SP-151: PUT меняет описание и категорию и не затирает валюту', async () => {
  const a = await newUser(app, 'Ann', 'q');
  const b = await newUser(app, 'Bob', 'q');
  const g = await newGroup(app, a, 'Trip USD', 'USD', [b]);
  const ids = g.members.map((m) => m.id);
  const created = await addExpense(app, a.token, g.id, {
    payerId: ids[0], amount: '20.00', currency: 'USD', category: CAT, description: 'Обед',
    splitType: 'equal', participants: ids,
  });
  fixtureOk(created, 'исходный расход в USD');
  const e0 = created.json.expense;
  const put = await api(app, 'PUT', `/api/groups/${g.id}/expenses/${e0.id}`, {
    token: a.token,
    body: {
      description: 'Ужин', amount: '20.00', currency: 'USD', category: 'Продукты',
      payerId: ids[0], splitType: 'equal', participants: ids,
    },
  });
  assert.ok(put.status >= 200 && put.status < 300,
    `SP-150: расход обязан изменяться по своему пути методом PUT; получено ${put.status} ${put.text.slice(0, 200)}`);
  const back = await api(app, 'GET', `/api/groups/${g.id}/expenses`, { token: a.token });
  const e1 = (back.json.expenses || back.json).find((x) => x.id === e0.id);
  assert.equal(e1.description, 'Ужин',
    'SP-151: изменению обязаны подлежать ВСЕ поля, включая описание — молчаливое игнорирование нового описания есть дефект');
  assert.equal(e1.category, 'Продукты', 'SP-151: категория обязана меняться');
  assert.equal(e1.currency, 'USD', 'SP-151: валюта расхода обязана сохраниться, а не быть затёртой');
});

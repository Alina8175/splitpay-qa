// ЗОНА B · UI — кейсы B-32…B-37 плана tests/plan-B.md.
// Порядок исполнения задан правкой D-40: B-32 → B-33 → B-37 → B-34 → B-35 → B-36.
// B-37 проверяет достижимость элемента отметки оплаты и обязан идти ДО B-34,
// который эту отметку ставит: на оплаченной строке элемента законно может не быть,
// и прежний порядок дал бы ложную находку доступности.
//
// Селекторы только getByRole / getByText. data-testid отменены SPEC 1.2.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startApp, newUser, launch, openPage, loginAs, createGroupUi, addExpenseUi, openTab, mainText, sleep,
} from './_ui-harness.mjs';

// ── Правка оснастки, внесена в сессии 4 ────────────────────────────────────────
// Две ошибки оснастки красили кейсы B-33, B-34 и B-35 без всякой находки:
//  1. Строка долга на странице занимает ДВЕ строки текста («Борис→Аня» и
//     «150.00 RUB»), а B-33 искал обе части в одной строке и не находил ни одной.
//  2. Нажатие «Оплачен» открывает модальное окно «Отметить долг оплаченным»;
//     без нажатия «Подтвердить» погашение не проводится, а подложка окна
//     перехватывает все последующие клики — B-34 и B-35 падали по таймауту.
// Правка касается только оснастки проверок; ожидания кейсов не меняются.

/** Строки блока долгов, собранные целиком: имена и сумма приходят разными строками. */
function debtRows(txt) {
  const block = (txt.split(/кто кому должен/i)[1] || txt).split(/Балансы/)[0];
  const rows = [];
  for (const line of block.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (/→|->|должен/.test(line)) rows.push(line);
    else if (rows.length) rows[rows.length - 1] += ' ' + line;
  }
  return rows;
}

/** Подтверждение модального окна погашения, если оно открылось. */
async function confirmSettle(p) {
  const heading = p.getByRole('heading', { name: /Отметить долг оплаченным/i });
  if (await heading.count()) {
    await p.getByRole('button', { name: 'Подтвердить' }).click();
    await sleep(900);
  }
}

let app, browser, page, users;
before(async () => {
  app = await startApp();
  browser = await launch();
  const A = await newUser(app, 'Аня', 'ua');
  const B = await newUser(app, 'Борис', 'ub');
  const V = await newUser(app, 'Вера', 'uv');
  users = { A, B, V };
  page = await openPage(browser, app);
  await loginAs(page, A);
  await createGroupUi(page, 'Поездка', [B.email, V.email], 'RUB');
  await addExpenseUi(page, { description: 'Бензин', amount: '100.00' });
});
after(async () => { await browser.close(); await app.stop(); });

test('B-32 · SP-131,SP-133: увидеть балансы', async () => {
  await openTab(page, 'Долги');
  const txt = await mainText(page);
  assert.match(txt, /Аня/, 'SP-131: страница обязана позволять увидеть балансы участников');
  assert.match(txt, /66\.66/, 'SP-133: баланс Ани обязан отображаться с двумя знаками после точки');
  assert.match(txt, /-33\.33|−33\.33|\(33\.33\)/, 'SP-133: отрицательный баланс обязан быть виден');
  assert.match(txt, /66\.66[^\n]{0,6}RUB|RUB[^\n]{0,6}66\.66/,
    'SP-133: денежные величины на странице обязаны отображаться С КОДОМ ВАЛЮТЫ — блок балансов тоже');
});

test('B-33 · SP-091,SP-131,SP-095: долги с направлением, суммой и статусом', async () => {
  await openTab(page, 'Долги');
  const txt = await mainText(page);
  const rows = debtRows(txt).filter((l) => /33\.33/.test(l) && /Борис|Вера/.test(l));
  assert.ok(rows.length >= 1, 'SP-131: список долгов обязан быть виден');

  const borisRow = rows.find((l) => /Борис/.test(l) && /Аня/.test(l));
  assert.ok(borisRow, 'SP-091: строка долга обязана содержать текстом имена ОБЕИХ сторон');
  // Правка D-12: направление проверяется позиционно, а не «оба имени на месте».
  const iFrom = borisRow.indexOf('Борис'), iTo = borisRow.indexOf('Аня');
  const arrow = /Борис[^А-Яа-я]{0,12}(→|->|должен|платит)[^А-Яа-я]{0,12}Аня/.test(borisRow);
  assert.ok(iFrom < iTo || arrow,
    `SP-091: направление долга обязано читаться из строки — должник Борис левее получателя Ани `
    + `либо между ними явный указатель направления. Строка: «${borisRow}». `
    + `Перевёрнутое «Аня → Борис» — провал, а не успех.`);
  assert.match(borisRow, /RUB/, 'SP-133: сумма долга обязана идти с кодом валюты');
  assert.match(borisRow, /pending|ожид|не оплач|не погаш/i,
    'SP-091 + SP-163: статус долга обязан читаться ТЕКСТОМ, а не только цветом или значком');
  assert.equal(txt.includes('Аня→Аня') || txt.includes('Борис→Борис'), false,
    'SP-095: строк, где обе стороны совпадают, на экране быть не должно');
});

test('B-37 · достижимость элемента отметки оплаты по роли и тексту', async () => {
  await openTab(page, 'Долги');
  const mark = page.getByRole('button', { name: /Оплачен|Отметить|Погасить/i });
  assert.ok(await mark.count() >= 1,
    'Примечание SPEC 1.2 к SP-134/SP-135: элемент отметки долга оплаченным обязан адресоваться '
    + 'ролью и видимым текстом. Недостижимость — дефект доступности интерфейса, а не повод завести data-testid.');
});

test('B-34 · SP-131,SP-168: отметить долг оплаченным через интерфейс', async () => {
  await openTab(page, 'Долги');
  await page.getByRole('button', { name: /Оплачен/i }).first().click();
  await sleep(600);
  await confirmSettle(page);
  const txt = await mainText(page);
  assert.match(txt, /33\.33/, 'SP-168: второй долг обязан остаться');
  assert.match(txt, /Аня\s*33\.33|33\.33\s*$|Аня[^\n]*33\.33/m,
    'SP-168: баланс Ани обязан измениться ровно на сумму погашения — с 66.66 на 33.33');
  assert.doesNotMatch(txt, /66\.66/,
    'SP-168: старый баланс 66.66 на экране остаться не должен — иначе погашение не отражено');
});

test('B-35 · SP-132,SP-166: отказ 409 показан текстом', async () => {
  await openTab(page, 'Долги');
  const mark = page.getByRole('button', { name: /Оплачен/i });
  const n = await mark.count();
  const paidRowStillMarkable = n >= 2;
  console.log(`[B-35 · наблюдение] элементов отметки оплаты после B-34: ${n}`);
  if (!paidRowStillMarkable) {
    assert.fail('SP-166 средствами интерфейса: элемент отметки на уже оплаченной строке отсутствует — '
      + 'повторное нажатие недостижимо. Наблюдение фиксируется; проверка кода 409 остаётся за B-16, '
      + 'который её и провалил: приложение проводит второе погашение вместо 409 CONFLICT.');
  }
  await mark.first().click();
  await sleep(600);
  await confirmSettle(page);
  const body = await page.locator('body').innerText();
  assert.match(body, /уже|оплач|погаш|conflict|409/i,
    'SP-132: отказ 409 обязан быть показан на странице ВИДИМЫМ ТЕКСТОМ, а не молча проигнорирован');
});

test('B-36 · SP-133,SP-092: два знака и код валюты у копеечных величин', async () => {
  const A = users.A;
  const p2 = await openPage(browser, app);
  await loginAs(p2, A);
  await createGroupUi(p2, 'Копейки', [users.B.email, users.V.email], 'RUB');
  await addExpenseUi(p2, { description: 'Копейка', amount: '0.01' });
  await openTab(p2, 'Долги');
  const txt = (await p2.locator('main').innerText());
  assert.doesNotMatch(txt, /(^|[^\d.])0(?![.\d])/m,
    'SP-133: величины обязаны изображаться с двумя знаками — «0» вместо «0.00» недопустимо');
  assert.match(txt, /0\.00/, 'SP-133: нулевые балансы обязаны быть видны как 0.00');
  assert.match(txt, /RUB/, 'SP-133: с кодом валюты');
});

// ЗОНА A · UI — кейсы A-42…A-46 плана tests/plan-A.md.
// Селекторы только getByRole / getByText. data-testid отменены SPEC 1.2.
// Правка D-17: наличие долей на экране фиксируется КАК ПРЕДУСЛОВИЕ, отдельным
// наблюдением, а не как условие внутри ожидания.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startApp, newUser, launch, openPage, loginAs, createGroupUi, addExpenseUi, openTab, mainText, sleep,
} from './_ui-harness.mjs';

let app, browser;
before(async () => { app = await startApp(); browser = await launch(); });
after(async () => { await browser.close(); await app.stop(); });

async function scene(currency = 'RUB') {
  const a = await newUser(app, 'Аня', 'a');
  const b = await newUser(app, 'Борис', 'b');
  const v = await newUser(app, 'Вера', 'v');
  const page = await openPage(browser, app);
  await loginAs(page, a);
  await createGroupUi(page, 'Поездка ' + Math.random().toString(36).slice(2, 6), [b.email, v.email], currency);
  return { a, b, v, page };
}

test('A-42 · SP-131,SP-133,SP-062: добавление расхода и отображение сумм', async () => {
  const s = await scene('RUB');
  await addExpenseUi(s.page, { description: 'Бензин', amount: '100.00' });
  const txt = await mainText(s.page);

  // Обязательная часть: сумма с двумя знаками и код валюты (SP-133).
  assert.match(txt, /100\.00/, 'SP-133: сумма расхода обязана отображаться с двумя знаками после точки');
  assert.match(txt, /100\.00\s*RUB|RUB\s*100\.00/,
    'SP-133: денежная величина на странице обязана отображаться с кодом валюты');

  // Предусловие правки D-17: показывает ли страница доли участников — фиксируется явно.
  const showsShares = /доля|дол[яи]\s|33\.3/.test(txt);
  console.log(`[A-42 · наблюдение по D-17] доли на экране: ${showsShares ? 'ЕСТЬ' : 'НЕТ'}`);
  if (showsShares) {
    assert.match(txt, /33\.34/,
      'SP-062 на уровне интерфейса: неделимая копейка обязана быть у Ани — первой добавленной в группу');
  }
});

test('A-43 · SP-132: ошибка от API показана на странице текстом', async () => {
  const s = await scene('RUB');
  await s.page.getByRole('button', { name: /\+ Расход/ }).click();
  await s.page.getByRole('textbox', { name: 'Описание' }).fill('Нулевая сумма');
  await s.page.getByRole('textbox', { name: 'Сумма' }).fill('0');
  await s.page.getByRole('button', { name: 'Добавить расход' }).click();
  await sleep(900);
  const body = await s.page.locator('body').innerText();
  assert.match(body, /ошибк|больше нуля|некоррект|неверн|должн|положительн/i,
    'SP-132: страница обязана показать ошибку, вернувшуюся от API, ТЕКСТОМ, а не игнорировать её молча');
  assert.equal((s.page._pageErrors || []).length, 0,
    'SP-132: отказ API не должен приводить к необработанному исключению на странице');
});

test('A-44 · SP-131,SP-150: изменение расхода через интерфейс', async () => {
  const s = await scene('RUB');
  await addExpenseUi(s.page, { description: 'Бензин', amount: '100.00' });
  const edit = s.page.getByRole('button', { name: /Изм/ }).first();
  assert.equal(await edit.count(), 1,
    'SP-131: страница обязана позволять изменить расход — элемент изменения должен быть достижим по роли и тексту');
  await edit.click();
  await sleep(400);
  await s.page.getByRole('textbox', { name: 'Сумма' }).fill('90.00');
  await s.page.getByRole('button', { name: /Сохранить|Добавить расход|Изменить/ }).first().click();
  await sleep(900);
  const txt = await mainText(s.page);
  assert.match(txt, /90\.00/, 'SP-153: изменение расхода обязано немедленно отражаться на странице');
  assert.doesNotMatch(txt, /100\.00/,
    'SP-155: изменение обязано менять расход, а не добавлять второй — старой суммы на экране быть не должно');
});

test('A-45 · SP-133: код валюты в группе с валютой, отличной от рубля', async () => {
  const s = await scene('USD');
  await addExpenseUi(s.page, { description: 'Dinner', amount: '20.00' });
  const txt = await mainText(s.page);
  assert.match(txt, /20\.00\s*USD|USD\s*20\.00/,
    'SP-133: код валюты обязан отображаться и он обязан быть валютой группы (USD), а не подставленным RUB');
  assert.doesNotMatch(txt, /20\.00\s*RUB/, 'SP-026: валюта расхода обязана совпадать с валютой группы');
});

test('A-46 · ревизия доступности формы расхода: роль и видимый текст', async () => {
  const s = await scene('RUB');
  await s.page.getByRole('button', { name: /\+ Расход/ }).click();
  await sleep(400);
  const p = s.page;
  const checks = [
    ['поле описания', p.getByRole('textbox', { name: 'Описание' })],
    ['поле суммы', p.getByRole('textbox', { name: 'Сумма' })],
    ['поле валюты', p.getByRole('textbox', { name: 'Валюта' })],
    ['выбор категории', p.getByRole('combobox', { name: 'Категория' })],
    ['выбор плательщика', p.getByRole('combobox', { name: /Кто платил|Плательщик/ })],
    ['способ «поровну»', p.getByRole('button', { name: /Поровну/ })],
    ['способ «по процентам»', p.getByRole('button', { name: /процент/i })],
    ['способ «вручную»', p.getByRole('button', { name: /Вручную/ })],
    ['отметка участника в составе', p.getByRole('checkbox').first()],
    ['кнопка добавления расхода', p.getByRole('button', { name: /Добавить расход/ })],
  ];
  const unreachable = [];
  for (const [what, loc] of checks) {
    if ((await loc.count()) === 0) unreachable.push(what);
  }
  assert.deepEqual(unreachable, [],
    'Примечание SPEC 1.2 к SP-134/SP-135: каждый элемент формы расхода обязан адресоваться ролью и видимым текстом. '
    + 'Недостижимые ролью элементы: ' + (unreachable.join(', ') || '—'));
});

test('A-46-NET · SP-130: страница работает без обращений в сеть', async () => {
  const s = await scene('RUB');
  await addExpenseUi(s.page, { description: 'Оффлайн', amount: '10.00' });
  assert.deepEqual(s.page._externalRequests, [],
    'SP-130: страница обязана работать без обращений в сеть — ни CDN, ни шрифтов, ни аналитики');
});

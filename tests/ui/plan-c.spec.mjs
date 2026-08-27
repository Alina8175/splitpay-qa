// ЗОНА C · UI — кейсы C-39…C-42 плана tests/plan-C.md, включая правки § XII:
// D-04 и D-16 (C-40: положительный признак раздела истории и непустая история),
// D-18 (C-41: проверка утечки по списку L не редуцируется никогда).
//
// Селекторы только getByRole / getByText. data-testid отменены SPEC 1.2:
// сценарий, невыразимый через роль или видимый текст, — это находка (C-42),
// а не повод завести служебный атрибут.
//
// Соглашение С-C1: «указать идентификатор пользователя» у этого приложения —
// вход по email и паролю. Кейсы исполняются над фактическим механизмом.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startApp, newUser, launch, openPage, loginAs, createGroupUi, addExpenseUi, openTab, mainText, sleep,
} from './_ui-harness.mjs';

let app, browser;
before(async () => { app = await startApp(); browser = await launch(); });
after(async () => { await browser.close(); await app.stop(); });

/** Денежные величины, видимые на странице: «300.00 RUB» либо «RUB 300.00». */
const MONEY_WITH_CURRENCY = /(\d+\.\d{2}\s*[A-Z]{3})|([A-Z]{3}[\s,]*\d+\.\d{2})/;

async function scene(name = 'Поездка') {
  const alice = await newUser(app, 'Аня', 'alice');
  const boris = await newUser(app, 'Борис', 'boris');
  const page = await openPage(browser, app);
  await loginAs(page, alice);
  const groupName = name + ' ' + Math.random().toString(36).slice(2, 6);
  await createGroupUi(page, groupName, [boris.email], 'RUB');
  return { alice, boris, page, groupName };
}

test('C-39 · SP-130,SP-120: страница отдаётся и работает без обращений в сеть', async () => {
  const alice = await newUser(app, 'Аня', 'alice');

  const res = await fetch(app.base + '/');
  assert.equal(res.status, 200, 'SP-120: GET / обязан отдавать страницу');
  assert.match(String(res.headers.get('content-type')), /^text\/html/,
    'SP-120: страница обязана отдаваться как text/html');
  const html = await res.text();

  const external = [
    ...html.matchAll(/<script[^>]+src=["']https?:\/\/[^"']+["']/gi),
    ...html.matchAll(/<link[^>]+href=["']https?:\/\/[^"']+["']/gi),
    ...html.matchAll(/@import\s+url\(\s*["']?https?:\/\//gi),
  ].map((m) => m[0]);
  assert.deepEqual(external, [],
    'SP-130: в исходном тексте страницы не обязано быть ссылок на внешние хосты: ' + external.join(' | '));

  const page = await openPage(browser, app);
  await loginAs(page, alice);
  await createGroupUi(page, 'Оффлайн ' + Math.random().toString(36).slice(2, 6), [], 'RUB');
  await sleep(500);
  assert.deepEqual(page._externalRequests, [],
    'SP-130: страница обязана работать без обращений в сеть — ни шрифтов, ни CDN, ни аналитики. '
    + 'Перехвачено: ' + page._externalRequests.join(', '));
  assert.deepEqual(page._pageErrors || [], [],
    'SP-130: прохождение сценария не обязано давать необработанных исключений на странице');
});

test('C-40 · SP-131,SP-133: путь по интерфейсу — вход, группа, участник, история с записями', async () => {
  const s = await scene('Путь');
  const page = s.page;
  const viktor = await newUser(app, 'Виктор', 'viktor');

  // Шаг 2. «Указать идентификатор пользователя» — вход по учётной записи (С-C1).
  // Признак того, что идентификация состоялась, — имя пользователя в шапке.
  assert.match(await page.locator('body').innerText(), /Аня/,
    'SP-131: после входа страница обязана показывать, под кем работает пользователь');

  // Шаг 4. Группа появилась без ручной перезагрузки — обеспечено ожиданием в createGroupUi.
  // Шаг 5. Добавить участника через интерфейс.
  await openTab(page, 'Участники');
  const emailField = page.getByRole('textbox', { name: /email участника|участник/i });
  assert.equal(await emailField.count(), 1,
    'SP-131: поле добавления участника обязано адресоваться ролью и доступным именем');
  await emailField.fill(viktor.email);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await sleep(800);
  const membersText = await mainText(page);
  const iBoris = membersText.indexOf('Борис');
  const iViktor = membersText.indexOf('Виктор');
  assert.ok(iBoris >= 0 && iViktor >= 0, 'SP-131: добавленные участники обязаны быть видны на странице');
  assert.ok(iBoris < iViktor, 'SP-006: участники обязаны идти в порядке добавления сверху вниз');

  // Шаг 6 (правка D-16). Раздел истории обязан дать ПОЛОЖИТЕЛЬНЫЙ признак того, что он отработал.
  await openTab(page, 'История');
  const heading = page.getByRole('heading', { name: /истори|операц/i });
  const emptyText = page.getByText(/нет операций|операций пока нет|пусто/i);
  const positive = (await heading.count()) + (await emptyText.count());
  assert.ok(positive > 0,
    'SP-131 (правка D-16): раздел истории обязан иметь положительный признак — заголовок по роли '
    + 'либо явный текст пустого состояния. Ноль найденных строк без такого признака неотличим '
    + 'от нереализованного обработчика: вкладка есть, клик не делает ничего');

  // Шаг 7 (новый). Расход и погашение через интерфейс.
  await openTab(page, 'Расходы');
  await addExpenseUi(page, { description: 'Бензин', amount: '300.00' });
  await openTab(page, 'Долги');
  const pay = page.getByRole('button', { name: /Оплачен/ });
  assert.ok(await pay.count() > 0, 'SP-131: отметка долга оплаченным обязана быть достижима по роли и тексту');
  await pay.first().click();
  await sleep(500);
  await page.getByRole('heading', { name: /Отметить долг оплаченным/ }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Подтвердить' }).click();
  await sleep(1000);

  // Шаг 8 (новый). Две видимые строки истории, новая сверху, суммы с валютой.
  await openTab(page, 'История');
  const hist = await mainText(page);
  const tail = hist.split('История').pop();
  const iExpense = tail.indexOf('Бензин');
  const iSettle = tail.search(/погаш|Оплачен|Долг/i);
  assert.ok(iExpense >= 0, 'SP-180: расход обязан попадать в историю');
  assert.ok(iSettle >= 0, 'SP-180: погашение обязано попадать в историю вместе с расходом, в один список');
  assert.ok(iSettle < iExpense,
    'SP-182: новая запись обязана стоять выше — погашение проведено позже расхода');

  assert.match(tail, MONEY_WITH_CURRENCY,
    'SP-133: денежные величины в истории обязаны отображаться с двумя знаками после точки и кодом валюты');

  // Общая проверка формата денег по всей странице сценария (SP-133).
  const amounts = [...(await mainText(page)).matchAll(/(?<![\d.])\d+\.\d{1,}(?![\d])/g)].map((m) => m[0]);
  const badPrecision = amounts.filter((x) => x.split('.')[1].length !== 2);
  assert.deepEqual(badPrecision, [],
    'SP-133: денежные величины обязаны показываться ровно с двумя знаками после точки: ' + badPrecision.join(', '));
});

test('C-41 · SP-132,SP-117: ошибка от API показывается текстом, чужие данные не утекают', async () => {
  // Чужая группа со своими маркерами: ни одна из строк не встречается у Ани.
  const bob = await newUser(app, 'Боб', 'bob');
  const zhenya = await newUser(app, 'Женя', 'zhenya');
  const zoya = await newUser(app, 'Зоя', 'zoya');
  const bobPage = await openPage(browser, app);
  await loginAs(bobPage, bob);
  await createGroupUi(bobPage, 'Дача', [zhenya.email, zoya.email], 'EUR');
  await addExpenseUi(bobPage, { description: 'Дрова', amount: '150.00' });

  const s = await scene('Своя');
  const page = s.page;

  // Шаг 2 в полном виде невозможен: интерфейс не адресует группу в URL
  // (адрес не меняется при открытии группы) и не принимает произвольный идентификатор.
  // Правка D-18: редуцируется только этот шаг, проверка списка L остаётся обязательной.
  const url = page.url();
  assert.ok(!/groups\//.test(url),
    'наблюдение: интерфейс не адресует группу в URL — обращение по чужому идентификатору выразить нечем; '
    + 'ограничение интерфейса, не провал');

  // Обязательная и нередуцируемая часть: ни одной строки чужой группы на странице под Аней.
  await openTab(page, 'Расходы');
  const visible = await page.locator('body').innerText();
  const L = ['Дача', 'Женя', 'Зоя', 'Дрова', 'EUR', '150.00', '75.00'];
  const leaked = L.filter((x) => visible.includes(x));
  assert.deepEqual(leaked, [],
    'SP-117 на уровне интерфейса: страница под своим пользователем не обязана показывать ни одной строки '
    + 'чужой группы. Утечка через клиент так же недопустима, как через API. Найдено: ' + leaked.join(', '));

  // Шаг 3. Ошибка от API обязана быть показана ТЕКСТОМ на странице.
  await page.getByRole('button', { name: /\+ Расход/ }).click();
  await page.getByRole('textbox', { name: 'Описание' }).fill('Нулевая сумма');
  await page.getByRole('textbox', { name: 'Сумма' }).fill('0');
  await page.getByRole('button', { name: 'Добавить расход' }).click();
  await sleep(900);
  const afterError = await page.locator('body').innerText();
  assert.match(afterError, /больше нуля|ошибк|некоррект|неверн|должн/i,
    'SP-132: отказ API обязан быть показан на странице видимым текстом, а не проигнорирован молча '
    + 'и не оставлен только в консоли браузера');
  assert.deepEqual(page._pageErrors || [], [],
    'SP-132: отказ API не обязан приводить к необработанному исключению на странице');

  // Шаг 4. Ошибка идентификации: после выхода действие, требующее API, обязано объясниться текстом.
  await page.getByRole('button', { name: 'Отмена' }).first().click();
  await sleep(400);
  await page.getByRole('button', { name: 'Выйти' }).click();
  await sleep(700);
  const loggedOut = await page.locator('body').innerText();
  assert.match(loggedOut, /Вход|Войти|Email/,
    'SP-132: после выхода интерфейс обязан вернуть пользователя к идентификации, а не оставить пустой экран');
});

test('C-42 · SP-131,SP-132: доступность — сценарий, невыразимый через роль и текст', async () => {
  const s = await scene('Ревизия');
  const page = s.page;

  // Ревизия элементов, задействованных в C-40 и C-41. Обход через data-testid запрещён.
  // Каждый элемент проверяется на том экране, где он существует.
  const unreachable = [];
  const need = async (what, loc) => { if ((await loc.count()) === 0) unreachable.push(what); };

  // Экран идентификации.
  await need('поле идентификации пользователя (email при входе)', page.getByRole('textbox', { name: 'Email' }));

  // Экран списка групп и форма создания группы.
  await page.getByRole('button', { name: /Все группы/ }).click();
  await sleep(500);
  await need('кнопка создания группы', page.getByRole('button', { name: /Новая группа/ }));
  const groupOpeners = await page.getByRole('button', { name: /Ревизия/ }).count()
    + await page.getByRole('link', { name: /Ревизия/ }).count()
    + await page.getByRole('listitem').filter({ hasText: /Ревизия/ }).count();
  if (groupOpeners === 0) unreachable.push('элемент выбора и открытия группы из списка');

  await page.getByRole('button', { name: /Новая группа/ }).click();
  await sleep(400);
  await need('поле названия группы', page.getByRole('textbox', { name: 'Название' }));
  await need('кнопка подтверждения создания группы', page.getByRole('button', { name: 'Создать', exact: true }));
  await page.getByRole('button', { name: 'Отмена' }).first().click();
  await sleep(400);

  // Экран группы: участники, история, форма расхода, фильтры.
  await page.getByText(s.groupName, { exact: false }).first().click();
  await page.getByRole('heading', { name: s.groupName, exact: true }).waitFor({ timeout: 10000 });
  await need('переход к истории операций', page.getByRole('button', { name: 'История', exact: true }));

  await openTab(page, 'Участники');
  await need('поле добавления участника', page.getByRole('textbox', { name: /email участника|участник/i }));
  await need('кнопка добавления участника', page.getByRole('button', { name: 'Добавить', exact: true }));

  await openTab(page, 'Расходы');
  const namedCombos = await page.getByRole('combobox', { name: /категор|плательщик/i }).count();
  const allCombos = await page.getByRole('combobox').count();
  if (allCombos > namedCombos) {
    unreachable.push(`фильтры списка расходов: ${allCombos - namedCombos} поля выбора без доступного имени`);
  }

  await page.getByRole('button', { name: /\+ Расход/ }).click();
  await sleep(400);
  await need('выбор категории расхода', page.getByRole('combobox', { name: 'Категория' }));
  await need('выбор плательщика', page.getByRole('combobox', { name: /Кто платил|Плательщик/ }));

  // Область показа ошибки: ошибка вызывается, затем ищется роль alert либо status.
  await page.getByRole('textbox', { name: 'Описание' }).fill('Ноль');
  await page.getByRole('textbox', { name: 'Сумма' }).fill('0');
  await page.getByRole('button', { name: 'Добавить расход' }).click();
  await sleep(900);
  const shown = await page.locator('body').innerText();
  const errorRegion = await page.getByRole('alert').count() + await page.getByRole('status').count();
  if (errorRegion === 0) {
    unreachable.push('область показа ошибки: текст «' + (shown.split('\n')[0] || '').slice(0, 60)
      + '» выводится в элементе без роли alert или status — программе чтения с экрана он не объявляется');
  }

  assert.deepEqual(unreachable, [],
    'Примечание SPEC 1.2 к SP-134/SP-135: каждый элемент сценария обязан адресоваться ролью '
    + 'с доступным именем либо видимым текстом. Недостижимы только через CSS-селектор, '
    + 'порядковый индекс или служебный атрибут: ' + (unreachable.join('; ') || '—'));
});

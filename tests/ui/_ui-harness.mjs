// Оснастка UI-проверок. Playwright подключается ОФЛАЙН командой `npm link playwright`
// (пакет установлен глобально в облачном контейнере, в реестр команда не ходит).
// На локальной машине Playwright отсутствует, поэтому UI-слой запускается отдельной
// командой и НЕ попадает под `node --test`: файлы названы *.spec.mjs, а не *.test.mjs.
//
// Запуск:  npm link playwright && node --test "tests/ui/*.spec.mjs"
//
// Селекторы — только getByRole и getByText. data-testid отменены версией SPEC 1.2:
// требовать служебную разметку от приложения, которое проверяется как чужое, —
// вмешательство в объект. Сценарий, невыразимый через роль или текст, — это находка
// (дефект доступности интерфейса), а не повод завести атрибут.

import { chromium } from 'playwright';
import { startApp, newUser } from '../api/_harness.mjs';

export { startApp, newUser };

const PASSWORD = 'passw0rd-qa-123';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  return chromium.launch();
}

/** Открывает страницу приложения. SP-130: страница обязана работать без обращений в сеть. */
export async function openPage(browser, app, { blockExternal = true } = {}) {
  const ctx = await browser.newContext();
  const external = [];
  if (blockExternal) {
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(app.base) || url.startsWith('data:') || url.startsWith('about:')) {
        return route.continue();
      }
      external.push(url);
      return route.abort();
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { page._pageErrors = (page._pageErrors || []).concat(String(e)); });
  await page.goto(app.base + '/');
  page._externalRequests = external;
  return page;
}

/** Вход по роли и видимому тексту. Учётная запись заводится через API. */
export async function loginAs(page, user) {
  await page.getByRole('button', { name: 'Вход' }).click();
  await page.getByRole('textbox', { name: 'Email' }).first().fill(user.email);
  await page.getByRole('textbox', { name: 'Пароль' }).first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByRole('heading', { name: /Мои группы/ }).waitFor({ timeout: 10000 });
}

/** Создание группы через интерфейс (SP-131, действие «создать группу»). */
export async function createGroupUi(page, name, memberEmails = [], currency = 'RUB') {
  await page.getByRole('button', { name: /Новая группа/ }).click();
  await page.getByRole('textbox', { name: 'Название' }).fill(name);
  const cur = page.getByRole('textbox', { name: /Валюта/ });
  if (await cur.count()) await cur.first().fill(currency);
  if (memberEmails.length) {
    await page.getByRole('textbox', { name: /Участник/ }).fill(memberEmails.join(', '));
  }
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 10000 });
}

/** Добавление расхода через интерфейс (SP-131, действие «добавить расход»). */
export async function addExpenseUi(page, { description, amount, splitMode }) {
  await page.getByRole('button', { name: /\+ Расход/ }).click();
  await page.getByRole('textbox', { name: 'Описание' }).fill(description);
  await page.getByRole('textbox', { name: 'Сумма' }).fill(amount);
  if (splitMode) await page.getByRole('button', { name: splitMode }).click();
  await page.getByRole('button', { name: 'Добавить расход' }).click();
  await page.getByText(description, { exact: false }).first().waitFor({ timeout: 10000 });
}

/** Переход на вкладку по видимому тексту кнопки. */
export async function openTab(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await sleep(400);
}

/** Весь видимый текст рабочей области — для проверок формата и утечек. */
export async function mainText(page) {
  return (await page.locator('main').innerText()).replace(/ /g, ' ');
}

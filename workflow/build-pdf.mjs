// Сборка run-report.pdf из run-report.html печатью в PDF.
//
// Вызов:  node workflow/build-pdf.mjs
// Нужен Playwright — то есть облачный контейнер (риск Р-2: реестр npm
// на локальной машине закрыт, поставить Playwright там нельзя).
//   npm link playwright && node workflow/build-pdf.mjs
//
// Колонтитул с номерами страниц задаётся здесь, а не в CSS: правило
// @page у Chromium номера страниц не печатает.

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO, 'run-report.html');
const OUT = path.join(REPO, 'run-report.pdf');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('file://' + SRC, { waitUntil: 'networkidle' });
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: `<div style="width:100%;font-family:DejaVu Sans,sans-serif;font-size:7.5pt;color:#5A6570;padding:0 18mm;display:flex;justify-content:space-between;">
      <span>SplitPay QA — отчёт о прогоне · 27–28 августа 2026</span>
      <span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  margin: { top: '20mm', bottom: '16mm', left: '18mm', right: '18mm' }
});
await browser.close();
console.log('собрано:', OUT);

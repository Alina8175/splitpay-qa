'use strict';

// ============================ small helpers ============================
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const show = (el, on) => { el.hidden = !on; };

const state = {
  user: null,
  token: localStorage.getItem('splitpay_token') || '',
  categories: [],
  groups: [],
  group: null,      // full detail payload
  tab: 'expenses',
  splitType: 'equal',
  editingExpenseId: null,
  filters: { category: '', payerId: '' }
};

function toast(message, isError) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', !!isError);
  show(el, true);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => show(el, false), isError ? 4200 : 2200);
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401) {
      state.token = '';
      localStorage.removeItem('splitpay_token');
      renderAuth();
    }
    throw new Error(payload.error || `Ошибка ${res.status}`);
  }
  return payload;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function money(text, currency) {
  return `${text} ${currency}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Mirrors the server's rounding so the preview never disagrees with the result.
function splitEvenly(total, count) {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  let rest = total - base * count;
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(base + (rest-- > 0 ? 1 : 0));
  }
  return out;
}
function splitByWeights(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map((r) => Math.floor(r));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  let k = 0;
  while (rest > 0 && order.length) { out[order[k % order.length].i] += 1; rest--; k++; }
  return out;
}
function toMinor(v) {
  const cleaned = String(v == null ? '' : v).trim().replace(/\s+/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Math.round(parseFloat(cleaned) * 100);
}
const fromMinor = (m) => (m / 100).toFixed(2);

// ============================ modals ============================
function openModal(sel) {
  show($('#modal-backdrop'), true);
  show($(sel), true);
}
function closeModals() {
  show($('#modal-backdrop'), false);
  ['#modal-group', '#modal-expense', '#modal-settle'].forEach((s) => show($(s), false));
}
$('#modal-backdrop').addEventListener('click', closeModals);
document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]')) { e.preventDefault(); closeModals(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

// ============================ auth screen ============================
function renderAuth() {
  state.user = null;
  show($('#view-auth'), true);
  show($('#view-app'), false);
}

$$('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    const isLogin = btn.dataset.authTab === 'login';
    show($('#form-login'), isLogin);
    show($('#form-register'), !isLogin);
  });
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/api/auth/login', {
      email: f.get('email'), password: f.get('password')
    });
    afterAuth(r);
  } catch (err) { toast(err.message, true); }
});

$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const r = await api('POST', '/api/auth/register', {
      name: f.get('name'), email: f.get('email'), password: f.get('password')
    });
    afterAuth(r);
  } catch (err) { toast(err.message, true); }
});

function afterAuth(r) {
  state.token = r.token;
  localStorage.setItem('splitpay_token', r.token);
  state.user = r.user;
  boot();
}

$('#btn-logout').addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout', {}); } catch (e) { /* ignore */ }
  state.token = '';
  localStorage.removeItem('splitpay_token');
  renderAuth();
});

// ============================ groups list ============================
$('#btn-home').addEventListener('click', () => openGroups());
$('#btn-back').addEventListener('click', () => openGroups());
$('#btn-new-group').addEventListener('click', () => {
  $('#form-group').reset();
  $('#form-group').elements.currency.value = 'RUB';
  openModal('#modal-group');
});

$('#form-group').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const emails = String(f.get('memberEmails') || '')
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  try {
    const r = await api('POST', '/api/groups', {
      name: f.get('name'),
      description: f.get('description'),
      currency: (f.get('currency') || 'RUB').toUpperCase(),
      memberEmails: emails
    });
    closeModals();
    toast('Группа создана');
    await openGroup(r.group.id);
  } catch (err) { toast(err.message, true); }
});

async function openGroups() {
  show($('#screen-group'), false);
  show($('#screen-groups'), true);
  const r = await api('GET', '/api/groups');
  state.groups = r.groups;
  const list = $('#groups-list');
  list.innerHTML = r.groups.map((g) => {
    const chips = g.myBalances.length
      ? g.myBalances.map((b) => {
          const positive = b.balance > 0;
          const text = positive
            ? `вам должны ${fromMinor(b.balance)} ${b.currency}`
            : `вы должны ${fromMinor(-b.balance)} ${b.currency}`;
          return `<span class="chip ${positive ? 'pos' : 'neg'}">${esc(text)}</span>`;
        }).join('')
      : '<span class="chip">всё рассчитано</span>';
    return `<div class="card" data-group="${esc(g.id)}">
      <div class="card-title">${esc(g.name)}</div>
      <div class="card-sub">${esc(g.description || '')}${g.description ? ' · ' : ''}${g.members.length} участник(ов) · ${g.expenseCount} расход(ов)</div>
      <div class="chips">${chips}</div>
    </div>`;
  }).join('');
  show($('#groups-empty'), r.groups.length === 0);
  $$('.card[data-group]', list).forEach((card) => {
    card.addEventListener('click', () => openGroup(card.dataset.group));
  });
}

// ============================ group detail ============================
async function openGroup(groupId) {
  const data = await api('GET', '/api/groups/' + encodeURIComponent(groupId));
  state.group = data;
  state.filters = { category: '', payerId: '' };
  show($('#screen-groups'), false);
  show($('#screen-group'), true);
  renderGroup();
}

function renderGroup() {
  const { group, expenses, balances } = state.group;
  $('#group-name').textContent = group.name;
  $('#group-meta').textContent =
    (group.description ? group.description + ' · ' : '') +
    `${group.members.length} участник(ов) · валюта по умолчанию ${group.currency}`;
  show($('#btn-delete-group'), group.ownerId === state.user.id);

  // my balance summary, one box per currency
  const mine = balances.map((c) => {
    const row = c.balances.find((b) => b.userId === state.user.id);
    return { currency: c.currency, balance: row ? row.balance : 0 };
  });
  $('#my-summary').innerHTML = mine.length
    ? mine.map((m) => `<div class="summary-box">
        <div class="summary-label">Ваш баланс, ${esc(m.currency)}</div>
        <div class="summary-value ${m.balance > 0 ? 'pos' : m.balance < 0 ? 'neg' : ''}">${fromMinor(m.balance)}</div>
      </div>`).join('')
    : '<div class="summary-box"><div class="summary-label">Ваш баланс</div><div class="summary-value">0.00</div></div>';

  renderFilters();
  renderExpenses();
  renderDebts();
  renderMembers();
  renderHistory();
  selectTab(state.tab);
}

$$('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
});
function selectTab(tab) {
  state.tab = tab;
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['expenses', 'debts', 'members', 'history'].forEach((t) => show($('#tab-' + t), t === tab));
}

// ---------- expenses ----------
function renderFilters() {
  const g = state.group.group;
  const cat = $('#filter-category');
  cat.innerHTML = '<option value="">Все категории</option>' +
    state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  cat.value = state.filters.category;
  const payer = $('#filter-payer');
  payer.innerHTML = '<option value="">Все плательщики</option>' +
    g.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  payer.value = state.filters.payerId;
}
$('#filter-category').addEventListener('change', (e) => {
  state.filters.category = e.target.value; renderExpenses();
});
$('#filter-payer').addEventListener('change', (e) => {
  state.filters.payerId = e.target.value; renderExpenses();
});

const SPLIT_LABEL = { equal: 'поровну', percent: 'по процентам', manual: 'вручную' };

function renderExpenses() {
  let list = state.group.expenses;
  if (state.filters.category) list = list.filter((e) => e.category === state.filters.category);
  if (state.filters.payerId) list = list.filter((e) => e.payerId === state.filters.payerId);

  const el = $('#expenses-list');
  if (!list.length) {
    el.innerHTML = '<p class="empty">Расходов нет. Нажмите «+ Расход», чтобы добавить первый.</p>';
    return;
  }
  el.innerHTML = list.map((e) => {
    const myShare = e.shares.find((s) => s.userId === state.user.id);
    const mine = myShare ? `ваша доля ${myShare.amountText} ${e.currency}` : 'вы не участвуете';
    return `<div class="item">
      <div class="item-main">
        <div class="item-title">${esc(e.description)}</div>
        <div class="item-sub">${esc(e.category)} · платил(а) ${esc(e.payerName)} · ${esc(SPLIT_LABEL[e.splitType] || e.splitType)} на ${e.shares.length} чел. · ${esc(fmtDate(e.date || e.createdAt))}</div>
        <div class="item-sub">${esc(mine)}</div>
      </div>
      <div class="item-right">
        <span class="amount">${esc(money(e.amountText, e.currency))}</span>
        <span class="row-actions">
          <button class="btn btn-ghost btn-sm" data-edit-expense="${esc(e.id)}">Изм.</button>
          <button class="btn btn-danger btn-sm" data-del-expense="${esc(e.id)}">Удал.</button>
        </span>
      </div>
    </div>`;
  }).join('');

  $$('[data-edit-expense]', el).forEach((b) =>
    b.addEventListener('click', () => openExpenseModal(b.dataset.editExpense)));
  $$('[data-del-expense]', el).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Удалить расход?')) return;
      try {
        await api('DELETE', `/api/groups/${state.group.group.id}/expenses/${b.dataset.delExpense}`, {});
        toast('Расход удалён');
        await openGroup(state.group.group.id);
      } catch (err) { toast(err.message, true); }
    }));
}

// ---------- debts ----------
function renderDebts() {
  const { group, balances, settlements } = state.group;
  const nameOf = (uid) => {
    const m = group.members.find((x) => x.id === uid);
    return m ? m.name : 'Неизвестно';
  };
  const parts = [];

  if (!balances.length) {
    parts.push('<p class="empty">Пока нет операций, поэтому долгов нет.</p>');
  }

  for (const cur of balances) {
    const rows = cur.balances.map((b) =>
      `<div class="balance-row"><span>${esc(nameOf(b.userId))}</span>
        <span class="amount ${b.balance > 0 ? 'pos' : b.balance < 0 ? 'neg' : ''}">${b.balanceText}</span></div>`).join('');

    const debts = cur.debts.length
      ? cur.debts.map((d) => `<div class="debt">
          <div class="debt-text">${esc(nameOf(d.from))}<span class="arrow">→</span>${esc(nameOf(d.to))}</div>
          <div>
            <span class="amount">${esc(money(d.amountText, cur.currency))}</span>
            <button class="btn btn-primary btn-sm" style="margin-left:10px"
              data-settle="${esc(d.from)}|${esc(d.to)}|${esc(d.amountText)}|${esc(cur.currency)}">Оплачен</button>
          </div>
        </div>`).join('')
      : '<p class="empty">Все рассчитались — долгов в этой валюте нет.</p>';

    parts.push(`<div class="cur-block">
      <p class="cur-title">${esc(cur.currency)} · кто кому должен</p>
      ${debts}
      <h3 style="margin-top:16px">Балансы</h3>
      <div class="item" style="display:block">${rows}</div>
    </div>`);
  }

  if (settlements.length) {
    parts.push(`<div class="cur-block"><p class="cur-title">Погашенные долги</p>` +
      settlements.map((s) => `<div class="debt">
        <div>
          <div class="debt-text">${esc(s.fromUserName)}<span class="arrow">→</span>${esc(s.toUserName)}</div>
          <div class="item-sub">${esc(fmtDate(s.createdAt))}${s.note ? ' · ' + esc(s.note) : ''}</div>
        </div>
        <div>
          <span class="amount pos">${esc(money(s.amountText, s.currency))}</span>
          <button class="btn btn-danger btn-sm" style="margin-left:10px" data-unsettle="${esc(s.id)}">Отменить</button>
        </div>
      </div>`).join('') + '</div>');
  }

  const body = $('#debts-body');
  body.innerHTML = parts.join('');

  $$('[data-settle]', body).forEach((b) => b.addEventListener('click', () => {
    const [from, to, amount, currency] = b.dataset.settle.split('|');
    openSettleModal(from, to, amount, currency);
  }));
  $$('[data-unsettle]', body).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Отменить отметку об оплате?')) return;
    try {
      await api('DELETE', `/api/groups/${state.group.group.id}/settlements/${b.dataset.unsettle}`, {});
      toast('Отметка отменена');
      await openGroup(state.group.group.id);
    } catch (err) { toast(err.message, true); }
  }));
}

// ---------- members ----------
function renderMembers() {
  const { group } = state.group;
  $('#members-list').innerHTML = group.members.map((m) => `<div class="item">
    <div class="item-main">
      <div class="item-title">${esc(m.name)}${m.id === state.user.id ? ' (вы)' : ''}</div>
      <div class="item-sub">${esc(m.email || '')}${m.isOwner ? ' · создатель группы' : ''}</div>
    </div>
    <div class="item-right">${
      m.isOwner ? '' :
      (group.ownerId === state.user.id || m.id === state.user.id)
        ? `<button class="btn btn-danger btn-sm" data-del-member="${esc(m.id)}">Убрать</button>` : ''
    }</div>
  </div>`).join('');

  $$('[data-del-member]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Убрать участника из группы?')) return;
    try {
      await api('DELETE', `/api/groups/${group.id}/members/${b.dataset.delMember}`, {});
      toast('Участник убран');
      if (b.dataset.delMember === state.user.id) await openGroups();
      else await openGroup(group.id);
    } catch (err) { toast(err.message, true); }
  }));
}

$('#form-add-member').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = new FormData(e.target).get('email');
  try {
    await api('POST', `/api/groups/${state.group.group.id}/members`, { email });
    e.target.reset();
    toast('Участник добавлен');
    await openGroup(state.group.group.id);
  } catch (err) { toast(err.message, true); }
});

$('#btn-delete-group').addEventListener('click', async () => {
  if (!confirm('Удалить группу вместе со всеми расходами?')) return;
  try {
    await api('DELETE', '/api/groups/' + state.group.group.id, {});
    toast('Группа удалена');
    await openGroups();
  } catch (err) { toast(err.message, true); }
});

// ---------- history ----------
function renderHistory() {
  const items = state.group.activity;
  $('#history-list').innerHTML = items.length
    ? items.map((a) => `<div class="tl-item">
        <div class="tl-dot"></div>
        <div class="tl-body"><div>${esc(a.text)}</div><div class="tl-time">${esc(fmtDate(a.createdAt))}</div></div>
      </div>`).join('')
    : '<p class="empty">История пуста.</p>';
}

// ============================ expense modal ============================
$('#btn-add-expense').addEventListener('click', () => openExpenseModal(null));

function openExpenseModal(expenseId) {
  const { group } = state.group;
  const form = $('#form-expense');
  form.reset();
  state.editingExpenseId = expenseId;
  const existing = expenseId ? state.group.expenses.find((e) => e.id === expenseId) : null;

  $('#expense-modal-title').textContent = existing ? 'Изменить расход' : 'Новый расход';
  $('#expense-submit').textContent = existing ? 'Сохранить' : 'Добавить расход';

  form.elements.category.innerHTML =
    state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  form.elements.payerId.innerHTML =
    group.members.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');

  form.elements.description.value = existing ? existing.description : '';
  form.elements.amount.value = existing ? existing.amountText : '';
  form.elements.currency.value = existing ? existing.currency : group.currency;
  form.elements.category.value = existing ? existing.category : (state.categories[0] || 'Прочее');
  form.elements.payerId.value = existing ? existing.payerId : state.user.id;

  state.splitType = existing ? existing.splitType : 'equal';
  $$('[data-split]').forEach((b) => b.classList.toggle('active', b.dataset.split === state.splitType));

  buildSplitRows(existing);
  updateSplitPreview();
  openModal('#modal-expense');
}

$$('[data-split]').forEach((btn) => btn.addEventListener('click', () => {
  state.splitType = btn.dataset.split;
  $$('[data-split]').forEach((b) => b.classList.toggle('active', b === btn));
  buildSplitRows(null, true);
  updateSplitPreview();
}));

function buildSplitRows(existing, keepSelection) {
  const { group } = state.group;
  const prev = keepSelection ? currentSelection() : null;
  const rows = group.members.map((m) => {
    let checked = true;
    let value = '';
    if (existing) {
      const sh = existing.shares.find((s) => s.userId === m.id);
      checked = !!sh;
      if (sh) {
        if (existing.splitType === 'percent' && sh.percent != null) value = String(sh.percent);
        else if (existing.splitType === 'manual') value = sh.amountText;
      }
    } else if (prev) {
      checked = prev.includes(m.id);
    }
    const needsValue = state.splitType !== 'equal';
    return `<div class="split-row" data-user="${esc(m.id)}">
      <label class="chk"><input type="checkbox" ${checked ? 'checked' : ''}> ${esc(m.name)}${m.id === state.user.id ? ' (вы)' : ''}</label>
      ${needsValue ? `<input class="val" inputmode="decimal" placeholder="${state.splitType === 'percent' ? '%' : '0.00'}" value="${esc(value)}">` : ''}
      <span class="preview"></span>
    </div>`;
  }).join('');
  $('#split-rows').innerHTML = rows;
  $$('#split-rows input').forEach((i) => {
    i.addEventListener('input', updateSplitPreview);
    i.addEventListener('change', updateSplitPreview);
  });
}

function currentSelection() {
  return $$('#split-rows .split-row')
    .filter((r) => $('input[type=checkbox]', r).checked)
    .map((r) => r.dataset.user);
}

$('#form-expense').elements.amount.addEventListener('input', updateSplitPreview);
$('#form-expense').elements.currency.addEventListener('input', updateSplitPreview);

function updateSplitPreview() {
  const form = $('#form-expense');
  const total = toMinor(form.elements.amount.value);
  const currency = (form.elements.currency.value || state.group.group.currency).toUpperCase();
  const rows = $$('#split-rows .split-row');
  const active = rows.filter((r) => $('input[type=checkbox]', r).checked);
  const status = $('#split-status');

  rows.forEach((r) => { $('.preview', r).textContent = ''; });

  if (!active.length) {
    status.className = 'split-status err';
    status.textContent = 'Выберите хотя бы одного участника.';
    return;
  }
  if (!Number.isFinite(total) || total <= 0) {
    status.className = 'split-status';
    status.textContent = 'Введите сумму расхода.';
    return;
  }

  if (state.splitType === 'equal') {
    const parts = splitEvenly(total, active.length);
    active.forEach((r, i) => { $('.preview', r).textContent = `${fromMinor(parts[i])} ${currency}`; });
    status.className = 'split-status ok';
    status.textContent = `Поровну между ${active.length} участниками.`;
    return;
  }

  const values = active.map((r) => {
    const raw = $('.val', r) ? $('.val', r).value : '';
    return String(raw).replace(',', '.').trim();
  });

  if (state.splitType === 'percent') {
    const percents = values.map((v) => (v === '' ? 0 : Number(v)));
    if (percents.some((p) => !Number.isFinite(p) || p < 0)) {
      status.className = 'split-status err';
      status.textContent = 'Проценты должны быть неотрицательными числами.';
      return;
    }
    const sum = percents.reduce((a, b) => a + b, 0);
    const hundredths = percents.map((p) => Math.round(p * 100));
    const parts = splitByWeights(total, hundredths);
    active.forEach((r, i) => { $('.preview', r).textContent = `${fromMinor(parts[i])} ${currency}`; });
    const exact = Math.abs(sum - 100) < 0.005;
    status.className = 'split-status ' + (exact ? 'ok' : 'err');
    status.textContent = exact
      ? 'Сумма процентов равна 100%.'
      : `Сумма процентов: ${sum.toFixed(2)}% — должно быть ровно 100%.`;
    return;
  }

  // manual
  const amounts = values.map((v) => (v === '' ? 0 : toMinor(v)));
  if (amounts.some((a) => !Number.isFinite(a))) {
    status.className = 'split-status err';
    status.textContent = 'Доли должны быть числами с не более чем 2 знаками после запятой.';
    return;
  }
  const sum = amounts.reduce((a, b) => a + b, 0);
  active.forEach((r, i) => { $('.preview', r).textContent = `${fromMinor(amounts[i])} ${currency}`; });
  const diff = total - sum;
  if (diff === 0) {
    status.className = 'split-status ok';
    status.textContent = 'Доли совпадают с суммой расхода.';
  } else {
    status.className = 'split-status err';
    status.textContent = diff > 0
      ? `Не распределено ещё ${fromMinor(diff)} ${currency}.`
      : `Превышение на ${fromMinor(-diff)} ${currency}.`;
  }
}

$('#form-expense').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const rows = $$('#split-rows .split-row').filter((r) => $('input[type=checkbox]', r).checked);
  if (!rows.length) return toast('Выберите участников расхода', true);

  const payload = {
    description: form.elements.description.value,
    amount: form.elements.amount.value,
    currency: (form.elements.currency.value || state.group.group.currency).toUpperCase(),
    category: form.elements.category.value,
    payerId: form.elements.payerId.value,
    splitType: state.splitType,
    splits: rows.map((r) => ({
      userId: r.dataset.user,
      value: $('.val', r) ? $('.val', r).value : undefined
    }))
  };
  if (state.splitType === 'equal') {
    payload.participants = rows.map((r) => r.dataset.user);
    delete payload.splits;
  }

  const gid = state.group.group.id;
  try {
    if (state.editingExpenseId) {
      await api('PUT', `/api/groups/${gid}/expenses/${state.editingExpenseId}`, payload);
      toast('Расход обновлён');
    } else {
      await api('POST', `/api/groups/${gid}/expenses`, payload);
      toast('Расход добавлен');
    }
    closeModals();
    await openGroup(gid);
  } catch (err) { toast(err.message, true); }
});

// ============================ settle modal ============================
let settleTarget = null;
function openSettleModal(from, to, amountText, currency) {
  settleTarget = { from, to, currency };
  const nameOf = (uid) => {
    const m = state.group.group.members.find((x) => x.id === uid);
    return m ? m.name : 'Неизвестно';
  };
  $('#settle-desc').textContent = `${nameOf(from)} → ${nameOf(to)}, валюта ${currency}`;
  $('#form-settle').reset();
  $('#form-settle').elements.amount.value = amountText;
  openModal('#modal-settle');
}

$('#form-settle').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', `/api/groups/${state.group.group.id}/settlements`, {
      fromUserId: settleTarget.from,
      toUserId: settleTarget.to,
      amount: f.get('amount'),
      currency: settleTarget.currency,
      note: f.get('note')
    });
    closeModals();
    toast('Долг отмечен оплаченным');
    await openGroup(state.group.group.id);
  } catch (err) { toast(err.message, true); }
});

// ============================ boot ============================
async function boot() {
  try {
    const meta = await api('GET', '/api/meta');
    state.categories = meta.categories;
  } catch (e) { state.categories = ['Прочее']; }

  if (!state.token) return renderAuth();
  try {
    const me = await api('GET', '/api/me');
    state.user = me.user;
  } catch (e) {
    return renderAuth();
  }
  show($('#view-auth'), false);
  show($('#view-app'), true);
  $('#who').textContent = state.user.name + ' · ' + state.user.email;
  await openGroups();
}

boot();

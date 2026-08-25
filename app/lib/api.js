'use strict';

const store = require('./store');
const auth = require('./auth');
const { computeBalances } = require('./balances');
const {
  id,
  now,
  HttpError,
  bad,
  toMinor,
  fromMinor,
  splitEvenly,
  splitByWeights,
  str,
  currencyCode,
  uniq
} = require('./util');

const CATEGORIES = [
  'Продукты',
  'Кафе и рестораны',
  'Жильё',
  'Транспорт',
  'Развлечения',
  'Путешествия',
  'Покупки',
  'Коммунальные',
  'Прочее'
];

const SPLIT_TYPES = ['equal', 'percent', 'manual'];

// ---- helpers ---------------------------------------------------------

function db() {
  return store.data();
}

function userMap() {
  const m = new Map();
  for (const u of db().users) m.set(u.id, u);
  return m;
}

function getGroupForUser(groupId, user) {
  const group = db().groups.find((g) => g.id === groupId);
  // Same answer for "does not exist" and "not yours": a user must not be able
  // to probe which group ids exist.
  if (!group || !group.memberIds.includes(user.id)) {
    throw new HttpError(404, 'Группа не найдена');
  }
  return group;
}

function logActivity(groupId, userId, type, text, meta) {
  const record = {
    id: id('act'),
    groupId,
    userId,
    type,
    text,
    meta: meta || {},
    createdAt: now()
  };
  db().activity.push(record);
  return record;
}

function groupExpenses(groupId) {
  return db().expenses.filter((e) => e.groupId === groupId);
}

function groupSettlements(groupId) {
  return db().settlements.filter((s) => s.groupId === groupId);
}

function shapeExpense(expense, users) {
  return {
    id: expense.id,
    groupId: expense.groupId,
    description: expense.description,
    amount: expense.amount,
    amountText: fromMinor(expense.amount),
    currency: expense.currency,
    category: expense.category,
    payerId: expense.payerId,
    payerName: users.get(expense.payerId) ? users.get(expense.payerId).name : 'Неизвестно',
    splitType: expense.splitType,
    date: expense.date,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
    createdBy: expense.createdBy,
    shares: expense.shares.map((s) => ({
      userId: s.userId,
      userName: users.get(s.userId) ? users.get(s.userId).name : 'Неизвестно',
      amount: s.amount,
      amountText: fromMinor(s.amount),
      percent: s.percent === undefined ? null : s.percent
    }))
  };
}

function shapeSettlement(settlement, users) {
  const name = (uid) => (users.get(uid) ? users.get(uid).name : 'Неизвестно');
  return {
    id: settlement.id,
    groupId: settlement.groupId,
    fromUserId: settlement.fromUserId,
    fromUserName: name(settlement.fromUserId),
    toUserId: settlement.toUserId,
    toUserName: name(settlement.toUserId),
    amount: settlement.amount,
    amountText: fromMinor(settlement.amount),
    currency: settlement.currency,
    note: settlement.note || '',
    createdAt: settlement.createdAt,
    createdBy: settlement.createdBy
  };
}

function shapeGroup(group, users) {
  return {
    id: group.id,
    name: group.name,
    description: group.description || '',
    currency: group.currency,
    ownerId: group.ownerId,
    createdAt: group.createdAt,
    members: group.memberIds.map((uid) => ({
      id: uid,
      name: users.get(uid) ? users.get(uid).name : 'Удалённый пользователь',
      email: users.get(uid) ? users.get(uid).email : null,
      isOwner: uid === group.ownerId
    }))
  };
}

// ---- expense split parsing ------------------------------------------

function buildShares(body, total, memberIds) {
  const splitType = str(body.splitType, 'splitType', { max: 20 });
  if (!SPLIT_TYPES.includes(splitType)) {
    throw bad('splitType должен быть одним из: equal, percent, manual');
  }

  let rows = [];
  if (Array.isArray(body.splits) && body.splits.length) {
    rows = body.splits.map((s) => ({ userId: str(s.userId, 'splits[].userId', { max: 60 }), value: s.value }));
  } else if (Array.isArray(body.participants) && body.participants.length) {
    rows = body.participants.map((uid) => ({ userId: str(uid, 'participants[]', { max: 60 }), value: undefined }));
  } else {
    throw bad('Укажите участников расхода (participants или splits)');
  }

  const ids = rows.map((r) => r.userId);
  if (uniq(ids).length !== ids.length) throw bad('Участник указан дважды');
  for (const uid of ids) {
    if (!memberIds.includes(uid)) throw bad('Участник расхода не состоит в группе');
  }

  if (splitType === 'equal') {
    const parts = splitEvenly(total, rows.length);
    return { splitType, shares: rows.map((r, i) => ({ userId: r.userId, amount: parts[i] })) };
  }

  if (splitType === 'percent') {
    const percents = rows.map((r) => {
      const n = typeof r.value === 'string' ? Number(r.value.replace(',', '.')) : Number(r.value);
      if (!Number.isFinite(n) || n < 0) throw bad('Проценты должны быть неотрицательными числами');
      return Math.round(n * 100); // hundredths of a percent
    });
    const sum = percents.reduce((a, b) => a + b, 0);
    if (sum !== 10000) {
      throw bad(`Сумма процентов должна быть равна 100, сейчас ${(sum / 100).toFixed(2)}`);
    }
    const parts = splitByWeights(total, percents);
    return {
      splitType,
      shares: rows.map((r, i) => ({ userId: r.userId, amount: parts[i], percent: percents[i] / 100 }))
    };
  }

  // manual
  const amounts = rows.map((r) => toMinor(r.value, 'splits[].value'));
  for (const a of amounts) {
    if (a < 0) throw bad('Суммы долей не могут быть отрицательными');
  }
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum !== total) {
    throw bad(
      `Сумма долей (${fromMinor(sum)}) не совпадает с суммой расхода (${fromMinor(total)})`
    );
  }
  return { splitType, shares: rows.map((r, i) => ({ userId: r.userId, amount: amounts[i] })) };
}

// ---- handlers --------------------------------------------------------

const handlers = {};

handlers['POST /api/auth/register'] = (ctx) => {
  const user = auth.register(ctx.body);
  const session = auth.createSession(user.id);
  ctx.setToken(session.token);
  return { token: session.token, user: auth.publicUser(user) };
};

handlers['POST /api/auth/login'] = (ctx) => {
  const user = auth.login(ctx.body);
  const session = auth.createSession(user.id);
  ctx.setToken(session.token);
  return { token: session.token, user: auth.publicUser(user) };
};

handlers['POST /api/auth/logout'] = (ctx) => {
  const token = auth.tokenFromRequest(ctx.req);
  if (token) auth.destroySession(token);
  ctx.clearToken();
  return { ok: true };
};

handlers['GET /api/me'] = (ctx) => ({ user: auth.publicUser(ctx.user()) });

handlers['GET /api/meta'] = () => ({ categories: CATEGORIES, splitTypes: SPLIT_TYPES });

handlers['GET /api/groups'] = (ctx) => {
  const user = ctx.user();
  const users = userMap();
  const groups = db()
    .groups.filter((g) => g.memberIds.includes(user.id))
    .map((g) => {
      const expenses = groupExpenses(g.id);
      const currencies = computeBalances(g.memberIds, expenses, groupSettlements(g.id));
      const mine = currencies
        .map((c) => {
          const row = c.balances.find((b) => b.userId === user.id);
          return row ? { currency: c.currency, balance: row.balance, balanceText: fromMinor(row.balance) } : null;
        })
        .filter(Boolean)
        .filter((c) => c.balance !== 0);
      return Object.assign(shapeGroup(g, users), {
        expenseCount: expenses.length,
        myBalances: mine
      });
    });
  groups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { groups };
};

handlers['POST /api/groups'] = (ctx) => {
  const user = ctx.user();
  const name = str(ctx.body.name, 'name', { max: 80 });
  const description = str(ctx.body.description, 'description', { max: 300, required: false });
  const currency = currencyCode(ctx.body.currency, 'RUB');

  const memberIds = [user.id];
  const invited = Array.isArray(ctx.body.memberEmails) ? ctx.body.memberEmails : [];
  const missing = [];
  for (const email of invited) {
    const clean = String(email || '').trim().toLowerCase();
    if (!clean) continue;
    const found = auth.findUserByEmail(clean);
    if (!found) {
      missing.push(clean);
      continue;
    }
    if (!memberIds.includes(found.id)) memberIds.push(found.id);
  }
  if (missing.length) {
    throw bad('Пользователи не найдены: ' + missing.join(', '));
  }

  const group = {
    id: id('grp'),
    name,
    description,
    currency,
    ownerId: user.id,
    memberIds,
    createdAt: now()
  };
  db().groups.push(group);
  logActivity(group.id, user.id, 'group.created', `${user.name} создал(а) группу «${name}»`);
  store.persist();
  return { group: shapeGroup(group, userMap()) };
};

handlers['GET /api/groups/:groupId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const users = userMap();
  const expenses = groupExpenses(group.id);
  const settlements = groupSettlements(group.id);
  return {
    group: shapeGroup(group, users),
    expenses: expenses
      .slice()
      .sort((a, b) => (a.date || a.createdAt) < (b.date || b.createdAt) ? 1 : -1)
      .map((e) => shapeExpense(e, users)),
    settlements: settlements
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((s) => shapeSettlement(s, users)),
    balances: computeBalances(group.memberIds, expenses, settlements),
    activity: db()
      .activity.filter((a) => a.groupId === group.id)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 100)
      .map((a) => ({
        id: a.id,
        type: a.type,
        text: a.text,
        userId: a.userId,
        userName: users.get(a.userId) ? users.get(a.userId).name : 'Неизвестно',
        createdAt: a.createdAt
      }))
  };
};

handlers['PATCH /api/groups/:groupId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  if (ctx.body.name !== undefined) group.name = str(ctx.body.name, 'name', { max: 80 });
  if (ctx.body.description !== undefined) {
    group.description = str(ctx.body.description, 'description', { max: 300, required: false });
  }
  if (ctx.body.currency !== undefined) group.currency = currencyCode(ctx.body.currency);
  logActivity(group.id, user.id, 'group.updated', `${user.name} изменил(а) настройки группы`);
  store.persist();
  return { group: shapeGroup(group, userMap()) };
};

handlers['DELETE /api/groups/:groupId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  if (group.ownerId !== user.id) throw new HttpError(403, 'Удалить группу может только её создатель');
  const d = db();
  d.groups = d.groups.filter((g) => g.id !== group.id);
  d.expenses = d.expenses.filter((e) => e.groupId !== group.id);
  d.settlements = d.settlements.filter((s) => s.groupId !== group.id);
  d.activity = d.activity.filter((a) => a.groupId !== group.id);
  store.persist();
  return { ok: true };
};

handlers['POST /api/groups/:groupId/members'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const email = str(ctx.body.email, 'email', { max: 120 }).toLowerCase();
  const found = auth.findUserByEmail(email);
  if (!found) throw new HttpError(404, 'Пользователь с таким email не зарегистрирован');
  if (group.memberIds.includes(found.id)) throw bad('Пользователь уже в группе');
  group.memberIds.push(found.id);
  logActivity(group.id, user.id, 'member.added', `${user.name} добавил(а) участника ${found.name}`);
  store.persist();
  return { group: shapeGroup(group, userMap()) };
};

handlers['DELETE /api/groups/:groupId/members/:userId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const target = ctx.params.userId;
  if (!group.memberIds.includes(target)) throw new HttpError(404, 'Участник не найден');
  if (target === group.ownerId) throw bad('Нельзя удалить создателя группы');
  if (user.id !== group.ownerId && user.id !== target) {
    throw new HttpError(403, 'Удалять участников может только создатель группы');
  }

  const expenses = groupExpenses(group.id);
  const settlements = groupSettlements(group.id);
  const involved =
    expenses.some((e) => e.payerId === target || e.shares.some((s) => s.userId === target)) ||
    settlements.some((s) => s.fromUserId === target || s.toUserId === target);
  if (involved) {
    const balances = computeBalances(group.memberIds, expenses, settlements);
    const nonZero = balances.some((c) => {
      const row = c.balances.find((b) => b.userId === target);
      return row && row.balance !== 0;
    });
    if (nonZero) throw bad('У участника ненулевой баланс — сначала рассчитайтесь');
  }

  const users = userMap();
  const name = users.get(target) ? users.get(target).name : 'участник';
  group.memberIds = group.memberIds.filter((uid) => uid !== target);
  logActivity(group.id, user.id, 'member.removed', `${user.name} удалил(а) участника ${name}`);
  store.persist();
  return { group: shapeGroup(group, userMap()) };
};

handlers['GET /api/groups/:groupId/expenses'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const users = userMap();
  let list = groupExpenses(group.id);
  const q = ctx.query;
  if (q.category) list = list.filter((e) => e.category === q.category);
  if (q.payerId) list = list.filter((e) => e.payerId === q.payerId);
  if (q.currency) list = list.filter((e) => e.currency === String(q.currency).toUpperCase());
  list = list.slice().sort((a, b) => ((a.date || a.createdAt) < (b.date || b.createdAt) ? 1 : -1));
  return { expenses: list.map((e) => shapeExpense(e, users)) };
};

handlers['POST /api/groups/:groupId/expenses'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);

  const description = str(ctx.body.description, 'description', { max: 160 });
  const amount = toMinor(ctx.body.amount, 'amount');
  if (amount <= 0) throw bad('Сумма расхода должна быть больше нуля');
  const currency = currencyCode(ctx.body.currency, group.currency);
  const category = str(ctx.body.category, 'category', { max: 60, required: false }) || 'Прочее';
  const payerId = str(ctx.body.payerId, 'payerId', { max: 60 });
  if (!group.memberIds.includes(payerId)) throw bad('Плательщик не состоит в группе');
  const date = ctx.body.date ? str(ctx.body.date, 'date', { max: 40 }) : now();

  const { splitType, shares } = buildShares(ctx.body, amount, group.memberIds);

  const expense = {
    id: id('exp'),
    groupId: group.id,
    description,
    amount,
    currency,
    category,
    payerId,
    splitType,
    shares,
    date,
    createdAt: now(),
    updatedAt: now(),
    createdBy: user.id
  };
  db().expenses.push(expense);
  const users = userMap();
  logActivity(
    group.id,
    user.id,
    'expense.added',
    `${user.name} добавил(а) расход «${description}» на ${fromMinor(amount)} ${currency}`,
    { expenseId: expense.id }
  );
  store.persist();
  return { expense: shapeExpense(expense, users) };
};

handlers['PUT /api/groups/:groupId/expenses/:expenseId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const expense = db().expenses.find((e) => e.id === ctx.params.expenseId && e.groupId === group.id);
  if (!expense) throw new HttpError(404, 'Расход не найден');

  const description = str(
    ctx.body.description === undefined ? expense.description : ctx.body.description,
    'description',
    { max: 160 }
  );
  const amount =
    ctx.body.amount === undefined ? expense.amount : toMinor(ctx.body.amount, 'amount');
  if (amount <= 0) throw bad('Сумма расхода должна быть больше нуля');
  const currency = currencyCode(ctx.body.currency, expense.currency);
  const category =
    str(ctx.body.category === undefined ? expense.category : ctx.body.category, 'category', {
      max: 60,
      required: false
    }) || 'Прочее';
  const payerId = str(
    ctx.body.payerId === undefined ? expense.payerId : ctx.body.payerId,
    'payerId',
    { max: 60 }
  );
  if (!group.memberIds.includes(payerId)) throw bad('Плательщик не состоит в группе');

  const splitInput =
    ctx.body.splitType || ctx.body.splits || ctx.body.participants
      ? ctx.body
      : { splitType: 'manual', splits: expense.shares.map((s) => ({ userId: s.userId, value: fromMinor(s.amount) })) };
  const { splitType, shares } = buildShares(splitInput, amount, group.memberIds);

  expense.description = description;
  expense.amount = amount;
  expense.currency = currency;
  expense.category = category;
  expense.payerId = payerId;
  expense.splitType = splitType;
  expense.shares = shares;
  if (ctx.body.date !== undefined) expense.date = str(ctx.body.date, 'date', { max: 40 });
  expense.updatedAt = now();

  logActivity(
    group.id,
    user.id,
    'expense.updated',
    `${user.name} изменил(а) расход «${description}»`,
    { expenseId: expense.id }
  );
  store.persist();
  return { expense: shapeExpense(expense, userMap()) };
};

handlers['DELETE /api/groups/:groupId/expenses/:expenseId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const d = db();
  const expense = d.expenses.find((e) => e.id === ctx.params.expenseId && e.groupId === group.id);
  if (!expense) throw new HttpError(404, 'Расход не найден');
  d.expenses = d.expenses.filter((e) => e.id !== expense.id);
  logActivity(
    group.id,
    user.id,
    'expense.deleted',
    `${user.name} удалил(а) расход «${expense.description}»`
  );
  store.persist();
  return { ok: true };
};

handlers['GET /api/groups/:groupId/balances'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const users = userMap();
  const balances = computeBalances(group.memberIds, groupExpenses(group.id), groupSettlements(group.id));
  const named = balances.map((c) => ({
    currency: c.currency,
    balances: c.balances.map((b) =>
      Object.assign({}, b, { userName: users.get(b.userId) ? users.get(b.userId).name : 'Неизвестно' })
    ),
    debts: c.debts.map((d) =>
      Object.assign({}, d, {
        fromName: users.get(d.from) ? users.get(d.from).name : 'Неизвестно',
        toName: users.get(d.to) ? users.get(d.to).name : 'Неизвестно'
      })
    )
  }));
  return { balances: named };
};

// Mark a debt as repaid.
handlers['POST /api/groups/:groupId/settlements'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const fromUserId = str(ctx.body.fromUserId, 'fromUserId', { max: 60 });
  const toUserId = str(ctx.body.toUserId, 'toUserId', { max: 60 });
  if (fromUserId === toUserId) throw bad('Плательщик и получатель совпадают');
  if (!group.memberIds.includes(fromUserId) || !group.memberIds.includes(toUserId)) {
    throw bad('Оба участника должны состоять в группе');
  }
  const amount = toMinor(ctx.body.amount, 'amount');
  if (amount <= 0) throw bad('Сумма платежа должна быть больше нуля');
  const currency = currencyCode(ctx.body.currency, group.currency);
  const note = str(ctx.body.note, 'note', { max: 200, required: false });

  const settlement = {
    id: id('stl'),
    groupId: group.id,
    fromUserId,
    toUserId,
    amount,
    currency,
    note,
    createdAt: now(),
    createdBy: user.id
  };
  db().settlements.push(settlement);
  const users = userMap();
  const fromName = users.get(fromUserId) ? users.get(fromUserId).name : '?';
  const toName = users.get(toUserId) ? users.get(toUserId).name : '?';
  logActivity(
    group.id,
    user.id,
    'settlement.added',
    `Долг погашен: ${fromName} → ${toName}, ${fromMinor(amount)} ${currency}`,
    { settlementId: settlement.id }
  );
  store.persist();
  return { settlement: shapeSettlement(settlement, users) };
};

handlers['DELETE /api/groups/:groupId/settlements/:settlementId'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const d = db();
  const settlement = d.settlements.find(
    (s) => s.id === ctx.params.settlementId && s.groupId === group.id
  );
  if (!settlement) throw new HttpError(404, 'Платёж не найден');
  d.settlements = d.settlements.filter((s) => s.id !== settlement.id);
  const users = userMap();
  const fromName = users.get(settlement.fromUserId) ? users.get(settlement.fromUserId).name : '?';
  const toName = users.get(settlement.toUserId) ? users.get(settlement.toUserId).name : '?';
  logActivity(
    group.id,
    user.id,
    'settlement.deleted',
    `${user.name} отменил(а) погашение долга ${fromName} → ${toName} на ${fromMinor(settlement.amount)} ${settlement.currency}`
  );
  store.persist();
  return { ok: true };
};

handlers['GET /api/groups/:groupId/activity'] = (ctx) => {
  const user = ctx.user();
  const group = getGroupForUser(ctx.params.groupId, user);
  const users = userMap();
  const limit = Math.min(Number(ctx.query.limit) || 100, 500);
  const items = db()
    .activity.filter((a) => a.groupId === group.id)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((a) => ({
      id: a.id,
      type: a.type,
      text: a.text,
      userId: a.userId,
      userName: users.get(a.userId) ? users.get(a.userId).name : 'Неизвестно',
      createdAt: a.createdAt
    }));
  return { activity: items };
};

const PUBLIC_ROUTES = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'GET /api/meta'
]);

module.exports = { handlers, PUBLIC_ROUTES, CATEGORIES };

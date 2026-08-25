'use strict';

const { fromMinor } = require('./util');

// Builds, per currency, the net balance of every member and the shortest list
// of transfers that settles the group.
//
// balance > 0  -> the group owes this member money (they overpaid)
// balance < 0  -> this member owes the group money
function computeBalances(memberIds, expenses, settlements) {
  const byCurrency = new Map();

  const bucket = (currency) => {
    if (!byCurrency.has(currency)) {
      const map = new Map();
      for (const uid of memberIds) map.set(uid, { paid: 0, owed: 0, settledOut: 0, settledIn: 0 });
      byCurrency.set(currency, map);
    }
    return byCurrency.get(currency);
  };

  const entry = (map, uid) => {
    if (!map.has(uid)) map.set(uid, { paid: 0, owed: 0, settledOut: 0, settledIn: 0 });
    return map.get(uid);
  };

  for (const e of expenses) {
    const map = bucket(e.currency);
    entry(map, e.payerId).paid += e.amount;
    for (const share of e.shares) {
      entry(map, share.userId).owed += share.amount;
    }
  }

  for (const s of settlements) {
    const map = bucket(s.currency);
    // `from` handed cash to `to`: it lifts from's debt and lowers to's credit.
    entry(map, s.fromUserId).settledOut += s.amount;
    entry(map, s.toUserId).settledIn += s.amount;
  }

  const result = [];
  for (const [currency, map] of byCurrency) {
    const balances = [];
    for (const [userId, v] of map) {
      const net = v.paid - v.owed + v.settledOut - v.settledIn;
      balances.push({
        userId,
        paid: v.paid,
        owed: v.owed,
        settled: v.settledOut - v.settledIn,
        balance: net,
        balanceText: fromMinor(net)
      });
    }
    balances.sort((a, b) => b.balance - a.balance || a.userId.localeCompare(b.userId));
    result.push({ currency, balances, debts: simplify(balances, currency) });
  }

  result.sort((a, b) => a.currency.localeCompare(b.currency));
  return result;
}

// Greedy largest-creditor / largest-debtor matching. Produces at most n-1
// transfers, which is the minimum number for the general case.
function simplify(balances, currency) {
  const creditors = balances
    .filter((b) => b.balance > 0)
    .map((b) => ({ userId: b.userId, amount: b.balance }));
  const debtors = balances
    .filter((b) => b.balance < 0)
    .map((b) => ({ userId: b.userId, amount: -b.balance }));

  creditors.sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));
  debtors.sort((a, b) => b.amount - a.amount || a.userId.localeCompare(b.userId));

  const debts = [];
  let ci = 0;
  let di = 0;
  let guard = 0;
  while (ci < creditors.length && di < debtors.length && guard++ < 10000) {
    const c = creditors[ci];
    const d = debtors[di];
    const amount = Math.min(c.amount, d.amount);
    if (amount > 0) {
      debts.push({
        from: d.userId,
        to: c.userId,
        amount,
        amountText: fromMinor(amount),
        currency
      });
    }
    c.amount -= amount;
    d.amount -= amount;
    if (c.amount === 0) ci += 1;
    if (d.amount === 0) di += 1;
  }
  return debts;
}

module.exports = { computeBalances };

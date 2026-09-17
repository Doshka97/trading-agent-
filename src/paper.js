'use strict';

const DEFAULTS = {
  enabled: true,
  autoTrade: true,
  initialBalance: 10000,
  currency: 'USD',
  riskPerTradePct: 1.0,
  leverage: 30,
  commissionPerTrade: 0,
  maxCurvePoints: 500,
  maxTrades: 200,
};

function cfgOf(paper) {
  return Object.assign({}, DEFAULTS, paper || {});
}

function createAccount(paper, time) {
  const cfg = cfgOf(paper);
  const t = time || Date.now();
  return {
    currency: cfg.currency,
    initialBalance: cfg.initialBalance,
    balance: cfg.initialBalance,
    position: null,
    trades: [],
    curve: [{ t, equity: cfg.initialBalance }],
    createdAt: new Date(t).toISOString(),
  };
}

function normalize(account, paper) {
  const cfg = cfgOf(paper);
  if (!account || typeof account !== 'object') return createAccount(cfg);
  const a = account;
  if (typeof a.balance !== 'number' || !isFinite(a.balance)) a.balance = cfg.initialBalance;
  if (typeof a.initialBalance !== 'number' || !isFinite(a.initialBalance)) a.initialBalance = cfg.initialBalance;
  if (!a.currency) a.currency = cfg.currency;
  if (!Array.isArray(a.trades)) a.trades = [];
  if (!Array.isArray(a.curve)) a.curve = [{ t: Date.now(), equity: a.balance }];
  if (a.position === undefined) a.position = null;
  return a;
}

function unrealized(pos, price) {
  if (!pos || typeof price !== 'number' || !isFinite(price)) return 0;
  return pos.side === 'long' ? (price - pos.entry) * pos.units : (pos.entry - price) * pos.units;
}

function equity(account) {
  let eq = account.balance;
  if (account.position) eq += unrealized(account.position, account.position.lastPrice);
  return eq;
}

function markPrice(account, symbol, price, time) {
  const cfg = { maxCurvePoints: DEFAULTS.maxCurvePoints };
  if (account.position && account.position.symbol === symbol && typeof price === 'number' && isFinite(price)) {
    account.position.lastPrice = price;
    const eq = equity(account);
    const last = account.curve[account.curve.length - 1];
    account.curve.push({ t: time || Date.now(), equity: eq });
    if (account.curve.length > cfg.maxCurvePoints) account.curve.splice(0, account.curve.length - cfg.maxCurvePoints);
    void last;
  }
  return account;
}

function openTrade(account, params, paper, time) {
  const cfg = cfgOf(paper);
  if (account.position) return { ok: false, reason: 'A position is already open (' + account.position.symbol + ')' };
  const { symbol, side, entry, stop, target, strategyName } = params;
  if (!symbol || !side) return { ok: false, reason: 'Missing symbol/side' };
  const riskPerUnit = Math.abs(entry - stop);
  if (!(riskPerUnit > 0) || !(entry > 0)) return { ok: false, reason: 'Invalid entry/stop' };

  const eq = equity(account);
  const riskAmount = eq * (cfg.riskPerTradePct / 100);
  let units = riskAmount / riskPerUnit;
  const maxNotional = eq * cfg.leverage;
  if (units * entry > maxNotional) units = maxNotional / entry;
  if (!(units > 0)) return { ok: false, reason: 'Computed size is zero' };

  const t = time || Date.now();
  account.position = {
    symbol,
    side,
    entry,
    stop,
    target,
    initialStop: stop,
    units,
    riskAmount: units * riskPerUnit,
    strategyName: strategyName || null,
    openedAt: new Date(t).toISOString(),
    openedTs: t,
    lastPrice: entry,
  };
  account.curve.push({ t, equity: eq });
  return { ok: true, position: account.position };
}

function closeTrade(account, price, reason, paper, time) {
  const cfg = cfgOf(paper);
  const pos = account.position;
  if (!pos) return { ok: false, reason: 'No open position' };
  const px = typeof price === 'number' && isFinite(price) ? price : pos.lastPrice;
  const gross = unrealized(pos, px);
  const pnl = gross - cfg.commissionPerTrade;
  account.balance += pnl;
  const t = time || Date.now();
  const trade = {
    symbol: pos.symbol,
    side: pos.side,
    entry: pos.entry,
    exit: px,
    stop: pos.stop,
    units: pos.units,
    pnl,
    rMultiple: pos.riskAmount ? gross / pos.riskAmount : 0,
    strategyName: pos.strategyName,
    openedAt: pos.openedAt,
    openedTs: pos.openedTs,
    closedAt: new Date(t).toISOString(),
    closedTs: t,
    reason: reason || 'Signal',
  };
  account.trades.unshift(trade);
  if (account.trades.length > cfg.maxTrades) account.trades.length = cfg.maxTrades;
  account.position = null;
  account.curve.push({ t, equity: account.balance });
  return { ok: true, trade };
}

function closeIfOtherSymbol(account, symbol, price, reason, paper, time) {
  if (account.position && account.position.symbol !== symbol) {
    return closeTrade(account, account.position.lastPrice, reason || 'Symbol changed', paper, time);
  }
  return { ok: false, reason: 'No cross-symbol position' };
}

function stats(account) {
  const closed = account.trades || [];
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = -Infinity;
  let maxDD = 0;
  for (const p of account.curve || []) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - p.equity) / peak);
  }
  const rs = closed.map((t) => t.rMultiple).filter((v) => typeof v === 'number' && isFinite(v));
  return {
    equity: equity(account),
    balance: account.balance,
    openPnl: account.position ? unrealized(account.position, account.position.lastPrice) : 0,
    totalPnl: account.balance - account.initialBalance,
    totalPnlPct: account.initialBalance ? ((account.balance - account.initialBalance) / account.initialBalance) * 100 : 0,
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDrawdownPct: maxDD * 100,
    bestR: rs.length ? Math.max.apply(null, rs) : 0,
    worstR: rs.length ? Math.min.apply(null, rs) : 0,
  };
}

module.exports = {
  DEFAULTS, cfgOf, createAccount, normalize, equity, unrealized,
  markPrice, openTrade, closeTrade, closeIfOtherSymbol, stats,
};

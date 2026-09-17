'use strict';

const DEFAULTS = {
  minEntryScore: 15,
  exitOnFlip: true,
  flipScore: 15,
  breakEvenAfterR: 1.0,
  useBarExtremes: true,
};

function sideOf(action) {
  const a = String(action || '').toUpperCase();
  if (a.includes('BUY')) return 'long';
  if (a.includes('SELL')) return 'short';
  return null;
}

function openPosition(analysis, price, config) {
  const side = sideOf(analysis.action);
  const lv = analysis.levels || {};
  const entry = lv.entry != null ? lv.entry : price;
  let stop = lv.stopLoss;
  let target = lv.takeProfit;
  if (stop == null || target == null) return null;
  if (side === 'long' && !(stop < entry && target > entry)) return null;
  if (side === 'short' && !(stop > entry && target < entry)) return null;
  return {
    side,
    entry,
    stop,
    initialStop: stop,
    target,
    strategy: analysis.strategy ? analysis.strategy.id : null,
    strategyName: analysis.strategy ? analysis.strategy.name : null,
    entryScore: analysis.score,
    entryAction: analysis.action,
    openedAt: new Date().toISOString(),
    breakEvenMoved: false,
  };
}

function exitAt(position, price, reason, bar) {
  const long = position.side === 'long';
  const risk = Math.abs(position.entry - position.initialStop) || 1;
  const pnl = long ? price - position.entry : position.entry - price;
  return {
    position: null,
    event: 'EXIT',
    message: reason,
    exit: {
      side: position.side,
      entry: position.entry,
      price,
      reason,
      time: (bar && bar.time) || Date.now(),
      pnl,
      pnlPct: position.entry ? (pnl / position.entry) * 100 : 0,
      rMultiple: pnl / risk,
      strategyName: position.strategyName,
    },
  };
}

function evaluate({ analysis, price, position, config, bar, manualExit }) {
  const cfg = Object.assign({}, DEFAULTS, (config && config.signals) || {});
  const px = typeof price === 'number' && isFinite(price) ? price : null;
  if (px == null) return { position: position || null, event: 'NONE', message: 'No price', exit: null };

  if (!position) {
    if (!analysis || !analysis.ok) return { position: null, event: 'NONE', message: '', exit: null };
    const side = sideOf(analysis.action);
    if (!side) return { position: null, event: 'NONE', message: '', exit: null };
    if (Math.abs(analysis.score) < cfg.minEntryScore) {
      return { position: null, event: 'NONE', message: 'Score below entry threshold (' + cfg.minEntryScore + ')', exit: null };
    }
    const pos = openPosition(analysis, px, cfg);
    if (!pos) return { position: null, event: 'NONE', message: 'No valid stop/target — cannot open', exit: null };
    return {
      position: pos,
      event: 'ENTRY',
      message: 'ENTRY ' + pos.side.toUpperCase() + ' at ' + fmt(px) + ' | SL ' + fmt(pos.stop) + ' | TP ' + fmt(pos.target),
      exit: null,
    };
  }

  const long = position.side === 'long';
  const barHigh = cfg.useBarExtremes && bar ? bar.high : px;
  const barLow = cfg.useBarExtremes && bar ? bar.low : px;
  const risk = Math.abs(position.entry - position.initialStop) || 1;

  if (manualExit) return exitAt(position, px, 'Manual exit', bar);

  if (cfg.breakEvenAfterR > 0 && !position.breakEvenMoved) {
    const moved = long
      ? barHigh >= position.entry + risk * cfg.breakEvenAfterR
      : barLow <= position.entry - risk * cfg.breakEvenAfterR;
    if (moved) {
      position = Object.assign({}, position, { stop: position.entry, breakEvenMoved: true });
    }
  }

  if (long) {
    if (cfg.useBarExtremes && barLow <= position.stop) return exitAt(position, position.stop, position.breakEvenMoved && position.stop >= position.entry ? 'Stop loss hit (breakeven)' : 'Stop loss hit', bar);
    if (!cfg.useBarExtremes && px <= position.stop) return exitAt(position, position.stop, 'Stop loss hit', bar);
    if (cfg.useBarExtremes && barHigh >= position.target) return exitAt(position, position.target, 'Take profit hit', bar);
    if (!cfg.useBarExtremes && px >= position.target) return exitAt(position, position.target, 'Take profit hit', bar);
  } else {
    if (cfg.useBarExtremes && barHigh >= position.stop) return exitAt(position, position.stop, position.breakEvenMoved && position.stop <= position.entry ? 'Stop loss hit (breakeven)' : 'Stop loss hit', bar);
    if (!cfg.useBarExtremes && px >= position.stop) return exitAt(position, position.stop, 'Stop loss hit', bar);
    if (cfg.useBarExtremes && barLow <= position.target) return exitAt(position, position.target, 'Take profit hit', bar);
    if (!cfg.useBarExtremes && px <= position.target) return exitAt(position, position.target, 'Take profit hit', bar);
  }

  if (cfg.exitOnFlip && analysis && analysis.ok) {
    const opp = long ? 'short' : 'long';
    const nowSide = sideOf(analysis.action);
    if (nowSide === opp && Math.abs(analysis.score) >= cfg.flipScore) {
      return exitAt(position, px, 'Signal reversed — strategy now favours ' + opp.toUpperCase(), bar);
    }
  }

  const pnl = long ? px - position.entry : position.entry - px;
  return {
    position,
    event: 'HOLD',
    message: 'HOLDING ' + position.side.toUpperCase() + ' | P&L ' + (pnl >= 0 ? '+' : '') + fmt(pnl) +
      ' (' + (pnl / risk).toFixed(2) + 'R) | SL ' + fmt(position.stop) + ' | TP ' + fmt(position.target),
    exit: null,
  };
}

function adopt(pos) {
  if (!pos || !pos.side || pos.entry == null) return null;
  const initialStop = pos.initialStop != null ? pos.initialStop : pos.stop;
  if (initialStop == null || pos.target == null) return null;
  return {
    side: pos.side,
    entry: pos.entry,
    stop: pos.stop != null ? pos.stop : initialStop,
    initialStop,
    target: pos.target,
    strategy: pos.strategy || null,
    strategyName: pos.strategyName || null,
    entryScore: pos.entryScore != null ? pos.entryScore : null,
    entryAction: pos.entryAction || null,
    openedAt: pos.openedAt || new Date().toISOString(),
    openedTs: pos.openedTs || null,
    breakEvenMoved: !!pos.breakEvenMoved,
    adopted: true,
  };
}

function fmt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '--';
  const abs = Math.abs(v);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  let s = v.toFixed(d);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

module.exports = { evaluate, adopt, sideOf, DEFAULTS };

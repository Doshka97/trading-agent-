'use strict';

const rules = require('./rules');

function backtest({ candles, rules: rulesCfg, strategy, initialBalance, riskPerTradePct, commissionPerTrade }) {
  const bal = typeof initialBalance === 'number' && initialBalance > 0 ? initialBalance : 10000;
  const riskPct = typeof riskPerTradePct === 'number' && riskPerTradePct > 0 ? riskPerTradePct : 1.0;
  const comm = typeof commissionPerTrade === 'number' && commissionPerTrade >= 0 ? commissionPerTrade : 0;

  if (!candles || candles.length < 80) {
    return { ok: false, error: 'Need at least 80 candles for backtest (got ' + (candles ? candles.length : 0) + ')' };
  }

  const sorted = candles.slice().sort((a, b) => a.time - b.time);
  const warmup = Math.max(rulesCfg.emaSlow || 50, rulesCfg.emaTrend || 50, rulesCfg.macdSlow || 26, rulesCfg.atrPeriod || 14, 55) + 10;

  let balance = bal;
  let position = null;
  const trades = [];
  const curve = [{ t: sorted[0].time, equity: bal }];
  let peak = bal;
  let maxDD = 0;

  for (let i = warmup; i < sorted.length; i++) {
    const window = sorted.slice(0, i + 1);
    const bar = sorted[i];
    const price = bar.close;

    let analysis;
    try {
      analysis = rules.analyze({ candles: window, rules: rulesCfg, sentimentScore: 0, price, strategy });
    } catch (e) {
      continue;
    }

    if (!position) {
      if (!analysis || !analysis.ok) continue;
      const side = analysis.action && analysis.action.includes('BUY') ? 'long'
        : analysis.action && analysis.action.includes('SELL') ? 'short' : null;
      if (!side) continue;
      if (Math.abs(analysis.score) < 15) continue;

      const lv = analysis.levels || {};
      const entry = lv.entry != null ? lv.entry : price;
      const stop = lv.stopLoss;
      const target = lv.takeProfit;
      if (stop == null || target == null) continue;
      if (side === 'long' && !(stop < entry && target > entry)) continue;
      if (side === 'short' && !(stop > entry && target < entry)) continue;

      const riskPerUnit = Math.abs(entry - stop);
      if (!(riskPerUnit > 0)) continue;

      const riskAmount = balance * (riskPct / 100);
      let units = riskAmount / riskPerUnit;
      const maxNotional = balance * 30;
      if (units * entry > maxNotional) units = maxNotional / entry;
      if (!(units > 0)) continue;

      position = {
        side,
        entry,
        stop,
        initialStop: stop,
        target,
        units,
        riskAmount: units * riskPerUnit,
        strategyName: analysis.strategy ? analysis.strategy.name : null,
        barIndex: i,
        openedAt: bar.time,
        breakEvenMoved: false,
      };
    } else {
      const long = position.side === 'long';
      const risk = Math.abs(position.entry - position.initialStop) || 1;

      if (riskPerTradePct > 0 && !position.breakEvenMoved) {
        const moved = long
          ? bar.high >= position.entry + risk * 1.0
          : bar.low <= position.entry - risk * 1.0;
        if (moved) {
          position.stop = position.entry;
          position.breakEvenMoved = true;
        }
      }

      let exitPrice = null;
      let exitReason = null;

      if (long) {
        if (bar.low <= position.stop) { exitPrice = position.stop; exitReason = position.breakEvenMoved && position.stop >= position.entry ? 'Breakeven' : 'Stop loss'; }
        else if (bar.high >= position.target) { exitPrice = position.target; exitReason = 'Take profit'; }
      } else {
        if (bar.high >= position.stop) { exitPrice = position.stop; exitReason = position.breakEvenMoved && position.stop <= position.entry ? 'Breakeven' : 'Stop loss'; }
        else if (bar.low <= position.target) { exitPrice = position.target; exitReason = 'Take profit'; }
      }

      if (!exitPrice && analysis && analysis.ok) {
        const opp = long ? 'short' : 'long';
        const nowSide = analysis.action && analysis.action.includes('BUY') ? 'long'
          : analysis.action && analysis.action.includes('SELL') ? 'short' : null;
        if (nowSide === opp && Math.abs(analysis.score) >= 15) {
          exitPrice = price;
          exitReason = 'Signal flip';
        }
      }

      if (!exitPrice && i === sorted.length - 1) {
        exitPrice = price;
        exitReason = 'End of data';
      }

      if (exitPrice != null) {
        const gross = long ? (exitPrice - position.entry) * position.units : (position.entry - exitPrice) * position.units;
        const pnl = gross - comm;
        balance += pnl;
        const rMult = position.riskAmount ? gross / position.riskAmount : 0;

        trades.push({
          side: position.side,
          entry: position.entry,
          exit: exitPrice,
          stop: position.initialStop,
          target: position.target,
          units: position.units,
          pnl,
          rMultiple: rMult,
          reason: exitReason,
          strategyName: position.strategyName,
          openedAt: position.openedAt,
          closedAt: bar.time,
          bars: i - position.barIndex,
        });

        if (balance > peak) peak = balance;
        const dd = peak > 0 ? (peak - balance) / peak : 0;
        if (dd > maxDD) maxDD = dd;

        curve.push({ t: bar.time, equity: balance });
        position = null;
      }
    }
  }

  if (position) {
    const last = sorted[sorted.length - 1];
    const long = position.side === 'long';
    const gross = long ? (last.close - position.entry) * position.units : (position.entry - last.close) * position.units;
    const pnl = gross - comm;
    balance += pnl;
    trades.push({
      side: position.side,
      entry: position.entry,
      exit: last.close,
      stop: position.initialStop,
      target: position.target,
      units: position.units,
      pnl,
      rMultiple: position.riskAmount ? gross / position.riskAmount : 0,
      reason: 'End of data (forced close)',
      strategyName: position.strategyName,
      openedAt: position.openedAt,
      closedAt: last.time,
      bars: sorted.length - 1 - position.barIndex,
    });
    curve.push({ t: last.time, equity: balance });
    position = null;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const rs = trades.map((t) => t.rMultiple).filter((v) => typeof v === 'number' && isFinite(v));
  const avgR = rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : 0;
  const avgBars = trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0;

  let sharpe = 0;
  if (curve.length > 2) {
    const returns = [];
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1].equity;
      if (prev > 0) returns.push((curve[i].equity - prev) / prev);
    }
    if (returns.length > 1) {
      const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
      const variance = returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (returns.length - 1);
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    }
  }

  return {
    ok: true,
    initialBalance: bal,
    finalBalance: balance,
    totalPnl: balance - bal,
    totalPnlPct: bal ? ((balance - bal) / bal) * 100 : 0,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    maxDrawdownPct: maxDD * 100,
    avgR,
    bestR: rs.length ? Math.max.apply(null, rs) : 0,
    worstR: rs.length ? Math.min.apply(null, rs) : 0,
    avgBarsPerTrade: avgBars,
    sharpe,
    trades: trades.slice(-200),
    curve,
  };
}

module.exports = { backtest };

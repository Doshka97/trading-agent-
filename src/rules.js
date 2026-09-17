'use strict';

const I = require('./indicators');
const S = require('./strategies');

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function toAction(score, thresholds) {
  if (score >= thresholds.strongBuy) return 'STRONG BUY';
  if (score >= thresholds.buy) return 'BUY';
  if (score <= thresholds.strongSell) return 'STRONG SELL';
  if (score <= thresholds.sell) return 'SELL';
  return 'NEUTRAL';
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function firstNum() {
  for (let i = 0; i < arguments.length; i++) {
    const v = num(arguments[i]);
    if (v !== null) return v;
  }
  return null;
}

function makePlan(dir, entry, stopRaw, targetRaw, atrV, note) {
  const long = dir === 'long';
  const maxRisk = atrV * 2.5;
  const minRisk = atrV * 0.8;
  let stop = num(stopRaw);
  if (stop === null) stop = entry + (long ? -1.5 : 1.5) * atrV;
  let risk = Math.abs(entry - stop);
  if (risk < minRisk || risk > maxRisk) {
    risk = clamp(risk, minRisk, maxRisk);
    stop = entry + (long ? -risk : risk);
  }
  let target = num(targetRaw);
  const minTarget = entry + (long ? risk * 1.5 : -risk * 1.5);
  if (target === null || (long ? target < minTarget : target > minTarget)) target = minTarget;
  return {
    entry,
    stopLoss: stop,
    takeProfit: target,
    direction: dir,
    atr: atrV,
    riskReward: Math.abs(target - entry) / risk,
    note: note,
  };
}

function computeLevels(ctx, price, action, rules, strategyId) {
  const atrV = ctx.atr[ctx.last] || 0;
  const isLong = action.includes('BUY');
  const isShort = action.includes('SELL');
  const n = ctx.last;
  const hi20 = num(ctx.don20.upper[n]);
  const lo20 = num(ctx.don20.lower[n]);
  const bbUp = num(ctx.bb.upper[n]);
  const bbMid = num(ctx.bb.middle[n]);
  const bbLo = num(ctx.bb.lower[n]);
  const vwap = num(ctx.vwapArr[n]);
  const kijun = num(ctx.ichimoku.kijun[n]);
  const tenkan = num(ctx.ichimoku.tenkan[n]);
  const senkouA = num(ctx.ichimoku.senkouA[n]);
  const senkouB = num(ctx.ichimoku.senkouB[n]);
  const emaFast = num(ctx.emaFast[n]);
  const emaSlow = num(ctx.emaSlow[n]);
  const emaTrend = num(ctx.emaTrend[n]);
  const { swingHigh, swingLow } = ctx.swing;
  const pv = I.pivotPoints(ctx.candles[n].high, ctx.candles[n].low, ctx.candles[n].close);

  const base = {
    entry: price,
    stopLoss: null,
    takeProfit: null,
    direction: 'none',
    atr: atrV,
    riskReward: null,
    note: '',
  };
  if ((!isLong && !isShort) || atrV <= 0) {
    base.note = 'No valid setup — score is neutral. Wait for a strategy to trigger before entering.';
    return base;
  }
  const dir = isLong ? 'long' : 'short';

  switch (strategyId) {
    case 'breakout_donchian': {
      const entry = isLong
        ? Math.max(price, hi20 !== null ? hi20 : price)
        : Math.min(price, lo20 !== null ? lo20 : price);
      const stop = isLong
        ? firstNum(lo20 !== null ? lo20 - atrV * 0.25 : null, entry - atrV * 2)
        : firstNum(hi20 !== null ? hi20 + atrV * 0.25 : null, entry + atrV * 2);
      const range = (hi20 !== null && lo20 !== null) ? hi20 - lo20 : atrV * 4;
      const target = isLong ? entry + Math.max(range, atrV * 2) : entry - Math.max(range, atrV * 2);
      return makePlan(dir, entry, stop, target, atrV,
        'Turtle breakout: enter on the ' + (isLong ? '20-bar high' : '20-bar low') +
        ' break, protective stop on the opposite channel, target = channel range projection.');
    }
    case 'trend_ema': {
      const stop = isLong
        ? firstNum(swingLow - atrV * 0.25, emaSlow, emaTrend, price - atrV * 1.5)
        : firstNum(swingHigh + atrV * 0.25, emaSlow, emaTrend, price + atrV * 1.5);
      const target = isLong
        ? firstNum(hi20 !== null && hi20 > price ? hi20 : null, price + atrV * 3)
        : firstNum(lo20 !== null && lo20 < price ? lo20 : null, price - atrV * 3);
      return makePlan(dir, price, stop, target, atrV,
        'Trend following: enter in the direction of the EMA ribbon, stop beyond the last swing / EMA-50, target the recent channel extreme.');
    }
    case 'momentum': {
      const stop = isLong
        ? firstNum(emaSlow, emaFast, price - atrV * 1.5)
        : firstNum(emaSlow, emaFast, price + atrV * 1.5);
      const target = isLong
        ? firstNum(swingHigh !== null && swingHigh > price + atrV ? swingHigh : null, price + atrV * 3)
        : firstNum(swingLow !== null && swingLow < price - atrV ? swingLow : null, price - atrV * 3);
      return makePlan(dir, price, stop, target, atrV,
        'Momentum: enter on the MACD/RSI trigger, stop just past the EMA that would invalidate the move, target the swing / 1:2 risk.');
    }
    case 'meanrev_bollinger': {
      const entry = price;
      const stop = isLong
        ? firstNum(bbLo !== null ? bbLo - atrV * 1 : null, price - atrV * 1.5)
        : firstNum(bbUp !== null ? bbUp + atrV * 1 : null, price + atrV * 1.5);
      const target = isLong
        ? firstNum(bbMid, bbUp)
        : firstNum(bbMid, bbLo);
      return makePlan(dir, entry, stop, target, atrV,
        'Mean reversion: fade the ' + (isLong ? 'lower' : 'upper') +
        ' band, stop one ATR beyond the band, target the Bollinger midline (mean).');
    }
    case 'ichimoku': {
      const stop = isLong
        ? firstNum(kijun !== null ? kijun - atrV * 0.5 : null, tenkan !== null ? tenkan - atrV * 0.5 : null, price - atrV * 1.5)
        : firstNum(kijun !== null ? kijun + atrV * 0.5 : null, tenkan !== null ? tenkan + atrV * 0.5 : null, price + atrV * 1.5);
      const cloudTop = (senkouA !== null && senkouB !== null) ? Math.max(senkouA, senkouB) : null;
      const cloudBot = (senkouA !== null && senkouB !== null) ? Math.min(senkouA, senkouB) : null;
      const target = isLong
        ? firstNum(price + Math.abs(price - (firstNum(kijun, price))) * 2, price + atrV * 3)
        : firstNum(price - Math.abs(price - (firstNum(kijun, price))) * 2, price - atrV * 3);
      return makePlan(dir, price, stop, target, atrV,
        'Ichimoku: enter on the cloud breakout with Tenkan/Kijun aligned, stop at the Kijun-sen' +
        (cloudTop !== null ? ', target 2x the Kijun distance (cloud ' + cloudBot.toFixed(2) + '–' + cloudTop.toFixed(2) + ')' : ', target 2x the Kijun distance') + '.');
    }
    case 'vwap_volume': {
      const stop = isLong
        ? firstNum(vwap !== null ? vwap - atrV : null, price - atrV * 1.5)
        : firstNum(vwap !== null ? vwap + atrV : null, price + atrV * 1.5);
      const target = isLong
        ? firstNum(hi20 !== null && hi20 > price ? hi20 : null, price + atrV * 3)
        : firstNum(lo20 !== null && lo20 < price ? lo20 : null, price - atrV * 3);
      return makePlan(dir, price, stop, target, atrV,
        'VWAP/volume: enter on the VWAP side with OBV confirmation, stop one ATR through VWAP (invalidation), target the volume profile extreme.');
    }
    case 'sr_fib': {
      const stop = isLong
        ? firstNum(swingLow - atrV * 0.5, pv.s1 - atrV * 0.25, price - atrV * 1.5)
        : firstNum(swingHigh + atrV * 0.5, pv.r1 + atrV * 0.25, price + atrV * 1.5);
      const target = isLong
        ? firstNum(pv.r2, swingHigh, pv.r1, price + atrV * 3)
        : firstNum(pv.s2, swingLow, pv.s1, price - atrV * 3);
      return makePlan(dir, price, stop, target, atrV,
        'Support/Resistance: enter on the level reaction, stop just beyond the ' +
        (isLong ? 'support' : 'resistance') + ', target the next pivot / swing level.');
    }
    case 'price_action': {
      const stop = isLong
        ? firstNum(swingLow - atrV * 0.5, price - atrV * 1.5)
        : firstNum(swingHigh + atrV * 0.5, price + atrV * 1.5);
      const target = isLong ? price + Math.abs(price - stop) * 2.5 : price - Math.abs(price - stop) * 2.5;
      return makePlan(dir, price, stop, target, atrV,
        'Price action: enter on the structure/pattern signal, stop beyond the invalidation swing, target a 1:2.5 measured move.');
    }
    default: {
      const structuralStop = isLong
        ? firstNum(swingLow - atrV * 0.25, emaTrend, price - atrV * 1.5)
        : firstNum(swingHigh + atrV * 0.25, emaTrend, price + atrV * 1.5);
      const channelTarget = isLong
        ? firstNum(hi20 !== null && hi20 > price ? hi20 : null, price + atrV * 3)
        : firstNum(lo20 !== null && lo20 < price ? lo20 : null, price - atrV * 3);
      return makePlan(dir, price, structuralStop, channelTarget, atrV,
        'Confluence: aggregate of all strategies. Stop beyond swing structure, target the channel extreme, confirm with news sentiment.');
    }
  }
}

function analyze({ candles, rules, sentimentScore, price, strategy }) {
  const result = {
    ok: false,
    error: null,
    action: 'NEUTRAL',
    score: 0,
    reasons: [],
    indicators: null,
    levels: null,
    strategy: null,
    regime: null,
    breakdown: null,
    agreement: null,
    updatedAt: null,
  };

  try {
    const minBars = Math.max(rules.emaSlow, rules.emaTrend, rules.macdSlow, rules.atrPeriod, rules.rsiPeriod, 55) + 10;
    if (!candles || candles.length < minBars) {
      result.error = 'Not enough candles for analysis yet (' + (candles ? candles.length : 0) + '/' + minBars + ').';
      return result;
    }

    const ctx = S.buildContext(candles, rules);
    const lastPrice = price || ctx.closes[ctx.last];
    const reg = S.regime(ctx);

    let pick = strategy || (rules.strategy) || 'confluence';
    if (pick === 'auto') pick = reg === 'range' ? 'meanrev_bollinger' : 'trend_ema';

    let outcome;
    if (pick === 'confluence') {
      outcome = S.runConfluence(ctx, rules.strategyWeights);
    } else {
      outcome = S.runStrategy(pick, ctx);
      if (!outcome) outcome = S.runConfluence(ctx, rules.strategyWeights);
    }

    const reasons = outcome.reasons.slice();
    let score = outcome.score;

    const sentimentW = rules.weights && rules.weights.sentiment != null ? rules.weights.sentiment : 0.2;
    if (typeof sentimentScore === 'number' && sentimentScore !== 0) {
      const newsVal = clamp(sentimentScore / 100, -1, 1);
      score = clamp(score + newsVal * sentimentW * 100, -100, 100);
      reasons.push({
        label: 'News',
        detail: 'News sentiment ' + (sentimentScore >= 0 ? '+' : '') + sentimentScore.toFixed(0) + ' / 100',
        value: newsVal,
      });
    }

    score = Math.round(score);
    const action = toAction(score, rules.thresholds);

    result.ok = true;
    result.action = action;
    result.score = score;
    result.reasons = reasons;
    result.strategy = { id: outcome.id, name: outcome.name };
    result.regime = reg;
    result.breakdown = outcome.breakdown || null;
    result.agreement = outcome.agreement || null;
    result.indicators = {
      price: lastPrice,
      emaFast: ctx.emaFast[ctx.last],
      emaSlow: ctx.emaSlow[ctx.last],
      emaTrend: ctx.emaTrend[ctx.last],
      ema200: ctx.ema200[ctx.last],
      rsi: ctx.rsi[ctx.last],
      macdLine: ctx.macd.line[ctx.last],
      macdSignal: ctx.macd.signal[ctx.last],
      macdHistogram: ctx.macd.histogram[ctx.last],
      atr: ctx.atr[ctx.last],
      adx: ctx.adx.adx[ctx.last],
      plusDI: ctx.adx.plusDI[ctx.last],
      minusDI: ctx.adx.minusDI[ctx.last],
      bbUpper: ctx.bb.upper[ctx.last],
      bbMiddle: ctx.bb.middle[ctx.last],
      bbLower: ctx.bb.lower[ctx.last],
      bbWidth: ctx.bb.width[ctx.last],
      stochK: ctx.stoch.k[ctx.last],
      stochD: ctx.stoch.d[ctx.last],
      williamsR: ctx.willR[ctx.last],
      cci: ctx.cci[ctx.last],
      mfi: ctx.mfi[ctx.last],
      vwap: ctx.vwapArr[ctx.last],
      obv: ctx.obvArr[ctx.last],
      volumeRatio: ctx.volSma[ctx.last] ? ctx.volumes[ctx.last] / ctx.volSma[ctx.last] : null,
      donchianUpper: ctx.don20.upper[ctx.last],
      donchianLower: ctx.don20.lower[ctx.last],
      tenkan: ctx.ichimoku.tenkan[ctx.last],
      kijun: ctx.ichimoku.kijun[ctx.last],
      senkouA: ctx.ichimoku.senkouA[ctx.last],
      senkouB: ctx.ichimoku.senkouB[ctx.last],
    };
    result.levels = computeLevels(ctx, lastPrice, action, rules, outcome.id);
    if (result.levels && action === 'NEUTRAL') {
      const ef = ctx.emaFast[ctx.last];
      const es = ctx.emaSlow[ctx.last];
      const bias = score !== 0 ? score > 0 : (ef != null && es != null ? ef >= es : null);
      if (bias !== null) {
        const biasAction = bias ? 'BUY' : 'SELL';
        result.levels = computeLevels(ctx, lastPrice, biasAction, rules, outcome.id);
        result.levels.conditional = true;
        result.levels.direction = bias ? 'long' : 'short';
        result.levels.note = 'Conditional plan — no signal yet (bias is ' + (bias ? 'bullish' : 'bearish') +
          '). ' + result.levels.note;
      }
    }
    result.updatedAt = new Date().toISOString();
    return result;
  } catch (err) {
    result.error = err.message;
    return result;
  }
}

module.exports = { analyze, toAction, clamp, SET: I };

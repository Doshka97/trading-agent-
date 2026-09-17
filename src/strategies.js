'use strict';

const I = require('./indicators');

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

const STRATEGIES = [
  { id: 'confluence', name: 'Confluence (all strategies)', category: 'blend' },
  { id: 'trend_ema', name: 'Trend Following (EMA ribbon + ADX)', category: 'trend' },
  { id: 'breakout_donchian', name: 'Turtle Breakout (Donchian 20/55)', category: 'breakout' },
  { id: 'momentum', name: 'Momentum (MACD + RSI + Stochastic)', category: 'momentum' },
  { id: 'meanrev_bollinger', name: 'Mean Reversion (Bollinger + RSI)', category: 'reversion' },
  { id: 'ichimoku', name: 'Ichimoku Cloud', category: 'trend' },
  { id: 'vwap_volume', name: 'VWAP + Volume/OBV', category: 'volume' },
  { id: 'sr_fib', name: 'Support/Resistance + Fibonacci', category: 'structure' },
  { id: 'price_action', name: 'Price Action + Structure', category: 'structure' },
];

function buildContext(candles, rules) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume || 0);
  const p = rules;
  const last = candles.length - 1;
  const prev = last - 1;
  return {
    candles, closes, highs, lows, volumes, last, prev,
    emaFast: I.ema(closes, p.emaFast),
    emaSlow: I.ema(closes, p.emaSlow),
    emaTrend: I.ema(closes, p.emaTrend),
    ema200: I.ema(closes, 200),
    rsi: I.rsi(closes, p.rsiPeriod),
    macd: I.macd(closes, p.macdFast, p.macdSlow, p.macdSignal),
    atr: I.atr(highs, lows, closes, p.atrPeriod),
    volSma: I.sma(volumes, p.volumeSmaPeriod),
    bb: I.bollinger(closes, p.bbPeriod || 20, p.bbMult || 2),
    stoch: I.stochastic(highs, lows, closes, p.stochK || 14, p.stochD || 3),
    adx: I.adx(highs, lows, closes, p.adxPeriod || 14),
    obvArr: I.obv(closes, volumes),
    vwapArr: I.vwap(highs, lows, closes, volumes, p.vwapPeriod || 20),
    don20: I.donchian(highs, lows, p.donchianFast || 20),
    don55: I.donchian(highs, lows, p.donchianSlow || 55),
    ichimoku: I.ichimoku(highs, lows, closes, 9, 26, 52),
    willR: I.williamsR(highs, lows, closes, 14),
    cci: I.cci(highs, lows, closes, 20),
    mfi: I.mfi(highs, lows, closes, volumes, 14),
    swing: I.swingLevels(highs, lows, p.swingLookback || 60),
  };
}

function val(ctx, arr) {
  return arr[ctx.last] === undefined ? null : arr[ctx.last];
}

function volumeRatio(ctx) {
  const vs = ctx.volSma[ctx.last];
  return vs ? ctx.volumes[ctx.last] / vs : null;
}

function regime(ctx) {
  const adxv = val(ctx, ctx.adx.adx);
  if (adxv === null) return 'unknown';
  if (adxv >= 25) return 'trend';
  if (adxv <= 20) return 'range';
  return 'transition';
}

function findPivots(series, lookback, type) {
  const n = series.length;
  const from = Math.max(2, n - lookback);
  const idx = [];
  for (let i = from; i < n - 1; i++) {
    if (type === 'low') {
      if (series[i] < series[i - 1] && series[i] < series[i + 1]) idx.push(i);
    } else {
      if (series[i] > series[i - 1] && series[i] > series[i + 1]) idx.push(i);
    }
  }
  return idx;
}

function rsiDivergence(ctx) {
  const rsiVals = ctx.rsi;
  const lowsIdx = findPivots(ctx.lows, 50, 'low');
  const highsIdx = findPivots(ctx.highs, 50, 'high');
  if (lowsIdx.length >= 2) {
    const a = lowsIdx[lowsIdx.length - 2];
    const b = lowsIdx[lowsIdx.length - 1];
    if (rsiVals[a] !== null && rsiVals[b] !== null && ctx.lows[b] < ctx.lows[a] && rsiVals[b] > rsiVals[a] + 1.5) {
      return { type: 'bullish', detail: 'Bullish RSI divergence (price lower low, RSI higher low)' };
    }
  }
  if (highsIdx.length >= 2) {
    const a = highsIdx[highsIdx.length - 2];
    const b = highsIdx[highsIdx.length - 1];
    if (rsiVals[a] !== null && rsiVals[b] !== null && ctx.highs[b] > ctx.highs[a] && rsiVals[b] < rsiVals[a] - 1.5) {
      return { type: 'bearish', detail: 'Bearish RSI divergence (price higher high, RSI lower high)' };
    }
  }
  return null;
}

function candlePattern(ctx) {
  const c = ctx.candles[ctx.last];
  const prev = ctx.candles[ctx.prev];
  if (!c || !prev) return null;
  const body = Math.abs(c.close - c.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const up = c.close > c.open;
  const prevUp = prev.close > prev.open;
  const topWick = c.high - Math.max(c.close, c.open);
  const bottomWick = Math.min(c.close, c.open) - c.low;
  if (body > 0 && prevBody > 0 && up && !prevUp && c.close > prev.open && c.open < prev.close) {
    return { type: 'bullish', detail: 'Bullish engulfing candle' };
  }
  if (body > 0 && prevBody > 0 && !up && prevUp && c.close < prev.open && c.open > prev.close) {
    return { type: 'bearish', detail: 'Bearish engulfing candle' };
  }
  if (body > 0 && bottomWick > body * 2 && topWick < body) {
    return { type: 'bullish', detail: 'Hammer / long lower wick (buyers defended)' };
  }
  if (body > 0 && topWick > body * 2 && bottomWick < body) {
    return { type: 'bearish', detail: 'Shooting star / long upper wick (sellers rejected)' };
  }
  return null;
}

/* ------------------------- strategies ------------------------- */

function stratTrendEma(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const fast = val(ctx, ctx.emaFast);
  const slow = val(ctx, ctx.emaSlow);
  const trend = val(ctx, ctx.emaTrend);
  const e200 = val(ctx, ctx.ema200);
  const adxv = val(ctx, ctx.adx.adx);
  const pdi = val(ctx, ctx.adx.plusDI);
  const mdi = val(ctx, ctx.adx.minusDI);
  let s = 0;
  if (fast > slow) { s += 30; reasons.push({ label: 'Trend', detail: 'EMA fast above EMA slow (bullish alignment)', value: 0.6 }); }
  else { s -= 30; reasons.push({ label: 'Trend', detail: 'EMA fast below EMA slow (bearish alignment)', value: -0.6 }); }
  if (price > trend) { s += 25; reasons.push({ label: 'Trend', detail: 'Price above EMA trend', value: 0.5 }); }
  else { s -= 25; reasons.push({ label: 'Trend', detail: 'Price below EMA trend', value: -0.5 }); }
  if (e200 !== null) {
    if (price > e200) { s += 15; reasons.push({ label: 'Trend', detail: 'Price above EMA 200 (primary uptrend)', value: 0.3 }); }
    else { s -= 15; reasons.push({ label: 'Trend', detail: 'Price below EMA 200 (primary downtrend)', value: -0.3 }); }
  }
  if (adxv !== null) {
    if (adxv >= 25 && pdi > mdi) { s += 20; reasons.push({ label: 'Trend', detail: 'ADX ' + adxv.toFixed(0) + ' with +DI>-DI (strong uptrend)', value: 0.4 }); }
    else if (adxv >= 25 && mdi > pdi) { s -= 20; reasons.push({ label: 'Trend', detail: 'ADX ' + adxv.toFixed(0) + ' with -DI>+DI (strong downtrend)', value: -0.4 }); }
    else { s *= 0.7; reasons.push({ label: 'Trend', detail: 'ADX ' + adxv.toFixed(0) + ' (weak/choppy trend — reduced conviction)', value: 0 }); }
  }
  return { score: clamp(s, -100, 100), reasons };
}

function stratBreakout(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const p = ctx.prev;
  const hi20 = ctx.don20.upper[p];
  const lo20 = ctx.don20.lower[p];
  const hi55 = ctx.don55.upper[p];
  const lo55 = ctx.don55.lower[p];
  const vr = volumeRatio(ctx);
  let s = 0;
  if (hi20 !== null && price > hi20) {
    s += 50;
    reasons.push({ label: 'Breakout', detail: 'Close above 20-bar high (' + hi20.toFixed(2) + ')', value: 0.8 });
    if (vr && vr >= 1.5) { s += 20; reasons.push({ label: 'Breakout', detail: 'Breakout confirmed by volume ' + vr.toFixed(2) + 'x', value: 0.4 }); }
  } else if (lo20 !== null && price < lo20) {
    s -= 50;
    reasons.push({ label: 'Breakout', detail: 'Close below 20-bar low (' + lo20.toFixed(2) + ')', value: -0.8 });
    if (vr && vr >= 1.5) { s -= 20; reasons.push({ label: 'Breakout', detail: 'Breakdown confirmed by volume ' + vr.toFixed(2) + 'x', value: -0.4 }); }
  } else {
    const distUp = hi20 ? (hi20 - price) / price : null;
    const distDown = lo20 ? (price - lo20) / price : null;
    if (distUp !== null && distDown !== null) {
      if (distUp < distDown) { s += 10; reasons.push({ label: 'Breakout', detail: 'Coiling just under 20-bar high (setup)', value: 0.2 }); }
      else { s -= 10; reasons.push({ label: 'Breakout', detail: 'Coiling just above 20-bar low (setup)', value: -0.2 }); }
    }
  }
  if (hi55 !== null && price > hi55 && s > 0) { s += 15; reasons.push({ label: 'Breakout', detail: 'Also above 55-bar high (Turtle long)', value: 0.3 }); }
  if (lo55 !== null && price < lo55 && s < 0) { s -= 15; reasons.push({ label: 'Breakout', detail: 'Also below 55-bar low (Turtle short)', value: -0.3 }); }
  return { score: clamp(s, -100, 100), reasons };
}

function stratMomentum(ctx) {
  const reasons = [];
  const rsiV = val(ctx, ctx.rsi);
  const line = val(ctx, ctx.macd.line);
  const sig = val(ctx, ctx.macd.signal);
  const hist = val(ctx, ctx.macd.histogram);
  const histPrev = ctx.macd.histogram[ctx.prev];
  const k = val(ctx, ctx.stoch.k);
  const d = val(ctx, ctx.stoch.d);
  let s = 0;
  if (line !== null && sig !== null) {
    const crossUp = ctx.macd.line[ctx.prev] !== null && ctx.macd.line[ctx.prev] <= ctx.macd.signal[ctx.prev] && line > sig;
    const crossDown = ctx.macd.line[ctx.prev] !== null && ctx.macd.line[ctx.prev] >= ctx.macd.signal[ctx.prev] && line < sig;
    if (crossUp) { s += 35; reasons.push({ label: 'Momentum', detail: 'MACD bullish crossover', value: 0.8 }); }
    else if (crossDown) { s -= 35; reasons.push({ label: 'Momentum', detail: 'MACD bearish crossover', value: -0.8 }); }
    else if (hist !== null && hist > 0) { s += 15; reasons.push({ label: 'Momentum', detail: 'MACD histogram positive', value: 0.3 }); }
    else if (hist !== null && hist < 0) { s -= 15; reasons.push({ label: 'Momentum', detail: 'MACD histogram negative', value: -0.3 }); }
    if (hist !== null && histPrev !== null) {
      if (hist > histPrev) s += 5; else s -= 5;
    }
  }
  if (rsiV !== null) {
    if (rsiV >= 70) { s -= 20; reasons.push({ label: 'Momentum', detail: 'RSI ' + rsiV.toFixed(0) + ' overbought', value: -0.4 }); }
    else if (rsiV <= 30) { s += 20; reasons.push({ label: 'Momentum', detail: 'RSI ' + rsiV.toFixed(0) + ' oversold', value: 0.4 }); }
    else if (rsiV > 55) { s += 15; reasons.push({ label: 'Momentum', detail: 'RSI ' + rsiV.toFixed(0) + ' bullish', value: 0.3 }); }
    else if (rsiV < 45) { s -= 15; reasons.push({ label: 'Momentum', detail: 'RSI ' + rsiV.toFixed(0) + ' bearish', value: -0.3 }); }
  }
  if (k !== null && d !== null) {
    if (k > d && k < 80) { s += 15; reasons.push({ label: 'Momentum', detail: 'Stochastic %K above %D (rising)', value: 0.3 }); }
    else if (k < d && k > 20) { s -= 15; reasons.push({ label: 'Momentum', detail: 'Stochastic %K below %D (falling)', value: -0.3 }); }
    else if (k >= 80) { s -= 10; reasons.push({ label: 'Momentum', detail: 'Stochastic overbought', value: -0.2 }); }
    else if (k <= 20) { s += 10; reasons.push({ label: 'Momentum', detail: 'Stochastic oversold', value: 0.2 }); }
  }
  return { score: clamp(s, -100, 100), reasons };
}

function stratMeanReversion(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const upper = val(ctx, ctx.bb.upper);
  const lower = val(ctx, ctx.bb.lower);
  const mid = val(ctx, ctx.bb.middle);
  const rsiV = val(ctx, ctx.rsi);
  const wr = val(ctx, ctx.willR);
  const reg = regime(ctx);
  let s = 0;
  if (lower !== null && upper !== null) {
    if (price <= lower) { s += 45; reasons.push({ label: 'Reversion', detail: 'Price at/below lower Bollinger band', value: 0.8 }); }
    else if (price >= upper) { s -= 45; reasons.push({ label: 'Reversion', detail: 'Price at/above upper Bollinger band', value: -0.8 }); }
    else {
      const pos = (price - lower) / (upper - lower);
      if (pos < 0.2) { s += 20; reasons.push({ label: 'Reversion', detail: 'Price near lower band', value: 0.4 }); }
      else if (pos > 0.8) { s -= 20; reasons.push({ label: 'Reversion', detail: 'Price near upper band', value: -0.4 }); }
    }
  }
  if (rsiV !== null) {
    if (rsiV <= 30) { s += 25; reasons.push({ label: 'Reversion', detail: 'RSI oversold (<30)', value: 0.5 }); }
    else if (rsiV >= 70) { s -= 25; reasons.push({ label: 'Reversion', detail: 'RSI overbought (>70)', value: -0.5 }); }
  }
  if (wr !== null) {
    if (wr <= -80) { s += 15; reasons.push({ label: 'Reversion', detail: 'Williams %R oversold', value: 0.3 }); }
    else if (wr >= -20) { s -= 15; reasons.push({ label: 'Reversion', detail: 'Williams %R overbought', value: -0.3 }); }
  }
  if (reg === 'trend') {
    s *= 0.4;
    reasons.push({ label: 'Reversion', detail: 'Trending regime (ADX high) — mean reversion de-weighted', value: 0 });
  }
  if (mid !== null && Math.abs(price - mid) / mid < 0.002) {
    reasons.push({ label: 'Reversion', detail: 'Price at Bollinger mid (mean) — no edge', value: 0 });
    s *= 0.3;
  }
  return { score: clamp(s, -100, 100), reasons };
}

function stratIchimoku(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const t = val(ctx, ctx.ichimoku.tenkan);
  const k = val(ctx, ctx.ichimoku.kijun);
  const a = val(ctx, ctx.ichimoku.senkouA);
  const b = val(ctx, ctx.ichimoku.senkouB);
  let s = 0;
  if (a !== null && b !== null) {
    const cloudTop = Math.max(a, b);
    const cloudBottom = Math.min(a, b);
    if (price > cloudTop) { s += 35; reasons.push({ label: 'Ichimoku', detail: 'Price above the cloud (bullish)', value: 0.7 }); }
    else if (price < cloudBottom) { s -= 35; reasons.push({ label: 'Ichimoku', detail: 'Price below the cloud (bearish)', value: -0.7 }); }
    else { reasons.push({ label: 'Ichimoku', detail: 'Price inside the cloud (indecision)', value: 0 }); }
  }
  if (t !== null && k !== null) {
    if (t > k) { s += 30; reasons.push({ label: 'Ichimoku', detail: 'Tenkan-sen above Kijun-sen (bullish)', value: 0.6 }); }
    else { s -= 30; reasons.push({ label: 'Ichimoku', detail: 'Tenkan-sen below Kijun-sen (bearish)', value: -0.6 }); }
  }
  if (b !== null) {
    if (price > b) { s += 15; reasons.push({ label: 'Ichimoku', detail: 'Price above Senkou Span B', value: 0.3 }); }
    else { s -= 15; reasons.push({ label: 'Ichimoku', detail: 'Price below Senkou Span B', value: -0.3 }); }
  }
  return { score: clamp(s, -100, 100), reasons };
}

function stratVwapVolume(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const vw = val(ctx, ctx.vwapArr);
  const vr = volumeRatio(ctx);
  const mfiV = val(ctx, ctx.mfi);
  const obvNow = ctx.obvArr[ctx.last];
  const obvAgo = ctx.obvArr[Math.max(0, ctx.last - 10)];
  let s = 0;
  if (vw !== null) {
    if (price > vw) { s += 30; reasons.push({ label: 'Volume', detail: 'Price above VWAP (buyers in control)', value: 0.6 }); }
    else { s -= 30; reasons.push({ label: 'Volume', detail: 'Price below VWAP (sellers in control)', value: -0.6 }); }
  }
  if (obvNow > obvAgo) { s += 25; reasons.push({ label: 'Volume', detail: 'On-Balance Volume rising', value: 0.5 }); }
  else if (obvNow < obvAgo) { s -= 25; reasons.push({ label: 'Volume', detail: 'On-Balance Volume falling', value: -0.5 }); }
  if (vr !== null && vr >= 1.5) {
    const up = ctx.candles[ctx.last].close >= ctx.candles[ctx.last].open;
    s += up ? 20 : -20;
    reasons.push({ label: 'Volume', detail: 'Volume spike ' + vr.toFixed(2) + 'x on ' + (up ? 'up' : 'down') + ' candle', value: up ? 0.4 : -0.4 });
  }
  if (mfiV !== null) {
    if (mfiV >= 60) { s += 15; reasons.push({ label: 'Volume', detail: 'Money Flow Index ' + mfiV.toFixed(0) + ' (inflow)', value: 0.3 }); }
    else if (mfiV <= 40) { s -= 15; reasons.push({ label: 'Volume', detail: 'Money Flow Index ' + mfiV.toFixed(0) + ' (outflow)', value: -0.3 }); }
  }
  return { score: clamp(s, -100, 100), reasons };
}

function stratSrFib(ctx) {
  const reasons = [];
  const price = ctx.closes[ctx.last];
  const pv = I.pivotPoints(ctx.candles[ctx.prev].high, ctx.candles[ctx.prev].low, ctx.candles[ctx.prev].close);
  const { swingHigh, swingLow } = ctx.swing;
  const fib = I.fibonacci(swingLow, swingHigh);
  const atrV = val(ctx, ctx.atr) || (price * 0.005);
  let s = 0;
  if (price > pv.pivot) { s += 15; reasons.push({ label: 'Levels', detail: 'Price above daily pivot (' + pv.pivot.toFixed(2) + ')', value: 0.3 }); }
  else { s -= 15; reasons.push({ label: 'Levels', detail: 'Price below daily pivot (' + pv.pivot.toFixed(2) + ')', value: -0.3 }); }
  const nearS1 = Math.abs(price - pv.s1) < atrV;
  const nearR1 = Math.abs(price - pv.r1) < atrV;
  if (nearS1) { s += 25; reasons.push({ label: 'Levels', detail: 'Price at pivot support S1', value: 0.5 }); }
  if (nearR1) { s -= 25; reasons.push({ label: 'Levels', detail: 'Price at pivot resistance R1', value: -0.5 }); }
  const fibLevels = [0.382, 0.5, 0.618];
  for (const r of fibLevels) {
    const lvl = swingHigh - (swingHigh - swingLow) * r;
    if (Math.abs(price - lvl) < atrV * 0.8) {
      const inUptrend = ctx.closes[ctx.last] > val(ctx, ctx.emaTrend);
      if (inUptrend) {
        s += 20; reasons.push({ label: 'Levels', detail: 'Price at Fibonacci ' + (r * 100).toFixed(1) + '% retracement (support in uptrend)', value: 0.4 });
      } else {
        s -= 20; reasons.push({ label: 'Levels', detail: 'Price at Fibonacci ' + (r * 100).toFixed(1) + '% retracement (resistance in downtrend)', value: -0.4 });
      }
      break;
    }
  }
  if (Math.abs(price - swingLow) < atrV) { s += 20; reasons.push({ label: 'Levels', detail: 'Testing recent swing low', value: 0.4 }); }
  if (Math.abs(price - swingHigh) < atrV) { s -= 20; reasons.push({ label: 'Levels', detail: 'Testing recent swing high', value: -0.4 }); }
  return { score: clamp(s, -100, 100), reasons, pivots: pv, fib, swing: { swingHigh, swingLow } };
}

function stratPriceAction(ctx) {
  const reasons = [];
  const n = ctx.last;
  let s = 0;
  const recentHighs = ctx.highs.slice(Math.max(0, n - 9), n + 1);
  const priorHighs = ctx.highs.slice(Math.max(0, n - 19), Math.max(0, n - 9));
  const recentLows = ctx.lows.slice(Math.max(0, n - 9), n + 1);
  const priorLows = ctx.lows.slice(Math.max(0, n - 19), Math.max(0, n - 9));
  if (recentHighs.length && priorHighs.length) {
    const rh = Math.max.apply(null, recentHighs);
    const ph = Math.max.apply(null, priorHighs);
    const rl = Math.min.apply(null, recentLows);
    const pl = Math.min.apply(null, priorLows);
    if (rh > ph && rl > pl) { s += 30; reasons.push({ label: 'Structure', detail: 'Higher highs & higher lows (uptrend)', value: 0.6 }); }
    else if (rh < ph && rl < pl) { s -= 30; reasons.push({ label: 'Structure', detail: 'Lower highs & lower lows (downtrend)', value: -0.6 }); }
    else {
      const mid = (rh + rl) / 2;
      const price = ctx.closes[ctx.last];
      if (price > mid) { s += 12; reasons.push({ label: 'Structure', detail: 'Price in upper half of range (mild bullish bias)', value: 0.25 }); }
      else { s -= 12; reasons.push({ label: 'Structure', detail: 'Price in lower half of range (mild bearish bias)', value: -0.25 }); }
    }
  }
  const pat = candlePattern(ctx);
  if (pat) { s += pat.type === 'bullish' ? 20 : -20; reasons.push({ label: 'Structure', detail: pat.detail, value: pat.type === 'bullish' ? 0.4 : -0.4 }); }
  const div = rsiDivergence(ctx);
  if (div) { s += div.type === 'bullish' ? 25 : -25; reasons.push({ label: 'Structure', detail: div.detail, value: div.type === 'bullish' ? 0.5 : -0.5 }); }
  return { score: clamp(s, -100, 100), reasons };
}

const RUNNERS = {
  trend_ema: stratTrendEma,
  breakout_donchian: stratBreakout,
  momentum: stratMomentum,
  meanrev_bollinger: stratMeanReversion,
  ichimoku: stratIchimoku,
  vwap_volume: stratVwapVolume,
  sr_fib: stratSrFib,
  price_action: stratPriceAction,
};

function runStrategy(id, ctx) {
  const fn = RUNNERS[id];
  if (!fn) return null;
  const out = fn(ctx);
  return Object.assign({ id, name: (STRATEGIES.find((x) => x.id === id) || {}).name || id }, out);
}

function defaultWeights() {
  return {
    trend_ema: 1.2,
    breakout_donchian: 1.0,
    momentum: 1.0,
    meanrev_bollinger: 0.8,
    ichimoku: 1.0,
    vwap_volume: 0.9,
    sr_fib: 0.8,
    price_action: 0.9,
  };
}

function runConfluence(ctx, weights) {
  const w = Object.assign(defaultWeights(), weights || {});
  const reg = regime(ctx);
  const results = [];
  let weightedSum = 0;
  let weightTotal = 0;
  const reasons = [];
  for (const id of Object.keys(RUNNERS)) {
    const res = runStrategy(id, ctx);
    if (!res) continue;
    let weight = w[id] != null ? w[id] : 1;
    if (reg === 'trend' && (id === 'meanrev_bollinger')) weight *= 0.5;
    if (reg === 'range' && (id === 'trend_ema' || id === 'breakout_donchian' || id === 'ichimoku')) weight *= 0.6;
    results.push({ id, name: res.name, score: res.score });
    weightedSum += res.score * weight;
    weightTotal += weight;
  }
  const composite = weightTotal ? weightedSum / weightTotal : 0;
  const forCount = results.filter((r) => r.score > 8).length;
  const againstCount = results.filter((r) => r.score < -8).length;
  const total = results.length || 1;
  const bullFrac = forCount / total;
  const bearFrac = againstCount / total;
  const best = results.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 6);
  for (const b of best) {
    if (Math.abs(b.score) < 10) continue;
    reasons.push({ label: b.name, detail: b.name + ' score ' + Math.round(b.score), value: clamp(b.score / 100, -1, 1) });
  }
  reasons.push({
    label: 'Agreement',
    detail: forCount + ' bullish / ' + againstCount + ' bearish of ' + total + ' strategies',
    value: clamp(bullFrac - bearFrac, -1, 1),
  });
  return {
    id: 'confluence',
    name: 'Confluence',
    score: clamp(Math.round(composite), -100, 100),
    reasons,
    regime: reg,
    breakdown: results,
    agreement: { bullish: forCount, bearish: againstCount, total, bullFrac, bearFrac },
  };
}

function runAll(ctx) {
  const results = {};
  for (const id of Object.keys(RUNNERS)) results[id] = runStrategy(id, ctx);
  return results;
}

module.exports = {
  STRATEGIES, buildContext, runStrategy, runConfluence, runAll,
  regime, rsiDivergence, candlePattern, defaultWeights,
};
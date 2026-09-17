'use strict';

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function macd(closes, fastPeriod, slowPeriod, signalPeriod) {
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const line = closes.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? fast[i] - slow[i] : null
  );
  const start = line.findIndex((v) => v !== null);
  if (start === -1) return { line, signal: new Array(closes.length).fill(null), histogram: new Array(closes.length).fill(null) };
  const trimmed = line.slice(start);
  const signal = sma(trimmed, signalPeriod);
  const signalFull = new Array(closes.length).fill(null);
  for (let i = 0; i < signal.length; i++) signalFull[start + i] = signal[i];
  const histogram = closes.map((_, i) =>
    line[i] !== null && signalFull[i] !== null ? line[i] - signalFull[i] : null
  );
  return { line, signal: signalFull, histogram };
}

function trueRange(highs, lows, closes) {
  const out = new Array(highs.length).fill(null);
  if (highs.length === 0) return out;
  out[0] = highs[0] - lows[0];
  for (let i = 1; i < highs.length; i++) {
    const prevClose = closes[i - 1];
    out[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
  }
  return out;
}

function atr(highs, lows, closes, period) {
  const tr = trueRange(highs, lows, closes);
  const out = new Array(tr.length).fill(null);
  let prev = 0;
  let count = 0;
  for (let i = 0; i < tr.length; i++) {
    if (tr[i] === null) continue;
    if (i < period) {
      prev += tr[i];
      count++;
      if (count === period) {
        prev /= period;
        out[i] = prev;
      }
    } else {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

function smaNullable(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null || values[i] === undefined) continue;
    sum += values[i];
    count++;
    if (count > period) {
      sum -= values[i - period];
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

function bollinger(closes, period, mult) {
  const middle = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (middle[i] === null) continue;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - middle[i];
      sumSq += d * d;
    }
    const sd = Math.sqrt(sumSq / period);
    upper[i] = middle[i] + sd * mult;
    lower[i] = middle[i] - sd * mult;
    width[i] = middle[i] ? ((upper[i] - lower[i]) / middle[i]) * 100 : null;
  }
  return { middle, upper, lower, width };
}

function stochastic(highs, lows, closes, kPeriod, dPeriod) {
  const k = new Array(closes.length).fill(null);
  for (let i = kPeriod - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    k[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
  }
  const d = smaNullable(k, dPeriod);
  return { k, d };
}

function adx(highs, lows, closes, period) {
  const n = closes.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
    const pc = closes[i - 1];
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc));
  }
  const adxArr = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < period * 2 + 1) return { adx: adxArr, plusDI, minusDI };
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += plusDM[i];
    mS += minusDM[i];
  }
  let dxSum = 0;
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i];
    pS = pS - pS / period + plusDM[i];
    mS = mS - mS / period + minusDM[i];
    const pDI = trS === 0 ? 0 : (pS / trS) * 100;
    const mDI = trS === 0 ? 0 : (mS / trS) * 100;
    plusDI[i] = pDI;
    minusDI[i] = mDI;
    const sum = pDI + mDI;
    const dx = sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100;
    if (i < period * 2) {
      dxSum += dx;
    } else if (i === period * 2) {
      dxSum += dx;
      adxArr[i] = dxSum / period;
    } else {
      adxArr[i] = (adxArr[i - 1] * (period - 1) + dx) / period;
    }
  }
  return { adx: adxArr, plusDI, minusDI };
}

function obv(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  let run = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) run += volumes[i] || 0;
    else if (closes[i] < closes[i - 1]) run -= volumes[i] || 0;
    out[i] = run;
  }
  return out;
}

function vwap(highs, lows, closes, volumes, period) {
  const out = new Array(closes.length).fill(null);
  let pv = 0;
  let vv = 0;
  let start = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    pv += tp * (volumes[i] || 0);
    vv += volumes[i] || 0;
    if (period && i - start + 1 > period) {
      const oldTp = (highs[start] + lows[start] + closes[start]) / 3;
      pv -= oldTp * (volumes[start] || 0);
      vv -= volumes[start] || 0;
      start++;
    }
    out[i] = vv === 0 ? null : pv / vv;
  }
  return out;
}

function donchian(highs, lows, period) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(lows.length).fill(null);
  const middle = new Array(highs.length).fill(null);
  for (let i = period - 1; i < highs.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    upper[i] = hh;
    lower[i] = ll;
    middle[i] = (hh + ll) / 2;
  }
  return { upper, lower, middle };
}

function ichimoku(highs, lows, closes, conversion, base, spanB) {
  const n = closes.length;
  const tenkan = new Array(n).fill(null);
  const kijun = new Array(n).fill(null);
  const senkouB = new Array(n).fill(null);
  function midline(i, period) {
    if (i < period - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    return (hh + ll) / 2;
  }
  for (let i = 0; i < n; i++) {
    tenkan[i] = midline(i, conversion);
    kijun[i] = midline(i, base);
    senkouB[i] = midline(i, spanB);
  }
  const senkouA = tenkan.map((t, i) => (t !== null && kijun[i] !== null ? (t + kijun[i]) / 2 : null));
  return { tenkan, kijun, senkouA, senkouB };
}

function williamsR(highs, lows, closes, period) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    out[i] = hh === ll ? -50 : ((hh - closes[i]) / (hh - ll)) * -100;
  }
  return out;
}

function cci(highs, lows, closes, period) {
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const ma = sma(tp, period);
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - ma[i]);
    dev /= period;
    out[i] = dev === 0 ? 0 : (tp[i] - ma[i]) / (0.015 * dev);
  }
  return out;
}

function mfi(highs, lows, closes, volumes, period) {
  const n = closes.length;
  const pos = new Array(n).fill(0);
  const neg = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const ptp = (highs[i - 1] + lows[i - 1] + closes[i - 1]) / 3;
    const flow = tp * (volumes[i] || 0);
    if (tp > ptp) pos[i] = flow;
    else if (tp < ptp) neg[i] = flow;
  }
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    let p = 0;
    let ng = 0;
    for (let j = i - period + 1; j <= i; j++) {
      p += pos[j];
      ng += neg[j];
    }
    out[i] = ng === 0 ? 100 : 100 - 100 / (1 + p / ng);
  }
  return out;
}

function pivotPoints(high, low, close) {
  const pivot = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot,
    r1: 2 * pivot - low,
    r2: pivot + range,
    r3: high + 2 * (pivot - low),
    s1: 2 * pivot - high,
    s2: pivot - range,
    s3: low - 2 * (high - pivot),
  };
}

function fibonacci(swingLow, swingHigh) {
  const diff = swingHigh - swingLow;
  return {
    level0: swingHigh,
    level236: swingHigh - diff * 0.236,
    level382: swingHigh - diff * 0.382,
    level500: swingHigh - diff * 0.5,
    level618: swingHigh - diff * 0.618,
    level786: swingHigh - diff * 0.786,
    level100: swingLow,
  };
}

function swingLevels(highs, lows, lookback) {
  const n = highs.length;
  const from = Math.max(0, n - lookback);
  let swingHigh = -Infinity;
  let swingLow = Infinity;
  for (let i = from; i < n; i++) {
    if (highs[i] > swingHigh) swingHigh = highs[i];
    if (lows[i] < swingLow) swingLow = lows[i];
  }
  return { swingHigh, swingLow };
}

module.exports = {
  sma, ema, rsi, macd, atr, trueRange, smaNullable,
  bollinger, stochastic, adx, obv, vwap, donchian, ichimoku,
  williamsR, cci, mfi, pivotPoints, fibonacci, swingLevels,
};
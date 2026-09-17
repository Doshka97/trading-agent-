'use strict';

const $ = (sel) => document.querySelector(sel);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const state = {
  cfg: null,
  market: 'crypto',
  symbol: 'BTCUSDT',
  interval: '60',
  strategy: 'confluence',
  tvSymbol: 'BINANCE:BTCUSDT',
  apiSymbol: 'BTCUSDT',
  candles: [],
  price: null,
  analysis: null,
  news: null,
  lastAction: null,
  position: null,
  signals: [],
  chartNeedsFit: true,
  dealState: 'FLAT',
  paper: null,
  paperSaveTimer: null,
  timers: {},
  tickTimer: null,
  tickBusy: false,
  tickErr: 0,
  tickDelay: 1000,
  lastTickAt: null,
  liveBar: null,
  ws: null,
  wsKey: null,
  wsLive: false,
  wsRetry: 0,
  wsTimer: null,
  pendingLive: null,
  liveTimer: null,
  tickCount: 0,
  lastWsDataAt: 0,
  mt5: false,
  mt5Info: null,
  mt5Timer: null,
  analysisPending: false,
  analysisDirty: false,
  lastAnalysisAt: 0,
  acctSig: null,
  dragging: null,
  searchMap: {},
  searchTimer: null,
  chartGraceUntil: 0,
};

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _emaCalc(values, period) {
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

function _smaCalc(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function _bbCalc(closes, period, mult) {
  const mid = _smaCalc(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    if (mid[i] === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mid[i];
      sq += d * d;
    }
    const sd = Math.sqrt(sq / period);
    upper[i] = mid[i] + sd * mult;
    lower[i] = mid[i] - sd * mult;
  }
  return { middle: mid, upper, lower };
}

function _donCalc(highs, lows, period) {
  const upper = new Array(highs.length).fill(null);
  const lower = new Array(lows.length).fill(null);
  for (let i = period - 1; i < highs.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    upper[i] = hh;
    lower[i] = ll;
  }
  return { upper, lower };
}

const DEFAULT_SYMBOL = { crypto: 'BTCUSDT', stock: 'AAPL', gold: 'XAUUSD', forex: 'EURUSD' };

function normalizeSymbol(input, market) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return null;
  let tv;
  if (raw.includes(':')) {
    tv = raw;
  } else if (market === 'crypto') {
    tv = 'BINANCE:' + raw;
  } else if (market === 'gold') {
    tv = (raw === 'XAUUSD' || raw === 'GOLD' || raw === 'XAU') ? 'OANDA:XAUUSD' : raw;
  } else if (market === 'forex') {
    tv = 'FX:' + raw;
  } else {
    const ex = state.searchMap && state.searchMap[raw];
    const prefix = (ex && window.lib.exchangeToTv && window.lib.exchangeToTv[ex]) || null;
    tv = prefix ? prefix + ':' + raw : (raw.endsWith('.US') ? raw : 'NASDAQ:' + raw);
  }
  const api = raw.includes(':') ? raw.split(':')[1] : raw.replace(/\.US$/, '');
  return { tv, api, raw };
}

function buildTvUrl() {
  const c = state.cfg.chart;
  const rand = Math.random().toString(36).slice(2, 8);
  const p = new URLSearchParams({
    frameElementId: 'tradingview_' + rand,
    symbol: state.tvSymbol,
    interval: state.interval,
    theme: c.theme || 'dark',
    style: String(c.style || 1),
    locale: c.locale || 'en',
    timezone: 'Etc/UTC',
    withdateranges: '1',
    symboledit: '1',
    enable_publishing: '0',
    hideideas: '1',
  });
  return (c.host || 'https://s.tradingview.com/widgetembed/') + '?' + p.toString();
}

function sizeWebview() {
  const wv = $('#tv');
  if (!wv) return;
  wv.style.position = 'absolute';
  wv.style.top = '0';
  wv.style.left = '0';
  wv.style.width = window.innerWidth + 'px';
  wv.style.height = window.innerHeight + 'px';
}

/* ---------- signals chart (lightweight-charts) ---------- */
let lw = null;

function ensureSignalChart() {
  if (lw) return lw;
  if (!window.LightweightCharts) {
    toast('Signals chart library failed to load.');
    return null;
  }
  const el = $('#signalChart');
  const chart = window.LightweightCharts.createChart(el, {
    layout: { background: { color: '#0e1116' }, textColor: '#8b98a5' },
    grid: { vertLines: { color: '#1a222c' }, horzLines: { color: '#1a222c' } },
    rightPriceScale: { borderColor: '#24303c' },
    timeScale: { borderColor: '#24303c', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: window.LightweightCharts.CrosshairMode.Normal },
    handleScale: { axisPressedMouseMove: true },
  });
  const series = chart.addCandlestickSeries({
    upColor: '#22c55e',
    downColor: '#ef4444',
    borderVisible: false,
    wickUpColor: '#22c55e',
    wickDownColor: '#ef4444',
  });
  const LS = window.LightweightCharts.LineStyle;
  const makeLine = (c, opts) => chart.addLineSeries({
    color: c,
    lineWidth: opts.w || 1,
    lineStyle: opts.s || LS.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });
  const overlay = {
    emaFast: makeLine('#f59e0b', { w: 1 }),
    emaSlow: makeLine('#3b82f6', { w: 1 }),
    emaTrend: makeLine('#8b5cf6', { w: 2 }),
    bbUpper: makeLine('rgba(99,102,241,0.35)', { w: 1, s: LS.Dashed }),
    bbMiddle: makeLine('rgba(99,102,241,0.5)', { w: 1 }),
    bbLower: makeLine('rgba(99,102,241,0.35)', { w: 1, s: LS.Dashed }),
    donFastUpper: makeLine('rgba(34,197,94,0.4)', { w: 1, s: LS.Dotted }),
    donFastLower: makeLine('rgba(239,68,68,0.4)', { w: 1, s: LS.Dotted }),
    donSlowUpper: makeLine('rgba(34,197,94,0.25)', { w: 1, s: LS.Dotted }),
    donSlowLower: makeLine('rgba(239,68,68,0.25)', { w: 1, s: LS.Dotted }),
  };
  lw = { chart, series, overlay, lines: [], lastLine: null, legend: null };
  return lw;
}

function sizeSignalChart() {
  if (!lw) return;
  const el = $('#signalChart');
  if (!el || el.classList.contains('hidden')) return;
  lw.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
}

function candleTime(t) {
  const n = Math.floor(t / 1000);
  return Number.isFinite(n) ? n : null;
}

function intervalSeconds() {
  const v = String(state.interval || '').toUpperCase();
  if (v === 'D') return 86400;
  if (v === 'W') return 604800;
  const m = Number(v);
  return Number.isFinite(m) && m > 0 ? m * 60 : 60;
}

function snapToBar(ms, times) {
  if (!times || !times.length) return null;
  const sec = candleTime(ms);
  if (sec === null) return null;
  const tol = intervalSeconds() * 2;
  let best = null;
  let bestD = Infinity;
  for (const t of times) {
    const d = Math.abs(t - sec);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return bestD <= tol ? best : null;
}

function dealReasonText(reason) {
  const r = (reason || '').toLowerCase();
  if (r.indexOf('take profit') >= 0 || r === 'tp') return 'TP';
  if (r.indexOf('stop loss') >= 0 || r === 'sl') return 'SL';
  if (r.indexOf('flip') >= 0 || r.indexOf('revers') >= 0) return 'FLIP';
  if (r.indexOf('symbol changed') >= 0) return 'SYMBOL';
  if (r.indexOf('manual') >= 0) return 'MANUAL';
  return 'CLOSE';
}

function markerPrice(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  const d = Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 10 ? 2 : 5;
  return v.toFixed(d);
}

function buildMarkers(times) {
  const markers = [];
  const used = new Set();
  const entryTimes = new Set();
  const closeTimes = new Set();
  const push = (m) => {
    const key = m.time + '|' + m.text;
    if (used.has(key)) return;
    used.add(key);
    markers.push(m);
  };

  const paper = state.paper;
  for (const t of ((paper && paper.trades) || []).slice(0, 40)) {
    const long = t.side === 'long';
    const ot = snapToBar(t.openedTs, times);
    const ct = snapToBar(t.closedTs || Date.parse(t.closedAt), times);
    if (ot !== null && !entryTimes.has(ot)) {
      entryTimes.add(ot);
      push({
        time: ot,
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? '#22c55e' : '#ef4444',
        shape: long ? 'arrowUp' : 'arrowDown',
        text: (long ? 'LONG' : 'SHORT') + ' ' + markerPrice(t.entry),
      });
    }
    if (ct !== null && !closeTimes.has(ct)) {
      closeTimes.add(ct);
      const win = t.pnl >= 0;
      const r = typeof t.rMultiple === 'number' ? t.rMultiple : 0;
      push({
        time: ct,
        position: long ? 'aboveBar' : 'belowBar',
        color: win ? '#22c55e' : '#ef4444',
        shape: 'circle',
        text: 'CLOSE ' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R · ' + dealReasonText(t.reason),
      });
    }
  }

  const pos = paper && paper.position;
  if (pos) {
    const long = pos.side === 'long';
    const ot = snapToBar(pos.openedTs, times);
    if (ot !== null && !entryTimes.has(ot)) {
      entryTimes.add(ot);
      push({
        time: ot,
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? '#22c55e' : '#ef4444',
        shape: long ? 'arrowUp' : 'arrowDown',
        text: 'OPEN ' + (long ? 'LONG' : 'SHORT') + ' ' + markerPrice(pos.entry),
      });
    }
  }

  for (const s of state.signals) {
    const t = snapToBar(s.time, times);
    if (t === null) continue;
    const isEntry = s.type === 'ENTRY';
    if (isEntry && entryTimes.has(t)) continue;
    if (!isEntry && closeTimes.has(t)) continue;
    const long = s.side === 'long';
    const stratTag = s.strategyName ? ' [' + s.strategyName.split('(')[0].trim().substring(0, 8).toUpperCase() + ']' : '';
    push({
      time: t,
      position: long ? 'belowBar' : 'aboveBar',
      color: isEntry ? '#3b82f6' : '#f59e0b',
      shape: 'square',
      text: isEntry ? 'SIGNAL ' + s.side.toUpperCase() + stratTag : 'SIGNAL EXIT' + stratTag,
    });
  }

  markers.sort((a, b) => a.time - b.time);
  return markers;
}

function currentDeal() {
  const paper = state.paper;
  if (paper && paper.position) {
    const p = paper.position;
    return { entry: p.entry, stop: p.stop, target: p.target, side: p.side, open: true, live: true };
  }
  const p = state.position;
  if (p) return { entry: p.entry, stop: p.stop, target: p.target, side: p.side, open: true, live: false };
  const a = state.analysis;
  const lv = a && a.ok ? a.levels : null;
  if (lv) return { entry: lv.entry, stop: lv.stopLoss, target: lv.takeProfit, side: lv.side, open: false, live: false };
  return null;
}

function drawLevelLines() {
  const c = lw;
  if (!c) return [];
  const titles = [];
  for (const line of c.lines) {
    try { c.series.removePriceLine(line); } catch (err) { void err; }
  }
  c.lines = [];
  c.lastLine = null;
  const deal = currentDeal();
  if (!deal) return titles;
  const { entry, stop, target, open, live } = deal;
  const risk = Math.abs(entry - stop);
  const long = deal.side === 'long' || (risk && target > entry);
  const tpR = risk ? (long ? (target - entry) / risk : (entry - target) / risk) : null;
  const rr = (p, r) => (typeof r === 'number' && isFinite(r) ? ' (' + (r >= 0 ? '+' : '') + r.toFixed(2) + 'R)' : '');
  const LS = window.LightweightCharts.LineStyle;
  const add = (price, color, title, style, width) => {
    if (typeof price !== 'number' || !isFinite(price)) return null;
    titles.push(title);
    const line = c.series.createPriceLine({
      price,
      color,
      lineWidth: width,
      lineStyle: style,
      axisLabelVisible: true,
      title,
    });
    c.lines.push(line);
    return line;
  };
  const tag = live ? 'OPEN' : open ? 'DEAL' : 'PLAN';
  add(entry, '#38bdf8', 'ENTRY ' + markerPrice(entry) + ' · ' + tag, LS.Solid, 2);
  add(stop, '#ef4444', 'SL ' + markerPrice(stop) + rr(stop, -1), LS.Dashed, live ? 2 : 1);
  add(target, '#22c55e', 'TP ' + markerPrice(target) + rr(target, tpR), LS.Dashed, live ? 2 : open ? 2 : 1);
  if (live) {
    const price = typeof state.price === 'number' ? state.price : entry;
    c.lastLine = add(price, '#e2b93b', 'LAST ' + markerPrice(price), LS.Dotted, 1);
  }
  return titles;
}

function ensureLegend() {
  const el = $('#signalChart');
  if (!el || lw.legend) return;
  const div = document.createElement('div');
  div.className = 'lw-legend';
  el.appendChild(div);
  lw.legend = div;
}

function updateLegend() {
  if (!lw || !lw.legend) return;
  const a = state.analysis;
  const i = a && a.indicators;
  const deal = currentDeal();
  const ds = state.dealState || 'FLAT';
  let html = '<span class="lw-state ' + ds.toLowerCase() + '">' + ds + (deal && deal.open ? ' ' + deal.side.toUpperCase() : '') + '</span> ' +
    '<b>' + state.apiSymbol + '</b> · ' + state.interval + ' · ' +
    (a && a.strategy ? a.strategy.name : '') +
    (a && a.ok ? ' · <b>' + a.action + '</b> (' + a.score + ')' : '');
  const entry = deal ? deal.entry : null;
  const stop = deal ? deal.stop : null;
  const target = deal ? deal.target : null;
  const risk = Math.abs((entry || 0) - (stop || 0));
  const tpR = risk && typeof target === 'number' ? (deal.side === 'long' ? (target - entry) / risk : (entry - target) / risk) : null;
  html += '<br>Entry <b>' + fmtPrice(entry, state.apiSymbol) + '</b>' +
    ' · SL <b class="neg">' + fmtPrice(stop, state.apiSymbol) + '</b>' +
    ' · TP <b class="pos">' + fmtPrice(target, state.apiSymbol) + '</b>' +
    (tpR !== null ? ' · R:R ' + tpR.toFixed(2) : '');
  if (deal && deal.open) {
    const price = typeof state.price === 'number' ? state.price : entry;
    const pnl = deal.side === 'long' ? price - entry : entry - price;
    const r = risk ? pnl / risk : 0;
    html += '<br>P&L <b class="' + (pnl >= 0 ? 'pos' : 'neg') + '">' + (pnl >= 0 ? '+' : '') +
      fmtPrice(pnl, state.apiSymbol) + ' (' + r.toFixed(2) + 'R)</b>';
  } else {
    html += '<br>Awaiting entry signal';
  }
  if (i && i.rsi !== null && i.rsi !== undefined) {
    html += '<br>RSI ' + i.rsi.toFixed(1) + ' · ADX ' + (i.adx !== null && i.adx !== undefined ? i.adx.toFixed(1) : '–') +
      ' · ATR ' + (i.atr !== null && i.atr !== undefined ? i.atr.toFixed(i.atr < 1 ? 6 : 2) : '–');
  }
  html += '<br><span style="color:#f59e0b">\u2500</span> EMA9 ' +
    '<span style="color:#3b82f6">\u2500</span> EMA21 ' +
    '<span style="color:#8b5cf6">\u2500</span> EMA50 ' +
    '<span style="color:rgba(99,102,241,0.5)">\u2500</span> BB ' +
    '<span style="color:rgba(34,197,94,0.5)">···</span> Don20/55';
  lw.legend.innerHTML = html;
}

function updateOverlayData(candles, liveBar) {
  if (!lw || !lw.overlay) return;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const minBars = 60;
  if (closes.length < minBars) {
    for (const k of Object.keys(lw.overlay)) {
      try { lw.overlay[k].setData([]); } catch (e) { void e; }
    }
    return;
  }
  const emaF = _emaCalc(closes, 9);
  const emaS = _emaCalc(closes, 21);
  const emaT = _emaCalc(closes, 50);
  const bb = _bbCalc(closes, 20, 2);
  const donF = _donCalc(highs, lows, 20);
  const donS = _donCalc(highs, lows, 55);
  const seriesData = (arr) => {
    const d = [];
    for (let i = 0; i < candles.length; i++) {
      if (arr[i] !== null) d.push({ time: candleTime(candles[i].time), value: arr[i] });
    }
    if (liveBar && liveBar.time != null && arr.length > 0) {
      const lv = arr[arr.length - 1];
      if (lv !== null) d.push({ time: liveBar.time, value: lv });
    }
    return d;
  };
  const bbData = (arr) => {
    const d = [];
    for (let i = 0; i < candles.length; i++) {
      if (arr[i] !== null) d.push({ time: candleTime(candles[i].time), value: arr[i] });
    }
    return d;
  };
  try {
    lw.overlay.emaFast.setData(seriesData(emaF));
    lw.overlay.emaSlow.setData(seriesData(emaS));
    lw.overlay.emaTrend.setData(seriesData(emaT));
    lw.overlay.bbUpper.setData(bbData(bb.upper));
    lw.overlay.bbMiddle.setData(bbData(bb.middle));
    lw.overlay.bbLower.setData(bbData(bb.lower));
    lw.overlay.donFastUpper.setData(seriesData(donF.upper));
    lw.overlay.donFastLower.setData(seriesData(donF.lower));
    lw.overlay.donSlowUpper.setData(seriesData(donS.upper));
    lw.overlay.donSlowLower.setData(seriesData(donS.lower));
  } catch (e) { void e; }
}

function renderSignalsChart() {
  const c = ensureSignalChart();
  if (!c) return;
  const seen = new Set();
  const data = [];
  for (const k of state.candles || []) {
    const t = candleTime(k.time);
    if (t === null || seen.has(t)) continue;
    if (![k.open, k.high, k.low, k.close].every((v) => typeof v === 'number' && isFinite(v))) continue;
    seen.add(t);
    data.push({ time: t, open: k.open, high: k.high, low: k.low, close: k.close });
  }
  data.sort((a, b) => a.time - b.time);
  if (state.liveBar && (!data.length || state.liveBar.time > data[data.length - 1].time)) {
    data.push({ time: state.liveBar.time, open: state.liveBar.open, high: state.liveBar.high, low: state.liveBar.low, close: state.liveBar.close });
  }
  c.series.setData(data);
  c.series.setMarkers(buildMarkers(data.map((d) => d.time)));
  updateOverlayData(state.candles, state.liveBar);
  drawLevelLines();
  ensureLegend();
  updateLegend();
  if (state.chartNeedsFit) {
    c.chart.timeScale().fitContent();
    state.chartNeedsFit = false;
  }
  sizeSignalChart();
}

function ensureLiveBar() {
  const c = state.candles;
  if (!c || !c.length) {
    state.liveBar = null;
    return null;
  }
  const last = c[c.length - 1];
  if (typeof last.time !== 'number' || typeof last.close !== 'number') return state.liveBar;
  const step = intervalSeconds() * 1000;
  const firstMs = last.time + step;
  const idx = Math.max(0, Math.floor((Date.now() - firstMs) / step));
  const barTime = Math.floor((firstMs + idx * step) / 1000);
  if (state.liveBar && state.liveBar.time === barTime) return state.liveBar;
  if (state.liveBar && state.liveBar.ws && state.liveBar.time >= barTime) return state.liveBar;
  state.liveBar = { time: barTime, open: last.close, high: last.close, low: last.close, close: last.close };
  return state.liveBar;
}

function applyLivePrice(px) {
  if (typeof px !== 'number' || !isFinite(px)) return;
  state.price = px;
  const bar = ensureLiveBar();
  if (bar) {
    bar.close = px;
    if (px > bar.high) bar.high = px;
    if (px < bar.low) bar.low = px;
    if (lw) {
      try { lw.series.update(bar); } catch (err) { void err; }
    }
  }
  updateLastLine(px);
}

function updateLastLine(px) {
  const c = lw;
  if (!c) return;
  if (c.lastLine) {
    try { c.lastLine.applyOptions({ price: px, title: 'LAST ' + markerPrice(px) }); return; } catch (err) { void err; }
  }
  drawLevelLines();
}

function renderLive() {
  const el = $('#lastPrice');
  if (el) el.textContent = fmtPrice(state.price, state.apiSymbol);
  recolorPrice();
  const dot = $('#liveDot');
  if (dot) {
    const route = priceRoute();
    const err = state.tickErr > 0 && !state.wsLive && route !== 'mt5';
    const label = err ? 'RETRYING' : route === 'mt5' ? 'MT5' : route === 'tradingview' ? 'TV' : state.wsLive ? 'STREAM' : 'LIVE';
    dot.textContent = '\u25CF ' + label;
    dot.className = 'live-dot' + (err ? ' err' : route === 'mt5' ? ' mt5' : route === 'tradingview' ? ' tv' : state.wsLive ? ' ws' : '');
    dot.title = route === 'mt5'
      ? 'MetaTrader 5 broker feed' + (state.mt5Info && state.mt5Info.account && state.mt5Info.account.server ? ' (' + state.mt5Info.account.server + ')' : '')
      : route === 'tradingview'
        ? 'TradingView live price for ' + (state.tvSymbol || state.apiSymbol)
        : state.wsLive
          ? 'streaming real-time (websocket)'
          : state.lastTickAt
            ? 'polling, last tick ' + ((Date.now() - state.lastTickAt) / 1000).toFixed(1) + 's ago'
            : '';
  }
  updateLegend();
}

function tickDelayMs() {
  const poll = (state.cfg && state.cfg.poll) || {};
  if (state.mt5) return Math.max(100, poll.mt5Ms || 250);
  const route = priceRoute();
  if (route === 'tradingview') return Math.max(100, poll.mt5Ms || 250);
  const base = poll.tickMs || 1000;
  return Math.max(250, base);
}

function priceRoute() {
  if (state.mt5) return 'mt5';
  if (streamSymbol()) return 'binance';
  if (state.market !== 'crypto' && window.lib.tvSymbol) {
    try {
      if (window.lib.tvSymbol(state.apiSymbol, state.market)) return 'tradingview';
    } catch (err) { void err; }
  }
  return 'poll';
}

function maxBackoffMs() {
  return (state.cfg && state.cfg.poll && state.cfg.poll.maxTickBackoffMs) || 30000;
}

async function tick() {
  if (state.tickBusy) return;
  if (!state.apiSymbol) return;
  state.tickBusy = true;
  try {
    const px = await window.lib.fetchPrice(state.apiSymbol, state.market, state.cfg);
    if (typeof px === 'number' && isFinite(px) && px > 0) {
      state.lastTickAt = Date.now();
      state.tickErr = 0;
      state.tickDelay = tickDelayMs();
      applyLivePrice(px);
      updateDeal();
      renderLive();
      runAnalysis();
      state.tickCount = (state.tickCount || 0) + 1;
      if (state.tickCount % 2 === 0) renderAccount();
    } else {
      throw new Error('bad price');
    }
  } catch (err) {
    state.tickErr = Math.min(state.tickErr + 1, 8);
    state.tickDelay = Math.min(tickDelayMs() * Math.pow(2, state.tickErr), maxBackoffMs());
    renderLive();
  } finally {
    state.tickBusy = false;
    scheduleTick();
  }
}

function scheduleTick() {
  clearTimeout(state.tickTimer);
  state.tickTimer = setTimeout(tick, state.tickDelay);
}

function mt5Markets() {
  const m = (state.cfg && state.cfg.market && state.cfg.market.mt5) || {};
  return m.markets || ['gold', 'forex', 'index'];
}

async function refreshMt5Source(force) {
  if (!window.lib.mt5Status) return false;
  let st = { available: false };
  try {
    st = await window.lib.mt5Status(state.cfg, !!force);
  } catch (err) {
    st = { available: false };
  }
  const useForMarket = !!(st.available && mt5Markets().indexOf(state.market) !== -1);
  const changed = state.mt5 !== useForMarket;
  state.mt5 = useForMarket;
  state.mt5Info = st.info || null;
  if (changed) {
    state.tickDelay = tickDelayMs();
    if (state.mt5) closeStream();
    else openStream();
    state.tickErr = 0;
    renderLive();
  }
  return useForMarket;
}

function startMt5Watch() {
  clearInterval(state.mt5Timer);
  state.mt5Timer = setInterval(() => { refreshMt5Source(); }, 15000);
}

function streamSymbol() {
  if (state.mt5) return null;
  if (!window.lib.binanceStreamSymbol) return null;
  try {
    return window.lib.binanceStreamSymbol(state.apiSymbol, state.market, state.cfg);
  } catch (err) {
    return null;
  }
}

function streamInterval() {
  if (!window.lib.binanceInterval) return '1h';
  try {
    return window.lib.binanceInterval(state.interval);
  } catch (err) {
    return '1h';
  }
}

function openStream() {
  const sym = streamSymbol();
  if (!sym) {
    closeStream();
    return;
  }
  const iv = streamInterval();
  const key = sym + '|' + iv;
  if (state.wsKey === key && state.ws && state.ws.readyState <= 1) return;
  closeStream();
  state.wsKey = key;
  const base = sym.toLowerCase();
  const url = 'wss://stream.binance.com:9443/stream?streams=' +
    base + '@aggTrade/' + base + '@kline_' + iv;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    scheduleStreamReconnect();
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    state.wsLive = true;
    state.wsRetry = 0;
    state.lastTickAt = Date.now();
    renderLive();
  };
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (err) { return; }
    onStreamData(msg && msg.data ? msg.data : msg);
  };
  ws.onerror = () => { void 0; };
  ws.onclose = () => {
    state.wsLive = false;
    state.ws = null;
    renderLive();
    scheduleStreamReconnect();
  };
}

function closeStream() {
  clearTimeout(state.wsTimer);
  if (state.ws) {
    try {
      state.ws.onclose = null;
      state.ws.onmessage = null;
      state.ws.close();
    } catch (err) { void err; }
  }
  state.ws = null;
  state.wsLive = false;
  state.wsKey = null;
}

function scheduleStreamReconnect() {
  if (!streamSymbol()) return;
  clearTimeout(state.wsTimer);
  state.wsRetry = Math.min(state.wsRetry + 1, 10);
  const delay = Math.min(1000 * Math.pow(2, state.wsRetry), maxBackoffMs());
  state.wsTimer = setTimeout(openStream, delay);
}

function onStreamData(d) {
  if (!d || !d.e) return;
  if (d.e === 'aggTrade') {
    const px = parseFloat(d.p);
    if (isFinite(px) && px > 0) enqueueLive(px, null);
    return;
  }
  if (d.e === 'kline' && d.k) {
    const k = d.k;
    const bar = {
      time: Math.floor(k.t / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
    };
    if ([bar.open, bar.high, bar.low, bar.close].every((v) => isFinite(v))) enqueueLive(bar.close, bar);
  }
}

function enqueueLive(px, bar) {
  state.pendingLive = { px, bar };
  if (state.liveTimer) return;
  state.liveTimer = setTimeout(flushLive, 120);
}

function flushLive() {
  state.liveTimer = null;
  const p = state.pendingLive;
  state.pendingLive = null;
  if (!p) return;
  state.lastTickAt = Date.now();
  state.lastWsDataAt = Date.now();
  state.tickErr = 0;
  if (p.bar && (!state.liveBar || p.bar.time >= state.liveBar.time)) {
    p.bar.ws = true;
    state.liveBar = p.bar;
    if (lw) {
      try { lw.series.update(p.bar); } catch (err) { void err; }
      try { updateOverlayData(state.candles, state.liveBar); } catch (err) { void err; }
    }
    state.price = p.px;
    updateLastLine(p.px);
  } else {
    applyLivePrice(p.px);
  }
  updateDeal();
  renderLive();
  runAnalysis();
  state.tickCount = (state.tickCount || 0) + 1;
  if (state.tickCount % 12 === 0) renderAccount();
}

function setSymbol(symbol, fromChart) {
  const norm = normalizeSymbol(symbol, state.market);
  if (!norm) return;
  if (norm.api !== state.apiSymbol) {
    if (state.paper && state.cfg && state.cfg.paper && state.cfg.paper.enabled) {
      const out = window.lib.paper.closeIfOtherSymbol(state.paper, norm.api, state.cfg.paper);
      state.paper = out.account;
      if (out.ok && out.trade) {
        toast('Paper ' + out.trade.side.toUpperCase() + ' ' + out.trade.symbol + ' closed (symbol changed)');
      }
      renderAccount();
      schedulePaperSave();
    }
    state.position = null;
    state.signals = [];
    state.lastAction = null;
    armPaper('symbol change');
  }
  state.symbol = norm.raw;
  state.tvSymbol = norm.tv;
  state.apiSymbol = norm.api;
  state.liveBar = null;
  state.tickErr = 0;
  state.tickDelay = tickDelayMs();
  state.chartNeedsFit = true;
  $('#chipSymbol').textContent = state.apiSymbol;
  if (!fromChart) {
  }
  closeStream();
  refreshMt5Source(true).then(() => openStream());
  scheduleAnalysis(0);
  scheduleNews(0);
}

function parseSymbolFromTvInput() {
  setSymbol($('#symbolInput').value);
}

function onSymbolTyping() {
  const q = $('#symbolInput').value.trim();
  if (q.length < 2 || state.market === 'crypto') return;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(async () => {
    try {
      const results = await window.agent.searchSymbols(q);
      const list = $('#symbolList');
      list.innerHTML = '';
      state.searchMap = {};
      for (const r of results.slice(0, 12)) {
        const sym = (r.symbol || '').toUpperCase();
        const opt = document.createElement('option');
        opt.value = r.symbol;
        opt.label = [r.name, r.exchange, r.type].filter(Boolean).join(' · ');
        list.appendChild(opt);
        state.searchMap[sym] = r.exchange;
      }
    } catch (err) {
      void err;
    }
  }, 300);
}

async function refreshData() {
  setConn('busy');
  try {
    state.candles = await window.lib.fetchCandles(state.apiSymbol, state.interval, state.market, state.cfg);
    state.liveBar = null;
    try {
      state.price = await window.lib.fetchPrice(state.apiSymbol, state.market, state.cfg);
    } catch (err) {
      state.price = state.candles.length ? state.candles[state.candles.length - 1].close : null;
    }
    await runAnalysis(true);
    ensureLiveBar();
    setConn('ok');
  } catch (err) {
    setConn('err');
    toast('Market data error: ' + err.message);
    state.analysis = { ok: false, error: err.message, reasons: [], action: 'WAIT', score: 0 };
    renderAnalysis(state.analysis);
  }
}

function analysisCandles() {
  const c = state.candles;
  if (!c || !c.length) return c || [];
  const live = state.liveBar;
  if (live && typeof live.time === 'number' && isFinite(live.close) &&
      live.time > c[c.length - 1].time) {
    return c.concat([{
      time: live.time,
      open: live.open,
      high: live.high,
      low: live.low,
      close: live.close,
      volume: live.volume || 0,
    }]);
  }
  return c;
}

function analysisMinMs() {
  const v = state.cfg && state.cfg.poll && state.cfg.poll.analysisMs;
  return typeof v === 'number' && v >= 100 ? v : 300;
}

function scheduleAnalysisSoon() {
  const wait = Math.max(0, analysisMinMs() - (Date.now() - state.lastAnalysisAt));
  clearTimeout(scheduleAnalysisSoon._t);
  scheduleAnalysisSoon._t = setTimeout(() => runAnalysis(), wait + 5);
}

async function runAnalysis(force) {
  if (!force && Date.now() - state.lastAnalysisAt < analysisMinMs()) {
    state.analysisDirty = true;
    scheduleAnalysisSoon();
    return;
  }
  if (state.analysisPending) {
    state.analysisDirty = true;
    return;
  }
  state.analysisPending = true;
  const cfg = state.cfg;
  const sentimentScore = state.news ? state.news.sentimentScore : 0;
  try {
    state.analysis = await window.lib.analyze({
      candles: analysisCandles(),
      rules: cfg.rules,
      sentimentScore,
      price: state.price,
      strategy: state.strategy,
    });
  } catch (err) {
    state.analysis = { ok: false, error: err.message, reasons: [], action: 'WAIT', score: 0 };
  } finally {
    state.analysisPending = false;
    state.lastAnalysisAt = Date.now();
  }
  renderAnalysis(state.analysis);
  const dealEvent = updateDeal();
  if (!dealEvent) maybeNotify(state.analysis);
  if (state.analysisDirty) {
    state.analysisDirty = false;
    scheduleAnalysisSoon();
  }
}

function updateDeal(manualExit) {
  if (!window.lib.evaluateSignal) return null;
  const live = state.liveBar;
  const bar = live && typeof live.high === 'number' && isFinite(live.high)
    ? live
    : (state.candles && state.candles.length ? state.candles[state.candles.length - 1] : null);
  let res;
  try {
    res = window.lib.evaluateSignal({
      analysis: state.analysis,
      price: state.price,
      position: state.position,
      config: state.cfg,
      bar,
      manualExit: !!manualExit,
    });
  } catch (err) {
    return null;
  }
  state.position = res.position;
  renderDeal(res);
  applyPaper(res);
  if (res.event === 'ENTRY' || res.event === 'EXIT') {
    const t = bar && bar.time ? bar.time : Date.now();
    if (res.event === 'ENTRY' && res.position) {
      state.signals.push({ time: t, type: 'ENTRY', side: res.position.side, price: res.position.entry, strategyName: res.position.strategyName || null });
    }
    if (res.event === 'EXIT' && res.exit) {
      state.signals.push({ time: t, type: 'EXIT', side: res.exit.side, price: res.exit.price, strategyName: res.exit.strategyName || null });
    }
    if (state.signals.length > 300) state.signals.splice(0, state.signals.length - 300);
    const side = res.event === 'ENTRY'
      ? (res.position ? res.position.side.toUpperCase() : '')
      : (res.exit && res.exit.side ? res.exit.side.toUpperCase() : '');
    window.agent.notify(
      res.event + ' ' + side + ' · ' + state.apiSymbol,
      res.message + (state.price ? ' | Last ' + fmtPrice(state.price, state.apiSymbol) : '')
    );
    toast(res.message);
    renderSignalsChart();
    return res.event;
  }
  updateLegend();
  return null;
}

function armDelay() {
  const v = state.cfg && state.cfg.paper && state.cfg.paper.armDelayMs;
  return typeof v === 'number' && v >= 0 ? v : 5000;
}

function armPaper(reason) {
  state.armUntil = Date.now() + armDelay();
  if (reason) console.log('[paper] arming ' + armDelay() + 'ms (' + reason + ')');
}

function applyPaper(res) {
  const pcfg = state.cfg.paper || {};
  const P = window.lib.paper;
  if (!state.paper || !P) return;
  let acct = state.paper;
  if (acct.position && state.position && acct.position.symbol === state.apiSymbol) {
    acct.position.stop = state.position.stop;
  }
  if (!pcfg.enabled) {
    state.paper = P.markPrice(acct, state.apiSymbol, state.price).account;
    renderAccount();
    return;
  }
  if (res.event === 'ENTRY' && res.position && pcfg.autoTrade) {
    const armed = Date.now() >= (state.armUntil || 0);
    if (armed) {
      const out = P.openTrade(acct, {
        symbol: state.apiSymbol,
        side: res.position.side,
        entry: res.position.entry,
        stop: res.position.stop,
        target: res.position.target,
        strategyName: res.position.strategyName,
      }, pcfg);
      acct = out.account;
      if (!out.ok) toast('Paper trading: ' + out.reason);
      else toast('Paper ' + res.position.side.toUpperCase() + ' opened · ' + state.apiSymbol);
    }
  }
  if (res.event === 'EXIT' && res.exit) {
    const out = P.closeTrade(acct, res.exit.price, res.exit.reason || 'Signal', pcfg);
    acct = out.account;
    if (out.ok && out.trade) {
      const t = out.trade;
      toast('Paper closed ' + t.side.toUpperCase() + ' ' + t.symbol + ' · ' +
        (t.pnl >= 0 ? '+' : '') + fmtMoney(t.pnl) + ' (' + t.rMultiple.toFixed(2) + 'R)');
    }
  }
  state.paper = P.markPrice(acct, state.apiSymbol, state.price).account;
  renderAccount();
  schedulePaperSave();
}

function schedulePaperSave() {
  clearTimeout(state.paperSaveTimer);
  state.paperSaveTimer = setTimeout(() => {
    if (state.paper) window.agent.paperSave(state.paper);
  }, 800);
}

function accountCurrency() {
  return (state.paper && state.paper.currency) ||
    (state.cfg.paper && state.cfg.paper.currency) || 'USD';
}

function fmtMoney(v) {
  if (typeof v !== 'number' || !isFinite(v)) return '--';
  const sign = v < 0 ? '-' : '';
  return sign + accountCurrency() + ' ' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAccount() {
  if (!state.paper || !window.lib.paper) return;
  const s = window.lib.paper.stats(state.paper);
  const pos = state.paper.position;
  const eqEl = $('#acctEquity');
  eqEl.textContent = fmtMoney(s.equity);
  eqEl.className = 'acct-big ' + (s.totalPnl >= 0 ? 'pos' : 'neg');
  $('#acctBalance').textContent = fmtMoney(s.balance);
  const openEl = $('#acctOpen');
  openEl.textContent = (s.openPnl >= 0 ? '+' : '') + fmtMoney(s.openPnl);
  openEl.className = 'acct-mid ' + (s.openPnl >= 0 ? 'pos' : 'neg');

  const sig = s.trades + '|' + (pos ? pos.side + pos.entry + pos.stop + pos.target : 'flat');
  if (sig !== state.acctSig) {
    state.acctSig = sig;
    const rows = [
      ['Total P&L', (s.totalPnl >= 0 ? '+' : '') + fmtMoney(s.totalPnl) + ' (' + s.totalPnlPct.toFixed(2) + '%)', s.totalPnl >= 0],
      ['Trades', s.trades + ' (' + s.wins + 'W / ' + s.losses + 'L)', s.trades ? s.winRate >= 50 : null],
      ['Win rate', s.trades ? s.winRate.toFixed(1) + '%' : '--', s.trades ? s.winRate >= 50 : null],
      ['Profit factor', s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2), s.profitFactor >= 1],
      ['Max drawdown', s.maxDrawdownPct.toFixed(2) + '%', s.maxDrawdownPct < 10],
      ['Best / worst R', s.bestR.toFixed(2) + ' / ' + s.worstR.toFixed(2), s.bestR >= 1],
    ];
    $('#acctStats').innerHTML = rows.map(([label, val, good]) =>
      '<div><span class="i-label">' + label + '</span><span class="i-val' +
      (good === null ? '' : good ? ' pos' : ' neg') + '">' + val + '</span></div>').join('');
    renderTrades();
  }
  drawEquityCurve();
}

function renderTrades() {
  const list = $('#tradeList');
  if (!list) return;
  const acct = state.paper;
  list.innerHTML = '';
  const open = acct.position;
  if (open) {
    const pnl = window.lib.paper.stats(acct).openPnl;
    const li = document.createElement('li');
    li.className = open.side === 'long' ? 'bullish' : 'bearish';
    li.innerHTML = '<div class="strat-row"><span><span class="news-badge ' + (open.side === 'long' ? 'bullish' : 'bearish') + '">' +
      open.side.toUpperCase() + '</span> ' + open.symbol + ' — OPEN</span>' +
      '<span class="r-val ' + (pnl >= 0 ? 'pos' : 'neg') + '">' + (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '</span></div>' +
      '<div class="news-meta">entry ' + fmtPrice(open.entry, open.symbol) + ' · SL ' + fmtPrice(open.stop, open.symbol) +
      ' · TP ' + fmtPrice(open.target, open.symbol) + ' · size ' + open.units.toFixed(2) + ' units' +
      (open.strategyName ? ' · ' + open.strategyName : '') + '</div>';
    list.appendChild(li);
  }
  if (!acct.trades.length && !open) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No paper trades yet. Signals will be executed automatically.';
    list.appendChild(li);
    return;
  }
  for (const t of acct.trades.slice(0, 40)) {
    const li = document.createElement('li');
    li.className = t.pnl >= 0 ? 'bullish' : 'bearish';
    li.innerHTML = '<div class="strat-row"><span><span class="news-badge ' + (t.side === 'long' ? 'bullish' : 'bearish') + '">' +
      t.side.toUpperCase() + '</span> ' + t.symbol + '</span>' +
      '<span class="r-val ' + (t.pnl >= 0 ? 'pos' : 'neg') + '">' + (t.pnl >= 0 ? '+' : '') + fmtMoney(t.pnl) + '</span></div>' +
      '<div class="news-meta">' + fmtPrice(t.entry, t.symbol) + ' → ' + fmtPrice(t.exit, t.symbol) + ' · ' +
      t.rMultiple.toFixed(2) + 'R · ' + t.reason + ' · ' + new Date(t.closedAt).toLocaleString() + '</div>';
    list.appendChild(li);
  }
}

function drawEquityCurve() {
  const cv = $('#equityCanvas');
  if (!cv || !state.paper) return;
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  const pts = (state.paper.curve || []).slice(-160);
  ctx.clearRect(0, 0, W, H);
  if (pts.length < 2) {
    ctx.fillStyle = '#8b98a5';
    ctx.font = '11px sans-serif';
    ctx.fillText('Equity curve builds as trades close…', 8, H / 2);
    return;
  }
  const ys = pts.map((p) => p.equity);
  let min = Math.min.apply(null, ys);
  let max = Math.max.apply(null, ys);
  if (min === max) { min -= 1; max += 1; }
  const pad = 6;
  const X = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const Y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
  const base = pts[0].equity;
  const up = pts[pts.length - 1].equity >= base;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(pts[0].equity));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(X(i), Y(pts[i].equity));
  ctx.strokeStyle = up ? '#22c55e' : '#ef4444';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(X(pts.length - 1), H - pad);
  ctx.lineTo(X(0), H - pad);
  ctx.closePath();
  ctx.fillStyle = up ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(139,152,165,.4)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad, Y(base));
  ctx.lineTo(W - pad, Y(base));
  ctx.stroke();
  ctx.setLineDash([]);
}

function renderDeal(res) {
  const box = $('#dealBox');
  const sig = $('#dealSignal');
  const p = state.position;
  box.classList.remove('flat', 'long', 'short');
  sig.classList.remove('flat', 'long', 'short', 'exit');

  if (p) {
    const long = p.side === 'long';
    const price = typeof state.price === 'number' ? state.price : p.entry;
    const pnl = long ? price - p.entry : p.entry - price;
    const risk = Math.abs(p.entry - p.initialStop) || 1;
    box.classList.add(p.side);
    sig.classList.add(p.side);
    state.dealState = res.event === 'ENTRY' ? 'ENTRY' : 'HOLD';
    sig.textContent = res.event === 'ENTRY' ? 'ENTRY ' + (long ? 'LONG' : 'SHORT') : 'HOLD ' + (long ? 'LONG' : 'SHORT');
    $('#dealSide').textContent = (p.strategyName || p.strategy || 'strategy') + ' · opened ' + new Date(p.openedAt).toLocaleTimeString();
    $('#dealCloseBtn').classList.remove('hidden');
    $('#dealStats').classList.remove('hidden');
    $('#dealEntry').textContent = fmtPrice(p.entry, state.apiSymbol);
    const pv = $('#dealPnl');
    pv.textContent = (pnl >= 0 ? '+' : '') + fmtPrice(pnl, state.apiSymbol);
    pv.className = 'level-val ' + (pnl >= 0 ? 'pos' : 'neg');
    $('#dealR').textContent = (pnl / risk).toFixed(2) + 'R';
    $('#dealMsg').textContent = res.message;
    return;
  }

  const e = res && res.event === 'EXIT' ? res.exit : null;
  if (e) {
    box.classList.add('flat');
    sig.classList.add('exit');
    state.dealState = 'EXIT';
    sig.textContent = 'EXIT ' + (e.side === 'long' ? 'LONG' : 'SHORT');
    $('#dealSide').textContent = 'Closed ' + e.side.toUpperCase() + ' @ ' + fmtPrice(e.price, state.apiSymbol);
    $('#dealStats').classList.remove('hidden');
    $('#dealEntry').textContent = fmtPrice(e.entry, state.apiSymbol);
    const pv = $('#dealPnl');
    pv.textContent = (e.pnl >= 0 ? '+' : '') + fmtPrice(e.pnl, state.apiSymbol) + ' (' + e.pnlPct.toFixed(2) + '%)';
    pv.className = 'level-val ' + (e.pnl >= 0 ? 'pos' : 'neg');
    $('#dealR').textContent = e.rMultiple.toFixed(2) + 'R';
    $('#dealMsg').textContent = e.reason + ' — ' + (e.strategyName || 'strategy');
  } else {
    box.classList.add('flat');
    sig.classList.add('flat');
    state.dealState = 'FLAT';
    sig.textContent = 'FLAT';
    $('#dealSide').textContent = 'No open deal';
    $('#dealStats').classList.add('hidden');
    $('#dealMsg').textContent = (res && res.message) ? res.message : 'Waiting for an entry signal…';
  }
  $('#dealCloseBtn').classList.add('hidden');
}

function maybeNotify(a) {
  const cfg = state.cfg;
  if (!cfg.alerts || !cfg.alerts.enabled) return;
  if (!a || !a.ok) return;
  const min = cfg.alerts.minAbsScore || 25;
  const isBuy = a.action === 'BUY' || a.action === 'STRONG BUY';
  const isSell = a.action === 'SELL' || a.action === 'STRONG SELL';
  const sameSide = state.lastAction && (
    (isBuy && (state.lastAction === 'BUY' || state.lastAction === 'STRONG BUY')) ||
    (isSell && (state.lastAction === 'SELL' || state.lastAction === 'STRONG SELL'))
  );
  const quiet = a.score !== 0 && Math.abs(a.score) < min;
  if (sameSide || quiet) {
    state.lastAction = a.action;
    return;
  }
  window.agent.notify(
    (isBuy ? 'BUY SIGNAL ' : isSell ? 'SELL SIGNAL ' : 'NEUTRAL ') + state.apiSymbol,
    a.action + ' — score ' + a.score +
    (a.reasons && a.reasons[0] ? ' | ' + a.reasons[0].detail : '') +
    (state.price ? ' | Last: ' + fmtPrice(state.price, state.apiSymbol) : '')
  );
  state.lastAction = a.action;
}

function fmtPrice(v, symbol) {
  if (v == null) return '--';
  if (/USD|USDT|USDC$/.test(symbol)) {
    return v >= 100 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : v >= 1 ? v.toLocaleString(undefined, { maximumFractionDigits: 3 })
        : v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function actionClass(action) {
  const a = (action || '').toUpperCase();
  if (a.includes('BUY')) return 'buy';
  if (a.includes('SELL')) return 'sell';
  if (a === 'NEUTRAL') return 'neutral';
  return 'wait';
}

function renderAnalysis(a) {
  if (!a) return;
  const chip = $('#chipSignal');
  chip.textContent = a.ok ? a.action : 'ERROR';
  chip.className = 'signal-chip ' + actionClass(a.ok ? a.action : 'WAIT');

  $('#lastPrice').textContent = fmtPrice(state.price, state.apiSymbol);
  recolorPrice();

  const badge = $('#scoreBadge');
  badge.textContent = a.ok ? a.score : '–';
  badge.className = 'score-badge ' + actionClass(a.ok ? a.action : 'WAIT');

  const pct = a.ok ? clamp(a.score, -100, 100) : 0;
  $('#meterFill').style.left = (50 + pct / 2) + '%';

  $('#stratName').textContent = a.ok && a.strategy ? a.strategy.name : '—';
  const rb = $('#regimeBadge');
  rb.textContent = 'regime: ' + (a.regime || '—');
  rb.className = 'regime-badge ' + (a.regime || '');

  const entryBox = $('#entryBox');
  if (a.ok && state.price) {
    entryBox.classList.remove('hidden');
    entryBox.classList.toggle('buy-style', a.action.includes('BUY'));
    entryBox.classList.toggle('sell-style', a.action.includes('SELL'));
    $('#entryText').textContent = (a.levels && a.levels.note) ? a.levels.note : buildEntryText(a, state.price);
    $('#levEntry').textContent = fmtPrice(a.levels.entry, state.apiSymbol);
    $('#levStop').textContent = fmtPrice(a.levels.stopLoss, state.apiSymbol);
    $('#levTp').textContent = fmtPrice(a.levels.takeProfit, state.apiSymbol);
    const rr = a.levels.riskReward;
    const pctMove = a.levels.entry ? (Math.abs(a.levels.takeProfit - a.levels.entry) / a.levels.entry) * 100 : null;
    $('#levMeta').textContent = 'Risk/Reward ' + (rr ? rr.toFixed(2) + ':1' : '--') +
      (pctMove != null ? ' · target move ' + pctMove.toFixed(2) + '%' : '') +
      ' · ' + (a.levels.direction === 'long' ? 'LONG' : a.levels.direction === 'short' ? 'SHORT' : '--');
  } else {
    entryBox.classList.add('hidden');
  }

  const list = $('#reasonList');
  list.innerHTML = '';
  if (a.ok) {
    const byLabel = {};
    for (const r of a.reasons) byLabel[r.label] = (byLabel[r.label] || 0) + r.value;
    const items = Object.entries(byLabel).sort((x, y) => y[1] - x[1]);
    for (const [label, value] of items) {
      const li = document.createElement('li');
      const v = Math.round(value * 100);
      const sign = v >= 0 ? '+' : '';
      li.innerHTML = '<span>' + label + '</span><span class="r-val ' + (v >= 0 ? 'pos' : 'neg') + '">' + sign + v + '</span>';
      list.appendChild(li);
    }
    if (!a.reasons.length) {
      const li = document.createElement('li');
      li.textContent = 'No strong factors detected — market is flat.';
      list.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.textContent = a.error || 'Analysis unavailable.';
    list.appendChild(li);
  }

  const i = a.indicators;
  if (a.ok && i) {
    $('#iEma').textContent = i.emaFast.toFixed(2) + ' / ' + i.emaSlow.toFixed(2) + ' / ' + i.emaTrend.toFixed(2);
    $('#iRsi').textContent = i.rsi !== null ? i.rsi.toFixed(1) : '–';
    $('#iMacd').textContent = i.macdHistogram !== null ? i.macdHistogram.toFixed(5) : '–';
    $('#iVol').textContent = i.volumeRatio !== null ? i.volumeRatio.toFixed(2) + 'x' : '–';
    $('#iAtr').textContent = i.atr !== null ? i.atr.toFixed(i.atr < 1 ? 6 : 2) : '–';
  } else {
    $('#iEma').textContent = $('#iRsi').textContent = $('#iMacd').textContent = $('#iVol').textContent = $('#iAtr').textContent = '–';
  }

  renderStrategies(a);
}

function renderStrategies(a) {
  const list = $('#strategyList');
  list.innerHTML = '';
  const rows = [];
  if (a && a.ok) {
    if (a.breakdown && a.breakdown.length) {
      for (const b of a.breakdown) rows.push({ name: b.name, score: b.score });
    } else if (a.strategy) {
      rows.push({ name: a.strategy.name, score: a.score });
    }
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = a && a.error ? a.error : 'No strategy output yet.';
    list.appendChild(li);
    return;
  }
  if (a.agreement) {
    const li = document.createElement('li');
    li.innerHTML = '<div><strong>Agreement</strong> <span class="news-badge neutral">' +
      a.agreement.bullish + ' bull / ' + a.agreement.bearish + ' bear</span></div>' +
      '<div class="news-meta">' + a.agreement.total + ' strategies evaluated · regime ' + (a.regime || '—') + '</div>';
    list.appendChild(li);
  }
  for (const r of rows.slice().sort((x, y) => y.score - x.score)) {
    const li = document.createElement('li');
    const s = Math.round(r.score);
    const cls = s >= 10 ? 'bullish' : s <= -10 ? 'bearish' : 'neutral';
    li.className = cls;
    li.innerHTML = '<div class="strat-row"><span>' + r.name + '</span><span class="r-val ' +
      (s >= 0 ? 'pos' : 'neg') + '">' + (s >= 0 ? '+' : '') + s + '</span></div>' +
      '<div class="strat-bar"><i style="width:' + clamp(Math.abs(s), 0, 100) + '%;" class="' + cls + '"></i></div>';
    list.appendChild(li);
  }
}

function lastBarDir() {
  const c = state.candles;
  if (!c || !c.length) return 0;
  const last = c[c.length - 1];
  return last.close >= last.open ? 1 : -1;
}

function recolorPrice() {
  const d = lastBarDir();
  $('#lastPrice').className = 'price ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
}

function buildEntryText(a, price) {
  if (a.action.includes('BUY')) {
    return 'Bullish setup. Enter near pullback to support (EMA ' + state.cfg.rules.emaFast + '). Size your position so you risk max ' + fmtPrice(price - a.levels.stopLoss, state.apiSymbol) + ' per unit below entry.';
  }
  if (a.action.includes('SELL')) {
    return 'Bearish setup. Enter on a bounce toward resistance (EMA ' + state.cfg.rules.emaFast + '). Risk ' + fmtPrice(a.levels.stopLoss - price, state.apiSymbol) + ' above entry.';
  }
  return 'No edge. Stand aside until the composite score crosses ' + state.cfg.rules.thresholds.buy + ' (buy) or ' + state.cfg.rules.thresholds.sell + ' (sell).';
}

async function refreshNews() {
  if (!state.cfg.news.enabled) {
    $('#newsHead').textContent = 'News disabled (enable in Settings).';
    return;
  }
  try {
    state.news = await window.agent.collectNews(state.apiSymbol, state.market);
    renderNews();
  } catch (err) {
    toast('News error: ' + err.message);
  }
}

function renderNews() {
  const n = state.news;
  if (!n) return;
  const head = $('#newsHead');
  const s = n.sentimentScore;
  head.textContent = 'Sentiment: ' + (s >= 0 ? '+' : '') + Math.round(s) + '/100' +
    ' (' + n.aggregate.bullish + ' bull / ' + n.aggregate.bearish + ' bear from ' + n.aggregate.count + ' items)';

  const list = $('#newsList');
  list.innerHTML = '';
  if (!n.articles.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = n.errors && n.errors.length ? 'No articles — ' + n.errors[0] : 'No recent articles for this ticker.';
    list.appendChild(li);
  } else {
    for (const a of n.articles) {
      const li = document.createElement('li');
      li.className = a.sentimentLabel;
      const badge = document.createElement('span');
      badge.className = 'news-badge ' + a.sentimentLabel;
      badge.textContent = a.sentimentLabel;
      const title = document.createElement('div');
      title.textContent = a.title;
      const meta = document.createElement('div');
      meta.className = 'news-meta';
      meta.textContent = (a.source === 'reddit' ? 'r/' + a.sub + ' • ' : a.source + ' • ') +
        (a.ageHours < 1 ? Math.round(a.ageHours * 60) + 'm' : a.ageHours.toFixed(1) + 'h') + ' ago' +
        (a.upvotes ? ' • ▲' + a.upvotes : '');
      li.appendChild(title);
      title.appendChild(badge);
      li.appendChild(meta);
      li.addEventListener('click', () => {
        if (a.url) window.agent.openExternal(a.url);
      });
      list.appendChild(li);
    }
  }

  const srcList = $('#sourceList');
  srcList.innerHTML = '';
  const sourceLabels = {
    reddit: 'Reddit RSS search',
    yahoo: 'Yahoo Finance RSS',
    coindesk: 'CoinDesk RSS',
    cointelegraph: 'CoinTelegraph RSS',
    finnhub: 'Finnhub API',
    newsapi: 'NewsAPI',
  };
  for (const [k, v] of Object.entries(n.sources || {})) {
    const li = document.createElement('li');
    li.innerHTML = '<div>' + k + ' <span class="news-badge neutral">' + v + '</span></div>' +
      '<div class="news-meta">' + (sourceLabels[k] || k) + '</div>';
    srcList.appendChild(li);
  }
  for (const e of n.errors || []) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="news-meta">provider error: ' + escapeReg(e).slice(0, 120) + '</div>';
    srcList.appendChild(li);
  }
}

function setConn(cls) {
  $('#conn').className = 'conn ' + (cls || 'ok');
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 4200);
}

function scheduleAnalysis(ms) {
  clearTimeout(scheduleAnalysis._t);
  scheduleAnalysis._t = setTimeout(refreshData, ms == null ? 300 : ms);
}

function scheduleNews(ms) {
  clearTimeout(scheduleNews._t);
  scheduleNews._t = setTimeout(refreshNews, ms == null ? 300 : ms);
}

/* ---------- overlay drag ---------- */
function initDrag() {
  const panel = $('#panel');
  const head = $('#panel-head');
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    state.dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', (e) => {
    if (!state.dragging) return;
    let x = e.clientX - state.dragging.dx;
    let y = e.clientY - state.dragging.dy;
    x = clamp(x, 4, window.innerWidth - panel.offsetWidth - 4);
    y = clamp(y, 54, window.innerHeight - panel.offsetHeight - 4);
    panel.style.left = x + 'px';
    panel.style.right = 'auto';
    panel.style.top = y + 'px';
  });
  document.addEventListener('mouseup', () => {
    state.dragging = null;
    head.style.cursor = 'grab';
  });
}

/* ---------- settings ---------- */
function openSettings() {
  const c = state.cfg;
  $('#setStrongBuy').value = c.rules.thresholds.strongBuy;
  $('#setBuy').value = c.rules.thresholds.buy;
  $('#setSell').value = c.rules.thresholds.sell;
  $('#setStrongSell').value = c.rules.thresholds.strongSell;
  $('#setWTrend').value = c.rules.weights.trend * 100;
  $('#setWMom').value = c.rules.weights.momentum * 100;
  $('#setWVol').value = c.rules.weights.volume * 100;
  $('#setWNews').value = c.rules.weights.sentiment * 100;
  $('#setWPrice').value = c.rules.weights.priceAction * 100;
  $('#setNewsEnabled').checked = c.news.enabled;
  $('#setNewsHours').value = c.news.hoursBack;
  $('#setFinnhub').value = c.news.finnhubKey || '';
  $('#setNewsapi').value = c.news.newsapiKey || '';
  $('#setAlertsEnabled').checked = c.alerts.enabled;
  $('#setAlertMin').value = c.alerts.minAbsScore;
  const sg = c.signals || {};
  $('#setMinEntry').value = sg.minEntryScore != null ? sg.minEntryScore : 15;
  $('#setFlipScore').value = sg.flipScore != null ? sg.flipScore : 15;
  $('#setBreakEvenR').value = sg.breakEvenAfterR != null ? sg.breakEvenAfterR : 1;
  $('#setExitOnFlip').checked = sg.exitOnFlip !== false;
  const pp = c.paper || {};
  $('#setPaperEnabled').checked = pp.enabled !== false;
  $('#setPaperAuto').checked = pp.autoTrade !== false;
  $('#setPaperBalance').value = pp.initialBalance != null ? pp.initialBalance : 10000;
  $('#setPaperRisk').value = pp.riskPerTradePct != null ? pp.riskPerTradePct : 1;
  $('#setPaperLev').value = pp.leverage != null ? pp.leverage : 30;
  $('#setTickMs').value = c.poll.tickMs || 1000;
  $('#setPriceMs').value = c.poll.priceMs;
  $('#setRecomputeMs').value = c.poll.recomputeMs;
  $('#setNewsMs').value = c.news.fetchMs;
  $('#settingsModal').classList.remove('hidden');
}

function saveSettings() {
  const c = state.cfg;
  c.rules.thresholds.strongBuy = num($('#setStrongBuy'));
  c.rules.thresholds.buy = num($('#setBuy'));
  c.rules.thresholds.sell = num($('#setSell'));
  c.rules.thresholds.strongSell = num($('#setStrongSell'));
  c.rules.weights.trend = num($('#setWTrend')) / 100;
  c.rules.weights.momentum = num($('#setWMom')) / 100;
  c.rules.weights.volume = num($('#setWVol')) / 100;
  c.rules.weights.sentiment = num($('#setWNews')) / 100;
  c.rules.weights.priceAction = num($('#setWPrice')) / 100;
  c.news.enabled = $('#setNewsEnabled').checked;
  c.news.hoursBack = num($('#setNewsHours'));
  c.news.finnhubKey = $('#setFinnhub').value.trim();
  c.news.newsapiKey = $('#setNewsapi').value.trim();
  c.alerts.enabled = $('#setAlertsEnabled').checked;
  c.alerts.minAbsScore = num($('#setAlertMin'));
  if (!c.signals) c.signals = {};
  c.signals.minEntryScore = num($('#setMinEntry'));
  c.signals.flipScore = num($('#setFlipScore'));
  c.signals.breakEvenAfterR = num($('#setBreakEvenR'));
  c.signals.exitOnFlip = $('#setExitOnFlip').checked;
  if (!c.paper) c.paper = {};
  c.paper.enabled = $('#setPaperEnabled').checked;
  c.paper.autoTrade = $('#setPaperAuto').checked;
  c.paper.initialBalance = num($('#setPaperBalance'));
  c.paper.riskPerTradePct = num($('#setPaperRisk'));
  c.paper.leverage = num($('#setPaperLev'));
  c.poll.tickMs = Math.max(250, num($('#setTickMs')));
  c.poll.priceMs = Math.max(2000, num($('#setPriceMs')));
  c.poll.recomputeMs = Math.max(200, num($('#setRecomputeMs')));
  c.news.fetchMs = Math.max(30000, num($('#setNewsMs')));
  closeSettingsModal();
  window.agent.saveConfig(c).then(() => {
    restartTimers();
    runAnalysis();
    toast('Settings saved');
  });
}

function num(el) {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : 0;
}

function closeSettingsModal() {
  $('#settingsModal').classList.add('hidden');
}

function restartTimers() {
  for (const k of Object.keys(state.timers)) clearInterval(state.timers[k]);
  state.timers = {};
  const c = state.cfg;
  const poll = c.poll || {};
  state.tickDelay = Math.max(250, poll.tickMs || 1000);
  state.timers.price = setInterval(refreshData, Math.max(2000, poll.priceMs || 15000));
  state.timers.recompute = setInterval(refreshAnalysis, Math.max(200, poll.recomputeMs || 300));
  state.timers.news = setInterval(refreshNews, c.news.fetchMs);
  scheduleTick();
}

async function refreshAnalysis() {
  if (state.tickBusy) return;
  await runAnalysis();
}

/* ---------- init ---------- */
async function init() {
  state.cfg = await window.agent.getConfig();

  try {
    const saved = await window.agent.paperLoad();
    state.paper = window.lib.paper.normalize(saved, state.cfg.paper);
  } catch (err) {
    state.paper = window.lib.paper.createAccount(state.cfg.paper);
  }
  if (state.paper && state.paper.position && window.lib.adoptPosition) {
    state.position = window.lib.adoptPosition(state.paper.position);
    state.dealState = 'HOLD';
  }
  armPaper('startup');

  const mcfg = state.cfg.market || {};
  if (mcfg.defaultMarket) state.market = mcfg.defaultMarket;
  if (mcfg.defaultSymbol) state.symbol = mcfg.defaultSymbol;
  if (mcfg.defaultInterval) state.interval = mcfg.defaultInterval;

  $('#marketSelect').value = state.market;
  $('#intervalSelect').value = state.interval;
  $('#symbolInput').value = state.symbol;

  const norm = normalizeSymbol(state.symbol, state.market);
  state.tvSymbol = norm.tv;
  state.apiSymbol = norm.api;
  $('#chipSymbol').textContent = state.apiSymbol;

  initDrag();

  $('#btnRefresh').addEventListener('click', refreshData);
  $('#btnPaperReset').addEventListener('click', () => {
    if (!window.confirm('Reset the paper account to its starting balance? All trades and history will be cleared.')) return;
    state.paper = window.lib.paper.createAccount(state.cfg.paper);
    window.agent.paperSave(state.paper);
    renderAccount();
    toast('Paper account reset');
  });
  $('#dealCloseBtn').addEventListener('click', () => {
    if (!state.position) return;
    updateDeal(true);
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnFullscreen').addEventListener('click', () => window.agent.toggleFullscreen());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      window.agent.toggleFullscreen();
    }
  });
  $('#btnSettingsSave').addEventListener('click', saveSettings);
  $('#btnSettingsCancel').addEventListener('click', closeSettingsModal);
  const togglePanel = () => {
    const hidden = $('#panel').classList.toggle('collapsed-hidden');
    $('#btnCollapse').textContent = hidden ? '+' : '–';
    $('#panelToggle').classList.toggle('active', !hidden);
  };
  $('#panelToggle').addEventListener('click', togglePanel);
  $('#btnCollapse').addEventListener('click', togglePanel);

  $('#symbolInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') parseSymbolFromTvInput();
  });
  $('#symbolInput').addEventListener('input', onSymbolTyping);
  $('#marketSelect').addEventListener('change', () => {
    state.market = $('#marketSelect').value;
    const def = DEFAULT_SYMBOL[state.market] || 'AAPL';
    $('#symbolInput').value = def;
    setSymbol(def);
  });
  $('#intervalSelect').addEventListener('change', () => {
    state.interval = $('#intervalSelect').value;
    state.chartNeedsFit = true;
    armPaper('interval change');
    openStream();
    scheduleAnalysis(0);
  });

  window.addEventListener('resize', sizeSignalChart);

  const TABS = { tabNews: 'newsPane', tabStrategies: 'strategiesPane', tabAccount: 'accountPane', tabBacktest: 'backtestPane', tabSources: 'sourcesPane' };
  for (const [btn, pane] of Object.entries(TABS)) {
    $('#' + btn).addEventListener('click', () => {
      for (const [b, p] of Object.entries(TABS)) {
        $('#' + b).classList.toggle('active', b === btn);
        $('#' + p).classList.toggle('hidden', p !== pane);
      }
    });
  }

  $('#btnRunBacktest').addEventListener('click', async () => {
    if (!window.lib.backtest) return;
    const status = $('#btStatus');
    status.textContent = 'Running...';
    $('#btnRunBacktest').disabled = true;
    try {
      const result = window.lib.backtest({
        candles: state.candles || [],
        rules: state.cfg.rules || {},
        strategy: state.strategy,
        initialBalance: (state.cfg.paper && state.cfg.paper.initialBalance) || 10000,
        riskPerTradePct: (state.cfg.paper && state.cfg.paper.riskPerTradePct) || 1.0,
        commissionPerTrade: (state.cfg.paper && state.cfg.paper.commissionPerTrade) || 0,
      });
      if (!result.ok) {
        status.textContent = result.error || 'Backtest failed';
        return;
      }
      status.textContent = result.trades + ' trades over ' + (result.curve ? result.curve.length : 0) + ' bars';
      $('#btStats').classList.remove('hidden');
      $('#btStats2').classList.remove('hidden');
      $('#btStats3').classList.remove('hidden');
      const pnlClass = result.totalPnl >= 0 ? 'pos' : 'neg';
      $('#btPnl').innerHTML = '<span class="' + pnlClass + '">' + (result.totalPnl >= 0 ? '+' : '') + fmtPrice(result.totalPnl, state.apiSymbol) + ' (' + result.totalPnlPct.toFixed(2) + '%)</span>';
      $('#btWinRate').textContent = result.winRate.toFixed(1) + '%';
      $('#btPF').textContent = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);
      $('#btTrades').textContent = result.trades;
      $('#btDD').textContent = result.maxDrawdownPct.toFixed(2) + '%';
      $('#btSharpe').textContent = result.sharpe.toFixed(2);
      $('#btAvgR').textContent = result.avgR.toFixed(2) + 'R';
      $('#btBestR').textContent = result.bestR.toFixed(2) + 'R';
      $('#btAvgBars').textContent = result.avgBarsPerTrade.toFixed(0);
      const canvas = $('#btEquityCanvas');
      canvas.classList.remove('hidden');
      const ctx = canvas.getContext('2d');
      const W = canvas.clientWidth || 420;
      const H = canvas.clientHeight || 64;
      canvas.width = W;
      canvas.height = H;
      ctx.clearRect(0, 0, W, H);
      if (result.curve && result.curve.length > 1) {
        const vals = result.curve.map((p) => p.equity);
        const min = Math.min.apply(null, vals);
        const max = Math.max.apply(null, vals);
        const range = max - min || 1;
        ctx.strokeStyle = vals[vals.length - 1] >= vals[0] ? '#22c55e' : '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < vals.length; i++) {
          const x = (i / (vals.length - 1)) * W;
          const y = H - ((vals[i] - min) / range) * (H - 4) - 2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      const list = $('#btTradeList');
      list.innerHTML = '';
      const recent = result.trades.slice(-50).reverse();
      for (const t of recent) {
        const li = document.createElement('li');
        const win = t.pnl >= 0;
        const d = Math.abs(t.entry) >= 1000 ? 1 : Math.abs(t.entry) >= 10 ? 2 : 5;
        li.innerHTML = '<span class="' + (win ? 'pos' : 'neg') + '">' + (t.side === 'long' ? 'LONG' : 'SHORT') + '</span> ' +
          t.entry.toFixed(d) + ' → ' + t.exit.toFixed(d) +
          ' <span class="' + (win ? 'pos' : 'neg') + '">' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2) + '</span> ' +
          t.rMultiple.toFixed(2) + 'R · ' + t.reason;
        list.appendChild(li);
      }
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
    } finally {
      $('#btnRunBacktest').disabled = false;
    }
  });

  const stratSel = $('#strategySelect');
  for (const s of window.lib.strategies || []) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    stratSel.appendChild(opt);
  }
  state.strategy = (state.cfg.rules && state.cfg.rules.strategy) || 'confluence';
  stratSel.value = state.strategy;
  stratSel.addEventListener('change', () => {
    state.strategy = stratSel.value;
    if (!state.cfg.rules) state.cfg.rules = {};
    state.cfg.rules.strategy = state.strategy;
    window.agent.saveConfig(state.cfg);
    runAnalysis();
  });

  refreshMt5Source(true).then(() => openStream());
  startMt5Watch();
  refreshNews();
  refreshData();
  restartTimers();
  renderAccount();
  renderSignalsChart();
  setTimeout(sizeSignalChart, 40);
}

init();
'use strict';

const MT5_TF = {
  '1': 'M1', '2': 'M2', '3': 'M3', '4': 'M4', '5': 'M5', '6': 'M6', '10': 'M10',
  '12': 'M12', '15': 'M15', '20': 'M20', '30': 'M30', '60': 'H1', '120': 'H2',
  '180': 'H3', '240': 'H4', '360': 'H6', '480': 'H8', '720': 'H12',
  'D': 'D1', 'W': 'W1', 'M': 'MN1',
};

const DEFAULT_MARKETS = ['gold', 'forex', 'index'];

function mt5Timeframe(tvInterval) {
  const k = String(tvInterval == null ? '' : tvInterval).toUpperCase().trim();
  return MT5_TF[k] || MT5_TF[k.replace(/^0+/, '')] || 'H1';
}

function mt5Config(cfg) {
  return (cfg && cfg.market && cfg.market.mt5) || null;
}

function mt5Enabled(cfg) {
  const m = mt5Config(cfg);
  return !!(m && m.enabled !== false);
}

function mt5Markets(cfg) {
  const m = mt5Config(cfg);
  return (m && m.markets) || DEFAULT_MARKETS;
}

function mt5Url(cfg) {
  const m = mt5Config(cfg) || {};
  return String(m.bridgeUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
}

function mt5Timeout(cfg) {
  const m = mt5Config(cfg) || {};
  return m.timeoutMs || 4000;
}

const state = { available: false, checkedAt: 0, info: null, error: null };

class Mt5Adapter {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async fetchJson(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), mt5Timeout(this.cfg));
    try {
      const res = await fetch(mt5Url(this.cfg) + path, { signal: ctrl.signal });
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json();
          detail = body && body.error ? ': ' + body.error : '';
        } catch (err) { void err; }
        throw new Error('MT5 bridge ' + res.status + detail);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(force) {
    if (!mt5Enabled(this.cfg)) {
      state.available = false;
      state.info = null;
      return false;
    }
    const now = Date.now();
    const ttl = state.available ? 20000 : 5000;
    if (!force && state.checkedAt && now - state.checkedAt < ttl) return state.available;
    state.checkedAt = now;
    try {
      const info = await this.fetchJson('/health');
      state.info = info || null;
      state.available = !!(info && info.ok);
      state.error = info && info.error ? info.error : null;
    } catch (err) {
      state.available = false;
      state.info = null;
      state.error = err.message;
    }
    return state.available;
  }

  async fetchCandles(symbol, tvInterval) {
    const tf = mt5Timeframe(tvInterval);
    const url = '/candles?symbol=' + encodeURIComponent(symbol) + '&tf=' + tf + '&n=400';
    const j = await this.fetchJson(url);
    const rows = (j && j.candles) || [];
    if (!rows.length) throw new Error('MT5: no candles for ' + symbol + ' ' + tf);
    return rows
      .map((r) => ({
        time: r.time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }))
      .slice(0, -1);
  }

  async fetchPrice(symbol) {
    const j = await this.fetchJson('/tick?symbol=' + encodeURIComponent(symbol));
    const last = j && typeof j.last === 'number' ? j.last : 0;
    const px = last > 0 ? last : ((j && j.bid ? j.bid : 0) + (j && j.ask ? j.ask : 0)) / 2;
    if (!(px > 0)) throw new Error('MT5: no tick for ' + symbol);
    return px;
  }
}

async function mt5Status(cfg, force) {
  const adapter = new Mt5Adapter(cfg);
  const available = await adapter.probe(force);
  return {
    available,
    error: state.error,
    info: state.info,
    url: mt5Url(cfg),
    enabled: mt5Enabled(cfg),
  };
}

module.exports = {
  Mt5Adapter, mt5Timeframe, mt5Enabled, mt5Markets, mt5Status,
  MT5_TF, DEFAULT_MARKETS,
};

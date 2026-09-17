'use strict';

const { Mt5Adapter, mt5Enabled, mt5Markets } = require('./mt5');
const { TradingViewAdapter } = require('./tradingview');

function parseCandle(row) {
  return {
    time: row[0],
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  };
}

const INTERVAL_MAP = {
  '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '60': '1h',
  '120': '2h', '180': '3h', '240': '4h', '360': '6h', '480': '8h',
  '720': '12h', 'D': '1d', 'W': '1w', 'M': '1M',
};

const YAHOO_INTERVAL = {
  '1': ['1m', '5d'], '3': ['5m', '1mo'], '5': ['5m', '1mo'], '15': ['15m', '1mo'],
  '30': ['30m', '1mo'], '60': ['60m', '3mo'], '120': ['60m', '6mo'], '180': ['60m', '6mo'],
  '240': ['60m', '1y'], '360': ['60m', '1y'], '480': ['60m', '1y'], '720': ['60m', '2y'],
  'D': ['1d', '2y'], 'W': ['1wk', '5y'], 'M': ['1mo', 'max'],
};

const EXCHANGE_TO_TV = {
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSEARCA', ASE: 'AMEX', BTS: 'BATS', PNK: 'OTC',
  LSE: 'LSE', TOR: 'TSX', FRA: 'FWB', GER: 'XETR', HKG: 'HKEX', TYO: 'TSE',
};

function toBinanceInterval(tvInterval) {
  return INTERVAL_MAP[String(tvInterval)] || '1h';
}

function proxySymbol(symbol, market, cfg) {
  const table = (cfg && cfg.market && cfg.market.binanceProxies) || null;
  if (!table) return null;
  const m = table[market];
  if (!m) return null;
  const s = String(symbol || '').toUpperCase().trim();
  return m[s] || m['*'] || null;
}

function binanceMarketSymbol(symbol, market, cfg) {
  const enabled = !cfg || !cfg.market || cfg.market.useBinanceProxies !== false;
  if (market === 'crypto') return String(symbol || '').toUpperCase().trim();
  if (!enabled) return null;
  return proxySymbol(symbol, market, cfg);
}

function toYahooSymbol(symbol, market) {
  const s = String(symbol || '').toUpperCase().trim();
  if (/[\^=]/.test(s) || s.includes('-')) return s;
  if (market === 'crypto') {
    const m = s.match(/^([A-Z0-9]+?)(USDT|USDC|BUSD|USD)$/);
    return (m ? m[1] : s) + '-USD';
  }
  if (market === 'gold') return 'GC=F';
  if (market === 'forex') return s + '=X';
  return s;
}

class BinanceAdapter {
  constructor(cfg) {
    this.baseUrl = (cfg && cfg.market && cfg.market.binance && cfg.market.binance.baseUrl) || 'https://api.binance.com';
    this.limit = (cfg && cfg.market && cfg.market.binance && cfg.market.binance.limit) || 300;
  }

  async fetchCandles(symbol, tvInterval) {
    const sym = String(symbol).toUpperCase();
    const url = this.baseUrl + '/api/v3/klines'
      + '?symbol=' + encodeURIComponent(sym)
      + '&interval=' + encodeURIComponent(toBinanceInterval(tvInterval))
      + '&limit=' + this.limit;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance klines ' + res.status + ' for ' + sym);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected Binance response');
    return rows.slice(0, -1).map(parseCandle);
  }

  async fetchPrice(symbol) {
    const sym = String(symbol).toUpperCase();
    const url = this.baseUrl + '/api/v3/ticker/price?symbol=' + encodeURIComponent(sym);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Binance price ' + res.status + ' for ' + sym);
    const data = await res.json();
    return parseFloat(data.price);
  }
}

class YahooAdapter {
  constructor(cfg) {
    const y = (cfg && cfg.market && cfg.market.yahoo) || {};
    this.chartBase = y.chartBase || 'https://query1.finance.yahoo.com/v8/finance/chart/';
    this.userAgent = y.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  }

  async fetchCandles(symbol, tvInterval, market) {
    const ySym = toYahooSymbol(symbol, market);
    const [interval, range] = YAHOO_INTERVAL[String(tvInterval)] || ['60m', '3mo'];
    const url = this.chartBase + encodeURIComponent(ySym) + '?interval=' + interval + '&range=' + range;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error('Yahoo chart ' + res.status + ' for ' + ySym);
    const data = await res.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error('Yahoo: no data for ' + ySym);
    const ts = result.timestamp || [];
    const q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q) throw new Error('Yahoo: no quote series for ' + ySym);
    const candles = [];
    for (let i = 0; i < ts.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        time: ts[i] * 1000,
        open: q.open[i],
        high: q.high[i],
        low: q.low[i],
        close: q.close[i],
        volume: q.volume[i] || 0,
      });
    }
    if (candles.length < 30) throw new Error('Yahoo: too few bars for ' + ySym);
    return candles.slice(0, -1);
  }

  async fetchPrice(symbol, market) {
    const ySym = toYahooSymbol(symbol, market);
    const url = this.chartBase + encodeURIComponent(ySym) + '?interval=5m&range=1d&includePrePost=false';
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) throw new Error('Yahoo price ' + res.status + ' for ' + ySym);
    const data = await res.json();
    const meta = data.chart.result[0].meta;
    return meta.regularMarketPrice;
  }
}

class AlphaVantageAdapter {
  constructor(cfg) {
    this.baseUrl = (cfg && cfg.market && cfg.market.alphavantage && cfg.market.alphavantage.baseUrl) || 'https://www.alphavantage.co/query';
  }

  async fetchCandles(symbol, tvInterval) {
    const key = process.env.ALPHAVANTAGE_KEY;
    if (!key) throw new Error('Alpha Vantage needs ALPHAVANTAGE_KEY (set it in Settings or env)');
    let interval = '60min';
    if (['1', '5', '15', '30', '60'].includes(String(tvInterval))) {
      interval = toBinanceInterval(tvInterval).replace('m', 'min').replace(/^(\d+)h$/, '$1min');
    }
    const url = this.baseUrl + '?function=TIME_SERIES_INTRADAY&symbol=' + encodeURIComponent(symbol)
      + '&interval=' + interval + '&outputsize=full&apikey=' + encodeURIComponent(key);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Alpha Vantage ' + res.status);
    const data = await res.json();
    const series = data['Time Series (' + interval + ')'];
    if (!series) throw new Error('Alpha Vantage: ' + (data['Note'] || data['Error Message'] || 'no series').slice(0, 160));
    return Object.entries(series)
      .map(([time, d]) => ({
        time: Date.parse(time),
        open: parseFloat(d['1. open']),
        high: parseFloat(d['2. high']),
        low: parseFloat(d['3. low']),
        close: parseFloat(d['4. close']),
        volume: parseFloat(d['5. volume']),
      }))
      .sort((a, b) => a.time - b.time)
      .slice(0, -1);
  }

  async fetchPrice(symbol) {
    const candles = await this.fetchCandles(symbol, '60');
    return candles[candles.length - 1].close;
  }
}

class BiquoteAdapter {
  constructor() {
    this.baseUrl = 'https://biquote.io/api';
  }

  async fetchPrice(symbol) {
    const sym = String(symbol).toUpperCase().trim();
    const url = this.baseUrl + '/' + encodeURIComponent(sym);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('Biquote ' + res.status + ' for ' + sym);
    const j = await res.json();
    if (j.stale) throw new Error('Biquote stale price for ' + sym);
    const bid = typeof j.bid === 'number' ? j.bid : 0;
    const ask = typeof j.ask === 'number' ? j.ask : 0;
    const mid = (bid + ask) / 2;
    if (mid > 0) return mid;
    throw new Error('Biquote: no price for ' + sym);
  }
}

class MarketData {
  constructor(cfg) {
    this.cfg = cfg;
    this.binance = new BinanceAdapter(cfg);
    this.yahoo = new YahooAdapter(cfg);
    this.alphavantage = new AlphaVantageAdapter(cfg);
    this.mt5 = new Mt5Adapter(cfg);
    this.tradingview = new TradingViewAdapter(cfg);
    this.biquote = new BiquoteAdapter();
  }

  chainFor(symbol, market) {
    if (market === 'crypto') return [this.binance, this.yahoo];
    if (market === 'gold' || market === 'forex') return [this.biquote, this.yahoo, this.alphavantage];
    if (market === 'stock') return [this.yahoo, this.alphavantage];
    return [this.binance, this.yahoo];
  }

  proxyFor(symbol, market) {
    const enabled = !this.cfg || !this.cfg.market || this.cfg.market.useBinanceProxies !== false;
    if (!enabled) return null;
    return proxySymbol(symbol, market, this.cfg);
  }

  useMt5(market) {
    return mt5Enabled(this.cfg) && mt5Markets(this.cfg).indexOf(market) !== -1;
  }

  useTradingViewPrice(market) {
    if (this.cfg && this.cfg.market && this.cfg.market.tradingviewPrice === false) return false;
    return market !== 'crypto';
  }

  async fetchCandles(symbol, interval, market) {
    const proxy = this.proxyFor(symbol, market);
    let lastErr = null;
    if (this.useMt5(market) && (await this.mt5.probe())) {
      try {
        return await this.mt5.fetchCandles(symbol, interval);
      } catch (err) {
        lastErr = err;
      }
    }
    if (proxy) {
      try {
        return await this.binance.fetchCandles(proxy, interval);
      } catch (err) {
        lastErr = err;
      }
    }
    for (const adapter of this.chainFor(symbol, market)) {
      try {
        return await adapter.fetchCandles(symbol, interval, market);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No data source available');
  }

  async fetchPrice(symbol, market) {
    const proxy = this.proxyFor(symbol, market);
    let lastErr = null;
    if (this.useMt5(market) && (await this.mt5.probe())) {
      try {
        return await this.mt5.fetchPrice(symbol);
      } catch (err) {
        lastErr = err;
      }
    }
    if (market === 'gold' || market === 'forex') {
      try {
        return await this.biquote.fetchPrice(symbol);
      } catch (err) {
        lastErr = err;
      }
    }
    if (this.useTradingViewPrice(market)) {
      try {
        return await this.tradingview.fetchPrice(symbol, market);
      } catch (err) {
        lastErr = err;
      }
    }
    if (proxy) {
      try {
        return await this.binance.fetchPrice(proxy);
      } catch (err) {
        lastErr = err;
      }
    }
    for (const adapter of this.chainFor(symbol, market)) {
      try {
        return await adapter.fetchPrice(symbol, market);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('No price source available');
  }
}

module.exports = {
  MarketData, BinanceAdapter, YahooAdapter, AlphaVantageAdapter, Mt5Adapter, TradingViewAdapter,
  toBinanceInterval, toYahooSymbol, proxySymbol, binanceMarketSymbol, EXCHANGE_TO_TV, INTERVAL_MAP,
};
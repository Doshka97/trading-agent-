'use strict';

const TV_PREFIX = { gold: 'OANDA:', forex: 'FX:', crypto: 'BINANCE:' };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function toTradingViewSymbol(symbol, market) {
  const s = String(symbol == null ? '' : symbol).toUpperCase().trim();
  if (!s) return null;
  if (s.includes(':')) return s;
  const prefix = TV_PREFIX[market];
  return prefix ? prefix + s : null;
}

class TradingViewAdapter {
  constructor(cfg) {
    this.cfg = cfg;
  }

  async fetchPrice(symbol, market) {
    const tv = toTradingViewSymbol(symbol, market);
    if (!tv) throw new Error('TradingView: unsupported market ' + market);
    const url = 'https://scanner.tradingview.com/symbol?symbol=' +
      encodeURIComponent(tv) + '&fields=close,bid,ask&update_mode=streaming&_=' + Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('TradingView ' + res.status + ' for ' + tv);
    const j = await res.json();
    const bid = j && typeof j.bid === 'number' ? j.bid : 0;
    const ask = j && typeof j.ask === 'number' ? j.ask : 0;
    const mid = (bid + ask) / 2;
    const close = j && typeof j.close === 'number' ? j.close : 0;
    const px = mid > 0 ? mid : close;
    if (!(px > 0)) throw new Error('TradingView: no price for ' + tv);
    return px;
  }

  async fetchCandles() {
    throw new Error('TradingView: candle history not supported');
  }
}

module.exports = { TradingViewAdapter, toTradingViewSymbol, TV_PREFIX };

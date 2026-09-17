'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { MarketData, EXCHANGE_TO_TV, toBinanceInterval, binanceMarketSymbol } = require('../src/market');
const { mt5Status } = require('../src/mt5');
const { toTradingViewSymbol } = require('../src/tradingview');
const rules = require('../src/rules');
const strategies = require('../src/strategies');
const signals = require('../src/signals');
const paper = require('../src/paper');

contextBridge.exposeInMainWorld('agent', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  collectNews: (ticker, market) => ipcRenderer.invoke('news:collect', { ticker, market }),
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  searchSymbols: (query) => ipcRenderer.invoke('symbol:search', query),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggleFullscreen'),
  paperLoad: () => ipcRenderer.invoke('paper:load'),
  paperSave: (account) => ipcRenderer.invoke('paper:save', account),
  paperReset: (account) => ipcRenderer.invoke('paper:reset', account),
});

contextBridge.exposeInMainWorld('lib', {
  fetchCandles: (symbol, interval, market, cfg) =>
    new MarketData(cfg).fetchCandles(symbol, interval, market),
  fetchPrice: (symbol, market, cfg) =>
    new MarketData(cfg).fetchPrice(symbol, market),
  analyze: (payload) => rules.analyze(payload),
  exchangeToTv: EXCHANGE_TO_TV,
  strategies: strategies.STRATEGIES,
  evaluateSignal: (payload) => signals.evaluate(payload),
  adoptPosition: (pos) => signals.adopt(pos),
  binanceStreamSymbol: (symbol, market, cfg) => binanceMarketSymbol(symbol, market, cfg),
  binanceInterval: (tvInterval) => toBinanceInterval(tvInterval),
  mt5Status: (cfg, force) => mt5Status(cfg, force),
  tvSymbol: (symbol, market) => toTradingViewSymbol(symbol, market),
  paper: {
    defaults: () => paper.DEFAULTS,
    createAccount: (cfg) => paper.createAccount(cfg),
    normalize: (account, cfg) => paper.normalize(account, cfg),
    markPrice: (account, symbol, price) => ({ account: paper.markPrice(account, symbol, price) }),
    openTrade: (account, params, cfg) => {
      const r = paper.openTrade(account, params, cfg);
      return { account, ok: r.ok, reason: r.reason };
    },
    closeTrade: (account, price, reason, cfg) => {
      const r = paper.closeTrade(account, price, reason, cfg);
      return { account, ok: r.ok, reason: r.reason, trade: r.trade };
    },
    closeIfOtherSymbol: (account, symbol, cfg) => {
      const r = paper.closeIfOtherSymbol(account, symbol, null, 'Symbol changed', cfg);
      return { account, ok: r.ok, reason: r.reason, trade: r.trade };
    },
    stats: (account) => paper.stats(account),
  },
});
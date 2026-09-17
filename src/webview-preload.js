'use strict';

const { ipcRenderer } = require('electron');

function currentUrlSymbol() {
  const m = window.location.search.match(/[?&]symbol=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function frameSymbol() {
  try {
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const f of frames) {
      const m = (f.src || '').match(/symbol=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
  } catch (err) {
    void err;
  }
  return null;
}

function headerTextCandidate() {
  try {
    const candidates = [
      '.tv-embed-widget-header__title',
      '.tv-embed-widget-header',
      '.tv-widget-header',
      '[class*="widget-embed"] h1',
      '[class*="widget-embed"] span',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').replace(/[·|]/g, ' ').trim();
        const parts = text.split(/\s+/);
        const first = parts[0] || '';
        if (/^[A-Z0-9:._-]{2,12}$/.test(first)) return first;
      }
    }
  } catch (err) {
    void err;
  }
  return null;
}

let lastSymbol = null;
let pending = null;
let pendingCount = 0;

function emit(symbol) {
  lastSymbol = symbol;
  console.log('[trading-agent] chart symbol observed:', symbol);
  ipcRenderer.sendToHost('ticker-state', { symbol, observedAt: Date.now() });
}

function detect() {
  const urlSym = currentUrlSymbol();
  const symbol = urlSym || frameSymbol() || headerTextCandidate();
  if (!symbol) return;
  const clean = symbol.replace(/^CRYPTO:/, '');
  if (clean === lastSymbol) {
    pending = null;
    pendingCount = 0;
    return;
  }
  // The symbol in our own webview URL is authoritative: trust it immediately.
  if (urlSym) {
    pending = null;
    pendingCount = 0;
    emit(clean);
    return;
  }
  // Scraped fallbacks are noisy, so only accept a symbol that stays stable
  // across two consecutive polls (guards against transient/stale header text).
  if (pending === clean) pendingCount += 1;
  else {
    pending = clean;
    pendingCount = 1;
  }
  if (pendingCount >= 2) {
    pending = null;
    pendingCount = 0;
    emit(clean);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(detect, 1500);
  setInterval(detect, 2500);
  setTimeout(() => {
    console.log('[trading-agent] chart viewport:', window.innerWidth + 'x' + window.innerHeight);
  }, 2500);
});
'use strict';

const { app, BrowserWindow, ipcMain, Notification, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const news = require('./news');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PAPER_PATH = path.join(ROOT, 'paper-account.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function loadPaper() {
  try {
    return JSON.parse(fs.readFileSync(PAPER_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

function savePaper(account) {
  fs.writeFileSync(PAPER_PATH, JSON.stringify(account, null, 2), 'utf8');
}

let mt5Bridge = null;

function mt5PackageAvailable(python, pythonArgs) {
  try {
    const res = spawnSync(python, pythonArgs.concat(['-c', 'import MetaTrader5']), {
      timeout: 8000,
      windowsHide: true,
    });
    return res.status === 0;
  } catch (err) {
    return false;
  }
}

function mt5BridgeHealthy(m, timeoutMs) {
  return new Promise((resolve) => {
    const url = String(m.bridgeUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '') + '/health';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
    fetch(url, { signal: controller.signal })
      .then((res) => res.json().then((j) => resolve(j.ok === true)))
      .catch(() => resolve(false))
      .finally(() => clearTimeout(timer));
  });
}

async function startMt5Bridge() {
  const cfg = loadConfig();
  const m = (cfg.market && cfg.market.mt5) || {};
  if (m.enabled === false || m.autostart === false) return;
  const script = path.join(ROOT, 'bridge', 'mt5_bridge.py');
  if (!fs.existsSync(script)) return;
  if (await mt5BridgeHealthy(m)) {
    console.log('[mt5] bridge already running');
    return;
  }
  const python = m.python || 'py';
  const pythonArgs = m.pythonArgs || ['-3'];
  if (!mt5PackageAvailable(python, pythonArgs)) {
    console.log('[mt5] MetaTrader5 python package not installed - bridge disabled');
    return;
  }
  const args = pythonArgs.concat([
    script,
    '--port', String(m.port || 8765),
  ]);
  if (m.login) args.push('--login', String(m.login));
  if (m.password) args.push('--password', String(m.password));
  if (m.server) args.push('--server', String(m.server));
  if (m.terminalPath) args.push('--path', String(m.terminalPath));
  try {
    const logFd = fs.openSync(path.join(ROOT, '_mt5.log'), 'a');
    mt5Bridge = spawn(python, args, {
      cwd: ROOT,
      detached: false,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    mt5Bridge.on('exit', (code) => {
      console.log('[mt5] bridge exited with code', code);
      mt5Bridge = null;
    });
    console.log('[mt5] bridge starting:', python, args.slice(1, 3).join(' '));
  } catch (err) {
    console.error('[mt5] failed to start bridge:', err.message);
    mt5Bridge = null;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1116',
    title: 'Trading Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  mainWindow.maximize();
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, '(' + sourceId + ':' + line + ')');
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[load-fail]', code, desc, url);
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow.webContents.getURL()) e.preventDefault();
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'notifications' || permission === 'fullscreen');
  });
  startMt5Bridge();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  if (mt5Bridge) {
    try { mt5Bridge.kill(); } catch (err) { void err; }
    mt5Bridge = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, cfg) => {
  saveConfig(cfg);
  return true;
});

ipcMain.handle('paper:load', () => loadPaper());

ipcMain.handle('paper:save', (_e, account) => {
  savePaper(account);
  return true;
});

ipcMain.handle('paper:reset', (_e, account) => {
  savePaper(account);
  return true;
});

ipcMain.handle('news:collect', async (_e, payload) => {
  const cfg = loadConfig();
  const { ticker, market } = payload || {};
  return news.collectNews(cfg, ticker || 'BTC', market || 'crypto');
});

ipcMain.handle('app:notify', (_e, payload) => {
  if (Notification.isSupported()) {
    const n = new Notification({
      title: payload.title || 'Trading Agent',
      body: payload.body || '',
      silent: false,
    });
    n.show();
  }
  return true;
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https?:\/\//.test(url || '')) shell.openExternal(url);
  return true;
});

ipcMain.handle('app:toggleFullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  return next;
});

ipcMain.handle('symbol:search', async (_e, query) => {
  const cfg = loadConfig();
  const q = String(query || '').trim();
  if (q.length < 1) return [];
  const y = (cfg.market && cfg.market.yahoo) || {};
  const base = y.searchBase || 'https://query1.finance.yahoo.com/v1/finance/search';
  const url = base + '?q=' + encodeURIComponent(q) + '&quotesCount=10&newsCount=0';
  try {
    const { status, body } = await news.netGet(url, { 'User-Agent': y.userAgent || 'trading-agent' });
    if (status !== 200) return [];
    const data = JSON.parse(body);
    return (data.quotes || [])
      .filter((x) => x.symbol)
      .map((x) => ({
        symbol: x.symbol,
        name: x.shortname || x.longname || '',
        exchange: x.exchange || '',
        type: x.quoteType || '',
      }));
  } catch (err) {
    return [];
  }
});
#!/usr/bin/env python
"""Local MetaTrader 5 bridge for the Trading Agent app.

Lets the Electron app read live prices and candles straight from a running
MetaTrader 5 terminal, so gold/forex data is the exact broker feed.

    py -3 bridge/mt5_bridge.py --port 8765
    py -3 bridge/mt5_bridge.py --login 12345678 --password secret --server Broker-Demo

Endpoints (all JSON, localhost only):
    GET /health                              connection + account status
    GET /symbols?filter=EUR                  symbols available at the broker
    GET /tick?symbol=XAUUSD                  latest bid/ask/last
    GET /candles?symbol=XAUUSD&tf=H1&n=400   OHLCV bars (oldest first)

Timeframes accept the app's interval codes (1, 5, 15, 30, 60, 120, 240, D, W)
or MT5 names (M1 ... MN1). The final, still-forming bar is included; the app
drops it, matching the other data adapters.
"""

import argparse
import json
import queue
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import MetaTrader5 as mt5
except Exception as exc:  # pragma: no cover - dependency guard
    mt5 = None
    MT5_IMPORT_ERROR = str(exc)
else:
    MT5_IMPORT_ERROR = None

# Every MT5 call runs in ONE persistent worker thread so the
# MetaTrader5 C extension (not fully thread-safe) is never called from
# different threads simultaneously.
import queue as _queue
MT5_QUEUE = _queue.Queue()
MT5_WORKER = None

CONNECT_LOCK = threading.Lock()
CALL_TIMEOUT = 10.0
RETRY_COOLDOWN = 30.0
CONNECT_TIMEOUT = 20.0

TF_NAMES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M10', 'M12', 'M15', 'M20',
            'M30', 'H1', 'H2', 'H3', 'H4', 'H6', 'H8', 'H12', 'D1', 'W1', 'MN1']

INTERVAL_TO_TF = {
    '1': 'M1', '2': 'M2', '3': 'M3', '4': 'M4', '5': 'M5', '6': 'M6',
    '10': 'M10', '12': 'M12', '15': 'M15', '20': 'M20', '30': 'M30',
    '60': 'H1', '120': 'H2', '180': 'H3', '240': 'H4', '360': 'H6',
    '480': 'H8', '720': 'H12',
    'D': 'D1', 'D1': 'D1', 'W': 'W1', 'W1': 'W1', 'M': 'MN1', 'MN': 'MN1',
}

STATE = {
    'connected': False,
    'ipc': False,
    'error': None,
    'account': None,
    'terminal': None,
    'started': time.time(),
    'nextAttempt': 0.0,
    'attempts': 0,
    'busy': False,
}


def mt5_worker():
    """Dedicated thread: runs every MT5 call sequentially."""
    while True:
        item = MT5_QUEUE.get()
        if item is None:
            break
        fn, result_queue = item
        try:
            result_queue.put(('ok', fn()))
        except Exception as exc:  # noqa: BLE001
            result_queue.put(('err', exc))


def start_worker():
    global MT5_WORKER
    MT5_WORKER = threading.Thread(target=mt5_worker, daemon=True)
    MT5_WORKER.start()


def dispatch(fn, timeout=CALL_TIMEOUT):
    """Run fn() on the MT5 worker thread. Returns its return value.

    Raises ValueError on timeout or on any MT5 exception.
    """
    result_queue = _queue.Queue()
    MT5_QUEUE.put((fn, result_queue))
    try:
        kind, value = result_queue.get(timeout=timeout)
    except Exception:  # noqa: BLE001 - queue.Empty
        raise ValueError('MT5 call timed out after %ss' % int(timeout))
    if kind == 'err':
        raise value
    return value


def resolve_tf(raw):
    if not raw:
        return 'H1'
    key = str(raw).upper().strip()
    if key in TF_NAMES:
        return key
    return INTERVAL_TO_TF.get(key) or INTERVAL_TO_TF.get(key.lstrip('0')) or 'H1'


def const(name):
    if mt5 is None:
        return None
    return getattr(mt5, 'TIMEFRAME_' + name, None)


def describe_terminal(info):
    if not info:
        return None
    try:
        return {
            'name': getattr(info, 'name', None),
            'company': getattr(info, 'company', None),
            'path': getattr(info, 'path', None),
            'build': getattr(info, 'build', None),
            'connected': bool(getattr(info, 'connected', False)),
        }
    except Exception:
        return None


def describe_account(info):
    if not info:
        return None
    try:
        return {
            'login': int(getattr(info, 'login', 0)),
            'server': getattr(info, 'server', None),
            'currency': getattr(info, 'currency', None),
            'balance': float(getattr(info, 'balance', 0.0)),
            'equity': float(getattr(info, 'equity', 0.0)),
            'leverage': int(getattr(info, 'leverage', 0)),
        }
    except Exception:
        return None


def diagnose(connected, error):
    """Translate an IPC failure into the thing the user actually has to do."""
    if connected:
        return None
    text = (error or '').lower()
    if 'timeout' in text:
        return ('mt5.initialize() timed out - the terminal is running but not '
                'answering IPC. Enable Tools > Options > Community > "Python '
                'integration", then restart the terminal.')
    if 'not found' in text:
        return ('MetaTrader 5 terminal not found. Open the terminal (or set '
                'market.mt5.terminalPath / product path) and try again.')
    return None


PROC_CACHE = {'at': 0.0, 'running': False}


def terminal_running():
    """True if terminal64.exe is already running. Keeps MT5 closed when the
    user only wants the agent, not the terminal."""
    now = time.time()
    if now - PROC_CACHE['at'] < 5.0:
        return PROC_CACHE['running']
    try:
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq terminal64.exe', '/NH'],
                             capture_output=True, text=True, timeout=5).stdout
        running = 'terminal64.exe' in out.lower()
    except Exception:  # noqa: BLE001
        running = True
    PROC_CACHE['at'] = now
    PROC_CACHE['running'] = running
    return running


def connect(args):
    """Initialise the MT5 terminal. Never blocks longer than CONNECT_TIMEOUT."""
    if mt5 is None:
        STATE['error'] = 'MetaTrader5 package not installed: %s' % MT5_IMPORT_ERROR
        return False
    if not CONNECT_LOCK.acquire(blocking=False):
        STATE['busy'] = True
        return False
    try:
        STATE['busy'] = True
        if not args.path and not args.launch and not terminal_running():
            STATE['ipc'] = False
            STATE['connected'] = False
            STATE['error'] = 'MetaTrader 5 terminal is not running'
            STATE['hint'] = 'Open MetaTrader 5 and log in, then it connects automatically.'
            STATE['nextAttempt'] = time.time() + RETRY_COOLDOWN
            return False
        kwargs = {}
        if args.path:
            kwargs['path'] = args.path
        if args.login:
            kwargs['login'] = int(args.login)
            kwargs['password'] = args.password or ''
            kwargs['server'] = args.server or ''
        STATE['attempts'] += 1
        try:
            ok = dispatch(lambda: mt5.initialize(**kwargs))
        except ValueError as exc:  # noqa: BLE001 - timeout
            ok = None
            STATE['error'] = str(exc)
        except Exception as exc:  # noqa: BLE001
            ok = None
            STATE['error'] = '%s: %s' % (type(exc).__name__, exc)
        if not ok:
            code, msg = mt5.last_error() if mt5.last_error() else (None, STATE['error'] or 'unknown')
            STATE['ipc'] = False
            STATE['connected'] = False
            STATE['error'] = '%s (%s)' % (msg, code)
            STATE['hint'] = diagnose(False, msg)
            STATE['nextAttempt'] = time.time() + RETRY_COOLDOWN
            return False
        STATE['ipc'] = True
        STATE['error'] = None
        STATE['hint'] = None
        STATE['terminal'] = describe_terminal(mt5.terminal_info())
        STATE['account'] = describe_account(mt5.account_info())
        STATE['connected'] = bool(STATE['terminal'] and STATE['terminal'].get('connected'))
        if not STATE['connected']:
            STATE['error'] = 'terminal up but not connected to a broker (log in)'
            STATE['hint'] = ('MT5 is running but no account is logged in. Log into a '
                             'demo or live account in the terminal.')
            STATE['nextAttempt'] = time.time() + RETRY_COOLDOWN
            return False
        return True
    finally:
        STATE['busy'] = False
        CONNECT_LOCK.release()


def ensure(args):
    if STATE['connected']:
        return True
    if STATE['busy']:
        return False
    if mt5 is not None and time.time() < STATE['nextAttempt']:
        return False
    return connect(args)


def request_connect(args):
    """Start a connect attempt in the background; never blocks the caller."""
    if STATE['connected'] or STATE['busy']:
        return
    if mt5 is not None and time.time() < STATE['nextAttempt']:
        return
    threading.Thread(target=connect, args=(args,), daemon=True).start()


def health(args):
    if STATE['connected']:
        try:
            info = dispatch(mt5.terminal_info)
        except Exception:  # noqa: BLE001
            info = None
        if info is not None:
            STATE['terminal'] = describe_terminal(info)
            if not (STATE['terminal'] and STATE['terminal'].get('connected')):
                STATE['connected'] = False
                STATE['error'] = 'terminal lost its broker connection'
                STATE['nextAttempt'] = time.time() + RETRY_COOLDOWN
    else:
        request_connect(args)
    return {
        'ok': bool(STATE['connected']),
        'connected': bool(STATE['connected']),
        'ipc': bool(STATE['ipc']),
        'busy': bool(STATE['busy']),
        'error': STATE['error'],
        'hint': STATE.get('hint'),
        'terminal': STATE['terminal'],
        'account': STATE['account'],
        'attempts': STATE['attempts'],
        'retryIn': max(0.0, round(STATE['nextAttempt'] - time.time(), 1)),
        'uptime': round(time.time() - STATE['started'], 1),
        'package': getattr(mt5, '__version__', None) if mt5 else None,
    }


def select_symbol(symbol):
    """Make symbol visible in the market watch, then return its info."""
    dispatch(lambda: mt5.symbol_select(symbol, True))
    info = dispatch(lambda: mt5.symbol_info(symbol))
    if info is None:
        return None
    if not info.visible:
        dispatch(lambda: mt5.symbol_select(symbol, True))
        info = dispatch(lambda: mt5.symbol_info(symbol)) or info
    return info


def tick(symbol):
    info = select_symbol(symbol)
    if info is None:
        raise ValueError('unknown symbol: %s' % symbol)
    t = dispatch(lambda: mt5.symbol_info_tick(symbol))
    if t is None:
        raise ValueError('no tick for %s' % symbol)
    digits = getattr(info, 'digits', 5)
    return {
        'symbol': symbol,
        'bid': float(t.bid),
        'ask': float(t.ask),
        'last': float(t.last or 0.0),
        'spread': int(getattr(info, 'spread', 0) or 0),
        'digits': int(digits),
        'time': int(t.time) * 1000,
        'serverTime': int(t.time_msc) if getattr(t, 'time_msc', 0) else None,
    }


def candles(symbol, tf_name, count):
    info = select_symbol(symbol)
    if info is None:
        raise ValueError('unknown symbol: %s' % symbol)
    tf = const(tf_name)
    if tf is None:
        raise ValueError('unsupported timeframe: %s' % tf_name)
    rates = dispatch(lambda: mt5.copy_rates_from_pos(symbol, tf, 0, int(count)))
    if rates is None or len(rates) == 0:
        code, msg = mt5.last_error()
        raise ValueError('no candles for %s %s (%s %s)' % (symbol, tf_name, msg, code))
    out = []
    for r in rates:
        out.append({
            'time': int(r['time']) * 1000,
            'open': float(r['open']),
            'high': float(r['high']),
            'low': float(r['low']),
            'close': float(r['close']),
            'volume': float(r['tick_volume']),
            'spread': int(r['spread']),
        })
    return out


def symbols(filter_text):
    all_syms = dispatch(lambda: mt5.symbols_get())
    if all_syms is None:
        return []
    needle = (filter_text or '').upper()
    names = [s.name for s in all_syms if needle in s.name.upper()]
    return names[:500]


class Handler(BaseHTTPRequestHandler):
    server_version = 'Mt5Bridge/1.0'
    args = None

    def log_message(self, fmt, *fmt_args):
        sys.stderr.write('[mt5] ' + (fmt % fmt_args) + '\n')

    def _send(self, code, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802 - stdlib signature
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.end_headers()

    def do_GET(self):  # noqa: N802 - stdlib signature
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        route = parsed.path.rstrip('/') or '/'

        def one(name, default=None):
            vals = query.get(name)
            return vals[0] if vals else default

        try:
            if route in ('/', '/health'):
                self._send(200, health(self.args))
                return
            if not STATE['connected']:
                request_connect(self.args)
                self._send(503, health(self.args))
                return
            with CONNECT_LOCK:
                if route == '/symbols':
                    self._send(200, {'ok': True, 'symbols': symbols(one('filter', ''))})
                elif route == '/tick':
                    self._send(200, {'ok': True, **tick(one('symbol', ''))})
                elif route == '/candles':
                    tf_name = resolve_tf(one('tf', 'H1'))
                    n = int(one('n', '400'))
                    n = max(10, min(n, 5000))
                    data = candles(one('symbol', ''), tf_name, n)
                    self._send(200, {'ok': True, 'symbol': one('symbol', ''), 'tf': tf_name, 'count': len(data), 'candles': data})
                else:
                    self._send(404, {'ok': False, 'error': 'unknown route ' + route})
        except ValueError as exc:
            self._send(400, {'ok': False, 'error': str(exc)})
        except Exception as exc:  # pragma: no cover - defensive
            self._send(500, {'ok': False, 'error': '%s: %s' % (type(exc).__name__, exc)})


def main():
    global RETRY_COOLDOWN, CONNECT_TIMEOUT

    parser = argparse.ArgumentParser(description='MetaTrader 5 bridge for the Trading Agent app')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--login', type=int, default=None)
    parser.add_argument('--password', default=None)
    parser.add_argument('--server', default=None)
    parser.add_argument('--path', default=None, help='path to terminal64.exe')
    parser.add_argument('--no-connect', action='store_true', help='serve without connecting yet')
    parser.add_argument('--launch', action='store_true',
                        help='allow mt5.initialize() to start a terminal that is not running')
    parser.add_argument('--retry', type=float, default=RETRY_COOLDOWN,
                        help='seconds between connect retries after a failure')
    parser.add_argument('--timeout', type=float, default=CONNECT_TIMEOUT,
                        help='seconds to wait for mt5.initialize() before giving up')
    args = parser.parse_args()

    RETRY_COOLDOWN = args.retry
    CONNECT_TIMEOUT = args.timeout
    start_worker()
    Handler.args = args
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print('mt5 bridge listening on http://%s:%d' % (args.host, args.port), flush=True)
    print('  package: %s' % (getattr(mt5, '__version__', 'missing') if mt5 else 'missing'), flush=True)

    def bootstrap():
        connect(args)
        status = health(args)
        print('mt5 bridge status: connected=%s error=%s' % (status['connected'], status['error']), flush=True)
        if not status['connected'] and status.get('hint'):
            print('  fix: %s' % status['hint'], flush=True)

    if not args.no_connect:
        threading.Thread(target=bootstrap, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if mt5 is not None and STATE['connected']:
            mt5.shutdown()


if __name__ == '__main__':
    main()

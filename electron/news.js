'use strict';

const { net } = require('electron');
const sentiment = require('../src/sentiment');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function netGet(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + url)), timeoutMs);
    const req = net.request(url);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function decodeEntities(input) {
  return String(input || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTag(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : '';
}

function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const block of blocks) {
    const href = (block.match(/<link\b[^>]*href="([^"]+)"/i) || [])[1];
    const linkText = firstTag(block, 'link');
    const title = decodeEntities(firstTag(block, 'title'));
    if (!title) continue;
    const summary = decodeEntities(
      firstTag(block, 'description') || firstTag(block, 'summary') || firstTag(block, 'content')
    );
    const dateStr = firstTag(block, 'pubDate') || firstTag(block, 'published') || firstTag(block, 'updated');
    items.push({
      title,
      url: decodeEntities(href || linkText),
      summary: summary.slice(0, 400),
      createdAt: Date.parse(dateStr) || 0,
    });
  }
  return items;
}

function keywordsFor(apiSymbol) {
  const s = String(apiSymbol || '').toUpperCase();
  const map = {
    BTC: ['btc', 'bitcoin'],
    ETH: ['eth', 'ethereum', 'ether'],
    SOL: ['sol', 'solana'],
    XRP: ['xrp', 'ripple'],
    DOGE: ['doge', 'dogecoin'],
    ADA: ['ada', 'cardano'],
    BNB: ['bnb', 'binance coin'],
    USDT: ['usdt', 'tether'],
  };
  for (const key of Object.keys(map)) {
    if (s.includes(key)) return map[key];
  }
  return [s.toLowerCase()];
}

function yahooSymbol(apiSymbol, market) {
  const s = String(apiSymbol || '').toUpperCase();
  if (market === 'crypto') {
    const m = s.match(/^([A-Z0-9]+?)(USDT|USDC|BUSD|USD)$/);
    return (m ? m[1] : s) + '-USD';
  }
  return s;
}

function matchesKeywords(text, keywords) {
  const t = String(text || '').toLowerCase();
  return keywords.some((k) => t.includes(k));
}

async function fetchFeed(url, ua) {
  const { status, body } = await netGet(url, { 'User-Agent': ua, Accept: 'application/rss+xml, application/xml, text/xml, */*' });
  if (status !== 200) throw new Error('status ' + status + ' for ' + url);
  return parseFeed(body);
}

async function redditSearch(cfg, sub, ticker) {
  const base = cfg.news.reddit.baseUrl;
  const q = sub ? 'q=' + encodeURIComponent(ticker) + '&restrict_sr=1' : 'q=' + encodeURIComponent(ticker);
  const path = sub
    ? '/r/' + sub + '/search.rss?' + q + '&sort=new&limit=15'
    : '/search.rss?' + q + '&sort=new&limit=15';
  const { status, body } = await netGet(base + path, { 'User-Agent': cfg.news.reddit.userAgent });
  if (status === 429) throw new Error('rate limited (429)');
  if (status !== 200) throw new Error('reddit status ' + status);
  return parseFeed(body).map((x) => ({ source: 'reddit', sub: sub || 'search', upvotes: 0, comments: 0, ...x }));
}

async function finnhubNews(cfg, ticker) {
  const key = cfg.news.finnhubKey || process.env.FINNHUB_KEY;
  if (!key) return [];
  const to = Math.floor(Date.now() / 1000);
  const from = to - 604800;
  const url = 'https://finnhub.io/api/v1/company-news?symbol=' + encodeURIComponent(ticker) + '&from=' + from + '&to=' + to + '&token=' + encodeURIComponent(key);
  const { status, body } = await netGet(url, { 'User-Agent': cfg.news.reddit.userAgent });
  if (status !== 200) throw new Error('finnhub status ' + status);
  const items = JSON.parse(body);
  return (Array.isArray(items) ? items : []).map((n) => ({
    source: 'finnhub', sub: '', upvotes: 0, comments: 0,
    title: n.headline || '', url: n.url || '', summary: (n.summary || '').slice(0, 400),
    createdAt: (n.datetime || 0) * 1000,
  }));
}

async function newsapiNews(cfg, ticker) {
  const key = cfg.news.newsapiKey || process.env.NEWSAPI_KEY;
  if (!key) return [];
  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const url = 'https://newsapi.org/v2/everything?q=' + encodeURIComponent(ticker) + '&from=' + from + '&sortBy=publishedAt&language=en&pageSize=15&apiKey=' + encodeURIComponent(key);
  const { status, body } = await netGet(url, { 'User-Agent': cfg.news.reddit.userAgent });
  if (status !== 200) throw new Error('newsapi status ' + status);
  const data = JSON.parse(body);
  return ((data && data.articles) || []).map((n) => ({
    source: 'newsapi', sub: '', upvotes: 0, comments: 0,
    title: n.title || '', url: n.url || '', summary: (n.description || '').slice(0, 400),
    createdAt: Date.parse(n.publishedAt || 0) || 0,
  }));
}

async function collectNews(cfg, ticker, market) {
  const newsCfg = cfg.news;
  const now = Date.now();
  const keywords = keywordsFor(ticker);
  const ua = newsCfg.reddit.userAgent;
  const collected = [];
  const errors = [];

  const subs = (market === 'crypto' ? newsCfg.subreddits.crypto : newsCfg.subreddits.stock) || [];
  const maxSubs = Math.min(newsCfg.maxRedditSubs || 2, subs.length);
  let redditBlocked = false;
  for (let i = 0; i < maxSubs; i++) {
    if (redditBlocked) break;
    try {
      collected.push(...(await redditSearch(cfg, subs[i], ticker)));
    } catch (err) {
      errors.push('reddit/' + subs[i] + ': ' + err.message);
      if (/429|rate limited/.test(err.message)) redditBlocked = true;
    }
    await sleep(900);
  }

  if (!redditBlocked) {
    try {
      collected.push(...(await redditSearch(cfg, '', ticker)));
    } catch (err) {
      errors.push('reddit/search: ' + err.message);
    }
  }

  try {
    const feedItems = await fetchFeed(newsCfg.yahooBase + yahooSymbol(ticker, market), ua);
    collected.push(...feedItems.map((x) => ({ source: 'yahoo', sub: '', upvotes: 0, comments: 0, ...x })));
  } catch (err) {
    errors.push('yahoo: ' + err.message);
  }

  const generalFeeds = (newsCfg.feeds && newsCfg.feeds[market]) || [];
  for (const feed of generalFeeds) {
    try {
      const items = await fetchFeed(feed.url, ua);
      const relevant = items.filter((x) => matchesKeywords(x.title + ' ' + x.summary, keywords));
      collected.push(...relevant.map((x) => ({ source: feed.name, sub: '', upvotes: 0, comments: 0, ...x })));
    } catch (err) {
      errors.push(feed.name + ': ' + err.message);
    }
    await sleep(400);
  }

  try {
    collected.push(...(await finnhubNews(cfg, ticker)));
  } catch (err) {
    errors.push('finnhub: ' + err.message);
  }
  try {
    collected.push(...(await newsapiNews(cfg, ticker)));
  } catch (err) {
    errors.push('newsapi: ' + err.message);
  }

  const seen = new Set();
  const scored = [];
  for (const item of collected) {
    const key = (item.title || '').toLowerCase().slice(0, 80);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ageHours = item.createdAt ? (now - item.createdAt) / 3600000 : 24;
    item.ageHours = Math.max(0, ageHours);
    item.score = sentiment.scoreArticle(item, ticker);
    item.sentimentLabel = item.score.score > 0.15 ? 'bullish' : item.score.score < -0.15 ? 'bearish' : 'neutral';
    scored.push(item);
  }

  const hoursBack = newsCfg.hoursBack || 6;
  const recent = scored.filter((a) => a.ageHours <= hoursBack);
  const agg = sentiment.aggregate(recent.length ? recent : scored);
  const sourceCounts = scored.reduce((acc, a) => {
    acc[a.source] = (acc[a.source] || 0) + 1;
    return acc;
  }, {});

  return {
    createdAt: new Date().toISOString(),
    ticker,
    market,
    sentimentScore: agg.score,
    aggregate: agg,
    articles: scored
      .slice()
      .sort((a, b) => a.ageHours - b.ageHours)
      .slice(0, 25)
      .map((a) => ({
        source: a.source,
        sub: a.sub,
        title: a.title,
        summary: a.summary,
        url: a.url,
        upvotes: a.upvotes,
        comments: a.comments,
        ageHours: a.ageHours,
        sentimentLabel: a.sentimentLabel,
        score: a.score,
      })),
    sources: sourceCounts,
    errors: errors.slice(0, 4),
  };
}

module.exports = { collectNews, parseFeed, redditSearch, fetchFeed, keywordsFor, yahooSymbol, netGet };
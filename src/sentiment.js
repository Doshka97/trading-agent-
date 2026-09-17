'use strict';

const POSITIVE_WORDS = [
  'bullish', 'rally', 'rallying', 'surge', 'surges', 'surged', 'soar', 'soars', 'soaring',
  'pump', 'pumping', 'gain', 'gains', 'gained', 'upgrade', 'upgraded', 'beat', 'beats',
  'record', 'records', 'all-time', 'ath', 'breakout', 'breakouts', 'moon', 'mooning',
  'adoption', 'partnership', 'partnerships', 'integration', 'launch', 'launches', 'launched',
  'approval', 'approved', 'green', 'profit', 'profits', 'profitable', 'bull', 'bulls',
  'outperform', 'outperformed', 'grew', 'growth', 'strong', 'momentum', 'support',
  'accumulation', 'whale', 'whales', 'inflow', 'inflows', 'buy', 'buying', 'buys', 'cheap',
  'undervalued', 'discount', 'opportunity', 'great', 'amazing', 'hopeful', 'optimistic',
  'positive', 'boom', 'explode', 'exploding', 'revenge', 'short squeeze', 'squeeze',
];

const NEGATIVE_WORDS = [
  'bearish', 'crash', 'crashed', 'crashing', 'dump', 'dumping', 'pump and dump', 'rug',
  'rugpull', 'scam', 'scams', 'fraud', 'fraudulent', 'hacked', 'hack', 'hacking',
  'exploit', 'exploited', 'vulnerability', 'lawsuit', 'lawsuit', 'sued', 'suing', 'fine', 'fined',
  'fines', 'investigation', 'investigated', 'charge', 'charged', 'charges', 'ban', 'banned',
  'bans', 'crackdown', 'crackdowns', 'collapse', 'collapsed', 'collapsing', 'loss', 'losses',
  'lost', 'sell', 'selling', 'sells', 'selloff', 'sell-off', 'red', 'bear', 'bears', 'bear market',
  'overvalued', 'bubble', 'bubbling', 'dip', 'dropped', 'drop', 'falls', 'falling', 'fell',
  'down', 'slump', 'slumped', 'weak', 'weakness', 'outflow', 'outflows', 'doubt', 'doubts',
  'risk', 'risks', 'warnings', 'warning', 'panic', 'panicking', 'fear', 'worried', 'worrying',
  'negative', 'disappointing', 'downgrade', 'downgraded', 'failed', 'failure', 'halted', 'halt',
  'delist', 'delisted', 'delisting', 'liquidation', 'liquidations', 'clawback', 'insolvent',
];

const NEGATION = new Set(['not', 'no', 'never', 'without', 'unlikely', 'hardly']);

const AHEAD = new Set(['ahead', 'next', 'upcoming', 'expected', 'forecast', 'signal', 'hint']);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function classifyText(text) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { score: 0, pos: 0, neg: 0, words: { pos: [], neg: [] } };

  let score = 0;
  const hits = { pos: [], neg: [] };
  for (let i = 0; i < tokens.length; i++) {
    let negated = false;
    let lookAhead = false;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (NEGATION.has(tokens[j])) negated = true;
    }
    for (let j = i + 1; j < Math.min(tokens.length, i + 4); j++) {
      if (AHEAD.has(tokens[j])) lookAhead = true;
    }
    let weight = 1;

    if (POSITIVE_WORDS.includes(tokens[i])) {
      weight = lookAhead ? 2 : 1;
      score += negated ? -weight : weight;
      hits.pos.push(tokens[i]);
    } else if (NEGATIVE_WORDS.includes(tokens[i])) {
      weight = lookAhead ? 0.5 : 1;
      score += negated ? weight : -weight;
      hits.neg.push(tokens[i]);
    }
  }
  const norm = score / Math.sqrt(Math.max(tokens.length, 1));
  return { score: norm, pos: hits.pos.length, neg: hits.neg.length, words: hits };
}

function rateTitle(title) {
  return classifyText(title);
}

function scoreArticle(article, ticker) {
  const title = rateTitle(article.title || '');
  const body = classifyText((article.body || article.author || '').slice(0, 500));
  const textScore = title.score * 2 + body.score;
  let engagement = 1;
  if (article.upvotes != null) engagement = 1 + clamp(Math.log1p(article.upvotes) / 6, 0, 3);
  if (article.comments != null) engagement = 1 + clamp(Math.log1p(article.comments) / 12, 0, 2);
  const recency = article.ageHours != null ? clamp(1.5 - article.ageHours / 48, 0.3, 1.5) : 1;
  const total = textScore * engagement * recency;
  return {
    score: clamp(total, -6, 6),
    titleScore: title.score,
    engagement,
    recency,
    posWords: title.words.pos,
    negWords: title.words.neg,
  };
}

function numericScore(article) {
  if (!article) return 0;
  if (typeof article.score === 'number') return article.score;
  if (article.score && typeof article.score.score === 'number') return article.score.score;
  return 0;
}

function aggregate(articles) {
  if (!articles || articles.length === 0) return { score: 0, count: 0, bullish: 0, bearish: 0 };
  const values = articles.map(numericScore);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const count = articles.length;
  const bullish = values.filter((v) => v > 0.15).length;
  const bearish = values.filter((v) => v < -0.15).length;
  const avg = sum / count;
  const norm05 = clamp(avg / 4, -1, 1);
  const norm08 = clamp((bullish - bearish) / count, -1, 1);
  const score = clamp((norm05 * 0.6 + norm08 * 0.4) * 100, -100, 100);
  return { score, count, bullish, bearish, rawAvg: avg };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = { classifyText, rateTitle, scoreArticle, aggregate, POSITIVE_WORDS, NEGATIVE_WORDS };
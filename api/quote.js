// Vercel 函式：GET /api/quote?symbols=0050,00675L,QQQM
// 向 Yahoo Finance 抓約 250 個交易日收盤價，對 ^GSPC 算 Beta（邏輯同 GAS「核心計算.js」）。

const BENCH = '^GSPC';
const DAYS = 250;
const MAX_SYMBOLS = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TW_RE = /^\d{4,6}[A-Z]?$/; // 0050、00675L 這類台股代碼
const SAFE_RE = /^[A-Z0-9.^=-]{1,15}$/;

async function fetchHistory(symbol) {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - Math.floor(DAYS * 86400 * 1.5);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?period1=' + period1 + '&period2=' + period2 + '&interval=1d';
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  const json = await resp.json().catch(() => null);
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) throw new Error('查無資料');

  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const close = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const offset = Number(meta.gmtoffset) || 0;

  // 以「交易所當地日期」當 key，台股與美股才能依日期對齊
  const dates = [];
  const prices = [];
  for (let i = 0; i < ts.length; i++) {
    const p = close[i];
    if (p === null || p === undefined || isNaN(Number(p))) continue;
    dates.push(new Date((ts[i] + offset) * 1000).toISOString().slice(0, 10));
    prices.push(Number(p));
  }
  if (prices.length === 0) throw new Error('查無資料');

  const price = Number(meta.regularMarketPrice) || prices[prices.length - 1];
  return {
    symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || '',
    price,
    dates,
    prices,
  };
}

// 台股先試 .TW，再試 .TWO
async function fetchWithFallback(input) {
  let candidates = [input];
  if (TW_RE.test(input)) candidates = [input + '.TW', input + '.TWO'];
  let lastErr = new Error('查無資料');
  for (const c of candidates) {
    try { return await fetchHistory(c); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function calcReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1] || 1;
    out.push((prices[i] - prev) / prev);
  }
  return out;
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n <= 1) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - ma) * (b[i] - mb);
  return sum / (n - 1);
}

function variance(a) { return covariance(a, a); }

// 依日期對齊後算 Beta = 共變異數 ÷ 大盤變異數；對齊不足 10 筆或大盤無波動時回 1.0（同 GAS）
function alignedBeta(stock, bench) {
  const map = new Map();
  stock.dates.forEach((d, i) => map.set(d, stock.prices[i]));
  const sp = [], bp = [];
  bench.dates.forEach((d, i) => {
    if (map.has(d)) { bp.push(bench.prices[i]); sp.push(map.get(d)); }
  });
  if (sp.length < 10) return { beta: 1.0, fallback: true };
  const sr = calcReturns(sp), br = calcReturns(bp);
  const vb = variance(br);
  if (vb === 0) return { beta: 1.0, fallback: true };
  const beta = Number((covariance(sr, br) / vb).toFixed(3));
  return Number.isFinite(beta) ? { beta, fallback: false } : { beta: 1.0, fallback: true };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  const raw = String((req.query && req.query.symbols) || '');
  const symbols = [...new Set(raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (symbols.length === 0) return res.status(400).json({ error: '請提供 symbols 參數，例如 ?symbols=0050,QQQM' });
  if (symbols.length > MAX_SYMBOLS) return res.status(400).json({ error: '一次最多 ' + MAX_SYMBOLS + ' 檔' });

  let bench = null;
  let benchError = null;
  try { bench = await fetchHistory(BENCH); } catch (e) { benchError = '大盤基準抓取失敗'; }

  // 美元匯率（美股換算台幣用），抓不到就回 null，由前端手動輸入
  let usdtwd = null;
  try { usdtwd = (await fetchHistory('TWD=X')).price; } catch (e) { /* 忽略 */ }

  const results = await Promise.all(symbols.map(async (sym) => {
    if (!SAFE_RE.test(sym)) return { symbol: sym, error: '查無資料' };
    try {
      const s = await fetchWithFallback(sym);
      const out = { symbol: sym, resolved: s.symbol, name: s.name, price: s.price, currency: s.currency, beta: null };
      if (bench) {
        const b = alignedBeta(s, bench);
        out.beta = b.beta;
        out.betaFallback = b.fallback;
      } else {
        out.error = benchError;
      }
      return out;
    } catch (e) {
      return { symbol: sym, error: '查無資料' };
    }
  }));

  res.status(200).json({ usdtwd, results });
};

module.exports._test = { alignedBeta, TW_RE };

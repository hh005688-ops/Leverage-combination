// Vercel 函式：GET /api/quote?symbols=0050,00675L,QQQM
// 向 Yahoo Finance 抓約 250 個交易日收盤價，對 ^GSPC 算 Beta（邏輯同 GAS「核心計算.js」）。

const BENCH_TW = '^TWII'; // 台股（.TW / .TWO）對照台灣加權指數
const BENCH_US = '^GSPC'; // 其餘（美股）對照標普 500
const DAYS = 250;
const MAX_SYMBOLS = 30;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TW_RE = /^\d{4,6}[A-Z]?$/; // 0050、00675L 這類台股代碼
const SAFE_RE = /^[A-Z0-9.^=-]{1,15}$/;
// 官方名單（每個來源可放多個網址，第一個有資料的就用）
const TW_SOURCES = {
  twse: ['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'], // 上市
  tpex: [
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', // 上櫃
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
  ],
};
const BROWSER_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};
const CJK_RE = /[\u4e00-\u9fff]/;

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

// ---------- 台股中文名稱：證交所 / 櫃買開放資料 ----------
let twCache = { t: 0, map: null, debug: null };

// 欄位名稱兩種常見命名（英文 / 中文）都處理
const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return null; };
const CODE_KEYS = ['Code', 'SecuritiesCompanyCode', '證券代號', '代號', 'stockNo'];
const NAME_KEYS = ['Name', 'CompanyName', '證券名稱', '名稱', 'stockName'];
const CLOSE_KEYS = ['ClosingPrice', 'Close', '收盤價', '收盤'];

function toPrice(v) {
  const n = Number(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const errText = (e) => [e && e.name, e && e.message, e && e.cause && (e.cause.code || e.cause.message)].filter(Boolean).join(': ');

// 抓單一網址，回傳 { rows, info }；info 供除錯：HTTP 狀態、錯誤、筆數、第一筆欄位名稱
async function fetchSource(url) {
  const info = { url, status: null, error: null, count: 0, firstKeys: null, firstRow: null, bodyHead: null };
  try {
    const origin = new URL(url).origin;
    const r = await fetch(url, { headers: { ...BROWSER_HEADERS, 'Referer': origin + '/' }, signal: AbortSignal.timeout(8000) });
    info.status = r.status;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 不是 JSON */ }
    if (!r.ok || !Array.isArray(json)) {
      info.bodyHead = text.slice(0, 120);
      if (!info.error) info.error = r.ok ? '回傳不是 JSON 陣列' : 'HTTP ' + r.status;
      return { rows: [], info };
    }
    info.count = json.length;
    if (json[0] && typeof json[0] === 'object') { info.firstKeys = Object.keys(json[0]); info.firstRow = json[0]; }
    return { rows: json, info };
  } catch (e) {
    info.error = errText(e);
    return { rows: [], info };
  }
}

async function loadSource(urls, map) {
  const dbg = { used: null, attempts: [], added: 0 };
  for (const url of urls) {
    const { rows, info } = await fetchSource(url);
    dbg.attempts.push(info);
    let added = 0;
    for (const x of rows) {
      if (!x || typeof x !== 'object') continue;
      const code = String(pick(x, CODE_KEYS) || '').trim().toUpperCase();
      const name = pick(x, NAME_KEYS);
      if (code && name && !map.has(code)) {
        map.set(code, { name: String(name).trim(), close: toPrice(pick(x, CLOSE_KEYS)) });
        added++;
      }
    }
    if (added > 0) { dbg.used = url; dbg.added = added; break; }
  }
  return dbg;
}

async function loadTwNames() {
  if (twCache.map && Date.now() - twCache.t < 6 * 3600 * 1000) {
    return { map: twCache.map, debug: { ...twCache.debug, cached: true } };
  }
  const map = new Map();
  const [twse, tpex] = await Promise.all([loadSource(TW_SOURCES.twse, map), loadSource(TW_SOURCES.tpex, map)]);
  const debug = { cached: false, size: map.size, twse, tpex };
  if (map.size) twCache = { t: Date.now(), map, debug };
  return { map, debug };
}

// 備援：Yahoo 中文名稱（search 與 quote 兩個端點，哪個回中文就用）
async function yahooZhName(ysym) {
  const enc = encodeURIComponent(ysym);
  const tries = [
    ['search', 'https://query1.finance.yahoo.com/v1/finance/search?q=' + enc + '&lang=zh-TW&region=TW&quotesCount=5&newsCount=0',
      j => (j.quotes || []).find(q => q.symbol === ysym)],
    ['quote', 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + enc + '&lang=zh-TW&region=TW',
      j => j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0]],
  ];
  const debug = {};
  for (const [label, url, getObj] of tries) {
    const d = { status: null, name: null, chinese: false, error: null };
    debug[label] = d;
    try {
      const r = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8000) });
      d.status = r.status;
      const j = await r.json().catch(() => null);
      const o = j && getObj(j);
      if (!o) { d.error = '無資料'; continue; }
      const names = [o.longname, o.shortname, o.longName, o.shortName, o.displayName].filter(Boolean);
      d.name = names[0] || null;
      const zh = names.find(n => CJK_RE.test(n));
      if (zh) { d.chinese = true; return { name: zh, debug }; }
    } catch (e) { d.error = errText(e); }
  }
  return { name: null, debug };
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

// 依 Yahoo 解析後的代碼決定基準指數
const benchmarkFor = (resolved) => /\.(TW|TWO)$/.test(resolved) ? BENCH_TW : BENCH_US;

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

  // 基準指數：同一次請求內每個指數最多只抓一次（Promise 快取，並行的各檔共用）
  const benchCache = {};
  const getBench = (id) => benchCache[id] || (benchCache[id] = fetchHistory(id).catch(() => null));

  // 美元匯率（美股換算台幣用），抓不到就回 null，由前端手動輸入
  let usdtwd = null;
  try { usdtwd = (await fetchHistory('TWD=X')).price; } catch (e) { /* 忽略 */ }

  // 有台股代碼才去抓證交所/櫃買名單；抓不到就退回 Yahoo 中文，再退回 Yahoo 英文
  let twMap = new Map();
  let twNamesDebug = null;
  if (symbols.some(x => TW_RE.test(x))) {
    try {
      const t = await loadTwNames();
      twMap = t.map;
      twNamesDebug = t.debug;
    } catch (e) { twNamesDebug = { error: errText(e) }; }
    twNamesDebug.yahooZh = {};
  }

  const results = await Promise.all(symbols.map(async (sym) => {
    if (!SAFE_RE.test(sym)) return { symbol: sym, error: '查無資料' };
    const isTw = TW_RE.test(sym);
    const official = isTw ? twMap.get(sym) : null;
    let s = null;
    try { s = await fetchWithFallback(sym); } catch (e) { if (!official || !official.close) return { symbol: sym, error: '查無資料' }; }

    // Yahoo 抓不到但官方有收盤價：先顯示名稱與價格，Beta 用預設 1.0
    if (!s) return { symbol: sym, name: official.name, nameSource: 'official', price: official.close, currency: 'TWD', beta: 1.0, betaFallback: true, benchmark: BENCH_TW };

    // 名稱優先順序：官方中文名單 → Yahoo 中文 → Yahoo 英文
    let name = s.name, nameSource = 'yahoo-en';
    if (official) { name = official.name; nameSource = 'official'; }
    else if (isTw) {
      const z = await yahooZhName(s.symbol);
      twNamesDebug.yahooZh[sym] = z.debug;
      if (z.name) { name = z.name; nameSource = 'yahoo-zh'; }
    }

    const benchmark = benchmarkFor(s.symbol);
    const bench = await getBench(benchmark);
    const out = { symbol: sym, resolved: s.symbol, name, nameSource, price: s.price, currency: s.currency, beta: null, benchmark };
    if (bench) {
      const b = alignedBeta(s, bench);
      out.beta = b.beta;
      out.betaFallback = b.fallback;
    } else {
      out.error = '基準指數 ' + benchmark + ' 抓取失敗';
    }
    return out;
  }));

  const body = { usdtwd, twNamesLoaded: twMap.size > 0, results };
  if (twNamesDebug) body.twNamesDebug = twNamesDebug;
  res.status(200).json(body);
};

module.exports._test = { alignedBeta, benchmarkFor, TW_RE };

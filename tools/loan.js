// 換貸試算（槓桿工具箱的第二個工具）。分成「信貸」和「房貸」兩邊，各自有自己的欄位、各自計算、資料分開存。
// 檔案結構：
//   1. 信貸計算：CALC START 到 CALC END 之間，與原本的換貸試算完全相同，要改信貸算法只改這一段
//   2. 房貸計算：逐月排出還款表，所以寬限期、階梯利率、本金平均都能算
//   3. 畫面
(function () {
  'use strict';

  // ============ 1. 信貸計算 ============
  // CALC START
  function pmt(P, rate, n) {
    var r = rate / 1200;
    if (n <= 0 || P <= 0) return 0;
    if (r === 0) return P / n;
    return P * r / (1 - Math.pow(1 + r, -n));
  }
  function balance(P, rate, N, k) {
    if (k >= N) return 0;
    var r = rate / 1200, m = pmt(P, rate, N);
    if (r === 0) return P - m * k;
    var g = Math.pow(1 + r, k);
    return Math.max(0, P * g - m * (g - 1) / r);
  }
  function calc(v, k) {
    var m0 = pmt(v.p0, v.r0, v.n0);
    var rem = v.n0 - k;
    var B = balance(v.p0, v.r0, v.n0, k);
    var penAmt = k < v.lock ? B * v.pen / 100 : 0;
    var oldBal12 = balance(v.p0, v.r0, v.n0, k + 12);
    var keep = { monthly: m0, cash: 0, pen: 0, fee: 0, cost: m0 * rem - B, bal12: oldBal12 };
    var X = Math.max(0, v.target - B);
    var mi = pmt(X, v.ri, v.nn);
    var A = { monthly: m0 + mi, cash: X - v.feeA, pen: 0, fee: v.feeA,
              cost: (m0 * rem - B) + (mi * v.nn - X) + v.feeA,
              bal12: oldBal12 + (X > 0 ? balance(X, v.ri, v.nn, 12) : 0), extra: mi, X: X };
    var pa = v.mode === 'absorbed' ? 0 : penAmt;
    var L = v.target + (v.mode === 'added' ? pa : 0);
    var mb = pmt(L, v.rn, v.nn);
    var cashB = v.target - B - (v.mode === 'deduct' ? pa : 0) - v.feeB;
    var Bz = { monthly: mb, cash: cashB, pen: pa, fee: v.feeB,
               cost: mb * v.nn - L + pa + v.feeB, bal12: balance(L, v.rn, v.nn, 12), loan: L };
    return { B: B, penAmt: penAmt, rem: rem, keep: keep, A: A, Bz: Bz, k: k };
  }
  // CALC END

  // ============ 2. 房貸計算 ============
  // 排出一筆貸款的逐月還款表。回傳的陣列用「第幾個月」當編號（0 是貸款剛撥下來時）。
  //   P 本金、rateAt(t) 第 t 個月的年利率（%）、n 總期數（含寬限期）、g 寬限期、method 'equal' 本息平均 / 'principal' 本金平均
  // 寬限期內只繳利息；之後把剩下的本金在（n − g）期內還完。利率每個月可以不同（階梯利率），
  // 本息平均時，每個月用「當下餘額、當月利率、剩餘期數」重算月付，沒有階梯時結果和一般公式相同。
  function schedule(P, rateAt, n, g, method) {
    var pay = [0], intr = [0], bal = [P];
    var b = P, prin0 = n - g > 0 ? P / (n - g) : 0;
    for (var t = 1; t <= n; t++) {
      var rate = rateAt(t);
      var i = b * rate / 1200, pr;
      if (t <= g) pr = 0;
      else if (method === 'principal') pr = prin0;
      else pr = pmt(b, rate, n - t + 1) - i;
      if (pr > b || t === n) pr = b;
      b -= pr;
      if (b < 1e-9) b = 0;
      pay.push(i + pr); intr.push(i); bal.push(b);
    }
    return { pay: pay, intr: intr, bal: bal, n: n };
  }
  function flatRate(r) { return function () { return r; }; }
  // 借新還舊的階梯利率：第 1 段 s1 個月、第 2 段 s2 個月、之後第 3 段；後面沒填就沿用前一段
  function stepRate(v) {
    var r1 = v.rn1;
    var r2 = v.rn2raw === '' ? r1 : v.rn2;
    var r3 = v.rn3raw === '' ? r2 : v.rn3;
    var s1 = Math.max(0, Math.round(v.s1)), s2 = Math.max(0, Math.round(v.s2));
    return function (t) {
      if (s1 <= 0 || t <= s1) return r1;
      if (s2 > 0 && t <= s1 + s2) return r2;
      return r3;
    };
  }
  function sumRange(a, from, to) {
    var s = 0;
    for (var i = from; i <= to && i < a.length; i++) s += a[i];
    return s;
  }
  // 現在起每個月的月付（陣列第 0 格 = 下一期）
  function futurePay(sch, k) { return sch.pay.slice(k + 1); }
  function addArrays(a, b) {
    var len = Math.max(a.length, b.length), out = [];
    for (var i = 0; i < len; i++) out.push((a[i] || 0) + (b[i] || 0));
    return out;
  }
  function maxOf(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

  // 房貸版的 calc：回傳的樣子和信貸的 calc 相同，另外多了 max（整段期間最高月付）
  function calcM(v, k, sch0) {
    var B = sch0.bal[k];
    var rem = v.n0 - k;
    var penAmt = k < v.lock ? B * v.pen / 100 : 0;
    var keepPay = futurePay(sch0, k);
    var keepInt = sumRange(sch0.intr, k + 1, v.n0);
    var oldBal12 = sch0.bal[Math.min(k + 12, v.n0)];
    var keep = { monthly: keepPay[0] || 0, max: maxOf(keepPay), cash: 0, pen: 0, fee: 0, cost: keepInt, bal12: oldBal12 };

    var X = Math.max(0, v.target - B);
    var schA = X > 0 ? schedule(X, flatRate(v.ri), v.nn, v.gn, v.amN) : null;
    var payA = schA ? addArrays(keepPay, futurePay(schA, 0)) : keepPay;
    var feeA = v.feeA + v.otherA;
    var A = { monthly: payA[0] || 0, max: maxOf(payA), cash: X - feeA, pen: 0, fee: feeA,
              cost: keepInt + (schA ? sumRange(schA.intr, 1, v.nn) : 0) + feeA,
              bal12: oldBal12 + (schA ? schA.bal[Math.min(12, v.nn)] : 0), X: X };

    var pa = v.mode === 'absorbed' ? 0 : penAmt;
    var L = v.target + (v.mode === 'added' ? pa : 0);
    var schB = schedule(L, stepRate(v), v.nn, v.gn, v.amN);
    var feeB = v.feeB + v.otherB;
    var Bz = { monthly: schB.pay[1] || 0, max: maxOf(schB.pay), cash: v.target - B - (v.mode === 'deduct' ? pa : 0) - feeB,
               pen: pa, fee: feeB, cost: sumRange(schB.intr, 1, v.nn) + pa + feeB,
               bal12: schB.bal[Math.min(12, v.nn)], loan: L };
    return { B: B, penAmt: penAmt, rem: rem, keep: keep, A: A, Bz: Bz, k: k };
  }

  // ============ 3. 畫面 ============
  var STORE = 'leverage-loan-v1';

  // 欄位清單：每個欄位 id、顯示名稱、預設值。pair 的欄位會兩個排一列，wide 獨佔一列。
  // 預設值只是範例數字，請換成自己的。
  var MODE_OPTS = [['deduct', '從撥款扣（實拿變少）'], ['absorbed', '銀行吸收'], ['added', '加進新貸款']];
  var AM_OPTS = [['equal', '本息平均'], ['principal', '本金平均']];
  var KINDS = {
    credit: {
      label: '信貸',
      cards: [
        { title: '原貸款現況', hint: '已繳期數未滿綁約期數，才會收違約金。', fields: [
          { id: 'p0', label: '原貸款金額（元）', def: '1000000' },
          { id: 'r0', label: '原利率（%）', def: '2.2' },
          { id: 'n0', label: '原總期數（月）', def: '84' },
          { id: 'k', label: '已繳期數（月）', def: '7' },
          { id: 'lock', label: '綁約期數（月）', def: '12' },
          { id: 'pen', label: '提前清償違約金（%）', def: '3' }] },
        { title: '預期的目標與報價', hint: '目標總負債額度是想把借款總額補回多少，多出的部分就是你多拿的現金。增貸利率預設跟原利率一樣，銀行願意給更低再自己改。', fields: [
          { id: 'target', label: '目標總負債額度（元）', def: '1000000', wide: true },
          { id: 'rn', label: '借新還舊利率（%）', def: '1.2' },
          { id: 'ri', label: '增貸利率（%）', def: '2.2' },
          { id: 'nn', label: '新貸款期數（月）', def: '84', wide: true },
          { id: 'feeA', label: '增貸開辦費（元）', def: '5000' },
          { id: 'feeB', label: '借新還舊開辦費（元）', def: '5000' },
          { id: 'mode', label: '違約金處理方式', def: 'deduct', opts: MODE_OPTS, wide: true }] }
      ]
    },
    mortgage: {
      label: '房貸',
      cards: [
        { title: '原房貸現況', hint: '總期數含寬限期；寬限期內只繳利息，沒有寬限期就留空。填了鑑價與可貸成數，才會幫你檢查目標負債有沒有超過銀行的上限。', fields: [
          { id: 'p0', label: '原貸款金額（元）', def: '5000000' },
          { id: 'r0', label: '原利率（%）', def: '2.2' },
          { id: 'n0', label: '原總期數（月，含寬限期）', def: '360' },
          { id: 'g0', label: '原寬限期（月）', def: '' },
          { id: 'k', label: '已繳期數（月）', def: '18' },
          { id: 'lock', label: '綁約期數（月）', def: '36' },
          { id: 'pen', label: '提前清償違約金（%）', def: '1' },
          { id: 'am0', label: '原攤還方式', def: 'equal', opts: AM_OPTS },
          { id: 'H', label: '房屋鑑價（元）', def: '8000000' },
          { id: 'ltv', label: '可貸成數（%）', def: '80' }] },
        { title: '預期的目標與報價', hint: '階梯利率：第 1 段用 N 個月，第 2 段用 N 個月，之後用第 3 段。沒有階梯就只填第 1 段利率，其餘留空。增貸利率如果也是階梯，填平均利率。設定費、代書費這類一次性費用，沒有就留空。攤還方式：本息平均＝每月繳一樣，本金平均＝每月本金固定、月付越繳越少。', fields: [
          { id: 'target', label: '目標總負債額度（元）', def: '6000000', wide: true },
          { id: 'rn1', label: '借新還舊：第 1 段利率（%）', def: '1.8' },
          { id: 's1', label: '第 1 段月數', def: '' },
          { id: 'rn2', label: '第 2 段利率（%）', def: '' },
          { id: 's2', label: '第 2 段月數', def: '' },
          { id: 'rn3', label: '第 3 段起利率（%）', def: '', wide: true },
          { id: 'ri', label: '增貸利率（%）', def: '2.4', wide: true },
          { id: 'nn', label: '新貸款期數（月，含寬限期）', def: '360' },
          { id: 'gn', label: '新貸款寬限期（月）', def: '' },
          { id: 'amN', label: '新貸款攤還方式', def: 'equal', opts: AM_OPTS, wide: true },
          { id: 'feeA', label: '增貸開辦費（元）', def: '5000' },
          { id: 'otherA', label: '增貸設定費、代書費等（元）', def: '' },
          { id: 'feeB', label: '借新還舊開辦費（元）', def: '5000' },
          { id: 'otherB', label: '借新還舊設定費、代書費等（元）', def: '' },
          { id: 'mode', label: '違約金處理方式', def: 'deduct', opts: MODE_OPTS, wide: true }] }
      ]
    }
  };

  var state = { mode: 'credit', credit: {}, mortgage: {} };
  var box, formBox, verdictBox, resultBox, modeBar;
  var activeTab = 'now';
  var last = { now: null, wait: null };

  function defaults(kind) {
    var d = {};
    KINDS[kind].cards.forEach(function (c) { c.fields.forEach(function (f) { d[f.id] = f.def; }); });
    return d;
  }
  function load() {
    state.credit = defaults('credit');
    state.mortgage = defaults('mortgage');
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!s) return;
      if (s.mode === 'mortgage') state.mode = 'mortgage';
      ['credit', 'mortgage'].forEach(function (kind) {
        var src = s[kind] || {};
        Object.keys(state[kind]).forEach(function (id) { if (typeof src[id] === 'string') state[kind][id] = src[id]; });
      });
    } catch (e) { /* 讀不到就用預設值 */ }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* 存不了就算了 */ }
  }

  function h(tag, props) {
    var e = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { e.append(x); });
      else e.append(c);
    }
    return e;
  }
  function fmt(x) { return Math.round(x).toLocaleString('zh-TW'); }
  function money(x) { return fmt(x) + ' 元'; }
  function num(s) { var n = parseFloat(s); return isFinite(n) ? n : 0; }

  // 把輸入框的文字轉成計算用的數字
  function readValues(kind) {
    var raw = state[kind], v = {};
    Object.keys(raw).forEach(function (id) {
      v[id] = (id === 'mode' || id === 'am0' || id === 'amN') ? raw[id] : num(raw[id]);
    });
    if (kind === 'mortgage') { v.rn2raw = String(raw.rn2).trim(); v.rn3raw = String(raw.rn3).trim(); }
    return v;
  }

  function fieldNode(kind, f) {
    var cur = state[kind][f.id], input;
    if (f.opts) {
      input = h('select', { onchange: function (e) { state[kind][f.id] = e.target.value; save(); recalc(); } },
        f.opts.map(function (o) { return h('option', Object.assign({ value: o[0] }, cur === o[0] ? { selected: '' } : {}), o[1]); }));
    } else {
      input = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: cur,
        oninput: function (e) { state[kind][f.id] = e.target.value; save(); recalc(); } });
    }
    return h('label', { class: 'f' + (f.wide ? ' lt-wide' : '') }, h('span', {}, f.label), input);
  }

  function buildForm() {
    var kind = state.mode;
    formBox.replaceChildren.apply(formBox, KINDS[kind].cards.map(function (card) {
      return h('div', { class: 'card' },
        h('h2', {}, card.title),
        h('div', { class: 'lt-grid' }, card.fields.map(function (f) { return fieldNode(kind, f); })),
        h('p', { class: 'hint' }, card.hint));
    }));
  }

  function buildModeBar() {
    modeBar.replaceChildren.apply(modeBar, ['credit', 'mortgage'].map(function (kind) {
      return h('button', { type: 'button', class: 'tab' + (state.mode === kind ? ' on' : ''),
        onclick: function () {
          if (state.mode === kind) return;
          state.mode = kind; activeTab = 'now'; save(); buildModeBar(); buildForm(); recalc();
        } }, KINDS[kind].label);
    }));
  }

  // ---- 比較表 ----
  function signed(d) {
    if (Math.abs(d) < 1) return h('span', { class: 'lt-dim' }, '—');
    return h('span', { class: d > 0 ? 'ok' : 'err' }, (d > 0 ? '省 ' : '多 ') + fmt(Math.abs(d)));
  }
  function monthlyCell(text, twoLoans) {
    return h('span', {}, text, twoLoans ? h('small', { class: 'sub' }, '兩筆合計') : null);
  }
  function tableFor(kind, c) {
    var mort = kind === 'mortgage';
    var rows = [];
    function row(label, a, b, d, key) { rows.push({ label: label, cells: [a, b, d], key: key }); }
    row(mort ? '起始月付' : '每月要繳', fmt(c.keep.monthly), monthlyCell(fmt(c.A.monthly), c.A.X > 0), fmt(c.Bz.monthly), true);
    if (mort && (Math.abs(c.keep.max - c.keep.monthly) >= 1 || Math.abs(c.A.max - c.A.monthly) >= 1 || Math.abs(c.Bz.max - c.Bz.monthly) >= 1)) {
      row('月付最高', fmt(c.keep.max), fmt(c.A.max), fmt(c.Bz.max));
    }
    row(mort ? '起始月付比維持不動' : '每月比維持不動', h('span', { class: 'lt-dim' }, '—'), signed(c.keep.monthly - c.A.monthly), signed(c.keep.monthly - c.Bz.monthly));
    row('違約金', '0', '0', fmt(c.Bz.pen));
    row(mort ? '開辦費＋設定費等' : '開辦費', '0', fmt(c.A.fee), fmt(c.Bz.fee));
    row('實拿現金', '0', fmt(c.A.cash), fmt(c.Bz.cash), true);
    row(mort ? '利息＋違約金＋各項費用' : '利息＋違約金＋開辦費', fmt(c.keep.cost), fmt(c.A.cost), fmt(c.Bz.cost), true);
    row('一年後剩餘本金', fmt(c.keep.bal12), fmt(c.A.bal12), fmt(c.Bz.bal12));
    return h('table', { class: 'cmp' },
      h('thead', {}, h('tr', {}, h('th', {}), h('th', {}, '維持不動'), h('th', {}, '增貸'), h('th', {}, '借新還舊'))),
      h('tbody', {}, rows.map(function (r) {
        return h('tr', r.key ? { class: 'lt-key' } : {}, h('th', {}, r.label), r.cells.map(function (x) { return h('td', {}, x); }));
      })));
  }
  function compareNote(c) {
    return h('p', { class: 'hint' }, '借新還舊相比增貸：總成本' + (c.A.cost - c.Bz.cost >= 0 ? '少' : '多') + ' ' + fmt(Math.abs(c.A.cost - c.Bz.cost)) +
      ' 元，每月' + (c.A.monthly - c.Bz.monthly >= 0 ? '少' : '多') + '繳 ' + fmt(Math.abs(c.A.monthly - c.Bz.monthly)) +
      ' 元，實拿現金' + (c.Bz.cash - c.A.cash >= 0 ? '多' : '少') + ' ' + fmt(Math.abs(c.Bz.cash - c.A.cash)) + ' 元。');
  }

  function judge(c) {
    var d = c.A.cost - c.Bz.cost;
    if (Math.abs(d) < 1000) return h('span', {}, '總成本約打平');
    return d > 0 ? h('span', { class: 'ok' }, '借新還舊省約 ' + money(d)) : h('span', { class: 'err' }, '借新還舊多花約 ' + money(-d));
  }

  function showMessage(title, text) {
    verdictBox.replaceChildren(h('strong', {}, title), h('span', { class: 'lt-sub' }, text));
    verdictBox.hidden = false;
    last = { now: null, wait: null };
    drawResult();
  }

  function recalc() {
    var kind = state.mode, v = readValues(kind), mort = kind === 'mortgage';
    last = { now: null, wait: null };
    // 房貸是逐月排表，期數一律取整數
    if (mort) ['n0', 'nn', 'k', 'lock', 'g0', 'gn', 's1', 's2'].forEach(function (id) { v[id] = Math.round(v[id]); });
    if (v.k >= v.n0 || v.n0 <= 0 || v.nn <= 0 || v.p0 <= 0 || v.k < 0) {
      return showMessage('請確認期數', '已繳期數要小於原總期數，新貸款期數要大於 0。');
    }
    if (mort && (v.g0 < 0 || v.gn < 0 || v.g0 >= v.n0 || v.gn >= v.nn)) {
      return showMessage('請確認寬限期', '寬限期不能大於或等於總期數。');
    }
    var sch0 = mort ? schedule(v.p0, flatRate(v.r0), v.n0, v.g0, v.am0) : null;
    function run(k) { return mort ? calcM(v, k, sch0) : calc(v, k); }

    var c = run(v.k);
    if (v.target < c.B) {
      return showMessage('目標總負債額度太低', '目前剩餘本金約 ' + money(c.B) + '，目標要大於這個數字。');
    }
    var wk = Math.max(v.k, v.lock), waitMonths = wk - v.k;
    var w = waitMonths > 0 && wk < v.n0 ? run(wk) : null;

    var rowsOut = [h('div', { class: 'lt-row' },
      h('strong', {}, '現在辦：', judge(c)),
      h('span', { class: 'lt-sub' }, '剩餘本金約 ' + money(c.B) + '，' + (c.penAmt > 0 ? '還在綁約期內，違約金約 ' + money(c.penAmt) : '已過綁約期，沒有違約金') + '。'))];
    if (w) {
      rowsOut.push(h('div', { class: 'lt-row' },
        h('strong', {}, '等 ' + waitMonths + ' 個月再辦：', judge(w)),
        h('span', { class: 'lt-sub' }, '等到已繳 ' + wk + ' 期，免違約金。')));
    }
    if (mort && v.H > 0 && v.ltv > 0) {
      var cap = v.H * v.ltv / 100;
      var over = Math.max(c.A.X + c.B, c.Bz.loan) > cap + 0.5;
      rowsOut.push(h('div', { class: 'lt-row' + (over ? ' lt-warn' : '') },
        h('strong', {}, over ? '⚠ 目標負債超過可貸上限' : '可貸上限檢查'),
        h('span', { class: 'lt-sub' }, '鑑價 ' + money(v.H) + ' × 成數 ' + fmt(v.ltv) + '% ＝ 最高可貸約 ' + money(cap) +
          (over ? '，你的目標比上限高，銀行可能不會核這麼多。' : '，目前剩餘本金約 ' + money(c.B) + '，最多還能再借約 ' + money(Math.max(0, cap - c.B)) + '。'))));
    }
    verdictBox.replaceChildren.apply(verdictBox, rowsOut);
    verdictBox.hidden = false;

    last.now = { c: c, sub: '已繳 ' + v.k + ' 期，剩餘本金約 ' + money(c.B), kind: kind };
    if (w) last.wait = { c: w, sub: '已繳 ' + wk + ' 期，剩餘本金約 ' + money(w.B) + '，沒有違約金', kind: kind, label: '等 ' + waitMonths + ' 個月再辦' };
    drawResult();
  }

  function drawResult() {
    if (!last.now) { resultBox.hidden = true; return; }
    resultBox.hidden = false;
    if (!last.wait) activeTab = 'now';
    var cur = activeTab === 'wait' ? last.wait : last.now;
    var seg = last.wait ? h('div', { class: 'lt-seg', role: 'tablist' },
      h('button', { type: 'button', class: activeTab === 'now' ? 'on' : '', role: 'tab', onclick: function () { activeTab = 'now'; drawResult(); } }, '現在辦'),
      h('button', { type: 'button', class: activeTab === 'wait' ? 'on' : '', role: 'tab', onclick: function () { activeTab = 'wait'; drawResult(); } }, last.wait.label)) : null;
    resultBox.replaceChildren.apply(resultBox, [
      seg,
      h('div', { class: 'lt-table-sub' }, cur.sub),
      h('div', { class: 'lt-table-wrap' }, tableFor(cur.kind, cur.c)),
      compareNote(cur.c),
      cur.kind === 'mortgage' ? h('p', { class: 'hint' }, '月付最高 ＝ 整段期間裡最高的那一個月，寬限期結束或利率調升後通常會變高；表上只在有變化時才會出現這一列。') : null,
      h('p', { class: 'hint' }, '總成本只算「從現在起」的利息、違約金和費用。月利率 = 年利率 ÷ 12。「現在辦」和「等滿綁約期再辦」是各自比較，時間點不同，剩餘本金和實拿現金也不同，不要跨分頁比較現金。實際數字以銀行的試算表為準。')
    ].filter(Boolean));
  }

  window.LoanTool = {
    mount: function (target) {
      box = target;
      load();
      modeBar = h('div', { class: 'tabs' });
      formBox = h('div');
      verdictBox = h('div', { class: 'lt-verdict', 'aria-live': 'polite' });
      resultBox = h('div', { class: 'card' });
      box.replaceChildren(
        modeBar,
        h('p', { class: 'hint' }, '信貸和房貸各自有一份欄位、分開計算，資料只存在這台裝置的瀏覽器，不會上傳。數字都是範例，請換成你自己的。'),
        formBox, verdictBox, resultBox);
      buildModeBar();
      buildForm();
      recalc();
    }
  };
})();

// 槓桿工具箱：最上面的工具列與切換。
// 新增工具的做法：
//   1. 在 index.html 加一個 <div id="view-xxx" hidden></div>，並引入 tools/xxx.js
//   2. 在下面的 TOOLS 清單加一行
// 每個工具自己的資料用自己的 localStorage 名稱，彼此不會互相影響。
(function () {
  var TOOLS = [
    { id: 'combo', label: '組合比對', view: 'view-combo' },
    { id: 'loan', label: '換貸試算', view: 'view-loan', mount: function (box) { window.LoanTool.mount(box); } }
  ];
  var KEY = 'leverage-toolbox-tool';
  var mounted = {};

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function remember(id) {
    try { localStorage.setItem(KEY, id); } catch (e) { /* 存不了就算了 */ }
  }

  function show(id) {
    var tool = TOOLS.filter(function (t) { return t.id === id; })[0] || TOOLS[0];
    TOOLS.forEach(function (t) {
      document.getElementById(t.view).hidden = t.id !== tool.id;
    });
    if (tool.mount && !mounted[tool.id]) {
      mounted[tool.id] = true;
      tool.mount(document.getElementById(tool.view));
    }
    Array.prototype.forEach.call(document.querySelectorAll('#toolbar button'), function (b) {
      b.classList.toggle('on', b.dataset.id === tool.id);
      b.setAttribute('aria-current', b.dataset.id === tool.id ? 'page' : 'false');
    });
    remember(tool.id);
  }

  var bar = document.getElementById('toolbar');
  TOOLS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = t.id;
    b.textContent = t.label;
    b.addEventListener('click', function () { show(t.id); window.scrollTo(0, 0); });
    bar.appendChild(b);
  });
  show(saved());
})();

/* 一键投递助手 · 界面逻辑 */
const bridge = window.api;

// 防止文件被拖到窗口空白处时 Chromium 直接导航去打开它（会把整个界面顶掉）
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());
const $ = id => document.getElementById(id);

const S = {
  cfg: null,
  cities: [],
  allCities: [],
  favCities: [],
  platform: 'boss',
  city: '南宁',
  bossType: 'intern',
  aiFilter: false,
  nkType: 'intern',
  nkEdu: '不限',
  zhType: 'intern',
  zhEdu: '不限',
  lpType: 'intern',
  lpEdu: '不限',
  lpCity: '',
  lpFavs: [],
  lpCities: [],
  running: false,
  stopping: false,
  sent: 0, fail: 0, skip: 0, seen: 0,
  prog: 0,
  lastLine: null,
  tasks: [],
  curTask: null,
  taskView: 'list',
  version: '',
};

/* 提示行：没有内容就整行收起来，不占版面 */
function setNote(id, text, warn) {
  const el = $(id);
  if (!el) return;
  const t = String(text || '').trim();
  el.textContent = t;
  el.classList.toggle('hide', !t);
  el.classList.toggle('warn', !!warn && !!t);
}

/* ---------------- 城市 ---------------- */
function persistCities() {
  if (!S.cfg) return;
  S.cfg.city = S.city;
  S.cfg.lpCity = S.lpCity;
  S.cfg.favCities = S.favCities.slice(0, 16);
  S.cfg.lpFavs = (S.lpFavs || []).slice(0, 16);
  bridge.saveCfg(S.cfg);
}

/* 猎聘：城市是它自己一套编码（400 个），空 = 全国；清单由主进程给 */
function lpCityList() { return S.lpCities || []; }

/* 猎聘的常用城市：只放选过的 */
function lpFavs() {
  return (S.lpFavs || []).filter(n => lpCityList().includes(n));
}

function setLpCity(name) {
  S.lpCity = name || '';
  if (name && lpCityList().includes(name)) {
    S.lpFavs = [name, ...lpFavs().filter(x => x !== name)].slice(0, 16);
  }
  $('cityCur').textContent = name || '全国';
  setNote('cityNote', name ? '只投该市岗位' : '');
  persistCities();
  renderCityList('');
}

function setCity(name) {
  if (S.platform === 'lp') { setLpCity(name); return true; }
  const c = (S.allCities || []).find(x => x.name === name);
  if (!c) return false;
  S.city = c.name;
  // 选过的城市才进入常用列表
  S.favCities = [c.name, ...S.favCities.filter(x => x !== c.name)].slice(0, 16);
  $('cityCur').textContent = c.name;
  $('cityInput').value = '';
  setNote('cityNote', '');
  persistCities();
  renderCityList('');
  return true;
}

function removeFav(name, ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  S.favCities = S.favCities.filter(x => x !== name);
  if (S.city === name) {
    S.city = '';
    $('cityCur').textContent = '未选择';
    setNote('cityNote', '请重新选择城市', true);
  }
  persistCities();
  renderCityList($('cityInput').value);
}

function removeLpFav(name, ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  S.lpFavs = lpFavs().filter(x => x !== name);
  if (S.lpCity === name) {
    S.lpCity = '';
    $('cityCur').textContent = '全国';
  }
  persistCities();
  renderCityList($('cityInput').value);
}

/* 默认空；只有选择过的城市才出现在常用列表里 */
function renderCityList(kw) {
  const wrap = $('cityList');
  const q = String(kw || '').trim();

  // 猎聘：自己一套城市清单，空 = 全国；平时只显示选过的，搜了才列出来
  if (S.platform === 'lp') {
    if (q) {
      const hit = lpCityList().filter(n => n.includes(q)).slice(0, 60);
      const withAll = /全国|不限|全部/.test(q);
      wrap.innerHTML =
        `<div class="cgroup">搜索「${esc(q)}」· ${hit.length} 个市</div>` +
        '<div class="cchips gxcity">' +
        (withAll ? `<button data-c=""${!S.lpCity ? ' class="on"' : ''}>全国</button>` : '') +
        hit.map(n => `<button data-c="${n}"${S.lpCity === n ? ' class="on"' : ''}>${n}</button>`).join('') +
        '</div>' +
        (hit.length || withAll ? '' : '<div class="citynone">猎聘没有收录这个城市</div>');
    } else {
      const favs = lpFavs();
      if (!favs.length) {
        wrap.innerHTML = '<div class="citynone">搜索城市名，选中后显示在这里（不选 = 全国）</div>';
        return;
      }
      wrap.innerHTML =
        '<div class="cgroup">常用城市</div><div class="cchips">' +
        favs.map(n =>
          `<div class="cc"><button data-c="${n}"${S.lpCity === n ? ' class="on"' : ''}>${n}</button><i class="del" data-del="${n}" title="从常用中移除">×</i></div>`
        ).join('') + '</div>' +
        (S.lpCity ? '<button class="gxbackbtn" data-c="">切回全国</button>' : '');
    }
    wrap.querySelectorAll('button[data-c]').forEach(b => {
      b.onclick = () => { if (!S.running) setLpCity(b.dataset.c || ''); };
    });
    wrap.querySelectorAll('.del').forEach(d => {
      d.onclick = ev => removeLpFav(d.dataset.del, ev);
    });
    return;
  }

  if (q) {
    const hit = S.allCities
      .filter(c => c.name.includes(q) || (c.prov || '').includes(q))
      .slice(0, 60);
    if (!hit.length) {
      wrap.innerHTML = `<div class="citynone">没找到「${esc(q)}」，换个关键字试试</div>`;
      return;
    }
    wrap.innerHTML =
      `<div class="cgroup">搜索「${esc(q)}」· ${hit.length} 个结果</div>` +
      '<div class="cchips wide">' +
      hit.map(c => `<button data-c="${esc(c.name)}" title="${esc(c.prov || '')}"${c.name === S.city ? ' class="on"' : ''}>${esc(c.name)}</button>`).join('') +
      '</div>';
    wrap.querySelectorAll('button[data-c]').forEach(b => {
      b.onclick = () => { if (!S.running) setCity(b.dataset.c); };
    });
    return;
  }

  const favs = S.favCities
    .map(n => S.allCities.find(c => c.name === n))
    .filter(Boolean);

  if (!favs.length) {
    wrap.innerHTML = '<div class="citynone">搜索城市名，选中后显示在这里</div>';
    return;
  }

  wrap.innerHTML =
    '<div class="cgroup">常用城市</div><div class="cchips">' +
    favs.map(c =>
      `<div class="cc"><button data-c="${esc(c.name)}" title="${esc(c.prov || '')}"${c.name === S.city ? ' class="on"' : ''}>${esc(c.name)}</button><i class="del" data-del="${esc(c.name)}" title="从常用中移除">×</i></div>`
    ).join('') + '</div>';

  wrap.querySelectorAll('button[data-c]').forEach(b => {
    b.onclick = () => { if (!S.running) setCity(b.dataset.c); };
  });
  wrap.querySelectorAll('.del').forEach(d => {
    d.onclick = ev => removeFav(d.dataset.del, ev);
  });
}

/* ---------------- 主题 ---------------- */
const THEME_KEY = 'aab-theme';

function applyTheme(t, persist = true) {
  const theme = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch {} }
  bridge.setTheme(theme);
}

/* ---------------- 颜色 ---------------- */
const ANSI = { '31': 'a-err', '32': 'a-ok', '33': 'a-warn', '36': 'a-info', '90': 'a-dim', '1': 'a-bold' };

function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmt(raw) {
  const s = esc(raw);
  const out = [];
  const re = /\x1b\[(\d+)m/g;
  let last = 0, cur = null, m;
  while ((m = re.exec(s))) {
    const t = s.slice(last, m.index);
    if (t) out.push(cur ? `<span class="${cur}">${t}</span>` : t);
    last = re.lastIndex;
    if (m[1] === '0') cur = null;
    else if (ANSI[m[1]]) cur = ANSI[m[1]];
  }
  const rest = s.slice(last);
  if (rest) out.push(cur ? `<span class="${cur}">${rest}</span>` : rest);
  return out.join('');
}

/* ---------------- 日志 ---------------- */
const box = $('logbox');
const MAX_LINES = 1500;
let logN = 0;

function clearEmpty() {
  const e = box.querySelector('.empty');
  if (e) box.removeChild(e);
}

function newLine(raw) {
  clearEmpty();
  logN++;
  hintLog();
  const d = document.createElement('div');
  d.className = 'ln';
  // 智能体动作统一走运行日志：带 [AI] 前缀且没有自带着色的行，给个青色以便和主流程区分
  const r0 = String(raw == null ? '' : raw);
  const paint = r0.includes('[AI]') && !/\x1b\[/.test(r0);
  d.dataset.raw = paint ? `\x1b[36m${r0}\x1b[0m` : r0;
  d.innerHTML = fmt(d.dataset.raw);
  box.appendChild(d);
  S.lastLine = d;
  while (box.childElementCount > MAX_LINES) box.removeChild(box.firstElementChild);
  scrollDown();
}

function appendLine(txt) {
  if (!S.lastLine) return newLine(txt);
  S.lastLine.dataset.raw = (S.lastLine.dataset.raw || '') + txt;
  S.lastLine.innerHTML = fmt(S.lastLine.dataset.raw);
  scrollDown();
}

function replaceLine(txt) {
  if (!S.lastLine) return newLine(txt);
  S.lastLine.dataset.raw = txt;
  S.lastLine.innerHTML = fmt(txt);
  scrollDown();
}

let autoScroll = true;
box.addEventListener('scroll', () => {
  autoScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
});
function scrollDown() {
  if (autoScroll) box.scrollTop = box.scrollHeight;
}

/* ---------------- 底部日志面板：拖高度 / 收起 / 复制 / 清空 ---------------- */
const LOGD = { min: 92, def: 220, h: 220 };
// file:// 下个别环境会禁用 localStorage，读写都要兜底
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const dock = $('logDock');
const grip = $('logGrip');

function hintLog() {
  const el = $('logHint');
  if (!el) return;
  el.textContent = logN ? `共 ${logN} 行` : '拖动上沿可调高度';
}

function logEmpty() {
  box.innerHTML = '<div class="empty"><div class="etitle">准备就绪</div>'
    + '<div class="esub">选好城市，点「开始投递」（Ctrl + Enter），日志会实时滚动在这里</div></div>';
}

// 上限：给上方工作区至少留 ~150px，同时不超过窗口 72%
function logMax() {
  const main = document.querySelector('.main');
  const h = main ? main.getBoundingClientRect().height : window.innerHeight;
  const room = h - 52 - 40 - 150;
  return Math.max(LOGD.min + 40, Math.min(room, Math.round(window.innerHeight * 0.72)));
}

function setLogH(h, persist) {
  LOGD.h = Math.max(LOGD.min, Math.min(logMax(), Math.round(h)));
  dock.classList.remove('folded');
  dock.style.setProperty('--logh', LOGD.h + 'px');
  if (persist) lsSet('jd.logh', String(LOGD.h));
}

function logExpand() {
  dock.classList.remove('folded');
  lsSet('jd.logfold', '0');
}

(function logPanelInit() {
  if (!dock || !grip) return;
  const savedH = Number(lsGet('jd.logh'));
  dock.style.setProperty('--logh', (savedH > 0 ? Math.min(savedH, 900) : LOGD.def) + 'px');
  LOGD.h = savedH > 0 ? savedH : LOGD.def;
  if (lsGet('jd.logfold') === '1') dock.classList.add('folded');
  setLogH(LOGD.h, false);
  logEmpty();
  hintLog();

  let drag = null;
  grip.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, h: dock.offsetHeight || LOGD.h };
    dock.classList.add('dragging');
    document.body.classList.add('logdrag');
    try { grip.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    if (!drag) return;
    setLogH(drag.h - (e.clientY - drag.y), false);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    dock.classList.remove('dragging');
    document.body.classList.remove('logdrag');
    lsSet('jd.logh', String(LOGD.h));
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', () => setLogH(LOGD.def, true));
  window.addEventListener('resize', () => {
    if (dock.classList.contains('folded')) return;
    if (LOGD.h > logMax()) setLogH(logMax(), true);
  });

  $('logFold').onclick = () => {
    const f = dock.classList.toggle('folded');
    lsSet('jd.logfold', f ? '1' : '0');
  };
  $('logClear').onclick = () => {
    box.innerHTML = '';
    S.lastLine = null;
    logN = 0;
    logEmpty();
    hintLog();
  };
  $('logCopy').onclick = async () => {
    // 复制时去掉 ANSI 颜色码，粘到聊天/文档里不带乱码
    const txt = [...box.querySelectorAll('.ln')]
      .map(d => String(d.dataset.raw || d.textContent).replace(/\x1b\[[0-9;]*m/g, ''))
      .join('\n');
    if (!txt.trim()) { toast('日志还是空的'); return; }
    try {
      await navigator.clipboard.writeText(txt);
      toast('日志已复制到剪贴板');
    } catch {
      toast('复制失败，可以拖动鼠标选中后 Ctrl+C');
    }
  };
})();

/* ---------------- 统计 ---------------- */
function paint() {
  $('stSent').textContent = S.sent;
  $('stFail').textContent = S.fail;
  $('stSkip').textContent = S.skip;
  $('stSeen').textContent = S.seen;
  $('progBar').style.width = Math.min(100, S.prog) + '%';
  $('stSent').parentElement.classList.toggle('hit', S.sent > 0);
  $('stFail').parentElement.classList.toggle('err', S.fail > 0);
}

function parseLine(raw) {
  const t = raw.replace(/\x1b\[\d+m/g, '');
  // 单条结果：[3/40] ✔ 岗位
  const one = t.match(/\[(\d+)\/(\d+)\]\s*([✔✘])/);
  if (one) {
    const [, i, n, mark] = one;
    S.prog = (Number(i) / Math.max(1, Number(n))) * 100;
    if (mark === '✔') S.sent++;
    else S.fail++;
    paint();
    return;
  }
  // 采集进度：[3/18] 采集「前端」
  const scan = t.match(/\[(\d+)\/(\d+)\]\s*采集/);
  if (scan) {
    S.prog = (Number(scan[1]) / Math.max(1, Number(scan[2]))) * 100 * 0.35;
    paint();
    return;
  }
  const pool = t.match(/池\s*(\d+)\s*→\s*符合条件\s*(\d+)/);
  if (pool) {
    S.seen = Number(pool[1]);
    S.prog = 40;
    paint();
    return;
  }
  if (/跳过/.test(t) && /\[/.test(t)) {
    S.skip++;
    paint();
  }
}

/* ---------------- 徽章 ---------------- */
function badge(cls, text) {
  const b = $('badge');
  b.className = 'badge ' + cls;
  b.innerHTML = '<span></span>' + esc(text);
}

/* ---------------- 平台切换 ---------------- */
function setPlatform(p) {
  if (S.running) return;
  flushKeywords();            // 先把刚敲进去的关键词落盘（四个平台共用一份）
  S.platform = p;
  document.querySelectorAll('#platSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.plat === p);
  });
  $('bossOpts') && $('bossOpts').classList.toggle('hide', p !== 'boss');
  $('nkOpts') && $('nkOpts').classList.toggle('hide', p !== 'nk');
  $('zhOpts') && $('zhOpts').classList.toggle('hide', p !== 'zh');
  $('lpOpts') && $('lpOpts').classList.toggle('hide', p !== 'lp');
  // BOSS 每日 150 位额度是硬上限，直接写在右上的小字里，不额外占一行
  const mh = $('maxHint');
  if (mh) mh.textContent = p === 'boss' ? '留空 = 不限 · 每日上限 150' : '留空 = 不限';
  const cur = S.city || '';
  const lcur = S.lpCity || '';
  if (p === 'lp') setNote('cityNote', lcur ? '只投该市岗位' : '');
  else if (p === 'zh') setNote('cityNote', cur ? '' : '不选会默认搜北京', !cur);
  else if (p === 'nk') setNote('cityNote', cur ? '' : '不选＝全国');
  else setNote('cityNote', cur ? '' : '请先选择城市', !cur);
  fillKeywords();
  fillEdu();
  fillMax(S.cfg ? (p === 'boss' ? S.cfg.bossMax : p === 'zh' ? S.cfg.zhMax : p === 'lp' ? S.cfg.lpMax : S.cfg.nkMax) : 40);
  if (p === 'lp') {
    $('cityCur').textContent = S.lpCity || '全国';
    $('cityInput').placeholder = '搜索城市（不选 = 全国）…';
    renderCityList('');
  } else {
    $('cityCur').textContent = S.city || '未选择';
    $('cityInput').placeholder = '搜索全国 373 个城市…';
    renderCityList('');
  }
}

function fillEdu() {
  const nk = S.nkEdu || '不限';
  const el = $('eduChips');
  if (el) el.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.edu === nk));
  const zh = S.zhEdu || '不限';
  const zl = $('zhEduChips');
  if (zl) zl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.edu === zh));
  const zt = ['all', 'fulltime', 'parttime', 'intern', 'campus'].includes(S.zhType) ? S.zhType : 'intern';
  const zc = $('zhTypeChips');
  if (zc) zc.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.ztype === zt));
  const bt = ['all', 'fulltime', 'parttime', 'intern'].includes(S.bossType) ? S.bossType : 'intern';
  const bc = $('bossTypeChips');
  if (bc) bc.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.btype === bt));
  document.querySelectorAll('.aiChips').forEach(box =>
    box.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.ai === '1') === !!S.aiFilter)));

  const lt = ['all', 'fulltime', 'parttime', 'intern'].includes(S.lpType) ? S.lpType : 'intern';
  const lc = $('lpTypeChips');
  if (lc) lc.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.lptype === lt));
  const le = S.lpEdu || '不限';
  const ll = $('lpEduChips');
  if (ll) ll.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.edu === le));
}

/* 关键词四个平台共用一份，切平台不改内容 */
function fillKeywords() {
  if (!S.cfg) return;
  const kw = (S.cfg.keywords && S.cfg.keywords.length)
    ? S.cfg.keywords
    : (S.cfg.bossKeywords || S.cfg.nkKeywords || S.cfg.zhKeywords || S.cfg.lpKeywords || []);
  $('kwInput').value = (kw || []).join(' ');
}

/* 关键词：只用空格分隔（连续空格、换行都算一个分隔符） */
function parseKeywords(raw) {
  return String(raw || '')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 60);
}

/* 边打边记：输入后立刻写进内存，400ms 后落盘；切平台 / 关窗口都会先补一次 */
let kwTimer = null, kwDirty = null;
function rememberKeywords() {
  if (!S.cfg) return;
  S.cfg.keywords = parseKeywords($('kwInput').value);
  kwDirty = S.cfg;
  clearTimeout(kwTimer);
  kwTimer = setTimeout(flushKeywords, 400);
}
function flushKeywords() {
  clearTimeout(kwTimer);
  if (kwDirty) { try { bridge.saveCfg(kwDirty); } catch {} }
  kwDirty = null;
}
function bindKeywordMemory() {
  const el = $('kwInput');
  if (!el) return;
  el.addEventListener('input', rememberKeywords);
  el.addEventListener('blur', flushKeywords);
  window.addEventListener('beforeunload', flushKeywords);
}

function fillMax(n) {
  const v = Number(n) || 0;
  $('maxInput').value = (!v || v >= 999) ? '' : v;
}

/* ---------------- 投递报告（md）解析 ---------------- */
const clean = s => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim();

/* 解析程序生成的报告 markdown（标题 / 键值 / 小节 / 表格 / 列表 / 引用） */
function parseReport(md) {
  const out = { title: '', meta: [], sections: [], notes: [] };
  let cur = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#\s+/.test(line)) { out.title = clean(line.replace(/^#\s+/, '')); continue; }
    if (/^-{3,}$/.test(line)) continue;
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) { cur = { name: clean(h[1]), table: null, list: [] }; out.sections.push(cur); continue; }
    if (line.startsWith('>')) { out.notes.push(clean(line.replace(/^>\s?/, ''))); continue; }
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) {
      const txt = li[1];
      if (!cur) {
        const kv = txt.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
        if (kv) out.meta.push({ k: kv[1].trim(), v: kv[2].trim() });
        else out.meta.push({ k: '', v: txt });
      } else cur.list.push(txt);
      continue;
    }
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(s => s.trim());
      if (!cells.length) continue;
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
      if (!cur) { cur = { name: '', table: null, list: [] }; out.sections.push(cur); }
      if (!cur.table) cur.table = { head: cells, rows: [] };
      else cur.table.rows.push(cells);
      continue;
    }
    if (!cur) out.meta.push({ k: '', v: line });
    else cur.list.push(line);
  }
  return out;
}

const STAT_ORDER = ['扫描', '成功', '跳过', '失败'];

function buildReportHtml(md) {
  const r = parseReport(md);
  const html = [];

  // 统计卡
  const stats = [], rest = [];
  for (const m of r.meta) {
    if (STAT_ORDER.some(k => m.k.includes(k))) stats.push(m);
    else rest.push(m);
  }
  stats.sort((a, b) => {
    const ai = STAT_ORDER.findIndex(k => a.k.includes(k));
    const bi = STAT_ORDER.findIndex(k => b.k.includes(k));
    return ai - bi;
  });
  if (stats.length) {
    html.push('<div class="rvstats">');
    for (const s of stats) {
      const num = clean(s.v).replace(/[^\d.]/g, '') || '0';
      const cls = /成功/.test(s.k) ? 'ok' : /失败/.test(s.k) ? 'bad' : '';
      html.push(`<div class="rvstat ${cls}"><b>${esc(num)}</b><i>${esc(s.k)}</i></div>`);
    }
    html.push('</div>');
  }
  if (rest.length) {
    html.push('<div class="rvmeta">' + rest.map(m =>
      esc(m.k) ? `<span>${esc(m.k)}：<em>${esc(clean(m.v))}</em></span>` : `<span>${esc(clean(m.v))}</span>`
    ).join('') + '</div>');
  }

  // 小节
  for (const sec of r.sections) {
    if (sec.name) html.push(`<div class="rvh">${esc(sec.name)}</div>`);
    if (sec.table && sec.table.rows.length) {
      html.push('<div class="rvtw"><table class="rvtable"><thead><tr>');
      for (const th of sec.table.head) html.push(`<th>${esc(clean(th))}</th>`);
      html.push('</tr></thead><tbody>');
      for (const row of sec.table.rows) {
        html.push('<tr>');
        for (const td of row) html.push(`<td>${esc(clean(td))}</td>`);
        html.push('</tr>');
      }
      html.push('</tbody></table></div>');
    }
    if (sec.list.length) {
      html.push('<div class="rvlist">');
      for (const it of sec.list) {
        const parts = clean(it).split(/[｜|]/).map(x => x.trim()).filter(Boolean);
        const main = parts[0] || it;
        const reason = parts.slice(1).join(' · ');
        html.push(`<div class="rvitem"><span class="dot"></span><span>${esc(main)}${reason ? ` <span class="reason">${esc(reason)}</span>` : ''}</span></div>`);
      }
      html.push('</div>');
    }
  }

  if (r.notes.length) {
    html.push('<div class="rvmeta" style="margin-top:16px">' +
      r.notes.map(n => `<span>${esc(n)}</span>`).join('') + '</div>');
  }

  return html.join('') || '<div class="rvmeta">报告为空</div>';
}

/* ---------------- 历史任务 ---------------- */
const PLAT_LABEL = { boss: 'BOSS 直聘', nk: '牛客网', zh: '智联招聘', lp: '猎聘' };
const TASK_STATUS = {
  running: ['进行中', 'run'],
  stopped: ['已停止', 'warn'],
  done: ['已完成', 'ok'],
  failed: ['出错', 'bad'],
  empty: ['无可投岗位', 'idle'],
};

function fmtWhen(ms) {
  if (!ms) return '—';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  const y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '-';
  return `${y}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function statusPill(s) {
  const [txt, cls] = TASK_STATUS[s] || TASK_STATUS.done;
  return `<span class="pill ${cls}"><i></i>${esc(txt)}</span>`;
}

function taskName(t) {
  const n = t.platformName || PLAT_LABEL[t.platform] || '任务';
  const c = t.city ? ' · ' + t.city : (t.platform === 'lp' ? ' · 全国' : '');
  return `${n}${c}`;
}

function taskTitle(t) {
  return `${taskName(t)} · ${fmtWhen(t.updatedAt || t.createdAt)}`;
}

function taskSubline(t) {
  if (t.legacy) return '旧版投递报告 · 没有任务快照，只能看内容';
  const st = t.stats || {};
  const kw = (t.keywords || []).slice(0, 3).join('，');
  const cond = [t.typeLabel && t.typeLabel !== '不限' ? t.typeLabel : '', t.edu || ''].filter(Boolean).join(' · ');
  const parts = [
    t.max > 0 ? `目标 ${t.max}` : '不限量',
    `已投 ${st.sent || 0}`,
    st.failed ? `失败 ${st.failed}` : '',
    `采集 ${st.collected || 0}`,
    kw,
    cond,
  ].filter(Boolean);
  return parts.join(' · ');
}

function renderTasks(list) {
  S.tasks = list || [];
  const wrap = $('taskList');
  if (!S.tasks.length) {
    wrap.innerHTML = '<div class="rep empty2">还没有任务记录，跑一次就会有</div>';
    return;
  }
  wrap.innerHTML = S.tasks.map(t => {
    const hot = t.status === 'stopped' || t.status === 'failed';
    return `
    <div class="rep${hot ? ' hot' : ''}" data-id="${esc(t.id)}">
      <div class="ic">${esc((t.platformName || t.platform || '?').slice(0, 1))}</div>
      <div class="m">
        <div class="n">${esc(taskTitle(t))}${t.resumedBy ? '<span class="rtag">已续投</span>' : ''}</div>
        <div class="d">${esc(taskSubline(t))}</div>
      </div>
      ${statusPill(t.status)}
      <div class="go">${t.status === 'stopped' ? '继续 ›' : '查看 ›'}</div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('.rep[data-id]').forEach(el => {
    el.onclick = () => openTask(el.dataset.id);
  });
}

function refreshTasks() {
  bridge.tasks().then(renderTasks).catch(() => {});
}

async function openTask(id) {
  const res = await bridge.getTask(id);
  if (!res || !res.ok) { toast((res && res.msg) || '任务记录读取失败'); return; }
  S.curTask = res.task;
  S.taskView = 'detail';
  $('taskList').classList.add('hide');
  $('taskView').classList.remove('hide');
  $('rvTitle').textContent = taskTitle(S.curTask);
  $('rvBody').innerHTML = buildTaskHtml(S.curTask);
  $('rvBody').scrollTop = 0;
  bindResumeBtn();
  paintTaskHead();
}

function paintTaskHead() {
  const t = S.curTask;
  if (!t) return;
  const inReport = S.taskView === 'report';
  // 「继续任务」已经移到详情正文顶部的提示条里（那里显眼），头部只留返回/报告/删除
  // 投递报告只在旧版记录里保留：新版任务的明细本来就在这一页
  const showReport = !!t.reportFile && (t.legacy || inReport);
  $('tvReport').classList.toggle('hide', !showReport);
  $('tvReport').textContent = inReport ? '任务详情' : '投递报告';
  $('tvDel').classList.toggle('hide', !!t.legacy || inReport);
}

// 详情页里「继续任务」大按钮的绑定（每次重绘正文都要重绑）
function bindResumeBtn() {
  const b = $('rbResume');
  if (b) b.onclick = resumeTask;
}

function hideTaskView() {
  S.curTask = null;
  S.taskView = 'list';
  $('taskView').classList.add('hide');
  $('taskList').classList.remove('hide');
  refreshTasks();
}

function buildTaskHtml(t) {
  const h = [];
  const st = t.stats || {};

  if (t.legacy) {
    h.push('<div class="rvmeta"><span>旧版投递报告</span><span>这条记录没有任务快照，只能查看报告内容</span></div>');
    h.push('<div class="rvlist"><div class="rvitem"><span class="dot"></span><span>这是早期版本生成的报告，之后的每个任务都会记录完整条件和采集结果，可直接继续投递。</span></div></div>');
    return h.join('');
  }

  const sentIds = new Set((t.sentItems || []).map(x => x.id));
  const wait = (t.pool || []).filter(x => !sentIds.has(x.id));

  // 「继续任务」放成正文顶部的大按钮：原来挤在右上角那排小字里，很难发现
  if ((t.status === 'stopped' || t.status === 'failed') && !t.resumedBy) {
    const head = t.status === 'failed' ? '这条任务出错中断了，还能接着投' : '这条任务停在中途，还可以接着投';
    if (wait.length) {
      h.push(`<div class="resumebar">
        <div class="rbtx">
          <b>${head}</b>
          <span>还剩 <em>${wait.length}</em> 个岗位没投（已投的会自动跳过），续投不用重新搜一遍</span>
        </div>
        <button class="primary rbbtn" id="rbResume">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13"></path><path d="M12 5l7 7-7 7"></path></svg>
          继续任务
        </button>
      </div>`);
    } else {
      h.push(`<div class="resumebar flat">
        <div class="rbtx">
          <b>这条任务的岗位都已经投过了</b>
          <span>继续也不会有新岗位。想再投请回左侧点「开始投递」，换个关键词或地区开新任务</span>
        </div>
      </div>`);
    }
  } else if (t.status === 'done' && !t.resumedBy) {
    h.push(`<div class="resumebar flat">
      <div class="rbtx">
        <b>这条任务已经结束</b>
        <span>任务结束后不能再继续；想再投请回左侧点「开始投递」开一条新任务</span>
      </div>
    </div>`);
  } else if (t.resumedBy) {
    h.push(`<div class="resumebar flat">
      <div class="rbtx">
        <b>这条任务已经续投过了</b>
        <span>接着投的是它续出来的那条新任务，去历史任务里找更新的那条</span>
      </div>
    </div>`);
  }

  h.push('<div class="rvstats">');
  h.push(`<div class="rvstat"><b>${st.collected || 0}</b><i>采集</i></div>`);
  h.push(`<div class="rvstat ok"><b>${st.sent || 0}</b><i>已投成功</i></div>`);
  h.push(`<div class="rvstat bad"><b>${st.failed || 0}</b><i>失败</i></div>`);
  const left = t.max > 0 ? Math.max(0, t.max - (st.sent || 0)) : '∞';
  h.push(`<div class="rvstat"><b>${left}</b><i>还差</i></div>`);
  h.push('</div>');

  h.push('<div class="rvmeta">' + [
    `<span>状态</span>${statusPill(t.status)}`,
    `<span>地区 <em>${esc(t.city || '全国')}</em></span>`,
    t.typeLabel ? `<span>工作性质 <em>${esc(t.typeLabel)}</em></span>` : '',
    t.edu ? `<span>学历 <em>${esc(t.edu)}</em></span>` : '',
    `<span>目标 <em>${t.max > 0 ? t.max + ' 个' : '不限'}</em></span>`,
    `<span>开始 <em>${esc(fmtWhen(t.createdAt))}</em></span>`,
    t.resumedFrom ? '<span>由上次任务续投</span>' : '',
    t.resumedBy ? '<span>已续投到新任务</span>' : '',
  ].filter(Boolean).join('') + '</div>');

  h.push('<div class="rvh">检索关键词</div>');
  h.push('<div class="kwchips">' + ((t.keywords || []).length
    ? t.keywords.map(k => `<span>${esc(k)}</span>`).join('')
    : '<span class="kwnone">（没有记录）</span>') + '</div>');

  if ((t.sentItems || []).length) {
    h.push(`<div class="rvh">已投成功 ${t.sentItems.length}</div>`);
    h.push('<div class="rvtw"><table class="rvtable"><thead><tr><th>#</th><th>公司</th><th>岗位</th><th>薪资</th></tr></thead><tbody>');
    t.sentItems.forEach((x, i) => h.push(
      `<tr><td>${i + 1}</td><td>${esc(x.co || '—')}</td><td>${esc(x.title)}</td><td>${esc(x.sal || '面议')}</td></tr>`));
    h.push('</tbody></table></div>');
  }

  if ((t.failedItems || []).length) {
    h.push(`<div class="rvh">失败 ${t.failedItems.length}</div>`);
    h.push('<div class="rvlist">');
    t.failedItems.slice(0, 60).forEach(x => h.push(
      `<div class="rvitem"><span class="dot bad"></span><span>${esc(x.title)} <span class="reason">${esc(x.co || '—')} · ${esc(x.reason || '未知')}</span></span></div>`));
    h.push('</div>');
  }

  if (wait.length) {
    h.push(`<div class="rvh">采集到但还没投 ${wait.length}</div>`);
    h.push('<div class="rvlist">');
    wait.slice(0, 100).forEach(x => h.push(
      `<div class="rvitem"><span class="dot"></span><span>${esc(x.title)} <span class="reason">${esc(x.co || '—')}${x.sal ? ' · ' + esc(x.sal) : ''}</span></span></div>`));
    h.push('</div>');
    if (wait.length > 100) h.push(`<div class="rvmeta"><span>只列出前 100 条，共 ${wait.length} 条</span></div>`);
  } else if (!(t.sentItems || []).length) {
    h.push('<div class="rvmeta"><span>这次没有采集到岗位</span></div>');
  }

  return h.join('');
}

async function toggleTaskReport() {
  const t = S.curTask;
  if (!t) return;
  if (S.taskView === 'report') {
    S.taskView = 'detail';
    $('rvBody').innerHTML = buildTaskHtml(t);
    bindResumeBtn();
    paintTaskHead();
    $('rvBody').scrollTop = 0;
    return;
  }
  const res = await bridge.readReport(t.reportFile);
  if (!res || !res.ok) { toast('报告读取失败'); return; }
  S.taskView = 'report';
  $('rvBody').innerHTML = buildReportHtml(res.content);
  paintTaskHead();
  $('rvBody').scrollTop = 0;
}

// 把历史任务的条件填回左侧表单，用户能先看到「续的是什么」，也能就地改
function applyTaskToForm(t) {
  setPlatform(t.platform === 'lp' ? 'lp' : t.platform);
  if (t.platform === 'lp') {
    if (lpCityList().includes(t.city)) setLpCity(t.city);
    else setLpCity('');
  } else if (t.city) {
    if (!setCity(t.city)) {
      S.city = '';
      $('cityCur').textContent = '未选择';
      $('cityNote').textContent = `城市「${t.city}」不可用，请重选`;
      $('cityNote').classList.remove('hide');
      $('cityNote').classList.add('warn');
    }
  }
  if (t.platform === 'boss' && t.type) S.bossType = t.type;
  if (t.platform === 'nk') { if (t.type) S.nkType = t.type; if (t.edu) S.nkEdu = t.edu; }
  if (t.platform === 'zh') { if (t.type) S.zhType = t.type; if (t.edu) S.zhEdu = t.edu; }
  if (t.platform === 'lp') { if (t.type) S.lpType = t.type; if (t.edu) S.lpEdu = t.edu; }
  fillEdu();

  $('kwInput').value = (t.keywords || []).join(' ');
  const left = t.max > 0 ? Math.max(1, t.max - ((t.stats && t.stats.sent) || 0)) : 0;
  $('maxInput').value = left > 0 ? String(left) : '';
  const w = $('kwWrap');
  if (w.classList.contains('hide')) { w.classList.remove('hide'); $('kwToggle').textContent = '收起'; }
}

function resumeTask() {
  const t = S.curTask;
  if (!t || t.legacy) return;
  if (t.status !== 'stopped' && t.status !== 'failed') {
    toast(t.resumedBy ? '这条任务已经续投过了，去历史任务里打开新的那条' : '只有中途停止或出错的任务才能继续');
    return;
  }
  if (t.resumedBy) { toast('这条任务已经续投过了，去历史任务里打开新的那条'); return; }
  if (S.running) { toast('正在投递中，先停止再继续'); return; }
  applyTaskToForm(t);
  if ((t.platform === 'boss' || t.platform === 'zh') && !S.city) {
    toast('这条任务没有记录城市，请先选一个城市再继续');
    return;
  }
  // 日志已经常驻在底部，续投时直接开始，并把日志面板展开
  logExpand();
  start({ resumeFrom: t.id });
}

/* ---------------- 启动任务 ---------------- */
function start(extra) {
  if (S.running) return;
  logExpand();               // 开始投递就把底部日志展开，能立刻看到进度
  if (U.forced && !$('upMask').classList.contains('hide')) {
    toast('请先完成更新再开始投递');
    return;
  }
  if (S.platform === 'boss' && !S.city) {
    setNote('cityNote', '请先选择城市', true);
    $('cityInput').focus();
    return;
  }
  if (S.platform === 'zh' && !S.city) {
    setNote('cityNote', '智联要先选城市，否则会搜北京', true);
    $('cityInput').focus();
    return;
  }
  const raw = $('maxInput').value.trim();
  const n = Number(raw);
  // 留空 / 0 / 负数 / 非数字 = 不限，由平台自身额度兜底
  const max = (raw === '' || !Number.isFinite(n) || n <= 0)
    ? 0
    : Math.min(999, Math.floor(n));
  const keywords = parseKeywords($('kwInput').value);
  if (!keywords.length) {
    const wrap = $('kwWrap');
    if (wrap.classList.contains('hide')) { wrap.classList.remove('hide'); $('kwToggle').textContent = '收起'; }
    $('kwInput').focus();
    toast('请先填写检索关键词');
    return;
  }

  // 重置统计
  S.sent = S.fail = S.skip = S.seen = 0;
  S.prog = 0;
  S.lastLine = null;
  box.innerHTML = '';
  paint();
  autoScroll = true;

  badge('run', '运行中');
  setRunning(true);
  $('footMsg').textContent = S.platform === 'boss'
    ? `正在投递 · ${S.city}`
    : S.platform === 'zh'
      ? `正在投递 · 智联 ${S.city}`
      : S.platform === 'lp'
        ? `正在投递 · 猎聘 ${S.lpCity || '全国'}`
        : `正在投递 · 牛客${S.city ? ' ' + S.city : '（全国）'}`;

  bridge.start({
    platform: S.platform,
    city: S.platform === 'lp' ? (S.lpCity || '') : S.city,
    max,
    keywords,
    bossType: S.bossType,
    aiFilter: !!S.aiFilter,
    nkType: S.nkType,
    nkEdu: S.nkEdu,
    zhType: S.zhType,
    zhEdu: S.zhEdu,
    lpType: S.lpType,
    lpEdu: S.lpEdu,
    resumeFrom: (extra && extra.resumeFrom) || '',
  });

  // 记住关键词与数量
  if (S.cfg) {
    if (S.platform === 'boss') {
      S.cfg.keywords = keywords; S.cfg.bossMax = max; S.cfg.bossType = S.bossType; S.cfg.aiFilter = S.aiFilter; S.cfg.city = S.city;
    } else if (S.platform === 'zh') {
      S.cfg.keywords = keywords; S.cfg.zhMax = max;
      S.cfg.zhType = S.zhType; S.cfg.zhEdu = S.zhEdu;
      S.cfg.city = S.city;
    } else if (S.platform === 'lp') {
      S.cfg.keywords = keywords; S.cfg.lpMax = max;
      S.cfg.lpType = S.lpType; S.cfg.lpEdu = S.lpEdu; S.cfg.lpCity = S.lpCity;
    } else {
      S.cfg.keywords = keywords; S.cfg.nkMax = max;
      S.cfg.nkRecruitType = S.nkType; S.cfg.nkEdu = S.nkEdu;
      S.cfg.city = S.city;
    }
    bridge.saveCfg(S.cfg);
  }
}

function setRunning(on) {
  S.running = on;
  S.stopping = false;
  $('btnStart').disabled = on;
  $('btnStart').querySelector('span').textContent = on ? '投递中…' : '开始投递';
  $('btnStop').classList.toggle('hide', !on);
  $('btnStop').disabled = false;
  $('btnStop').textContent = '停止';
  $('btnCloseBr').classList.add('hide');   // 状态一变先收起，任务结束后再按需显示
}

/* ---------------- 事件 ---------------- */
bridge.on('log', p => {
  if (!p) return;
  if (p.mode === 'begin') newLine(p.text);
  else if (p.mode === 'append') appendLine(p.text);
  else if (p.mode === 'replace') { replaceLine(p.text); parseLine(p.text); }
  else { newLine(p.text); parseLine(p.text); }
});

bridge.on('state', s => {
  setRunning(!!s.running);
  if (s.running) badge('run', '运行中');
});

bridge.on('run:done', r => {
  setRunning(false);
  S.prog = 100;
  if (r.ok) {
    S.sent = r.sent; S.fail = r.failed; S.skip = r.skipped;
    if (r.aborted) {
      badge('idle', '已中断');
      $('footMsg').textContent = `已中断 · 成功 ${r.sent} · 失败 ${r.failed} · 可在「历史任务」里继续`;
    } else {
      badge(r.stopped ? 'idle' : 'ok', r.stopped ? '已停止' : '已完成');
      $('footMsg').textContent = r.stopped
        ? `已停止 · 已投成功 ${r.sent} · 失败 ${r.failed} · 跳过 ${r.skipped}`
        : `完成 · 成功 ${r.sent} · 失败 ${r.failed} · 跳过 ${r.skipped}`;
    }
  } else {
    const stopped = /停止/.test(r.msg || '');
    badge('idle', stopped ? '已停止' : '无结果');
    $('footMsg').textContent = r.msg || '本轮没有可投递的岗位';
  }
  paint();
  refreshTasks();
  if (r.reportFile) newLine(`\x1b[32m  ✔ 报告已保存：${r.reportFile}\x1b[0m`);
  if (r.stopped || r.aborted) {
    newLine(`\x1b[33m  ! 任务已存档，去「历史任务」点这条记录可以接着投\x1b[0m`);
  }
  // 跑完了就把「关闭浏览器」露出来：投递用的那个窗口留着没用，还占内存
  $('btnCloseBr').classList.remove('hide');
});

bridge.on('run:error', msg => {
  setRunning(false);
  badge('bad', '出错');
  S.prog = 0;
  paint();
  newLine(`\x1b[31m  ✘ ${msg}\x1b[0m`);
  $('footMsg').textContent = msg;
});

/* ---------------- 初始化 ---------------- */
let savedTheme = 'dark';
try { savedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}
applyTheme(savedTheme, false);

/* ---------------- 版本更新 ---------------- */
const U = { info: null, forced: false, stage: 'idle', file: '', pct: 0 };

function fmtSize(n) {
  if (!n) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

function fmtSpeed(bps) {
  if (!bps || bps < 1024) return '';
  if (bps >= 1024 ** 2) return (bps / 1024 ** 2).toFixed(1) + ' MB/s';
  return Math.round(bps / 1024) + ' KB/s';
}

function toast(msg, ms = 2600) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hide');
  // 重新触发一次弹入动画，连续提示也能看清
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hide'), ms);
}

function showUpdate(info) {
  const m = info && info.manifest;
  if (!m || !m.version) return;
  if (U.info && U.info.manifest.version === m.version
      && !$('upMask').classList.contains('hide')) return;

  U.info = { manifest: m, current: info.current || S.version || '' };
  U.forced = !!m.forced;
  U.stage = 'idle';
  U.file = '';

  $('upCard').classList.toggle('force', U.forced);
  $('upTitle').innerHTML = (U.forced ? '需要更新到新版本 ' : '发现新版本 ')
    + `<b>v${esc(m.version)}</b>`;
  $('upSub').textContent = `当前 v${U.info.current || '—'}  →  最新 v${m.version}`;
  $('upFlag').textContent = '可选更新';
  $('upFlag').classList.toggle('hide', U.forced);

  const notes = (m.notes || []).filter(Boolean);
  $('upNotes').innerHTML = notes.length
    ? '<ul>' + notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>'
    : '<p>本次更新优化了稳定性与使用体验，建议升级到最新版本。</p>';

  $('upMeta').innerHTML = [
    m.size ? `安装包 <i>${fmtSize(m.size)}</i>` : '',
    m.pubDate ? `发布 <i>${esc(m.pubDate)}</i>` : '',
  ].filter(Boolean).join('<em>·</em>');

  $('upLater').classList.toggle('hide', U.forced);
  $('upLater').textContent = '稍后再说';
  $('upLater').disabled = false;
  $('upNow').disabled = false;
  $('upNow').textContent = '立即更新';
  $('upProg').classList.add('hide');
  $('upErr').classList.add('hide');
  $('upBar').style.width = '0%';
  $('upMask').classList.remove('hide');

  $('ver').classList.add('new');
  bridge.setForcing(U.forced);
}

function hideUpdate() {
  $('upMask').classList.add('hide');
  $('ver').classList.remove('new');
  bridge.setForcing(false);
  U.stage = 'idle';
}

async function downloadAndInstall() {
  if (!U.info || U.stage === 'downloading') return;
  const m = U.info.manifest;
  const btn = $('upNow');

  U.stage = 'downloading';
  btn.disabled = true;
  btn.textContent = '正在下载…';
  $('upErr').classList.add('hide');
  $('upProg').classList.remove('hide');
  $('upBar').style.width = '0%';
  $('upPct').textContent = '0%';
  $('upSpd').textContent = '';
  $('upLater').disabled = true;

  const r = await bridge.downloadUpdate(m.version);
  $('upLater').disabled = false;

  if (!r || !r.ok) {
    U.stage = 'error';
    btn.disabled = false;
    btn.textContent = '重试';
    $('upErr').textContent = '下载失败：' + ((r && r.msg) || '请检查网络后重试');
    $('upErr').classList.remove('hide');
    return;
  }

  U.file = r.file;
  U.stage = 'ready';
  $('upBar').style.width = '100%';
  $('upPct').textContent = '100%';
  $('upSpd').textContent = '下载完成';

  const ins = await bridge.installUpdate();
  if (ins && ins.dev) {
    btn.textContent = '已下载';
    $('upErr').classList.add('hide');
    $('upLater').classList.remove('hide');
    // 开发模式跑不了安装程序，留一个退出口；正式版强制更新时没有这个按钮
    $('upLater').textContent = U.forced ? '退出（开发模式）' : '关闭';
    bridge.setForcing(false);
    toast('安装包已下载：' + r.file, 6000);
    return;
  }
  if (ins && ins.ok === false) {
    U.stage = 'error';
    btn.disabled = false;
    btn.textContent = '重试';
    $('upErr').textContent = '无法启动安装程序：' + (ins.msg || '');
    $('upErr').classList.remove('hide');
    return;
  }
  btn.textContent = '正在启动安装程序…';
  $('upSub').textContent = '应用即将关闭，安装完成后会自动重新打开';
}

async function checkUpdates() {
  if (S.running) { toast('投递进行中，结束后再检查更新'); return; }
  const btn = $('ver');
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检查中…';
  let r = null;
  try { r = await bridge.checkUpdate(); } catch (e) { r = { ok: false, msg: e.message }; }
  btn.disabled = false;
  btn.textContent = label;

  if (!r || !r.ok) {
    if (r && r.reason === 'no-source') toast('暂未配置更新源，发布新版本后会自动提示');
    else toast('检查更新失败：' + ((r && r.msg) || '网络异常'));
    return;
  }
  if (!r.available) {
    toast('已是最新版本 v' + (r.current || S.version || ''));
    return;
  }
  showUpdate({ manifest: r.manifest, current: r.current });
}

/* ---------------- 智能体 ---------------- */
const AI = { state: null, kb: null, loaded: false, sendMode: 1, agreeMode: 1, busy: false };

// 智能体动作统一进底部运行日志，不再单独开面板

function aiSetState(st) {
  if (!st || st.ok === false) return;
  AI.state = st;
  const badge = $('aiState');
  if (st.watch && st.watch.running) {
    const st2 = st.watch.stats || {};
    badge.textContent = `值守中 · 已回 ${st2.replied || 0}` + (st2.agreed ? ` · 同意 ${st2.agreed}` : '');
    badge.classList.add('on');
    badge.classList.remove('err');
  } else if (!st.hasKey) {
    badge.textContent = '待填 API Key';
    badge.classList.remove('on');
    badge.classList.add('err');
  } else if (!st.kb.resumeLen && !st.kb.profileFilled) {
    badge.textContent = '待建知识库';
    badge.classList.remove('on');
    badge.classList.add('err');
  } else {
    badge.textContent = '已就绪 · 未值守';
    badge.classList.remove('on');
    badge.classList.remove('err');
  }

  const w = $('aiWatch');
  if (w) {
    const running = !!(st.watch && st.watch.running);
    w.textContent = running ? '运行中' : '未运行';
    w.classList.toggle('on', running);
    $('aiStart').classList.toggle('hide', running);
    $('aiStop').classList.toggle('hide', !running);
    const sub = $('aiWatchSub');
    if (running) {
      const t = st.watch.lastScan ? new Date(st.watch.lastScan).toLocaleTimeString() : '—';
      const st2 = st.watch.stats || {};
      sub.textContent = `上次扫描 ${t} · 已回 ${st2.replied || 0} · 同意简历 ${st2.agreed || 0} · 跳过 ${st2.skipped || 0} · 失败 ${st2.failed || 0}`
        + (st.watch.activeName ? ` · 盯「${st.watch.activeName}」` : '')
        + (st.watch.lastError ? ` · ${st.watch.lastError}` : '');
    } else {
      sub.textContent = '开启后每 30 秒把消息页置前扫一次未读';
    }
  }
  AI.sendMode = st.autoSend ? 1 : 0;
  const chips = $('aiSendMode');
  if (chips) chips.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.send) === AI.sendMode));
  AI.agreeMode = st.autoAgreeResume === false ? 0 : 1;
  const agreeChips = $('aiAgreeMode');
  if (agreeChips) agreeChips.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.agree) === AI.agreeMode));
}

function aiFillCfg(st) {
  $('aiBase').value = st.baseUrl || 'https://api.deepseek.com';
  $('aiModel').value = st.model || 'deepseek-v4-flash';
  $('aiMaxChars').value = st.maxChars || 60;
  $('aiPoll').value = st.pollSec || 30;
  $('aiDelayMin').value = st.delayMin || 20;
  $('aiDelayMax').value = st.delayMax || 90;
  $('aiMaxPerHour').value = st.maxPerHour || 3;
  $('aiKey').placeholder = st.hasKey ? `已保存 ${st.keyMask}（留空表示不修改）` : 'sk-…';
}

function aiFillProfile(p) {
  p = p || {};
  $('aiPName').value = p.name || '';
  $('aiPDegree').value = p.degree || '';
  $('aiPMajor').value = p.major || '';
  $('aiPStatus').value = p.status || '';
  $('aiPYears').value = p.years || '';
  $('aiPRole').value = p.expectRole || '';
  $('aiPCity').value = p.expectCity || '';
  $('aiPSkills').value = (p.skills || []).join('、');
  $('aiPProjects').value = (p.projects || []).join('；');
  $('aiPIntro').value = p.intro || '';
}

function aiFillKb(kb) {
  if (!kb) return;
  AI.kb = kb;
  $('aiResume').value = kb.resume || '';
  $('aiResumeLen').textContent = (kb.resume || '').length + ' 字';
  aiFillProfile(kb.profile);
  $('aiQa').value = kb.qa || '';
  $('aiRules').value = kb.rules || '';
}

async function aiRefresh(force) {
  try {
    const st = await bridge.agentState();
    if (st && st.ok !== false) aiSetState(st);
    if (!AI.loaded || force) {
      const kb = await bridge.agentKb();
      if (kb && !kb.msg) aiFillKb(kb);
      AI.loaded = true;
    }
    if (st && st.ok !== false && !AI.cfgFilled) {
      aiFillCfg(st);
      AI.cfgFilled = true;
    }
  } catch {}
}

async function aiSaveKb() {
  const split = (v, re) => String(v || '').split(re).map(s => s.trim()).filter(Boolean);
  const patch = {
    resume: $('aiResume').value,
    qa: $('aiQa').value,
    rules: $('aiRules').value,
    profile: {
      name: $('aiPName').value.trim(),
      degree: $('aiPDegree').value.trim(),
      major: $('aiPMajor').value.trim(),
      status: $('aiPStatus').value.trim(),
      years: $('aiPYears').value.trim(),
      expectRole: $('aiPRole').value.trim(),
      expectCity: $('aiPCity').value.trim(),
      skills: split($('aiPSkills').value, /[、,，;；\s]+/),
      projects: split($('aiPProjects').value, /[;；\n]+/),
      intro: $('aiPIntro').value.trim(),
    },
  };
  const r = await bridge.agentKbSave(patch);
  const tip = $('aiSaveTip');
  if (r && r.ok) {
    tip.textContent = '已保存到本地知识库';
    newLine('[AI] 知识库已保存');
    aiRefresh();
  } else {
    tip.textContent = (r && r.msg) || '保存失败';
  }
  setTimeout(() => { if (tip.textContent) tip.textContent = ''; }, 4000);
}

function aiBind() {
  // 面板内三个子页
  document.querySelectorAll('.aisub button[data-ai]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.aisub button[data-ai]').forEach(x => x.classList.toggle('on', x === b));
      const k = b.dataset.ai;
      $('aiKb').classList.toggle('hide', k !== 'kb');
      $('aiRun').classList.toggle('hide', k !== 'run');
      $('aiTestSec').classList.toggle('hide', k !== 'test');
    };
  });

  $('aiResume').oninput = () => { $('aiResumeLen').textContent = $('aiResume').value.length + ' 字'; };

  const applyResumeResult = (r, label) => {
    $('aiResume').value = r.text || '';
    $('aiResumeLen').textContent = ($('aiResume').value || '').length + ' 字';
    const by = r.profileSource === 'ai' ? 'AI 抽取' : '本地规则';
    if (r.profile) aiFillProfile(r.profile);
    $('aiSaveTip').textContent = r.profile
      ? `已解析 ${label || r.file} · 档案已按${by}自动填好，核对后点「保存知识库」`
      : `已解析 ${label || r.file}${r.warn ? ' · ' + r.warn : ''}`;
    newLine(`[AI] 简历已解析：${label || r.file}（${(r.text || '').length} 字）${r.profile ? '，档案已自动填写' : ''}`);
    aiRefresh(true);
  };

  // 拖拽上传：读成二进制交给主进程解析，和「上传简历」按钮走同一条链路
  const uploadResumeFile = async file => {
    if (!file) return;
    const b = $('aiUpload');
    const old = b.textContent;
    b.disabled = true;
    b.textContent = '正在解析…';
    try {
      const buf = await file.arrayBuffer();
      const r = await bridge.agentUploadBuffer(file.name, new Uint8Array(buf));
      if (r && r.ok) applyResumeResult(r, file.name);
      else toast((r && r.msg) || '解析失败');
    } catch (err) {
      toast('读取文件失败：' + err.message);
    } finally {
      b.disabled = false;
      b.textContent = old;
    }
  };

  $('aiUpload').onclick = async () => {
    const b = $('aiUpload');
    b.disabled = true;
    b.textContent = '正在解析…';
    try {
      const r = await bridge.agentUpload();
      if (r && r.ok) {
        applyResumeResult(r);
      } else if (!r || !r.canceled) {
        toast((r && r.msg) || '解析失败');
      }
    } finally {
      b.disabled = false;
      b.textContent = '上传简历（PDF / Word）';
    }
  };

  // 整张「简历原文」卡片都是投放区；计数器避免拖过子元素时高亮闪烁
  const resumeCard = $('aiResumeCard');
  if (resumeCard) {
    let depth = 0;
    resumeCard.addEventListener('dragenter', e => {
      e.preventDefault(); e.stopPropagation();
      depth++;
      resumeCard.classList.add('dragover');
    });
    resumeCard.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
    resumeCard.addEventListener('dragleave', e => {
      e.preventDefault(); e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (!depth) resumeCard.classList.remove('dragover');
    });
    resumeCard.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      depth = 0;
      resumeCard.classList.remove('dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      uploadResumeFile(f);
    });
  }

  $('aiKbDir').onclick = () => bridge.agentOpenKbDir();
  $('aiSaveKb').onclick = aiSaveKb;
  $('aiResetQa').onclick = async () => {
    const kb = await bridge.agentKbReset('qa');
    if (kb) { aiFillKb(kb); toast('标准问答已恢复默认'); }
  };
  $('aiResetRules').onclick = async () => {
    const kb = await bridge.agentKbReset('rules');
    if (kb) { aiFillKb(kb); toast('回复规则已恢复默认'); }
  };

  $('aiTest').onclick = async () => {
    const b = $('aiTest');
    b.disabled = true;
    b.textContent = '测试中…';
    const r = await bridge.agentTest();
    $('aiCfgTip').textContent = (r && r.msg) || '';
    toast((r && r.msg) || '测试结束');
    b.disabled = false;
    b.textContent = '测试连接';
  };

  $('aiSaveCfg').onclick = async () => {
    const patch = {
      apiKey: $('aiKey').value,
      baseUrl: $('aiBase').value,
      model: $('aiModel').value,
      maxChars: $('aiMaxChars').value,
      pollSec: $('aiPoll').value,
      delayMin: $('aiDelayMin').value,
      delayMax: $('aiDelayMax').value,
      maxPerHour: $('aiMaxPerHour').value,
      autoSend: AI.sendMode === 1,
      autoAgreeResume: AI.agreeMode === 1,
    };
    const st = await bridge.agentCfgSave(patch);
    if (st && st.ok !== false) {
      $('aiKey').value = '';
      aiSetState(st);
      aiFillCfg(st);
      $('aiCfgTip').textContent = '已保存';
      toast('设置已保存');
    } else {
      $('aiCfgTip').textContent = (st && st.msg) || '保存失败';
    }
    setTimeout(() => { const e = $('aiCfgTip'); if (e) e.textContent = ''; }, 4000);
  };

  $('aiSendMode').onclick = e => {
    const b = e.target.closest('button[data-send]');
    if (!b) return;
    AI.sendMode = Number(b.dataset.send);
    $('aiSendMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    bridge.agentCfgSave({ autoSend: AI.sendMode === 1 });
  };

  $('aiAgreeMode').onclick = e => {
    const b = e.target.closest('button[data-agree]');
    if (!b) return;
    AI.agreeMode = Number(b.dataset.agree);
    $('aiAgreeMode').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    bridge.agentCfgSave({ autoAgreeResume: AI.agreeMode === 1 });
  };

  $('aiStart').onclick = async () => {
    if (AI.busy) return;
    AI.busy = true;
    const b = $('aiStart');
    b.disabled = true;
    b.textContent = '启动中…';
    try {
      const r = await bridge.agentStart();
      toast((r && r.msg) || '已开启');
      if (!r || !r.ok) newLine(`[AI] 开启失败：${(r && r.msg) || '未知原因'}`);
    } finally {
      AI.busy = false;
      b.disabled = false;
      b.textContent = '开启值守';
      aiRefresh();
    }
  };

  $('aiStop').onclick = async () => {
    const r = await bridge.agentStop();
    toast((r && r.msg) || '已停止');
    aiRefresh();
  };

  $('aiScan').onclick = async () => {
    const b = $('aiScan');
    b.disabled = true;
    b.textContent = '扫描中…';
    const r = await bridge.agentScan();
    if (!r || !r.ok) toast((r && r.msg) || '扫描失败');
    else toast(`未读会话 ${(r.convs || []).length} 个`);
    b.disabled = false;
    b.textContent = '立即扫描一次';
    aiRefresh();
  };

  $('aiDiag').onclick = async () => {
    const b = $('aiDiag');
    b.disabled = true;
    b.textContent = '抓取中…';
    const r = await bridge.agentDiag();
    toast(r && r.ok ? '结构已保存，见智能体日志' : ((r && r.msg) || '抓取失败'));
    b.disabled = false;
    b.textContent = '抓取页面结构';
  };

  $('aiTestRun').onclick = async () => {
    const text = $('aiTestInput').value.trim();
    if (!text) { toast('先输入一条消息'); return; }
    const b = $('aiTestRun');
    b.disabled = true;
    b.textContent = '生成中…';
    $('aiTestTip').textContent = '';
    const r = await bridge.agentTry(text);
    const out = $('aiTestOut');
    if (r && r.ok) {
      out.textContent = r.reply;
      out.classList.remove('hide');
      $('aiTestTip').textContent = `${r.reply.length} 字`;
    } else {
      out.classList.add('hide');
      $('aiTestTip').textContent = (r && r.msg) || '生成失败';
    }
    b.disabled = false;
    b.textContent = '生成回复';
  };

  // ---------- 试运行 · 从消息列表勾选 HR，批量发送自定义消息 ----------
  const B = { convs: [], picked: new Set(), busy: false };
  const escAttr = s => esc(String(s == null ? '' : s)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pickedNames = () => B.convs.filter(c => B.picked.has(c.name)).map(c => c.name).slice(0, 10);
  const syncBatchTip = () => {
    $('aiBatchTip').textContent = B.convs.length
      ? `共 ${B.convs.length} 位 · 已选 ${pickedNames().length}/10`
      : '';
  };
  function renderBatch() {
    const box = $('aiBatchList');
    if (!B.convs.length) {
      box.innerHTML = '<div class="hint">点「获取消息列表」后，在这里勾选要发送的 HR</div>';
      syncBatchTip();
      return;
    }
    box.innerHTML = B.convs.map((c, i) => {
      const on = B.picked.has(c.name);
      const nm = esc(c.name);
      const av = c.avatar
        ? `<img src="${escAttr(c.avatar)}" alt="" referrerpolicy="no-referrer">`
        : `<span class="bn">${nm.slice(0, 1)}</span>`;
      return `<label class="aibatchitem${on ? ' on' : ''}" title="${escAttr(c.preview || c.name)}">`
        + `<input type="checkbox" data-i="${i}" ${on ? 'checked' : ''}>`
        + `${av}<span class="bn">${nm}</span></label>`;
    }).join('');
    syncBatchTip();
  }
  $('aiBatchList').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    const c = B.convs[Number(cb.dataset.i)];
    if (!c) return;
    if (cb.checked) {
      if (!B.picked.has(c.name) && B.picked.size >= 10) {
        cb.checked = false;
        toast('一次最多选 10 位 HR');
        return;
      }
      B.picked.add(c.name);
    } else B.picked.delete(c.name);
    cb.closest('.aibatchitem').classList.toggle('on', cb.checked);
    syncBatchTip();
  });
  $('aiBatchLoad').onclick = async () => {
    const b = $('aiBatchLoad');
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = '获取中…';
    try {
      const r = await bridge.agentBatchConvs();
      if (r && r.ok) {
        B.convs = r.convs || [];
        B.picked = new Set();
        renderBatch();
        toast(`已获取 ${B.convs.length} 位 HR，勾选头像后可发送`);
      } else {
        $('aiBatchTip').textContent = (r && r.msg) || '获取失败';
        toast((r && r.msg) || '获取失败');
      }
    } catch (e) { toast(e.message || '获取失败'); }
    finally { b.disabled = false; b.textContent = '获取消息列表'; }
  };
  $('aiBatchAll').onclick = () => {
    B.picked = new Set(B.convs.slice(0, 10).map(c => c.name));
    renderBatch();
  };
  $('aiBatchNone').onclick = () => { B.picked = new Set(); renderBatch(); };
  $('aiBatchSend').onclick = async () => {
    if (B.busy) return;
    const names = pickedNames();
    const message = $('aiBatchMsg').value.trim();
    if (!names.length) { toast('先勾选要发送的 HR'); return; }
    if (!message) { toast('先填写要发送的消息'); return; }
    const ok = window.confirm(
      `确认给以下 ${names.length} 位 HR 发送同一条消息？\n\n${names.join('、')}\n\n消息内容：\n${message}`
    );
    if (!ok) return;
    B.busy = true;
    const b = $('aiBatchSend');
    b.disabled = true;
    b.textContent = '发送中…';
    $('aiBatchStop').classList.remove('hide');
    const out = $('aiBatchOut');
    out.classList.remove('hide');
    out.textContent = `正在逐条发送（${names.length} 位），进度见下方智能体日志…`;
    try {
      const r = await bridge.agentBatchSend({
        names, message, confirm: true,
        delaySec: Math.max(3, Math.min(120, Number($('aiBatchDelay').value) || 10)),
      });
      if (r && r.ok) {
        out.textContent = `完成：成功 ${r.sent} / ${(r.results || []).length}${r.stopped ? '（已手动停止）' : ''}\n`
          + (r.results || []).map(x => `  ${x.ok ? '✓' : '×'} ${x.name}${x.why ? ' — ' + x.why : ''}`).join('\n');
        toast(`批量发送完成：成功 ${r.sent} 位`);
      } else {
        out.textContent = (r && r.msg) || '发送失败';
        toast((r && r.msg) || '发送失败');
      }
    } catch (e) { out.textContent = e.message || '发送失败'; }
    finally {
      B.busy = false;
      b.disabled = false;
      b.textContent = '确认发送';
      $('aiBatchStop').classList.add('hide');
    }
  };
  $('aiBatchStop').onclick = async () => {
    await bridge.agentBatchStop();
    toast('已请求停止：当前这条发完就停');
  };

  // 面板可见时轻量刷新值守状态
  setInterval(() => {
    if ($('paneAi').classList.contains('hide')) return;
    aiRefresh(false);
  }, 5000);
}

async function aiInit() {
  aiBind();
  aiInitFold();
  await aiRefresh(true);
}

// 每个卡片标题都可以点一下收起/展开，状态记在本地，下次打开还是收起的
function aiInitFold() {
  document.querySelectorAll('#paneAi .aicard').forEach(card => {
    const h = card.querySelector('h4');
    if (!h || h.querySelector('.fold')) return;
    const key = 'jd.fold.' + (h.textContent || '').trim().slice(0, 16);
    const btn = document.createElement('span');
    btn.className = 'fold';
    btn.textContent = '▾';
    h.appendChild(btn);
    if (localStorage.getItem(key) === '1') { card.classList.add('collapsed'); btn.textContent = '▸'; }
    h.addEventListener('click', ev => {
      if (ev.target.closest('button,input,a,.right')) return;
      const col = card.classList.toggle('collapsed');
      btn.textContent = col ? '▸' : '▾';
      try { localStorage.setItem(key, col ? '1' : '0'); } catch {}
    });
  });
}

async function init() {
  const st = await bridge.state();
  S.cfg = st.cfg;
  S.cities = st.cities || [];
  S.allCities = st.allCities || S.cities;
  S.bossType = ['all', 'fulltime', 'parttime', 'intern'].includes(st.cfg.bossType) ? st.cfg.bossType : 'intern';
  S.aiFilter = !!st.cfg.aiFilter;
  S.nkType = st.cfg.nkRecruitType || 'intern';
  S.nkEdu = st.cfg.nkEdu || '不限';
  S.zhType = ['all', 'fulltime', 'parttime', 'intern', 'campus'].includes(st.cfg.zhType) ? st.cfg.zhType : 'intern';
  S.zhEdu = ['不限', '大专', '本科'].includes(st.cfg.zhEdu) ? st.cfg.zhEdu : '不限';
  S.lpType = ['all', 'fulltime', 'parttime', 'intern'].includes(st.cfg.lpType) ? st.cfg.lpType : 'intern';
  S.lpEdu = ['不限', '大专', '本科'].includes(st.cfg.lpEdu) ? st.cfg.lpEdu : '不限';
  S.lpCities = Array.isArray(st.lpCities) ? st.lpCities : [];
  S.lpCity = S.lpCities.includes(st.cfg.lpCity) ? st.cfg.lpCity : '';
  S.lpFavs = Array.isArray(st.cfg.lpFavs) ? st.cfg.lpFavs.filter(n => S.lpCities.includes(n)) : [];
  // 选中的市也算一个常用项，免得列表里空着
  if (S.lpCity && !S.lpFavs.includes(S.lpCity)) S.lpFavs.unshift(S.lpCity);

  $('ver').textContent = 'v' + (st.version || '1.0');
  S.version = st.version || '';
  $('histTop').innerHTML = `<span class="hdot"></span>已投 BOSS <b>${st.counts.boss}</b> · 牛客 <b>${st.counts.nowcoder}</b> · 智联 <b>${st.counts.zhilian || 0}</b> · 猎聘 <b>${st.counts.liepin || 0}</b>`;

  // 常用城市（初始为空，选过才出现）
  S.favCities = Array.isArray(st.cfg.favCities) ? st.cfg.favCities : [];
  S.city = st.cfg.city || '';
  $('cityCur').textContent = S.city || '未选择';
  renderCityList('');

  renderTasks(st.tasks);
  setPlatform('boss');

  bind();
  bindKeywordMemory();   // 关键词边打边记，下次打开自动带出来
  aiInit().catch(() => {});

  // 主进程查到新版本 / 下载进度
  bridge.on('update:available', p => showUpdate(p));
  bridge.on('update:noclose', () => {
    if (!U.forced) return;
    toast('请先完成更新，更新后才能继续使用');
    const card = $('upCard');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  });
  bridge.on('update:progress', p => {
    if (U.stage !== 'downloading') return;
    const pct = p.total ? Math.min(99.5, (p.received / p.total) * 100) : (p.pct || 0);
    $('upBar').style.width = pct.toFixed(1) + '%';
    $('upPct').textContent = Math.round(pct) + '%';
    $('upSpd').textContent = [p.total ? fmtSize(p.total) : '', fmtSpeed(p.speed)]
      .filter(Boolean).join(' · ');
  });
}

function bind() {
  document.querySelectorAll('#platSeg button').forEach(b => {
    b.onclick = () => setPlatform(b.dataset.plat);
  });

  const ci = $('cityInput');
  ci.oninput = () => renderCityList(ci.value);
  ci.onkeydown = e => {
    if (e.key === 'Escape') { ci.value = ''; renderCityList(''); ci.blur(); return; }
    if (e.key !== 'Enter') return;
    const typed = ci.value.trim();
    if (!typed) return;
    const exact = S.allCities.find(c => c.name === typed);
    if (exact) { setCity(exact.name); return; }
    const first = $('cityList').querySelector('button[data-c]');
    if (first) setCity(first.dataset.c);
  };

  $('typeChips').onclick = e => {
    const b = e.target.closest('button[data-type]');
    if (!b || S.running) return;
    S.nkType = b.dataset.type;
    $('typeChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  };

  $('eduChips').onclick = e => {
    const b = e.target.closest('button[data-edu]');
    if (!b || S.running) return;
    S.nkEdu = b.dataset.edu;
    $('eduChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.nkEdu = S.nkEdu; bridge.saveCfg(S.cfg); }
  };

  $('zhTypeChips') && ($('zhTypeChips').onclick = e => {
    const b = e.target.closest('button[data-ztype]');
    if (!b || S.running) return;
    S.zhType = b.dataset.ztype;
    $('zhTypeChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.zhType = S.zhType; bridge.saveCfg(S.cfg); }
  });

  $('zhEduChips') && ($('zhEduChips').onclick = e => {
    const b = e.target.closest('button[data-edu]');
    if (!b || S.running) return;
    S.zhEdu = b.dataset.edu;
    $('zhEduChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.zhEdu = S.zhEdu; bridge.saveCfg(S.cfg); }
  });

  document.querySelectorAll('.aiChips').forEach(box => {
    box.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      S.aiFilter = b.dataset.ai === '1';
      document.querySelectorAll('.aiChips').forEach(x =>
        x.querySelectorAll('button').forEach(y => y.classList.toggle('on', y.dataset.ai === b.dataset.ai)));
      if (S.cfg) { S.cfg.aiFilter = S.aiFilter; bridge.saveCfg(S.cfg); }
      toast(S.aiFilter ? '已开启 AI 过滤：只投与关键词同行业的岗位（四个平台通用）' : '已关闭过滤：搜到什么投什么');
    };
  });

  $('bossTypeChips') && ($('bossTypeChips').onclick = e => {
    const b = e.target.closest('button[data-btype]');
    if (!b || S.running) return;
    S.bossType = b.dataset.btype;
    $('bossTypeChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.bossType = S.bossType; bridge.saveCfg(S.cfg); }
  });

  $('lpTypeChips') && ($('lpTypeChips').onclick = e => {
    const b = e.target.closest('button[data-lptype]');
    if (!b || S.running) return;
    S.lpType = b.dataset.lptype;
    $('lpTypeChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.lpType = S.lpType; bridge.saveCfg(S.cfg); }
  });

  $('lpEduChips') && ($('lpEduChips').onclick = e => {
    const b = e.target.closest('button[data-edu]');
    if (!b || S.running) return;
    S.lpEdu = b.dataset.edu;
    $('lpEduChips').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (S.cfg) { S.cfg.lpEdu = S.lpEdu; bridge.saveCfg(S.cfg); }
  });

  $('kwToggle').onclick = () => {
    const w = $('kwWrap');
    const hidden = w.classList.toggle('hide');
    $('kwToggle').textContent = hidden ? '展开' : '收起';
  };

  // 用知识库里的整份简历生成检索词，任何专业都走同一套提示词
  $('aiGenKw').onclick = async () => {
    const b = $('aiGenKw');
    if (b.disabled) return;
    const label = b.querySelector('.aigen-t') || b;
    b.disabled = true;
    label.textContent = '生成中…';
    $('aiKwTip').textContent = '正在读简历生成…';
    try {
      const r = await bridge.agentGenerateKeywords();
      if (r && r.ok && (r.text || (r.keywords || []).length)) {
        $('kwInput').value = r.text || (r.keywords || []).join(' ');
        const w = $('kwWrap');
        if (w.classList.contains('hide')) { w.classList.remove('hide'); $('kwToggle').textContent = '收起'; }
        $('aiKwTip').textContent = `已填入 ${(r.keywords || []).length} 个（${r.source === 'ai' ? 'AI 生成' : '本地档案'}${r.msg ? ' · ' + r.msg : ''}）`;
        if (S.cfg) { S.cfg.keywords = parseKeywords($('kwInput').value); bridge.saveCfg(S.cfg); }
        toast('已根据简历生成检索关键词');
      } else {
        $('aiKwTip').textContent = (r && r.msg) || '生成失败';
        toast((r && r.msg) || '生成失败');
      }
    } catch (e) {
      $('aiKwTip').textContent = e.message || '生成失败';
    } finally {
      b.disabled = false;
      label.textContent = 'AI 生成';
    }
  };

  $('btnStart').onclick = start;
  $('btnStop').onclick = () => {
    if (S.stopping) return;
    S.stopping = true;
    $('btnStop').disabled = true;
    $('btnStop').textContent = '停止中…';
    $('footMsg').textContent = '正在停止…';
    bridge.stop();
  };
  $('btnCloseBr').onclick = async () => {
    const b = $('btnCloseBr');
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = '正在关闭…';
    try {
      const r = await bridge.closeBrowser();
      if (r && r.ok) {
        b.classList.add('hide');
        $('footMsg').textContent = '浏览器已关闭';
        toast('投递浏览器已关闭');
      } else {
        toast((r && r.msg) || '没找到正在运行的投递浏览器');
      }
    } catch {
      toast('关闭失败，可以在任务栏里手动关掉');
    } finally {
      b.disabled = false;
      b.textContent = '关闭浏览器';
    }
  };
  $('btnDir').onclick = () => bridge.openDir();
  $('ver').onclick = checkUpdates;
  $('upNow').onclick = downloadAndInstall;
  $('upLater').onclick = () => hideUpdate();
  $('rvBack').onclick = hideTaskView;
  $('tvReport').onclick = toggleTaskReport;
  $('tvDel').onclick = async () => {
    const t = S.curTask;
    if (!t || t.legacy) return;
    const r = await bridge.deleteTask(t.id);
    if (!r || !r.ok) { toast('删除失败，可能文件被占用了'); return; }
    hideTaskView();
    toast('已删除这条任务记录');
  };

  $('btnTheme').onclick = () => {
    const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(cur === 'light' ? 'dark' : 'light');
  };

  document.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
      const t = b.dataset.tab;
      $('paneRep').classList.toggle('hide', t !== 'rep');
      $('paneAi').classList.toggle('hide', t !== 'ai');
      if (t === 'ai') aiRefresh(false);
    };
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !S.running) start();
  });
}

init().catch(e => {
  newLine('\x1b[31m界面初始化失败：' + (e && e.message) + '\x1b[0m');
});

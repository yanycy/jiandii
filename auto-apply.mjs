/**
 * 一键投递助手 (AutoApplyBot)
 * 支持 BOSS直聘 / 牛客网  自动采集 → 筛选 → 投递
 * 依赖：本机已登录的 Chrome（脚本自动拉起并连接 CDP）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { discover, connect, portOpen, sleep } from './lib/cdp.mjs';
// 智能体（知识库驱动的 AI 自动回复），作为独立模块挂在投递主链路旁边
import * as Agt from './lib/agent.mjs';

// ------------------------------------------------------------------ 路径
function resolveAppDir() {
  // 单文件 exe（Node SEA）里没有脚本路径，用可执行文件所在目录
  try {
    const sea = require('node:sea');
    if (sea && typeof sea.isSea === 'function' && sea.isSea()) return path.dirname(process.execPath);
  } catch {}
  if (process.pkg) return path.dirname(process.execPath);
  const argv1 = process.argv[1];
  if (argv1) return path.dirname(path.resolve(argv1));
  return path.dirname(process.execPath);
}
const APP_DIR = process.env.AAB_APP_DIR || resolveAppDir();
const DATA_DIR = process.env.AAB_DATA_DIR || path.join(APP_DIR, '简递数据');
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const HIST_FILE = path.join(DATA_DIR, 'applied_history.json');

// 命令行版也做一次旧目录迁移，历史投递记录不丢
// 注意：这里不能用 fs.cpSync —— 在 Windows 上复制到中文目录会直接崩进程
function copyDirSafe(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSafe(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

try {
  if (!process.env.AAB_DATA_DIR) {
    const legacy = path.join(APP_DIR, 'AutoApplyBot-data');
    if (!fs.existsSync(DATA_DIR) && fs.existsSync(legacy)) {
      copyDirSafe(legacy, DATA_DIR);
    }
  }
} catch {}

function ensureDir() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {} }

// ------------------------------------------------------------------ 配置
// 城市码表：来自 BOSS 官方接口，覆盖全国 373 个城市，支持任意城市
import { ALL_CITIES, HOT_CITIES, findCity } from './lib/cities.mjs';
// 智联招聘城市码（jl 参数），独立编码体系
import { zhCode } from './lib/zhilian-cities.mjs';
// 猎聘城市码（dq 参数），独立编码体系
import { LP_CITIES, LP_DQ, LP_PROV_DQ, LP_NATIONWIDE_DQ, lpDq } from './lib/liepin-cities.mjs';

// 常用城市（主要一线），命令行菜单按此顺序展示
const CITIES = HOT_CITIES;

const DEFAULT_CFG = {
  // 关键词默认留空：新装的用户不该看到别人预设的词，第一次开始前自己填
  // keywords 是四个平台共用的一份；下面四个是旧字段，仅做兼容（loadCfg 会同步成同一份）
  keywords: [],
  bossKeywords: [],
  bossType: 'intern',        // BOSS「求职类型」：all=不限 / fulltime=全职 / parttime=兼职 / intern=实习
  nkKeywords: [],
  nkRecruitType: 'intern',   // intern=实习 / campus=校招 / all=全部职位
  nkEdu: '不限',             // 牛客「学历要求」筛选：不限 / 专科 / 本科 / 硕士
  zhKeywords: [],
  zhType: 'intern',          // 对应智联「工作性质」：all=不限 / intern=实习 / fulltime=全职 / parttime=兼职
  zhEdu: '不限',             // 智联学历过滤：不限 / 大专 / 本科
  lpKeywords: [],
  lpType: 'intern',          // 猎聘「工作性质」：all=不限 / intern=实习 / fulltime=全职 / parttime=兼职
  lpEdu: '不限',             // 猎聘「学历上限」：不限 / 大专 / 本科（只投要求不高于此学历的岗）
  bossMax: 0,          // 0 = 不限，投到平台额度用完
  nkMax: 0,
  zhMax: 0,
  lpMax: 0,
  city: '',            // 上次选择的城市
  favCities: [],       // 常用城市（用户选过的）
  updateUrl: 'https://jiandidi.oss-cn-shenzhen.aliyuncs.com/latest.json',  // 更新清单（阿里云 OSS），可在 update-source.json 里覆盖
  delayMs: 900,
};

/** 关键词四个平台共用：统一到 cfg.keywords，并回写四个旧字段 */
function syncKeywords(cfg) {
  const list = v => (Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : []);
  let kw = list(cfg.keywords);
  if (!kw.length) {
    // 老配置里关键词是按平台存的，取第一个非空的迁过来
    kw = list(cfg.bossKeywords).length ? list(cfg.bossKeywords)
      : list(cfg.nkKeywords).length ? list(cfg.nkKeywords)
        : list(cfg.zhKeywords).length ? list(cfg.zhKeywords)
          : list(cfg.lpKeywords);
  }
  cfg.keywords = kw;
  cfg.bossKeywords = kw.slice();
  cfg.nkKeywords = kw.slice();
  cfg.zhKeywords = kw.slice();
  cfg.lpKeywords = kw.slice();
  return cfg;
}

function loadCfg() {
  ensureDir();
  try { return syncKeywords({ ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) }); }
  catch { return { ...DEFAULT_CFG }; }
}
function saveCfg(c) { ensureDir(); fs.writeFileSync(CFG_FILE, JSON.stringify(syncKeywords(c), null, 2)); }
function loadHist() { try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { return {}; } }
function saveHist(h) { ensureDir(); fs.writeFileSync(HIST_FILE, JSON.stringify(h, null, 2)); }

// ------------------------------------------------------------------ 终端
const C = {
  r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[36m${s}\x1b[0m`,
  d: s => `\x1b[90m${s}\x1b[0m`, B: s => `\x1b[1m${s}\x1b[0m`,
};
// 图形界面模式：把日志重定向到回调，而不是标准输出
let LOG_SINK = null;
export function setLogSink(fn) { LOG_SINK = typeof fn === 'function' ? fn : null; }
export function hasLogSink() { return !!LOG_SINK; }
const log = (...a) => {
  if (LOG_SINK) { LOG_SINK(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ') + '\n'); return; }
  console.log(...a);
};
// 不换行输出：\u0001 前缀表示「追加到上一行末尾」
const logPart = s => {
  if (LOG_SINK) { LOG_SINK('\u0001' + s); return; }
  process.stdout.write(s);
};
// 手动停止信号
let STOP_FLAG = false;
let ABORTED = false;   // 这一轮是否因为连续失败/额度用尽被程序自己中断（不是用户点的停止）
export function requestStop() { STOP_FLAG = true; }
export function resetStop() { STOP_FLAG = false; }
export function forceCloseCdp() {
  try { if (GLOBAL_CDP) GLOBAL_CDP.close(); } catch {}
  GLOBAL_CDP = null;
}

// 关掉「投递专用」的那个浏览器窗口。
// 只认命令行里带专用 profile 目录的进程 —— 用户自己平时用的浏览器不会被误关。
// 优先让浏览器自己退出（CDP Browser.close，不会留下崩溃恢复提示），连不上再按进程杀。
export async function closeBrowser() {
  const profile = chromeProfileDir();
  let closed = 0;

  // ① 先断开我们自己的连接，否则浏览器可能因为仍有调试会话而延迟退出
  try { forceCloseCdp(); } catch {}

  // ② CDP：让浏览器自己关
  try {
    const d = await discover();
    if (d.ok) {
      const cdp = new CDP(d.wsUrl);
      await cdp.connect(6000);
      await cdp.send('Browser.close', {}, null, 4000).catch(() => {});
      try { cdp.close(); } catch {}
      for (let i = 0; i < 10; i++) {
        await sleep(350);
        if (!(await portOpen(d.port))) { closed++; break; }
      }
    }
  } catch {}

  // ③ 兜底：按专用 profile 命令精确找进程（pid 文件里的也一并算上）
  const pids = new Set();
  try {
    const pf = path.join(DATA_DIR, 'browser.pid');
    if (fs.existsSync(pf)) {
      const n = Number(String(fs.readFileSync(pf, 'utf8')).trim());
      if (n > 0) pids.add(n);
    }
  } catch {}
  try {
    const esc = profile.replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -like '*${esc}*' } | ForEach-Object { $_.ProcessId }`;
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 15000 });
    for (const s of String(out).split(/\s+/)) {
      const n = Number(s);
      if (n > 0) pids.add(n);
    }
  } catch { /* PowerShell 不可用就只靠 pid 文件 */ }

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  if (pids.size) {
    await sleep(1000);
    // 还没退就强杀（只针对确认是专用窗口的进程）
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    closed += pids.size;
  }
  try { fs.unlinkSync(path.join(DATA_DIR, 'browser.pid')); } catch {}

  if (!closed) return { ok: false, msg: '没有找到正在运行的投递浏览器（可能已经关掉了）' };
  return { ok: true, count: closed };
}
const ok = m => log(C.g('  ✔ ') + m);
const warn = m => log(C.y('  ! ') + m);
const err = m => log(C.r('  ✘ ') + m);
const info = m => log(C.d('    ' + m));

let RL = null;
let STDIN_GONE = false;
const LINE_Q = [];
const WAITERS = [];
function getRL() {
  if (!RL) {
    RL = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    RL.on('line', l => {
      const w = WAITERS.shift();
      if (w) w(l.trim()); else LINE_Q.push(l.trim());
    });
    RL.on('close', () => {
      STDIN_GONE = true;
      while (WAITERS.length) WAITERS.shift()('');
    });
  }
  return RL;
}
function ask(q) {
  getRL();
  process.stdout.write(q);
  return new Promise((res, rej) => {
    if (LINE_Q.length) { res(LINE_Q.shift()); return; }
    if (STDIN_GONE) { rej(new Error('__EOF__')); return; }
    WAITERS.push(res);
  });
}
const askNum = async (q, def) => {
  const a = await ask(q);
  if (!a) return def;
  const n = Number(a);
  return Number.isFinite(n) ? n : def;
};
const pause = async (m = '按回车继续') => {
  if (LOG_SINK) { log(C.d(`  ${m}（图形界面模式下自动继续）`)); return; }
  await ask(C.d(`\n${m}...`));
};

// ------------------------------------------------------------------ 浏览器
// 只认 Chromium 内核（调试协议才通用）：Chrome 优先，没装就用 Windows 自带的 Edge。
// 不写死 C 盘：很多人把浏览器装在 D 盘，这里把常见盘符都扫一遍。
function browserCandidates() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    'C:\\Program Files', 'C:\\Program Files (x86)',
  ];
  for (const d of ['D', 'E', 'F', 'G']) {
    roots.push(`${d}:\\Program Files`, `${d}:\\Program Files (x86)`);
  }
  const uniq = [...new Set(roots.filter(Boolean))];

  const list = [];
  // ① Chrome（最常用，登录状态也多半在这里）
  for (const r of uniq) list.push({ name: 'Chrome', exe: path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  list.push({ name: 'Chrome', exe: path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe') });
  // ② Edge（Win10/11 自带）。新版 Edge 的 exe 有两种文件名，都要试
  for (const r of uniq) {
    list.push({ name: 'Edge', exe: path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
    list.push({ name: 'Edge', exe: path.join(r, 'Microsoft', 'Edge', 'Application', 'Microsoft Edge.exe') });
  }
  list.push({ name: 'Edge', exe: path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe') });
  list.push({ name: 'Edge', exe: path.join(la, 'Microsoft', 'Edge', 'Application', 'Microsoft Edge.exe') });
  return list;
}

// 极端情况（系统被精简到没有 Chrome / Edge）：允许手动指定浏览器路径。
// 支持环境变量 AAB_BROWSER，或数据目录下的 browser.txt（只写一行 exe 完整路径）
function manualBrowser() {
  let v = String(process.env.AAB_BROWSER || '').trim();
  if (!v) {
    try { v = fs.readFileSync(path.join(DATA_DIR, 'browser.txt'), 'utf8').trim(); } catch {}
  }
  v = v.replace(/^["'\s]+|["'\s]+$/g, '');
  if (!v) return null;
  try {
    if (!fs.existsSync(v)) return null;
    return { name: /edge/i.test(v) ? 'Edge' : 'Chrome', exe: v, manual: true };
  } catch { return null; }
}

// 第一次扫到浏览器后就「打标签」记下来，之后直接读缓存，不再重复扫盘。
// 缓存只在路径真的失效时（用户卸载/挪走了浏览器）才丢弃并重扫一次。
const BROWSER_CACHE_FILE = path.join(DATA_DIR, 'browser-cache.json');
let _browserMemo;          // undefined = 本进程还没探测过；null = 确认找不到

function readBrowserCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(BROWSER_CACHE_FILE, 'utf8'));
    const exe = String(raw && raw.exe || '').trim();
    if (!exe) return null;
    if (!fs.existsSync(exe)) {          // 浏览器被卸载或换了位置：标签作废
      try { fs.unlinkSync(BROWSER_CACHE_FILE); } catch {}
      return null;
    }
    return { name: raw.name || (/edge/i.test(exe) ? 'Edge' : 'Chrome'), exe, cached: true, savedAt: raw.savedAt || '' };
  } catch { return null; }
}

function writeBrowserCache(b) {
  try {
    if (!b || !b.exe) return;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const old = (() => { try { return JSON.parse(fs.readFileSync(BROWSER_CACHE_FILE, 'utf8')); } catch { return null; } })();
    if (old && old.exe === b.exe && old.name === b.name) return;   // 没变化就不写，少一次磁盘操作
    const d = new Date(), p2 = n => String(n).padStart(2, '0');   // 本地时间，方便用户自己看
    fs.writeFileSync(BROWSER_CACHE_FILE, JSON.stringify({
      name: b.name, exe: b.exe,
      savedAt: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`,
      note: '首次自动检测的结果，删掉本文件可让程序重新检测',
    }, null, 2), 'utf8');
  } catch (e) { /* 写不进去也不影响这次使用，只在 stderr 留个痕迹 */
    try { console.error('[browser-cache] 写入失败:', e && e.message); } catch {}
  }
}

// force=true 时忽略缓存/本进程记忆，强制重新扫描（用于「重新检测」场景）
function findBrowser(force = false) {
  if (!force && _browserMemo !== undefined) return _browserMemo;   // 本进程只探测一次

  const m = manualBrowser();
  if (m) { _browserMemo = m; return m; }

  if (!force) {
    const c = readBrowserCache();
    if (c) { _browserMemo = c; return c; }
  }

  for (const b of browserCandidates()) {
    try {
      if (fs.existsSync(b.exe)) {
        writeBrowserCache(b);
        _browserMemo = b;
        return b;
      }
    } catch {}
  }
  _browserMemo = null;
  return null;
}

function findChrome() { const b = findBrowser(); return b ? b.exe : undefined; }

// 浏览器是否已经在跑（Chrome 和 Edge 都算）
function chromeRunning() {
  for (const img of ['chrome.exe', 'msedge.exe', 'Microsoft Edge.exe']) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${img}" /NH`, { encoding: 'utf8', timeout: 8000 });
      if (out.toLowerCase().includes(img.toLowerCase())) return true;
    } catch {}
  }
  return false;
}

// 各平台首页（浏览器窗口打开的落地页，跟随当前平台，不要写死 BOSS）
const HOME_URL = {
  boss: 'https://www.zhipin.com/',
  nk: 'https://www.nowcoder.com/jobs/intern/center',
  zh: 'https://www.zhaopin.com/jobs/',
  lp: 'https://www.liepin.com/zhaopin/',
};

function chromeProfileDir() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(la, 'AutoApplyBot', 'chrome-profile');
}

// 首次使用：把平时浏览器里的登录 Cookies 复制到专用目录，
// 这样不用重新登录 BOSS / 牛客 / 智联，也完全不碰你原来的浏览器配置
function seedProfileIfNew(profile, prefer = 'Chrome') {
  const dstCookies = path.join(profile, 'Default', 'Network', 'Cookies');
  try { if (fs.existsSync(dstCookies)) return 'exists'; } catch {}
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const chromeUD = path.join(la, 'Google', 'Chrome', 'User Data');
  const edgeUD = path.join(la, 'Microsoft', 'Edge', 'User Data');
  // 用哪个浏览器，就先从它自己的配置里取登录态
  const srcs = prefer === 'Edge' ? [edgeUD, chromeUD] : [chromeUD, edgeUD];
  for (const src of srcs) {
    const srcCookies = path.join(src, 'Default', 'Network', 'Cookies');
    if (!fs.existsSync(srcCookies)) continue;
    try {
      fs.mkdirSync(path.join(profile, 'Default', 'Network'), { recursive: true });
      // Local State 里存着解密 Cookie 的密钥，必须一起复制（同一 Windows 账号才能解）
      const ls = path.join(src, 'Local State');
      if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(profile, 'Local State'));
      fs.copyFileSync(srcCookies, dstCookies);
      return 'seeded';
    } catch { /* 占用或被锁就跳过，用户在专用窗口登录一次即可 */ }
  }
  return 'fresh';
}

// 找一个能用的调试端口：9222 常常被别的工具占着（占了 Chrome 就不开调试口）
async function pickDebugPort() {
  const forced = Number(process.env.AAB_CDP_PORT || 0);
  if (forced > 0) return forced;
  for (const p of [9222, 9223, 9224, 9333, 9444]) {
    if (!(await portOpen(p))) return p;
  }
  return 9225;
}

async function startChrome(platform = 'boss') {
  const br = findBrowser();
  if (!br) {
    return {
      ok: false,
      msg: '没找到可用的浏览器（Chrome 或 Edge 都没有）',
      noBrowser: true,
    };
  }
  const exe = br.exe;
  const profile = chromeProfileDir();
  try { fs.mkdirSync(profile, { recursive: true }); } catch {}
  const seed = seedProfileIfNew(profile, br.name);
  const port = await pickDebugPort();
  // Chrome / Edge 136+ 起：用「默认用户目录 + --remote-debugging-port」会被直接拒绝
  // （端口不开、还会反复弹「允许远程调试」框）。必须给一个独立的用户目录。
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    HOME_URL[platform] || HOME_URL.boss,
  ];
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    // 记下 pid：任务结束后「关闭浏览器」靠它精确找到这个窗口，不会误伤用户自己开的浏览器
    try { fs.writeFileSync(path.join(DATA_DIR, 'browser.pid'), String(child.pid), 'utf8'); } catch {}
    return { ok: true, seed, port, browser: br.name, exe, manual: !!br.manual, cached: !!br.cached };
  } catch (e) { return { ok: false, msg: `${br.name} 启动失败: ` + e.message, browser: br.name }; }
}

async function ensureChrome(platform = 'boss') {
  log(C.d('  · 正在检测浏览器调试通道...'));
  // ① 先看有没有已经开着的浏览器调试通道 —— 有就直接用，不再新开窗口
  let d = await discover();
  if (d.ok) {
    const alive = chromeRunning();
    ok(`检测到已打开的浏览器，直接复用（端口 ${d.port}${alive ? '' : '，进程刚启动'}）`);
    return d;
  }

  // ② 浏览器在跑但没开调试端口：Chrome / Edge 都不支持事后接管，只能另开一个投递专用窗口
  if (chromeRunning()) {
    warn('检测到你正在用浏览器（Chrome 或 Edge），但它没有开启调试端口，无法直接接管');
    info('程序会另开一个「投递专用」窗口（和你原来的浏览器互不影响，登录一次即可）');
  } else {
    log(C.d('  · 没有检测到正在运行的浏览器，正在启动...'));
  }

  const s = await startChrome(platform);
  if (!s.ok) {
    err(s.msg);
    if (s.noBrowser) {
      log('');
      log(C.y('  程序需要一个 Chromium 内核的浏览器才能投递，装好其中一个就行：'));
      log(C.d('   · Chrome（推荐）https://www.google.cn/chrome/'));
      log(C.d('   · Edge           https://www.microsoft.com/edge'));
      log(C.d('  Windows 10/11 一般自带 Edge，如果你这台是精简版系统可能被删掉了，'));
      log(C.d('  装完任意一个回到本程序重新点「开始投递」即可。'));
      log(C.d(`  如果浏览器装在别处（绿色版/便携版），把 exe 完整路径写进：${path.join(DATA_DIR, 'browser.txt')}`));
    }
    return { ok: false, noBrowser: !!s.noBrowser };
  }
  log(C.d(`  · 使用 ${s.browser}${s.manual ? '（手动指定）' : s.cached ? '（上次检测已记住）' : '（首次检测）'}：${s.exe}`));
  if (s.seed === 'seeded') {
    log(C.d('    · 已尝试沿用你平时浏览器里的登录状态（若显示未登录，在该窗口登录一次即可）'));
  } else if (s.seed === 'fresh') {
    log(C.y('    ⚠ 首次使用：请在弹出的窗口里登录（BOSS / 牛客 / 智联 / 猎聘，只需一次）'));
    log(C.d('      登录状态保存在专用目录，下次自动复用，不会影响你平时的浏览器'));
  }

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    d = await discover();
    if (d.ok) { ok(`${s.browser} 已就绪（端口 ${d.port}）`); return d; }
    if (i === 4) log(C.d('    ...仍在启动，继续等待'));
    if (i > 4 && i % 5 === 4) log(C.d(`    ...等待中 ${i + 1}s`));
  }
  err('浏览器调试通道没有开起来');
  log('');
  log('  可以这样排查：');
  log(C.d('   1) 若刚才的浏览器窗口已经开着，先把它全部关掉再点开始（一个窗口只认第一次启动参数）'));
  log(C.d('   2) 安全软件（360/火绒等）可能拦截了调试端口，临时放行后再试'));
  log(C.d('   3) 手动启动一次，成功后重试本程序：'));
  log(C.d(`      "${s.exe}" --remote-debugging-port=9222 --user-data-dir="${chromeProfileDir()}"`));
  return { ok: false };
}

// 全局复用一条 CDP 连接：每次新建连接都会让 Chrome 弹一次「允许远程调试」授权框
let GLOBAL_CDP = null;
async function getCdp() {
  if (GLOBAL_CDP) {
    try {
      await GLOBAL_CDP.send('Browser.getVersion', {}, null, 8000);
      return GLOBAL_CDP;
    } catch {
      try { GLOBAL_CDP.close(); } catch {}
      GLOBAL_CDP = null;
    }
  }
  log(C.d('  · 正在连接 Chrome 调试接口...'));
  const r = await connect({ timeout: 90000, tries: 1 });
  if (!r.ok) {
    err('CDP 连接失败：' + ((r.err && r.err.message) || '未知错误'));
    log('');
    log('  可能原因：');
    log(C.d('   1) 浏览器窗口被关掉了'));
    log(C.d('   2) 调试端口被安全软件拦截'));
    log(C.d('   3) 有别的程序占用了 9222 端口'));
    throw new Error('CDP 连接失败');
  }
  GLOBAL_CDP = r.cdp;
  ok('已连接浏览器（复用同一条连接，不会反复弹窗）');
  return GLOBAL_CDP;
}

// ------------------------------------------------------------------ 登录检测
// 判断页面是否处于「未登录」状态：出现登录/扫码弹窗，或顶部只有「登录/注册」入口且没有头像
// 抽成常量：除了当前工作页，还要拿去逐个检查别的标签页
const LOGIN_JS = `(()=>{
      // ① 整页被跳转到登录页（BOSS 登录失效最常见的表现：passport.zhipin.com / /web/user/）
      const u=location.href||'';
      if(/passport\\.(zhipin|zhaopin)\\.com|login\\.zhaopin\\.com|\\/web\\/user\\/|nowcoder\\.com\\/(login|signin|register)|zhaopin\\.com\\/login|liepin\\.com\\/(user\\/)?login|wow\\.liepin\\.com\\/t\\d+|\\/signin|\\/account\\/login|\\/web\\/login|\\/user\\/login/i.test(u)) return true;
      // ② 页面本身就是登录表单
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
        return r.width>4 && r.height>4 && s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity)!==0; };
      const tel=[...document.querySelectorAll('input[type="tel"],input[placeholder*="手机号"],input[placeholder*="验证码"]')].filter(vis);
      if(tel.length && /登录|注册|验证码/.test((document.body.innerText||'').slice(0,3000))) return true;
      // ③ 蒙层里的登录弹窗（三个平台的类名各不相同，统一按可见文案判断）
      const boxes=[...document.querySelectorAll('.a-modal,.a-dialog,.dialog-wrap,.dialog-container,[class*="login"],[class*="Login"],[class*="signin"],[class*="SignIn"],[class*="nc-modal"],[class*="el-dialog"]')].filter(vis);
      for(const b of boxes){
        const tx=(b.innerText||'').replace(/\\s+/g,' ');
        if(/登录/.test(tx) && /扫码|验证码|手机号|微信|密码/.test(tx)) return true;
      }
      // ④ 全靠文案兜底：出现「扫码登录 / 密码登录 / 验证码登录」就一定停在登录界面上
      const head=(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,2500);
      if(/扫码登录|密码登录|验证码登录|手机号登录|账号登录/.test(head)) return true;
      // ⑤ 顶栏只有「登录/注册」而没有用户信息
      const entry=[...document.querySelectorAll('a,button,span,div')]
        .filter(e=>vis(e) && /^(登录|登录\\/注册|立即登录|去登录)$/.test((e.innerText||'').trim()));
      const who=!!document.querySelector('.nav-figure,.user-avatar,.avatar,[class*="user-info"],[class*="userInfo"],[class*="user-name"],[class*="userName"]');
      return entry.length>0 && !who;
    })()`;

async function loginPending(cdp) {
  try {
    return !!(await cdp.eval(LOGIN_JS));
  } catch { return false; }
}

// 风控栏（滑块/安全校验）：需要人工滑一下，不算登录问题，但同样要停下等
async function captchaPending(cdp) {
  try {
    return !!(await cdp.eval(`(()=>{
      const u=location.href||'';
      if(/security-check|verify-slider|captcha|verify\\.html|\\/zpgeek\\/security/i.test(u)) return true;
      const t=(document.body.innerText||'').slice(0,1200);
      return /请完成安全验证|拖动滑块|按住左边滑块/.test(t);
    })()`));
  } catch { return false; }
}

// 判断「别的标签页」是否已经登录：只用 DOM 文本，不依赖布局
// （后台标签页可能不计算布局，用 getBoundingClientRect 会误判；textContent 不受影响）
const OTHER_TAB_JS = `(()=>{
      const u=location.href||'';
      if(/passport\\.(zhipin|zhaopin)\\.com|wow\\.liepin\\.com|login\\.|\\/login|\\/signin|\\/register/i.test(u)) return 'login-page';
      const t=(document.body.textContent||'').replace(/\\s+/g,' ');
      if(!t || t.length<20) return 'blank';
      if(/登录\\/注册|立即登录|请先登录|登录后查看|登录查看更多|去登录/.test(t)) return 'need-login';
      if(/退出登录|我的简历|投递记录|我的收藏/.test(t)) return 'logged-in';
      return 'unknown';
    })()`;

// 平台 → 所属域名，用来判断「别的标签页是不是同一家招聘站」
const SITE_RE = [
  [/智联/, /zhaopin\.com/i],
  [/BOSS|直聘/i, /zhipin\.com/i],
  [/牛客/, /nowcoder\.com/i],
  [/猎聘/, /liepin\.com/i],
];
function siteReOf(platform) {
  for (const [k, re] of SITE_RE) if (k.test(platform)) return re;
  return null;
}

// 用户经常在新开的标签页里完成登录，工作页收不到任何通知。
// 这里去其它同站标签页上看一眼：只要有一个明确「已登录」，就说明登录已经成功了。
async function loggedInElsewhere(cdp, platform) {
  const re = siteReOf(platform);
  if (!re) return false;
  try {
    const pages = await cdp.listPages();
    for (const p of pages) {
      if (p.targetId === cdp.targetId) continue;
      if (!re.test(p.url || '')) continue;
      if ((await cdp.evalIn(p.targetId, OTHER_TAB_JS)) === 'logged-in') return true;
    }
  } catch {}
  return false;
}

// 刷新工作页，把「别的标签页里已经登好」的登录状态同步过来
async function resyncWorkPage(cdp) {
  let url = cdp.lastWorkUrl;
  if (!url || /passport\.|login\.|\/login|\/signin/i.test(url)) {
    // 还没走过 goto（或上次停在登录页）：退而用当前页地址
    const cur = await cdp.eval('location.href').catch(() => '');
    if (!cur || /passport\.|login\.|\/login|\/signin/i.test(cur)) return false;
    url = cur;
  }
  try { await cdp.goto(url, 3000); return true; } catch { return false; }
}

// 工作页上是否正摆着登录表单（你正在输手机号 / 扫码）。这时候不能刷新，否则打断你登录
async function loginFormVisible(cdp) {
  try {
    return !!(await cdp.eval(`(()=>{
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
        return r.width>4 && r.height>4 && s.visibility!=='hidden' && s.display!=='none' && Number(s.opacity)!==0; };
      return [...document.querySelectorAll('input[type="tel"],input[placeholder*="手机号"],input[placeholder*="验证码"]')].some(vis);
    })()`));
  } catch { return false; }
}

// 尝试把「别处已登录」的状态同步到工作页。返回 resynced / user-logging / no-signal / failed
async function tryResync(cdp, platform) {
  if (await loginFormVisible(cdp)) return 'user-logging';       // 你正在这个窗口登录，别打扰
  if (!(await loggedInElsewhere(cdp, platform))) return 'no-signal';
  return (await resyncWorkPage(cdp)) ? 'resynced' : 'failed';
}

// 卡在登录界面时：停下等用户登录，持续监听，登录完成后自动继续
async function waitForLogin(cdp, platform, maxMs = 10 * 60 * 1000) {
  // 先排除假警报：当前工作页没登录，但你在另一个标签页已经登好了
  if (await loggedInElsewhere(cdp, platform)) {
    info(`检测到你在另一个标签页已登录「${platform}」，正在同步当前页面…`);
    const st = await tryResync(cdp, platform);
    if (st === 'resynced' && !(await loginPending(cdp))) {
      ok(`${platform} 已就绪，继续投递`);
      return true;
    }
  }
  log('');
  err(`检测到「${platform}」登录状态已失效（或还没登录）`);
  log(C.y('   ▶ 请在弹出的浏览器窗口里完成登录（扫码 / 手机号都行）'));
  log(C.d('     登录成功后程序会自动继续，不需要回来点任何按钮'));
  const t0 = Date.now();
  let lastLog = 0, saidCaptcha = false, resynced = 0;
  while (Date.now() - t0 < maxMs) {
    if (STOP_FLAG) { warn('已手动停止，本轮结束'); return false; }
    await sleep(2500);
    const cap = await captchaPending(cdp);
    if (cap && !saidCaptcha) {
      saidCaptcha = true;
      warn('页面出现安全验证（滑块），请在浏览器窗口里拖动滑块完成，完成后自动继续');
    }
    if (!cap && !(await loginPending(cdp))) {
      await sleep(1500);
      if (!(await captchaPending(cdp)) && !(await loginPending(cdp))) {
        ok(`${platform} 登录成功，继续投递`);
        await sleep(1200);
        return true;
      }
    }
    // 当前工作页还是未登录，但你在别的标签页里已经登好了 —— 把工作页刷新一次同步状态
    if (!cap && resynced < 5) {
      const st = await tryResync(cdp, platform);
      if (st === 'resynced') {
        resynced++;
        ok(`检测到你已在另一个标签页登录「${platform}」，已刷新当前页面同步状态`);
        continue;
      }
      if (st === 'failed') resynced = 5;   // 刷新不了就别反复试
    }
    const s = Math.floor((Date.now() - t0) / 1000);
    if (s - lastLog >= 30) { lastLog = s; log(C.d(`     仍在等待登录…（已等 ${s}s，最长 ${Math.round(maxMs / 60000)} 分钟）`)); }
  }
  err('等待登录超时，本轮已结束（登录后重新点开始即可）');
  return false;
}

// 统一的「被登录/风控拦住」守卫：没被拦返回 true；被拦就停下等用户处理完再继续
async function guardBlocked(cdp, platform) {
  if (!(await loginPending(cdp)) && !(await captchaPending(cdp))) return true;
  return await waitForLogin(cdp, platform);
}

// 采集量够了就停：用户设了投 50 个，没必要把 18 个关键词全翻一遍（过滤会杀掉一部分，留 3 倍余量）
function enoughCollected(pool, need, ratio = 3) {
  if (!(need > 0)) return false;
  // 只算本轮新采到的：续投时代入的上次岗位不能算「已够」，否则会直接跳过采集
  let fresh = 0;
  for (const x of pool.values()) if (!x._seed) fresh++;
  return fresh >= need * ratio;
}

// 续投时本轮新采到的岗位排在前面，上次遗留的放后面（它们可能已过期，先试新的）
function freshFirst(arr) {
  return arr.slice().sort((a, b) => (a && a._seed ? 1 : 0) - (b && b._seed ? 1 : 0));
}

// ------------------------------------------------------------------ 报告
function ts() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
function writeReport(platform, cityName, sent, skipped, failed, totalScanned) {
  ensureDir();
  const f = path.join(DATA_DIR, `投递报告_${platform}${cityName ? '_' + cityName : ''}_${ts()}.md`);
  const L = [];
  L.push(`# ${platform} 自动投递报告\n`);
  L.push(`- 时间：${new Date().toLocaleString('zh-CN')}`);
  if (cityName) L.push(`- 城市：${cityName}`);
  L.push(`- 扫描岗位：${totalScanned}`);
  L.push(`- 投递成功：**${sent.length}**`);
  L.push(`- 已投过跳过：${skipped}`);
  L.push(`- 失败：${failed.length}\n`);
  if (sent.length) {
    L.push('## 成功明细\n');
    L.push('| # | 公司 | 岗位 | 薪资 | 城市 |');
    L.push('|---|---|---|---|---|');
    sent.forEach((x, i) => L.push(`| ${i + 1} | ${x.co || '—'} | ${x.title} | ${x.sal || '面议'} | ${x.city || '—'} |`));
  }
  if (failed.length) {
    L.push('\n## 失败明细\n');
    failed.forEach(x => L.push(`- ${x.title}｜${x.co || '—'}｜${x.reason || ''}`));
  }
  fs.writeFileSync(f, L.join('\n'), 'utf8');
  return f;
}

// ------------------------------------------------------------------ 任务快照（历史任务 / 断点续投）
// 每轮任务从开始到结束都写一份快照到 简递数据/tasks/*.json：
//   条件（平台/城市/关键词/筛选/目标数）+ 采集到的岗位 + 已投/失败明细 + 状态
// 中途停止时这份文件就是「断点」，重新开始任务时把 pool 灌回去接着投。
const TASK_DIR = path.join(DATA_DIR, 'tasks');
const TASK_POOL_MAX = 800;        // 单任务最多留 800 条采集结果，防止文件无限膨胀
const TASK_KEEP_MAX = 60;         // 最多保留 60 条历史任务
let CUR_TASK = null;
let lastFlush = 0;

function taskStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 只留续投和展示真正需要的字段：字段名跟着各平台采集结构走
function trimItem(x) {
  const s = (v, n) => String(v == null ? '' : v).slice(0, n);
  const o = {
    id: s(x.id, 40), title: s(x.title, 60), co: s(x.co, 40), sal: s(x.sal, 20),
    city: s(x.city, 20), kw: s(x.kw, 40),
  };
  if (x.edu != null) o.edu = s(x.edu, 20);
  if (x.wt != null) o.wt = s(x.wt, 20);
  if (x.wtc != null) o.wtc = s(x.wtc, 8);
  if (x.exp != null) o.exp = s(x.exp, 20);
  if (x.age != null) o.age = s(x.age, 20);
  if (x.desc != null) o.desc = s(x.desc, 160);
  if (x.area != null) o.area = s(x.area, 20);
  if (x.applied != null) o.applied = !!x.applied;
  if (x.isIntern != null) o.isIntern = !!x.isIntern;
  if (x.score != null) o.score = Number(x.score) || 0;
  return o;
}

function taskWrite(force) {
  if (!CUR_TASK) return;
  const now = Date.now();
  if (!force && now - lastFlush < 800) return;   // 投递循环里每投一个都会调，节流一下
  lastFlush = now;
  try {
    fs.mkdirSync(TASK_DIR, { recursive: true });
    CUR_TASK.updatedAt = now;
    fs.writeFileSync(path.join(TASK_DIR, CUR_TASK.id + '.json'), JSON.stringify(CUR_TASK), 'utf8');
  } catch {}
}

export function taskBegin(meta) {
  const m = meta || {};
  // 同一秒内可能连开两个任务（刚停止就续投），后缀加随机串保证 id 不撞
  let id = `${m.platform || 'task'}-${taskStamp()}`;
  try {
    if (fs.existsSync(path.join(TASK_DIR, id + '.json'))) {
      id += '-' + Math.random().toString(36).slice(2, 6);
    }
  } catch {}
  CUR_TASK = {
    v: 1,
    id,
    platform: m.platform || '',
    platformName: m.platformName || '',
    city: m.city || '',
    type: m.type || '',
    typeLabel: m.typeLabel || '',
    edu: m.edu || '',
    keywords: Array.isArray(m.keywords) ? m.keywords.slice(0, 40) : [],
    max: Number(m.max) || 0,
    resumedFrom: m.resumedFrom || '',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stats: { collected: 0, sent: 0, failed: 0, skipped: 0 },
    sentItems: [],
    failedItems: [],
    pool: [],
    reportFile: '',
  };
  taskWrite(true);
  lastFlush = 0;   // 紧接着的 taskPool(seed) 要立刻落盘，别被节流吞掉
  return id;
}

export function taskCurrentId() { return CUR_TASK ? CUR_TASK.id : ''; }

// 采集阶段随时把当前池子存下来（停止时就能拿到已采到的部分）
export function taskPool(pool) {
  if (!CUR_TASK || !pool) return;
  const all = typeof pool.values === 'function' ? [...pool.values()] : (Array.isArray(pool) ? pool : []);
  CUR_TASK.pool = all.slice(0, TASK_POOL_MAX).map(trimItem);
  CUR_TASK.stats.collected = all.length;
  taskWrite();
}

export function taskSent(job, extra) {
  if (!CUR_TASK || !job) return;
  CUR_TASK.sentItems.push(trimItem(job));
  if (extra && extra.skipped != null) CUR_TASK.stats.skipped = Number(extra.skipped) || 0;
  CUR_TASK.stats.sent = CUR_TASK.sentItems.length;
  taskWrite();
}

export function taskFailed(job, reason) {
  if (!CUR_TASK || !job) return;
  CUR_TASK.failedItems.push({ ...trimItem(job), reason: String(reason || '').slice(0, 80) });
  CUR_TASK.stats.failed = CUR_TASK.failedItems.length;
  taskWrite();
}

export function taskSkip(skipped) {
  if (!CUR_TASK) return;
  CUR_TASK.stats.skipped = Number(skipped) || 0;
  taskWrite();
}

// status: done / stopped / failed / empty
export function taskEnd(status, reportFile) {
  if (!CUR_TASK) return null;
  if (status) CUR_TASK.status = status;
  if (reportFile) CUR_TASK.reportFile = path.basename(reportFile);
  taskWrite(true);
  const done = { ...CUR_TASK };
  CUR_TASK = null;
  try { pruneTasks(); } catch {}
  return done;
}

function pruneTasks() {
  const files = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'));
  if (files.length <= TASK_KEEP_MAX) return;
  const items = files.map(f => {
    const p = path.join(TASK_DIR, f);
    let t = 0;
    try { t = JSON.parse(fs.readFileSync(p, 'utf8')).updatedAt || 0; } catch {}
    return { p, t: t || fs.statSync(p).mtimeMs };
  }).sort((a, b) => b.t - a.t);
  for (const it of items.slice(TASK_KEEP_MAX)) { try { fs.unlinkSync(it.p); } catch {} }
}

export function taskLoad(id) {
  try {
    const p = path.join(TASK_DIR, path.basename(String(id)) + '.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

export function taskRemove(id) {
  try { fs.unlinkSync(path.join(TASK_DIR, path.basename(String(id)) + '.json')); return true; }
  catch { return false; }
}

// 续投后把老任务标一下，列表里能看出「已续投到 xxx」
export function taskMarkResumed(id, newId) {
  const t = taskLoad(id);
  if (!t) return false;
  t.resumedBy = newId;
  try {
    fs.writeFileSync(path.join(TASK_DIR, path.basename(String(id)) + '.json'), JSON.stringify(t), 'utf8');
    return true;
  } catch { return false; }
}

// 程序启动时调用：还挂在「running」上的任务一定是上次被强杀/崩溃留下的，改成「已停止」才能续投
export function taskMarkStopped(id) {
  const t = taskLoad(id);
  if (!t || t.status !== 'running') return false;
  t.status = 'stopped';
  try {
    fs.writeFileSync(path.join(TASK_DIR, path.basename(String(id)) + '.json'), JSON.stringify(t), 'utf8');
    return true;
  } catch { return false; }
}

export function taskListRaw() {
  const out = [];
  try {
    if (!fs.existsSync(TASK_DIR)) return out;
    for (const f of fs.readdirSync(TASK_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(TASK_DIR, f), 'utf8'))); } catch {}
    }
  } catch {}
  return out;
}

// 把上次采集的岗位灌回本轮池子（续投用）；返回补进来的条数
// 打 _seed 标记：这些是上次任务遗留的，可能已经下架/过期，失败时不当成「连续失败」
function seedPool(pool, seed) {
  if (!Array.isArray(seed) || !seed.length) return 0;
  let n = 0;
  for (const x of seed) {
    if (!x || !x.id || pool.has(x.id)) continue;
    pool.set(x.id, { ...x, _seed: true });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ BOSS
const BOSS_SEL_JS = `(()=>{
  const as=[...document.querySelectorAll('a[href*="/job_detail/"]')];
  const seen=new Set(); const out=[];
  for(const a of as){
    const h=a.getAttribute('href')||'';
    const m=h.match(/job_detail\\/([a-zA-Z0-9]+)\\.html/); if(!m) continue;
    const id=m[1]; if(seen.has(id)) continue; seen.add(id);
    let p=a; for(let i=0;i<4;i++) if(p.parentElement) p=p.parentElement;
    const lines=(p.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
    out.push({id,lines:lines.slice(0,9)});
  }
  return JSON.stringify(out);})()`;

const dec = s => [...s].map(c => {
  const cp = c.codePointAt(0);
  return (cp >= 0xE031 && cp <= 0xE03A) ? String(cp - 0xE031) : c;
}).join('');

function parseBossCard(x) {
  const L = x.lines.map(l => dec(l).trim()).filter(Boolean);
  const title = L[0] || '', sal = L[1] || '';
  // 实习岗的识别：日薪（150-200元/天）、「天/周」字样，或标签里写着「实习 / 在校 / 应届」
  const dayPay = /元\/天|天\/周/.test(sal) || L.some(l => /元\/天|天\/周/.test(l));
  const tagIntern = L.slice(2, 6).some(l => /^(实习|实习生|实习岗|在校\/应届|应届生|在校生)$/.test(l));
  const isIntern = dayPay || tagIntern;
  // 卡片文字行的顺序并不稳定（实习卡还会多一行「天/周」），所以按内容特征识别而不是按下标取
  const rest = L.slice(2);
  const edu = rest.find(l => BOSS_EDU_RE.test(l) && !/元\/天|天\/周/.test(l) && l.length <= 12) || '';
  const expLine = rest.find(l => BOSS_EXP_RE.test(l)) || '';
  const area = rest.find(l => BOSS_AREA_RE.test(l) && l.length <= 12) || '';
  const co = rest.find(l => BOSS_CO_RE.test(l) && !BOSS_EDU_RE.test(l) && !BOSS_EXP_RE.test(l)
    && !BOSS_AREA_RE.test(l) && l !== area && l !== edu) || '';
  const exp = isIntern ? '实习' : (expLine || '');
  return { id: x.id, title, sal, exp, edu, co, area, isIntern };
}

const GOOD = /前端|全栈|Web|web|Vue|小程序|Java|Python|开发|研发|软件|实施|交付|技术支持|技术工程师|运维|系统集成|数据|AI|人工智能|IT|计算机|产品助理|程序员|FDE|解决方案/;
const BAD = /销售|行政|人事|人力资源|财务|会计|文员|录入|设计实习|美工|剪辑|短视频|短剧|主播|客服|话务|教师|讲师|助教|培训|造价|资料员|跟单|采购|仓管|物流|司机|保安|保洁|护士|医药|法务|律师|操盘|交易员|信贷|理财|保险|柜员|游戏测试|电脑维修|维修师傅|维修技术|美容|餐饮|导购|店长|储备干部|外呼|电销|编剧|运营助理|数据运营|充电桩|储能|档案|标注|数据采集|纯文字沟通|小白|普工|临时工|打包员/;
const CITYRE = /(南宁|柳州|桂林|北海|玉林|梧州|钦州|贵港|百色|河池|来宾|崇左|贺州|防城港|北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|厦门|长沙|重庆|天津|合肥|郑州|青岛|大连|福州|无锡|东莞|佛山|宁波|济南|珠海|南昌)/;
// BOSS 卡片的字段识别（卡片文字顺序不稳定，按特征匹配比按下标取稳）
const BOSS_EDU_RE = /^(大专|本科|硕士|博士|中专\/中技|中专|高中|初中及以下|学历不限|不限)$/;
const BOSS_EXP_RE = /^(\d+-\d+年|\d+年以内|经验不限|在校\/应届|应届生|应届|在校生|10年以上|无经验)$/;
const BOSS_AREA_RE = /^(南宁|柳州|桂林|北海|玉林|梧州|钦州|贵港|百色|河池|来宾|崇左|贺州|防城港|北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州|厦门|长沙|重庆|天津|合肥|郑州|青岛|大连|福州|无锡|东莞|佛山|宁波|济南|珠海|南昌|嘉兴|常州)(·|$|\s|-)/;
const BOSS_CO_RE = /(公司|科技|有限|集团|中心|工作室|事务所|银行|学校|学院|事业部|研究所)/;

function scoreBoss(r) {
  let s = 0;
  if (r.isIntern) s += 20;
  if (/在校|应届/.test(r.exp)) s += 12;
  if (/前端|全栈|Web|web|Vue|小程序/.test(r.title)) s += 14;
  if (/实施|交付|技术支持|运维|系统集成/.test(r.title)) s += 14;
  if (/AI|人工智能|大数据/.test(r.title)) s += 10;
  if (/开发|研发|软件|程序员|FDE|解决方案/.test(r.title)) s += 8;
  return s;
}

// ------------------------------------------------------------------ BOSS 求职类型
// 与 BOSS 搜索页「求职类型」下拉一致：不限 / 全职 / 兼职 / 实习
const BOSS_TYPE_LABEL = { all: '不限', fulltime: '全职', parttime: '兼职', intern: '实习' };
// URL 参数 jobType（实测：1902=实习、1901=全职、1903=兼职；不传=不限）
// 生效后页面顶部筛选条会显示「求职类型(1)」，服务端直接返回筛过的岗位
const BOSS_TYPE_CODE = { fulltime: '1901', intern: '1902', parttime: '1903' };

function bossTypeKey(cfg) {
  const k = String(cfg && cfg.bossType || '');
  return BOSS_TYPE_LABEL[k] ? k : 'all';
}

/** 构造 BOSS 搜索地址：把求职类型写进 URL，等同于在页面上点筛选 */
function bossSearchUrl(kw, cityCode, typeKey) {
  const t = BOSS_TYPE_CODE[typeKey];
  return `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(kw || '')}&city=${cityCode}${t ? `&jobType=${t}` : ''}`;
}

/** 读取页面顶部筛选条里「求职类型」的状态，用来确认 URL 参数真的生效了 */
const BOSS_BAR_JS = `(()=>{
  const all=[...document.querySelectorAll('div,span,a,li')];
  const hits=all.filter(e=>{const t=(e.innerText||'').replace(/\\s+/g,' ').trim();
    return /^求职类型/.test(t) && t.length<24 && e.children.length<=2;});
  if(!hits.length) return '';
  const e=hits[hits.length-1];
  return (e.innerText||'').replace(/\\s+/g,' ').trim();})()`;

async function runBoss(cdp, cityObj, cfg, _retry = 0, seed = null) {
  if (!_retry) { STOP_FLAG = false; ABORTED = false; }
  const hist = loadHist();
  const applied = new Set(hist.boss || []);
  const typeKey = bossTypeKey(cfg);
  log('');
  log(C.B(`▶ BOSS 直聘 · ${cityObj.name}`) + (typeKey !== 'all' ? C.d(` · 求职类型 ${BOSS_TYPE_LABEL[typeKey]}`) : ''));
  info(`关键词 ${cfg.bossKeywords.length} 组，目标投递 ${cfg.bossMax > 0 ? cfg.bossMax + " 个" : "不限（到额度用完）"}`);

  await cdp.attachPage('zhipin.com');
  await cdp.goto(bossSearchUrl(cfg.bossKeywords[0] || '前端', cityObj.code, typeKey), 2400);
  if (!(await guardBlocked(cdp, 'BOSS 直聘'))) return null;

  // 确认筛选真的落到页面上（BOSS 登录失效时会跳登录页，这里会先被上面的等待拦住）
  if (typeKey !== 'all') {
    let bar = '';
    try { bar = String((await cdp.eval(BOSS_BAR_JS)) || ''); } catch {}
    if (bar && /\(1\)|实习|全职|兼职/.test(bar)) {
      ok(`页面筛选已勾选：${bar}（与 BOSS 筛选条一致）`);
    } else if (bar) {
      warn(`页面筛选条显示「${bar}」，与目标「${BOSS_TYPE_LABEL[typeKey]}」不一致，本地会再过滤一遍`);
    }
  }

  // 1) 采集
  const pool = new Map();
  const seededBoss = seedPool(pool, seed);
  if (seededBoss) info(`沿用上次任务采集的 ${seededBoss} 个岗位，继续往下投`);
  for (let i = 0; i < cfg.bossKeywords.length; i++) {
    if (STOP_FLAG) { log(C.y('  已手动停止，采集结束')); break; }
    if (enoughCollected(pool, cfg.bossMax)) {
      log(C.d(`  已采集 ${pool.size} 条，够投 ${cfg.bossMax} 个，停止采集`));
      break;
    }
    const kw = cfg.bossKeywords[i];
    logPart(C.d(`  [${i + 1}/${cfg.bossKeywords.length}] 采集「${kw}」... `));
    let arr = [];
    try {
      await cdp.goto(bossSearchUrl(kw, cityObj.code, typeKey), 1500);
      let n = 0;
      for (let k = 0; k < 12; k++) {
        await sleep(1000);
        try { n = (await cdp.eval(`document.querySelectorAll('a[href*="/job_detail/"]').length`)) || 0; } catch { n = 0; }
        if (n > 2) break;
      }
      // 登录状态失效时 BOSS 会整页跳登录页：停下等用户登录，登录完自动重采本关键词
      if (await loginPending(cdp) || await captchaPending(cdp)) {
        log('');
        if (!(await waitForLogin(cdp, 'BOSS 直聘'))) return null;
        await cdp.goto(bossSearchUrl(kw, cityObj.code, typeKey), 2600);
        n = 0;
        for (let k = 0; k < 12; k++) {
          await sleep(1000);
          try { n = (await cdp.eval(`document.querySelectorAll('a[href*="/job_detail/"]').length`)) || 0; } catch { n = 0; }
          if (n > 2) break;
        }
      }
      if (n === 0) { log(C.y('无结果')); continue; }
      try {
        await cdp.eval('window.scrollTo(0,document.body.scrollHeight)');
        await sleep(2000);
        await cdp.eval('window.scrollTo(0,0)');
        await sleep(600);
      } catch {}
      arr = JSON.parse((await cdp.eval(BOSS_SEL_JS)) || '[]');
    } catch (e) {
      log(C.y('页面异常，跳过（' + e.message.slice(0, 30) + '）'));
      await sleep(1200);
      continue;
    }
    let add = 0;
    for (const x of arr) {
      const r = parseBossCard({ ...x, id: x.id });
      if (!pool.has(r.id)) { r.city = cityObj.name; pool.set(r.id, r); add++; }
    }
    log(C.d(`${arr.length} 条，新增 ${add}，累计 ${pool.size}`));
    taskPool(pool);
    await sleep(600);
  }
  if (!pool.size) {
    // 一条都没采到，很可能是登录态在采集途中失效（页面被顶到登录页），先等用户登录再来一轮
    if (!_retry && (await loginPending(cdp) || await captchaPending(cdp))) {
      if (!(await waitForLogin(cdp, 'BOSS 直聘'))) return null;
      return await runBoss(cdp, cityObj, cfg, 1, seed);
    }
    err('没采集到岗位：可能未登录 BOSS（请在浏览器窗口登录后重试），或该城市该关键词无结果');
    return null;
  }

  // 2) 筛选
  const poolArr = [...pool.values()];
  const internCnt = poolArr.filter(r => r.isIntern).length;
  const picked = poolArr.filter(r => {
    if (BAD.test(r.title) || !GOOD.test(r.title)) return false;
    if (typeKey === 'intern') return r.isIntern;        // 只要实习（页面已按 jobType=1902 筛过，这里兜底）
    if (typeKey === 'fulltime') return !r.isIntern;     // 全职：排除实习卡
    if (typeKey === 'parttime') return true;            // 兼职由页面筛，本地不再区分
    return r.isIntern || /经验不限|在校|应届|1年以内/.test(r.exp);
  }).map(r => ({ ...r, score: scoreBoss(r) })).sort((a, b) => b.score - a.score);

  log('');
  ok(`池 ${pool.size}（实习 ${internCnt}）→ 符合条件 ${picked.length}`);
  if (!picked.length) {
    if (typeKey === 'intern') {
      warn(`「${cityObj.name}」这些关键词下没搜到实习岗（本轮 ${pool.size} 条里实习 ${internCnt} 条）`);
      info('可把「求职类型」切「不限」，或把关键词换成「前端实习 / 开发实习生」这类更准的词');
    } else if (typeKey === 'fulltime') {
      warn(`没有符合方向的全职岗（本轮实习 ${internCnt} 条已按「全职」排除）`);
    } else {
      warn('没有符合你方向的岗位');
    }
    return null;
  }

  const todo = freshFirst(picked.filter(r => !applied.has(r.id))).slice(0, cfg.bossMax > 0 ? cfg.bossMax : 999);
  const alreadyCnt = picked.filter(r => applied.has(r.id)).length;
  info(`待投 ${todo.length} 个（历史上已投过 ${alreadyCnt} 个，超出上限未列入 ${Math.max(0, picked.length - alreadyCnt - todo.length)} 个）`);
  if (!todo.length) { warn('这批岗位都投过了，没有新增（换个关键词或城市再试）'); return null; }
  if (!cfg.autoYes) {
    const a = await ask(C.b(`\n开始投递 ${todo.length} 个？(Y/n) `));
    if (/^n/i.test(a)) { warn('已取消'); return null; }
  }

  // 3) 投递
  const sent = [], failed = [];
  let blocked = 0, remaining = null;
  for (let i = 0; i < todo.length; i++) {
    if (STOP_FLAG) { warn("已手动停止，本轮中断"); break; }
    const job = todo[i];
    const tag = `[${i + 1}/${todo.length}]`;
    try {
      await cdp.goto(`https://www.zhipin.com/job_detail/${job.id}.html`, 2200);
      const btn = await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");return b?b.innerText.trim():"NOBTN";})()`);
      if (btn !== '立即沟通') {
        log(`${tag} ${C.d('跳过')} ${job.title} (${btn})`);
        if (btn === '继续沟通') applied.add(job.id);
        continue;
      }
      await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");if(b)b.click();})()`);
      await sleep(2200);

      // 未登录会弹登录框：停下等用户登录，登录完自动重试
      if (await loginPending(cdp) || await captchaPending(cdp)) {
        if (!(await waitForLogin(cdp, 'BOSS 直聘'))) return null;
        await sleep(1200);
        await cdp.goto(`https://www.zhipin.com/job_detail/${job.id}.html`, 2200);
        await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");if(b)b.click();})()`);
        await sleep(2400);
      }

      // 额度提示框
      let dlg = { open: false };
      try {
        dlg = JSON.parse(await cdp.eval(`(()=>{
          const vis=e=>{if(!e)return 0;const r=e.getBoundingClientRect();const s=getComputedStyle(e);
            if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return 0;return r.height;};
          for(const w of document.querySelectorAll('.dialog-wrap,.dialog-container')){
            let h=vis(w); if(h<10){for(const c of w.querySelectorAll('*')) h=Math.max(h,vis(c));}
            if(h<10) continue;
            const tx=(w.innerText||'').replace(/\\s+/g,' ').trim(); if(!tx) continue;
            const m=tx.match(/还剩\\s*(\\d+)\\s*次/);
            return JSON.stringify({open:true,text:tx.slice(0,100),remaining:m?Number(m[1]):null,
              limit:/已达上限|次数已用完|明日再来|已达到沟通上限/.test(tx)});
          }
          return JSON.stringify({open:false});})()`) || '{}');
      } catch {}

      if (dlg.open) {
        if (dlg.remaining !== null) remaining = dlg.remaining;
        if (dlg.limit) {
          log('');
          err('今日沟通次数已达上限（BOSS 每天 150 位），明天再来'); ABORTED = true;
          break;
        }
        // 关闭提示框再点一次
        try {
          await cdp.eval(`(()=>{const w=[...document.querySelectorAll('.dialog-wrap,.dialog-container')]
            .find(e=>e.getBoundingClientRect().height>10); if(!w)return;
            const bs=[...w.querySelectorAll('a,button,span,div')]
              .filter(e=>/^好$|知道了|我知道了|确定/.test((e.innerText||'').trim())&&e.getBoundingClientRect().height>0);
            if(bs.length) bs[bs.length-1].click();})()`);
        } catch {}
        await sleep(1200);
        const b2 = await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");return b?b.innerText.trim():"NOBTN";})()`);
        if (b2 === '立即沟通') {
          await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");if(b)b.click();})()`);
          await sleep(2000);
        }
      }

      const after = await cdp.eval(`(()=>{const b=document.querySelector(".btn-startchat");return b?b.innerText.trim():"NOBTN";})()`);
      if (after === '继续沟通' || after === '已沟通') {
        sent.push(job); applied.add(job.id); blocked = 0;
        taskSent(job);
        log(`${tag} ${C.g('✔')} ${job.title} ${C.d('|')} ${job.sal} ${C.d('|')} ${job.co || '—'}`);
      } else if (job._seed && after === 'NOBTN') {
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`);
      } else {
        blocked++;
        failed.push({ ...job, reason: '按钮=' + after });
        taskFailed(job, '按钮=' + after);
        log(`${tag} ${C.r('✘')} ${job.title} (${after})`);
        if (blocked >= 3) { err('连续 3 次无响应，可能触发风控，已停止'); break; }
      }
    } catch (e) {
      // 续投带进来的旧岗位可能早就下架了，打不开不该算「连续失败」，否则会误触发自动停止
      if (job._seed) {
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`);
        continue;
      }
      blocked++;
      failed.push({ ...job, reason: e.message.slice(0, 60) });
      taskFailed(job, e.message.slice(0, 60));
      log(`${tag} ${C.r('✘')} ${job.title} (${e.message.slice(0, 40)})`);
      if (blocked >= 3) { err('连续 3 个岗位都没能投出去，已停止（多半是登录掉了或触发了风控；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
    }
    if (remaining !== null && remaining <= 1) { err('额度即将用尽，已停止'); ABORTED = true; break; }
    await sleep(cfg.delayMs);
  }

  hist.boss = [...applied];
  saveHist(hist);
  taskSkip(picked.length - todo.length);
  return { sent, failed, skipped: picked.length - todo.length, total: picked.length, aborted: ABORTED };
}

// ------------------------------------------------------------------ 牛客
// 牛客「职位类型」tab：全部职位 / 校招 / 社招 / 实习
const NK_TYPE_LABEL = { intern: '实习', campus: '校招', social: '社招', all: '全部职位' };
const NK_CLICK_TAB = label => `(()=>{
  const box=document.querySelector('.filter-left')||document;
  const tabs=[...box.querySelectorAll('.filter-recruit-type')];
  if(!tabs.length) return 'NO_TAB';
  const tab=tabs.find(e=>(e.innerText||'').trim()===${JSON.stringify(label)});
  if(!tab) return 'NO_MATCH';
  if(/\\bselect\\b/.test(tab.className||'')) return 'ALREADY';
  tab.click();
  return 'CLICKED';})()`;

// 牛客的元素必须派发真实鼠标事件，Vue 才能收到（直接 .click() 常无效）
const NK_FIRE = (sel, want) => `(()=>{
  const norm=s=>String(s||'').replace(/\\s+/g,'').replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区)$/,'');
  const cands=[...document.querySelectorAll(${JSON.stringify(sel)})]
    .filter(e=>e.offsetParent!==null||getComputedStyle(e).position==='fixed');
  const el=${want ? `cands.find(e=>norm(e.innerText)===norm(${JSON.stringify(want)}))` : 'cands[0]'};
  if(!el) return 'NOT_FOUND';
  const t=el.querySelector('.cascader-item-content')||el;
  const r=t.getBoundingClientRect();
  const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2||1,clientY:r.top+r.height/2||1};
  ['mouseenter','mousedown','mouseup','click'].forEach(n=>t.dispatchEvent(new MouseEvent(n,o)));
  return 'FIRED';})()`;

const NK_CITY_LABEL = `(()=>{const c=document.querySelector('.city-cascader');
  return c?(c.innerText||'').replace(/\\s+/g,'').trim():'';})()`;

// 城市级联是「省 → 市」两列，直辖市第二列里也有同名项，必须从最右侧的菜单里点
const NK_FIRE_MENU = want => `(()=>{
  const norm=s=>String(s||'').replace(/\\s+/g,'').replace(/(省|市|自治区)$/,'');
  const pop=[...document.querySelectorAll('.nc-city-cascader-popover')].filter(e=>getComputedStyle(e).display!=='none');
  if(!pop.length) return 'NO_POP';
  const menus=[...pop[pop.length-1].querySelectorAll('.cascader-menu')].reverse();
  for(const m of menus){
    const it=[...m.querySelectorAll('.cascader-item')].find(e=>norm(e.innerText)===norm(${JSON.stringify(want)}));
    if(it){
      const t=it.querySelector('.cascader-item-content')||it;
      const r=t.getBoundingClientRect();
      const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2||1,clientY:r.top+r.height/2||1};
      ['mouseenter','mousedown','mouseup','click'].forEach(n=>t.dispatchEvent(new MouseEvent(n,o)));
      return 'FIRED';
    }
  }
  return 'NOT_FOUND';})()`;

// 牛客「全部城市」级联：省 → 市
async function applyNkCity(cdp, cityObj) {
  const name = String(cityObj.name || '').replace(/[市]$/, '');
  const prov = String(cityObj.prov || '').replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区)$/, '');
  try {
    const cur = await cdp.eval(NK_CITY_LABEL);
    if (cur.includes(name)) return { ok: true, already: true, label: cur };
    await cdp.eval(NK_FIRE('.city-cascader'));
    await sleep(900);
    if (prov && prov !== name) {
      const p = await cdp.eval(NK_FIRE('.nc-city-cascader-popover .cascader-item', prov));
      if (p !== 'FIRED') {
        await cdp.eval('document.body.click()');
        return { ok: false, step: 'province', detail: p, label: await cdp.eval(NK_CITY_LABEL) };
      }
      await sleep(1100);
    }
    let detail = await cdp.eval(NK_FIRE_MENU(name));
    await sleep(2200);
    let label = await cdp.eval(NK_CITY_LABEL);
    if (!label.includes(name)) {          // 直辖市要再点一次第二列
      detail += '/' + await cdp.eval(NK_FIRE_MENU(name));
      await sleep(2000);
      label = await cdp.eval(NK_CITY_LABEL);
    }
    return { ok: label.includes(name), step: 'city', detail, label };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 40) };
  }
}

// 牛客「筛选」面板 → 学历要求
async function applyNkEdu(cdp, edu) {
  if (!edu || edu === '不限') return { ok: true, skipped: true };
  try {
    await cdp.eval(NK_FIRE('.filter-btn .text'));
    await sleep(1300);
    const pick = await cdp.eval(`(()=>{
      const ds=[...document.querySelectorAll('.el-dialog')].filter(d=>d.offsetParent!==null);
      if(!ds.length) return 'NO_DIALOG';
      const d=ds[ds.length-1];
      const sec=[...d.querySelectorAll('.filter-section')].find(s=>/学历要求/.test(s.innerText||''));
      if(!sec) return 'NO_SECTION';
      const it=[...sec.querySelectorAll('.filter-item')].find(i=>(i.innerText||'').trim()===${JSON.stringify(edu)});
      if(!it) return 'NO_ITEM';
      const r=it.getBoundingClientRect();
      const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
      ['mousedown','mouseup','click'].forEach(n=>it.dispatchEvent(new MouseEvent(n,o)));
      return 'PICKED';})()`);
    await sleep(500);
    const sure = await cdp.eval(`(()=>{
      const ds=[...document.querySelectorAll('.el-dialog')].filter(d=>d.offsetParent!==null);
      if(!ds.length) return 'NO_DIALOG';
      const b=[...ds[ds.length-1].querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='确定');
      if(!b) return 'NO_OK'; b.click(); return 'OK';})()`);
    await sleep(1800);
    return { ok: pick === 'PICKED' && sure === 'OK', detail: pick + '/' + sure };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 40) };
  }
}

// 牛客职位详情页 title 形如「岗位名_公司名校招_牛客网」，从中解析公司名
function parseNkCompany(title) {
  const t = String(title || '').trim();
  if (!t) return '';
  const seg = t.split('_').map(s => s.trim()).filter(Boolean);
  if (seg.length >= 3) {
    return seg[seg.length - 2].replace(/(校招|社招|实习|全职|兼职|招聘)$/, '').trim();
  }
  if (seg.length === 2) {
    const c = seg[1].replace(/[-|｜]?\s*牛客网?$/, '').replace(/(校招|社招|实习|全职|兼职|招聘)$/, '').trim();
    if (c && c !== seg[0]) return c;
  }
  return '';
}

async function runNowcoder(cdp, cfg, cityObj, _retry = 0, seed = null) {
  if (!_retry) { STOP_FLAG = false; ABORTED = false; }
  const hist = loadHist();
  const applied = new Set(hist.nowcoder || []);
  const typeKey = cfg.nkRecruitType || 'intern';
  const typeLabel = NK_TYPE_LABEL[typeKey] || '实习';
  const edu = cfg.nkEdu || '不限';
  const cityName = cityObj ? String(cityObj.name || '').replace(/[市]$/, '') : '';
  log('');
  log(C.B(`▶ 牛客网 · ${typeLabel}岗${cityName ? ' · ' + cityName : ' · 全国'}`));
  info(`关键词 ${cfg.nkKeywords.length} 组，目标投递 ${cfg.nkMax > 0 ? cfg.nkMax + " 个" : "不限"}`);
  info(cityName
    ? `地区限制：${cityName}（用牛客「全部城市」下拉筛选）${edu !== '不限' ? ' · 学历要求 ' + edu : ''}`
    : `地区限制：全国${edu !== '不限' ? ' · 学历要求 ' + edu : ''}`);

  await cdp.attachPage('nowcoder.com');
  await cdp.goto(`https://www.nowcoder.com/search/job?query=${encodeURIComponent(cfg.nkKeywords[0] || '前端')}&type=job`, 2600);
  if (!(await guardBlocked(cdp, '牛客网'))) return null;

  const pool = new Map();
  let internTabOk = false;
  let cityOk = 0, cityBad = 0, eduBad = 0, emptyKws = 0;
  const seededNk = seedPool(pool, seed);
  if (seededNk) info(`沿用上次任务采集的 ${seededNk} 个岗位，继续往下投`);
  for (let i = 0; i < cfg.nkKeywords.length; i++) {
    if (STOP_FLAG) { log(C.y('  已手动停止，采集结束')); break; }
    if (enoughCollected(pool, cfg.nkMax)) {
      log(C.d(`  已采集 ${pool.size} 条，够投 ${cfg.nkMax} 个，停止采集`));
      break;
    }
    // 采集途中登录态失效（点进职位列表被弹登录）——停下来等用户登录，登录完继续本关键词
    if (await loginPending(cdp) || await captchaPending(cdp)) {
      log('');
      if (!(await waitForLogin(cdp, '牛客网'))) return null;
    }
    const kw = cfg.nkKeywords[i];
    logPart(C.d(`  [${i + 1}/${cfg.nkKeywords.length}] 采集「${kw}」... `));
    let arr = [];
    try {
      await cdp.goto(`https://www.nowcoder.com/search/job?query=${encodeURIComponent(kw)}&type=job`, 3000);
      // 显式切到「实习」筛选，避免搜到的校招/社招混进来
      let tabR = 'ERR';
      try { tabR = await cdp.eval(NK_CLICK_TAB(typeLabel)); } catch {}
      if (tabR === 'CLICKED') { await sleep(2200); internTabOk = true; }
      else if (tabR === 'ALREADY') internTabOk = true;
      else if (!internTabOk) { try { tabR = await cdp.eval(NK_CLICK_TAB(typeLabel)); } catch {} }

      // 城市限制：走牛客自己的「全部城市」下拉
      if (cityName) {
        const cr = await applyNkCity(cdp, cityObj);
        if (!cr.ok) { cityBad++; if (cityBad === 1) warn(`城市筛选失败（${cr.step || cr.err || ''}），本轮改为按标题城市判断`); }
        else cityOk++;
      }
      // 其他筛选：学历要求
      if (edu !== '不限') {
        const er = await applyNkEdu(cdp, edu);
        if (!er.ok && eduBad < 1) { eduBad++; warn(`学历筛选失败（${er.detail || er.err || ''}），改按标题判断`); }
      }
      // 该城市无结果时牛客会兜底推荐热门职位，这些不是目标地区的，必须跳过
      const noHit = await cdp.eval(`/暂无满足条件的职位/.test(document.body.innerText)`);
      if (noHit) { emptyKws++; log(C.y(`${cityName || '该条件'}下无结果`)); await sleep(600); continue; }

      arr = JSON.parse(await cdp.eval(`(()=>{const as=[...document.querySelectorAll('a')]
        .filter(a=>/\\/jobs\\/detail/.test(a.getAttribute('href')||''));
        return JSON.stringify(as.map(a=>{const h=a.getAttribute('href');
          const id=(h.match(/detail\\/(\\d+)/)||[])[1]||'';
          let p=a; for(let i=0;i<4;i++) if(p.parentElement) p=p.parentElement;
          const cardTxt=(p.innerText||'').replace(/\\s+/g,' ');
          const t=(a.innerText||'').replace(/\\s+/g,' ').trim();
          const root=a.closest('[class*="job-card"]')||p;
          const coEl=root.querySelector('a[href*="/company/"]')||root.querySelector('[class*="company-name"],[class*="companyName"]');
          const co=coEl?((coEl.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30)):'';
          return {id,t,co,card:cardTxt.slice(0,220)};}).filter(x=>x.id&&x.t.length>8));})()`) || '[]');
      if (i === 0) info(`筛选状态：${tabR === 'ALREADY' || tabR === 'CLICKED' ? '已切到「' + typeLabel + '」' : '未能切换（' + tabR + '），改用标题判断'}`);
    } catch (e) {
      log(C.y('页面异常，跳过'));
      await sleep(1000);
      continue;
    }
    let add = 0;
    for (const x of arr) if (!pool.has(x.id)) { pool.set(x.id, { ...x, kw }); add++; }
    log(C.d(`${arr.length} 条，新增 ${add}，累计 ${pool.size}`));
    taskPool(pool);
    await sleep(700);
  }
  if (!pool.size) {
    // 一条都没采到：多半是没登录（搜索接口直接返回空），停下等登录后重采一轮
    if (!_retry && (await loginPending(cdp) || await captchaPending(cdp))) {
      if (!(await waitForLogin(cdp, '牛客网'))) return null;
      return await runNowcoder(cdp, cfg, cityObj, 1, seed);
    }
    if (cityName && emptyKws) err(`「${cityName}」没有搜到${typeLabel}岗，换个城市试试（比如广州/深圳）`);
    else err('没采集到岗位：可能未登录牛客（请在浏览器窗口登录后重试）');
    return null;
  }
  if (cityName) {
    if (cityOk) info(`城市筛选：已应用「${cityName}」（${cityOk}/${cfg.nkKeywords.length} 个关键词）`);
    else warn('城市下拉没能选上，本轮改为按卡片城市文字过滤');
  }

  // 筛选：只要明确写「实习」的
  const BADNK = /销售|客服|运营|教师|助教|编辑|文案|剪辑|美工|人事|行政|财务|招聘|主播|标注|算法|嵌入式|硬件|结构|电气|机械|测绘|造价|医药|律师|U3D|Unity|游戏|原画|动画|数据分析|数据挖掘|机器学习|深度学习|NLP|C\+\+|BSP|影像|电池|电芯|内核/;
  const GOODNK = /前端|全栈|Web|web|Vue|React|Node|小程序|FDE|交付|实施|技术支持|驻场|技术顾问|售前|解决方案|客户成功|低代码|数字化|信息化|Python|Java|Golang|数据开发|AI应用|大模型|Agent|AI开发|AI工程|软件开发|软件工程|研发工程|产品助理|项目助理/;
  const picked = [];
  const cityLocal = cityName && cityOk === 0;   // 下拉没点上时的兜底：按卡片城市文字过滤
  for (const x of pool.values()) {
    const t = x.t;
    if (cityLocal) {
      const hay = (x.card || '') + ' ' + t;
      if (!hay.includes(cityName) && !/全国|远程|不限地点/.test(hay)) continue;
    }
    // 已成功切到官方「实习」筛选时，不再要求标题里带「实习」二字
    if (!(typeKey === 'intern' && internTabOk)) {
      if (!/实习/.test(t)) continue;
    } else if (/社招/.test(x.card || '') && !/实习/.test(x.card || '')) {
      continue;
    }
    if (/2028|28届|硕士|博士|研究生/.test(t) && !/本科|大专|统招/.test(t)) continue;
    let title = t.replace(/^(实习|校招|社招|全职)\s*[|｜]\s*/, '');
    const cut = title.search(/\d+\s*-\s*\d+元|薪资面议|\d+-\d+K/);
    if (cut > 0) title = title.slice(0, cut).trim();
    if (!title || title.length < 4) continue;
    if (BADNK.test(title) || !GOODNK.test(title)) continue;
    const city = (t.match(CITYRE) || [])[1] || ((x.card || '').match(CITYRE) || [])[1] || cityName || '';
    const sal = (t.match(/(\d+-\d+元\/天|薪资面议|\d+-\d+K)/) || [])[1] || '';
    let score = 0;
    if (/前端|全栈|Web|Vue|小程序/.test(title)) score += 12;
    if (/交付|实施|技术支持|售前|解决方案|客户成功|FDE/.test(title)) score += 14;
    if (/AI|大模型|Agent/.test(title)) score += 8;
    if (/Python|Java|Golang|数据开发|软件开发|研发/.test(title)) score += 5;
    picked.push({ id: x.id, title: title.slice(0, 44), sal, city, co: x.co || '—', score });
  }
  picked.sort((a, b) => b.score - a.score);

  log('');
  ok(`池 ${pool.size} → 符合条件 ${picked.length}`);
  if (!picked.length) {
    if (cityName) {
      warn(`「${cityName}」没有符合条件的${typeLabel}岗，换个城市（如广州/深圳）再试`);
    } else warn('没有符合条件的实习岗');
    return null;
  }

  const todo = freshFirst(picked.filter(r => !applied.has(r.id))).slice(0, cfg.nkMax > 0 ? cfg.nkMax : 999);
  info(`去重后待投 ${todo.length} 个`);
  if (!todo.length) { warn('这批岗位都投过了，没有新增（换个关键词或城市再试）'); return null; }
  if (!cfg.autoYes) {
    const a = await ask(C.b(`\n开始投递 ${todo.length} 个？(Y/n) `));
    if (/^n/i.test(a)) { warn('已取消'); return null; }
  }

  const sent = [], failed = [];
  let blocked = 0;
  for (let i = 0; i < todo.length; i++) {
    if (STOP_FLAG) { warn('已手动停止，本轮中断'); break; }
    const job = todo[i];
    const tag = `[${i + 1}/${todo.length}]`;
    try {
      await cdp.goto(`https://www.nowcoder.com/jobs/detail/${job.id}`, 3200);
      // 同一次取回按钮与页面标题（标题里带公司名，用于报告的「公司」列）
      const head = JSON.parse(await cdp.eval(`(()=>{
        const b=[...document.querySelectorAll('button')]
          .find(x=>/立即申请|继续沟通|已投递|已申请|停止投递/.test(x.innerText||'')&&x.offsetParent!==null);
        return JSON.stringify({btn:b?b.innerText.trim():'NOBTN', title:document.title||''});})()`) || '{}');
      const btn = head.btn;
      if (!job.co || job.co === '—') {
        const co = parseNkCompany(head.title);
        if (co) job.co = co;
      }

      if (/继续沟通|已投递|已申请/.test(btn)) {
        applied.add(job.id); log(`${tag} ${C.d('已投过')} ${job.title}`); continue;
      }
      if (btn !== '立即申请') { log(`${tag} ${C.d('跳过')} ${job.title} (${btn})`); continue; }

      await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')]
        .find(x=>(x.innerText||'').trim()==='立即申请'&&x.offsetParent!==null);
        if(b){b.scrollIntoView({block:'center'});b.click();}})()`);
      await sleep(2400);

      // 专场招聘 → 只能走网申
      const kind = await cdp.eval(`(()=>{
        const dls=[...document.querySelectorAll('.el-dialog')].filter(d=>d.offsetParent!==null);
        if(!dls.length)return 'NO_DLG';
        const txt=(dls[dls.length-1].innerText||'').replace(/\\s+/g,' ');
        if(/专场招聘|请选择志愿|直达官网/.test(txt))return 'SPECIAL';
        return 'NORMAL';})()`);
      if (kind === 'SPECIAL') { log(`${tag} ${C.y('专场')} ${job.title} ${C.d('(需网申，跳过)')}`); continue; }

      // 意向城市必填
      await cdp.eval(`(()=>{const dls=[...document.querySelectorAll('.el-dialog')].filter(d=>d.offsetParent!==null);
        if(!dls.length)return;const dl=dls[dls.length-1];
        const sels=[...dl.querySelectorAll('.el-select')];
        const empty=sels.find(s=>!((s.querySelector('.el-select__selected-item')||{innerText:''}).innerText||'').trim());
        if(empty)empty.click();})()`);
      await sleep(1100);
      await cdp.eval(`(()=>{const ps=[...document.querySelectorAll('.el-select-dropdown__item')].filter(x=>x.offsetParent!==null);
        if(!ps.length)return;const txt=x=>(x.innerText||'').trim();
        for(const c of ['南宁','广州','深圳','上海','北京','杭州']){
          const hit=ps.find(p=>txt(p).includes(c)); if(hit){hit.click();return;}}
        ps[0].click();})()`);
      await sleep(800);

      const NK_SUBMIT_JS = `(()=>{const dls=[...document.querySelectorAll('.el-dialog')].filter(d=>d.offsetParent!==null);
        const dl=dls[dls.length-1]||document;
        const b=[...dl.querySelectorAll('button')].filter(x=>(x.innerText||'').trim()==='投递简历'&&x.offsetParent!==null).pop();
        if(!b)return 'NO_BTN';
        if(b.disabled||b.classList.contains('is-disabled'))return 'DISABLED';
        b.click();return 'CLICKED';})()`;
      const sub = await cdp.eval(NK_SUBMIT_JS);
      await sleep(2800);

      // 未登录会弹登录框：停下等用户登录，登录完自动重投一次
      if (await loginPending(cdp) || await captchaPending(cdp)) {
        if (!(await waitForLogin(cdp, '牛客网'))) return null;
        blocked = 0;
        await sleep(1500);
        await cdp.eval(NK_SUBMIT_JS);
        await sleep(3000);
      }

      const after = await cdp.eval(`(()=>{const b=[...document.querySelectorAll('button')]
        .find(x=>/立即申请|继续沟通|已投递|停止投递/.test(x.innerText||''));
        return b?b.innerText.trim():'NONE';})()`);

      if (/继续沟通|已投递|已申请/.test(after)) {
        sent.push(job); applied.add(job.id); blocked = 0;
        taskSent(job);
        log(`${tag} ${C.g('✔')} ${job.title} ${C.d('|')} ${job.sal} ${C.d('|')} ${job.city || '—'}`);
      } else {
        blocked++;
        failed.push({ ...job, reason: `提交=${sub} 结果=${after}` });
        taskFailed(job, `提交=${sub} 结果=${after}`);
        log(`${tag} ${C.r('✘')} ${job.title} (${after})`);
        if (blocked >= 5) { err('连续 5 个岗位都没能投出去，已停止（多半是登录掉了或触发了平台限制；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
      }
    } catch (e) {
      // 续投带进来的旧岗位可能早就下架了，打不开不该算「连续失败」，否则会误触发自动停止
      if (job._seed) {
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`);
        continue;
      }
      blocked++;
      failed.push({ ...job, reason: e.message.slice(0, 60) });
      taskFailed(job, e.message.slice(0, 60));
      log(`${tag} ${C.r('✘')} ${job.title} (${e.message.slice(0, 40)})`);
      if (blocked >= 5) { err('连续 5 个岗位都没能投出去，已停止（多半是登录掉了或页面结构变了；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
    }
    await sleep(800);
  }

  hist.nowcoder = [...applied];
  saveHist(hist);
  taskSkip(picked.length - todo.length);
  return { sent, failed, skipped: picked.length - todo.length, total: picked.length, aborted: ABORTED };
}

// ------------------------------------------------------------------ 智联招聘
// 工作性质取值与智联「工作性质」筛选完全一致：不限 / 全职 / 实习 / 兼职
// 与智联「工作性质」下拉一致：不限 / 全职 / 兼职-临时 / 实习 / 校园
const ZH_TYPE_LABEL = { all: '不限', fulltime: '全职', parttime: '兼职/临时', intern: '实习', campus: '校园' };
// 智联页面上「工作性质」筛选的真实参数（jobStatusCode）：不限=-1 全职=2 兼职/临时=1 实习=4 校园=5
// 走 URL 参数，页面顶部筛选条会自动显示为已选中状态（实测有效，服务端返回的就是筛过的结果）
const ZH_JOB_STATUS = { all: '', fulltime: '2', parttime: '1', intern: '4', campus: '5' };
// 智联「学历」筛选（educationTypeCode）：大专=5 本科=4
const ZH_EDU_CODE = { '不限': '', '大专': '5', '本科': '4' };

/** 构造智联搜索地址：把工作性质/学历写进 URL，等同于在页面上点这两个筛选 */
function zhSearchUrl(jl, kw, typeKey, edu) {
  const q = [`jl=${jl || '530'}`, `kw=${encodeURIComponent(kw || '')}`];
  const st = ZH_JOB_STATUS[typeKey];
  if (st) q.push(`jobStatusCode=${st}`);
  const ed = ZH_EDU_CODE[edu];
  if (ed) q.push(`educationTypeCode=${ed}`);
  return `https://www.zhaopin.com/jobs/?${q.join('&')}`;
}

// 智联 workTypeCode 实测：1=兼职/临时 2=全职 4=实习 5=校园
function zhWtKey(p) {
  const c = String(p.wtc || '');
  const t = String(p.wt || '');
  if (c === '5' || /校园|校招/.test(t)) return 'campus';
  if (c === '4' || /实习/.test(t)) return 'intern';
  if (c === '2' || /全职/.test(t)) return 'fulltime';
  if (c === '1' || /兼职|临时/.test(t)) return 'parttime';
  return '';
}

// 智联列表页内嵌了 __INITIAL_STATE__.positionList，字段比 DOM 全（含工作性质/学历/是否已投）
const ZH_COLLECT_JS = `(()=>{
  const st=(typeof __INITIAL_STATE__!=='undefined')?__INITIAL_STATE__:null;
  if(!st||!Array.isArray(st.positionList)) return '[]';
  return JSON.stringify(st.positionList.map(p=>({
    id:String(p.jobId||''),
    title:String(p.name||'').trim(),
    co:String(p.companyName||'').trim(),
    sal:String(p.salary60||'').trim(),
    city:String(p.workCity||'').trim(),
    wt:String(p.workType||''),
    wtc:String(p.workTypeCode||''),
    edu:String(p.education||''),
    exp:String(p.workingExp||''),
    applied:!!p.hasAppliedPosition,
    // 官方给的详情页地址：列表卡片会随搜索结果实时轮换，投递时靠它直达岗位，不受轮换影响
    url:String(p.positionURL||p.positionUrl||''),
  })).filter(x=>x.id&&x.title&&x.co));
})()`;

// 智联投递：点卡片 → 右侧详情面板 → 立即投递 → 出现「已向对方发送简历和打招呼语」即成功
async function zhApplyOne(cdp, job) {
  const name = JSON.stringify(job.title), co = JSON.stringify(job.co);
  // 等目标卡片真正渲染出来再点，避免页面还在导航时点到了上一页的列表
  const appears = `(()=>{
    const cards=[...document.querySelectorAll('.job-card')];
    const want=${name};
    return cards.some(c=>{
      const t=((c.querySelector('.vue-clamp__text')||{}).innerText||'').trim();
      return t===want;
    });})()`;
  for (let k = 0; k < 10; k++) {
    let ok2 = false;
    try { ok2 = await cdp.eval(appears); } catch {}
    if (ok2) break;
    await sleep(800);
  }
  const hit = await cdp.eval(`(()=>{
    const cards=[...document.querySelectorAll('.job-card')];
    const norm=s=>(s||'').replace(/\\s+/g,'').trim();
    const want=norm(${name}), wantCo=norm(${co});
    const nm=e=>norm((e.querySelector('.vue-clamp__text')||e.querySelector('[aria-label]')||{}).innerText);
    const cm=e=>norm((e.querySelector('.job-card__company-name')||{}).innerText);
    let c=cards.find(e=>nm(e)===want && (!wantCo||cm(e)===wantCo));
    if(!c) c=cards.find(e=>nm(e)===want);
    if(!c) c=cards.find(e=>norm(e.innerText).includes(want) && (!wantCo||norm(e.innerText).includes(wantCo)));
    if(!c) return 'NO_CARD|'+cards.length+'|'+cards.slice(0,3).map(e=>nm(e)).join(' / ');
    c.scrollIntoView({block:'center'});
    const r=c.getBoundingClientRect();
    const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
    ['mouseenter','mouseover','mousedown','mouseup','click'].forEach(n=>c.dispatchEvent(new MouseEvent(n,o)));
    return 'CLICKED';})()`);
  if (hit !== 'CLICKED') return { ok: false, miss: true, why: '该岗已不在本轮列表（智联列表会轮换）' };
  await sleep(2500);

  // 校验面板是同一个岗位，防止点错投错（智联大量猎头/外包岗，公司名常显示为「客户公司：某大型公司」，
  // 所以以「岗位标题」为准，公司名只在拿不到标题时做兜底）
  const panel = JSON.parse(await cdp.eval(`(()=>{
    const s=document.querySelector('.job-detail-summary');
    if(!s) return JSON.stringify({none:true});
    return JSON.stringify({
      title:((s.querySelector('.job-detail-summary__title-text')||s.querySelector('.job-detail-summary__title')||{}).innerText||'').split('\\n')[0].trim(),
      co:((s.querySelector('.job-detail-summary__company-name')||{}).innerText||'').trim(),
      txt:(s.innerText||'').replace(/\\s+/g,' ').slice(0,120),
      btn:((s.querySelector('.job-detail-summary__apply')||{}).innerText||'').trim(),
    });})()`) || '{}');
  if (panel.none) return { ok: false, why: '详情面板未出现' };
  const nrm = s => String(s || '').replace(/[\s·（）()【】[\]]/g, '');
  const pT = nrm(panel.title), jT = nrm(job.title);
  if (pT) {
    if (!(pT === jT || pT.includes(jT) || jT.includes(pT))) {
      return { ok: false, why: '面板岗位不符(' + String(panel.title).slice(0, 14) + ')' };
    }
  } else if (job.co && panel.co && panel.co !== job.co && !/客户公司|某|保密/.test(panel.co)) {
    return { ok: false, why: '面板公司不符(' + panel.co.slice(0, 12) + ')' };
  }
  if (/已投递|已申请/.test(panel.txt)) return { ok: false, why: '已投递', dup: true };

  const CLICK_APPLY_JS = `(()=>{
    const s=document.querySelector('.job-detail-summary');
    if(!s) return 'NO_PANEL';
    const b=s.querySelector('.job-detail-summary__apply')||[...s.querySelectorAll('button')].find(x=>/立即投递|投递简历/.test((x.innerText||'').trim()));
    if(!b) return 'NO_BTN';
    if(b.disabled||b.classList.contains('is-disabled')||b.classList.contains('a-button--disabled')) return 'DISABLED';
    b.click(); return 'CLICKED';})()`;
  const clicked = await cdp.eval(CLICK_APPLY_JS);
  if (clicked === 'NO_BTN') return { ok: false, why: '无投递按钮' };
  if (clicked === 'DISABLED') return { ok: false, why: '按钮禁用' };
  await sleep(2600);

  // 未登录会弹登录框：停下等用户登录，登录完自动重投一次
  if (await loginPending(cdp) || await captchaPending(cdp)) {
    if (!(await waitForLogin(cdp, '智联招聘'))) return { ok: false, why: '等待登录超时' };
    await sleep(1200);
    await cdp.eval(CLICK_APPLY_JS);
    await sleep(2800);
  }

  const res = JSON.parse(await cdp.eval(`(()=>{
    const box=[...document.querySelectorAll('.deliver-greeting-modal__box,.deliver-greeting-modal__wrapper')].filter(e=>e.offsetParent!==null);
    const txt=box.length?(box[0].innerText||'').replace(/\\s+/g,' '):'';
    const msg=[...document.querySelectorAll('.a-message,.a-notification,.el-message,[class*="toast"]')]
      .filter(e=>e.offsetParent!==null).map(e=>(e.innerText||'').trim()).join(' / ');
    const s=document.querySelector('.job-detail-summary');
    const btn=s?((s.querySelector('.job-detail-summary__apply')||{}).innerText||'').trim():'';
    return JSON.stringify({greet:box.length>0, txt:txt.slice(0,120), msg:msg.slice(0,120), btn});
  })()`) || '{}');

  // 关掉「已发送简历」弹窗，回到列表
  if (res.greet) {
    await cdp.eval(`(()=>{
      const w=document.querySelector('.deliver-greeting-modal__wrapper');
      if(!w) return;
      const b=[...w.querySelectorAll('.deliver-greeting-modal__btn')].find(x=>/留在此页/.test((x.innerText||'').trim()))
        ||w.querySelector('.deliver-greeting-modal__close');
      if(b) b.click();})()`);
    await sleep(700);
  }

  if (res.greet) return { ok: true };
  if (res.msg) return { ok: false, why: res.msg.slice(0, 40) };
  if (/已投递|已申请/.test(res.btn)) return { ok: false, why: '已投递', dup: true };
  return { ok: false, why: '未出现投递成功提示' };
}

// 直接打开岗位详情页投递。
// 智联的搜索结果是实时变化的：重新打开某个关键词页时，上次采集到的岗位常已被新岗位挤到后面几页，
// 于是「按标题在列表里找卡片」会大面积找不到。详情页地址由智联自己在 positionURL 里给出，
// 只要岗位还没下架就能直达，是列表轮换时唯一可靠的兜底路径。
async function zhApplyByDetail(cdp, job) {
  const url = String(job.url || '');
  if (!url) return { ok: false, miss: true, why: '旧任务没记录详情页地址' };
  await cdp.goto(url, 2600);
  if (await loginPending(cdp) || await captchaPending(cdp)) {
    if (!(await waitForLogin(cdp, '智联招聘'))) return { ok: false, why: '等待登录超时' };
    await cdp.goto(url, 2600);
  }

  // 等「立即投递」按钮渲染出来。
  // 智联投过之后会把主按钮换成「继续沟通」，这也是明确的「已投过」信号；
  // 岗位下架则整块 .summary-planes__action 都不存在（页面会显示「页面不小心走丢了」）。
  const FIND_BTN = `(()=>{
    const bs=[...document.querySelectorAll('button')];
    if(bs.some(x=>/^(立即投递|投递简历)$/.test((x.innerText||'').trim())&&!x.disabled)) return 'READY';
    if(bs.some(x=>/^已投递$/.test((x.innerText||'').trim()))) return 'APPLIED';
    const box=document.querySelector('.summary-planes__action');
    if(box&&/继续沟通|已投递|已申请/.test((box.innerText||''))) return 'APPLIED';
    if(/页面不小心走丢了|职位不存在|已下线|停止招聘|已结束招聘/.test((document.body.innerText||'').slice(0,800))) return 'GONE';
    const off=bs.find(x=>/^(立即投递|投递简历)$/.test((x.innerText||'').trim()));
    if(off) return 'DISABLED';
    return 'NONE';
  })()`;
  let st = 'NONE';
  for (let k = 0; k < 9; k++) {
    try { st = await cdp.eval(FIND_BTN); } catch { st = 'NONE'; }
    // 下架页只停留一两秒就自动跳首页，必须在循环里抓住
    if (st === 'GONE' || st === 'APPLIED' || st === 'READY') break;
    await sleep(700);
  }
  if (st === 'APPLIED' || st === 'DISABLED') return { ok: false, dup: true, why: '已投递' };
  if (st === 'GONE') return { ok: false, miss: true, why: '岗位已下架' };
  if (st !== 'READY') return { ok: false, miss: true, why: '详情页没有投递按钮' };

  const CLICK = `(()=>{
    const b=[...document.querySelectorAll('button')].find(x=>/^(立即投递|投递简历)$/.test((x.innerText||'').trim()));
    if(!b) return 'NO_BTN';
    if(b.disabled) return 'DISABLED';
    b.scrollIntoView({block:'center'});
    b.click(); return 'CLICKED';})()`;
  const clicked = await cdp.eval(CLICK);
  if (clicked === 'NO_BTN') return { ok: false, why: '无投递按钮' };
  if (clicked === 'DISABLED') return { ok: false, dup: true, why: '已投递' };
  await sleep(2400);

  // 未登录会弹登录框：停下等用户登录，登录完自动重投一次
  if (await loginPending(cdp) || await captchaPending(cdp)) {
    if (!(await waitForLogin(cdp, '智联招聘'))) return { ok: false, why: '等待登录超时' };
    await sleep(1200);
    await cdp.eval(CLICK).catch(() => {});
    await sleep(2600);
  }

  // 成功标志：弹出「已向对方发送简历和打招呼语」
  let greet = false;
  for (let k = 0; k < 5; k++) {
    const r = JSON.parse(await cdp.eval(`(()=>{
      const w=document.querySelector('.deliver-greeting-modal__wrapper');
      const t=w?(w.innerText||'').replace(/\\s+/g,' '):'';
      const hit=/已向对方发送简历|投递成功|简历已发送/.test(t)
        ||/已向对方发送简历和打招呼语/.test((document.body.innerText||'').replace(/\\s+/g,' '));
      return JSON.stringify({hit});})()`) || '{}');
    if (r.hit) { greet = true; break; }
    await sleep(600);
  }

  if (greet) {
    // 点「留在此页」把弹窗收掉；不点「继续沟通」，那会顺带打开聊天窗
    await cdp.eval(`(()=>{
      const w=document.querySelector('.deliver-greeting-modal__wrapper');
      if(!w) return;
      const b=[...w.querySelectorAll('.deliver-greeting-modal__btn,button,a')].find(x=>/留在此页/.test((x.innerText||'').trim()))
        ||w.querySelector('.deliver-greeting-modal__close');
      if(b) b.click();})()`).catch(() => {});
    await sleep(500);
    return { ok: true };
  }
  // 部分入口不弹成功框，按钮直接变「已投递」
  const nowApplied = await cdp.eval(`[...document.querySelectorAll('button')].some(x=>/^已投递$/.test((x.innerText||'').trim()))`).catch(() => false);
  if (nowApplied) return { ok: true };
  return { ok: false, why: '未出现投递成功提示' };
}

async function runZhilian(cdp, cfg, cityObj, _retry = 0, seed = null) {
  if (!_retry) { STOP_FLAG = false; ABORTED = false; }
  const hist = loadHist();
  const applied = new Set(hist.zhilian || []);
  const typeKey = ZH_TYPE_LABEL[cfg.zhType] ? cfg.zhType : 'intern';
  const edu = cfg.zhEdu || '不限';
  const cityName = cityObj ? String(cityObj.name || '').replace(/[市]$/, '') : '';
  const jl = cityName ? zhCode(cityName) : '';

  log('');
  log(C.B(`▶ 智联招聘 · ${cityName || '全国'} · ${ZH_TYPE_LABEL[typeKey] || '实习'}`));
  info(`关键词 ${cfg.zhKeywords.length} 组，目标投递 ${cfg.zhMax > 0 ? cfg.zhMax + ' 个' : '不限'}`);
  if (typeKey !== 'all' || edu !== '不限') {
    info(C.d(`页面筛选已勾选：工作性质=${ZH_TYPE_LABEL[typeKey] || '不限'}${edu !== '不限' ? ' · 学历=' + edu : ''}（与智联筛选条一致）`));
  }
  if (cityName && !jl) warn(`「${cityName}」没有对应的智联城市码，本轮改为全国搜索`);

  await cdp.attachPage('zhaopin.com');
  await cdp.goto(zhSearchUrl(jl, cfg.zhKeywords[0] || '前端', typeKey, edu), 3200);
  if (!(await guardBlocked(cdp, '智联招聘'))) return null;
  // 确认页面上的筛选条已真的切到目标状态（选中后 label 会显示成「实习」，所以按 trigger 文本判断）
  let trigs = [];
  try {
    trigs = JSON.parse(await cdp.eval(`(()=>JSON.stringify([...document.querySelectorAll('.filter-select-box__trigger')].map(x=>(x.innerText||'').replace(/\\s+/g,' ').trim())))()`) || '[]');
  } catch {}
  const pageFiltered = typeKey !== 'all' && Array.isArray(trigs) && trigs.includes(ZH_TYPE_LABEL[typeKey]);
  if (typeKey !== 'all' && !pageFiltered) {
    warn(`页面筛选条没显示「${ZH_TYPE_LABEL[typeKey]}」，本地会再按工作性质过滤一遍`);
  }

  const pool = new Map();
  const seededZh = seedPool(pool, seed);
  if (seededZh) info(`沿用上次任务采集的 ${seededZh} 个岗位，继续往下投`);
  for (let i = 0; i < cfg.zhKeywords.length; i++) {
    if (STOP_FLAG) { log(C.y('  已手动停止，采集结束')); break; }
    if (enoughCollected(pool, cfg.zhMax)) {
      log(C.d(`  已采集 ${pool.size} 条，够投 ${cfg.zhMax} 个，停止采集`));
      break;
    }
    // 智联未登录时搜索页会弹登录框 / 直接跳 passport，先拦一道
    if (await loginPending(cdp) || await captchaPending(cdp)) {
      log('');
      if (!(await waitForLogin(cdp, '智联招聘'))) return null;
    }
    const kw = cfg.zhKeywords[i];
    logPart(C.d(`  [${i + 1}/${cfg.zhKeywords.length}] 采集「${kw}」... `));
    let arr = [];
    try {
      const url = zhSearchUrl(jl, kw, typeKey, edu);
      await cdp.goto(url, 3200);
      let n = 0;
      for (let k = 0; k < 10; k++) {
        await sleep(800);
        try {
          n = (await cdp.eval(`(typeof __INITIAL_STATE__!=='undefined'&&__INITIAL_STATE__.positionList||[]).length`)) || 0;
        } catch { n = 0; }
        if (n > 0) break;
      }
      if (!n) {
        // 兜底：DOM 抓一遍（个别版本不暴露 __INITIAL_STATE__）
        arr = JSON.parse((await cdp.eval(`(()=>{
          const cs=[...document.querySelectorAll('.job-card')];
          return JSON.stringify(cs.map(c=>({
            id:'', title:((c.querySelector('.vue-clamp__text')||{}).innerText||'').trim(),
            co:((c.querySelector('.job-card__company-name')||{}).innerText||'').trim(),
            sal:((c.querySelector('.job-card__salary')||{}).innerText||'').trim(),
            city:'', wt:'', wtc:'', edu:'', exp:'', applied:false })).filter(x=>x.title&&x.co));})()`) || '[]'));
      } else {
        arr = JSON.parse((await cdp.eval(ZH_COLLECT_JS)) || '[]');
      }
    } catch (e) {
      log(C.y('页面异常，跳过'));
      await sleep(1000);
      continue;
    }
    let add = 0;
    for (const x of arr) {
      const key = x.id || (x.title + '|' + x.co);
      const old = pool.get(key);
      if (!old) { pool.set(key, { ...x, id: key, kw }); add++; }
      // 续投带进来的旧岗位没有详情页地址，这次正好采到同一个岗位，顺手补上
      else if (!old.url && x.url) old.url = x.url;
    }
    log(C.d(`${arr.length} 条，新增 ${add}，累计 ${pool.size}`));
    taskPool(pool);
    await sleep(500);
  }
  if (!pool.size) {
    // 没采到岗位：先确认是不是登录态掉了，等登录后重采一轮
    if (!_retry && (await loginPending(cdp) || await captchaPending(cdp))) {
      if (!(await waitForLogin(cdp, '智联招聘'))) return null;
      return await runZhilian(cdp, cfg, cityObj, 1, seed);
    }
    err('没采集到岗位：可能未登录智联（请在浏览器窗口登录后重试），或该城市该关键词无结果'); return null;
  }

  // 方向过滤
  const ZH_BAD = /销售|客服|话务|电销|外呼|行政|人事|人力资源|财务|会计|出纳|文员|录入|档案|美工|剪辑|短视频|主播|带货|教师|讲师|助教|培训|造价|预算|资料员|跟单|采购|仓管|物流|司机|保安|保洁|护士|医药|法务|律师|保险|信贷|理财|柜员|导购|店长|储备干部|普工|操作工|叉车|打包|分拣|质检|美容|餐饮|厨|房产|中介|招商|渠道|BD|拓展|市场|文案|编辑|策划|设计|平面|UI|运营|算法|嵌入式|硬件|结构|电气|机械|测绘|医药代表|标注/;
  const ZH_GOOD = /前端|全栈|Web|web|Vue|React|Node|小程序|FDE|交付|实施|技术支持|驻场|技术顾问|售前|解决方案|客户成功|低代码|数字化|信息化|Python|Java|Golang|数据开发|AI应用|大模型|Agent|AI开发|AI工程|软件开发|软件工程|研发工程|开发工程师|技术员|运维|系统集成|IT|程序员|产品助理|项目助理/;

  const picked = [];
  for (const x of pool.values()) {
    if (x.applied) continue;                       // 智联自己标记的已投递
    const t = x.title;
    if (!t || t.length < 4) continue;
    if (ZH_BAD.test(t) || !ZH_GOOD.test(t)) continue;
    if (edu !== '不限' && x.edu && !/学历不限/.test(x.edu) && !x.edu.includes(edu)) continue;
    // 工作性质：页面已筛选时完全信任服务端结果，避免个别卡片缺字段被误杀
    const wtKey = zhWtKey(x);
    if (!pageFiltered && typeKey !== 'all' && wtKey !== typeKey) continue;
    let score = 0;
    if (wtKey === 'intern') score += 100;
    else if (wtKey === 'campus') score += 70;
    if (/前端|全栈|Web|Vue|小程序/.test(t)) score += 14;
    if (/交付|实施|技术支持|售前|解决方案|客户成功|FDE/.test(t)) score += 14;
    if (/AI|大模型|Agent/.test(t)) score += 8;
    if (/开发|研发|Python|Java|数据开发|运维|系统集成/.test(t)) score += 6;
    picked.push({
      id: x.id, title: t.slice(0, 44), sal: x.sal || '面议',
      co: x.co, city: x.city || cityName, score, wt: ZH_TYPE_LABEL[wtKey] || (x.wt || ''),
      kw: x.kw, url: x.url || '',
    });
  }
  // 排序：实习段在前；同段内按关键词分组（避免每投一个都重开页面），组间按最高分排
  const gk = x => (x.wt === '实习' ? 'A' : 'B') + '|' + (x.kw || '');
  const gmax = new Map();
  for (const x of picked) gmax.set(gk(x), Math.max(gmax.get(gk(x)) || 0, x.score));
  picked.sort((a, b) => {
    const ka = gk(a), kb = gk(b);
    if (ka !== kb) {
      const sa = ka[0] === 'A' ? 0 : 1, sb = kb[0] === 'A' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ma = gmax.get(ka), mb = gmax.get(kb);
      if (ma !== mb) return mb - ma;
      return ka.localeCompare(kb);
    }
    return b.score - a.score;
  });

  const internCnt = picked.filter(p => p.wt === '实习').length;
  // 采集池里的工作性质分布（解释「为什么一个都没匹配上」时很有用）
  const wtCnt = { intern: 0, fulltime: 0, parttime: 0, campus: 0 };
  for (const x of pool.values()) {
    const k = zhWtKey(x);
    if (wtCnt[k] !== undefined) wtCnt[k]++;
  }
  log('');
  ok(`池 ${pool.size} → 符合条件 ${picked.length}${typeKey === 'all' ? `（其中实习 ${internCnt}）` : ''}`);
  if (!picked.length) {
    const dist = `本轮采集到：实习 ${wtCnt.intern} · 全职 ${wtCnt.fulltime} · 兼职 ${wtCnt.parttime} · 校园 ${wtCnt.campus}`;
    if (typeKey === 'intern') {
      warn(`「${cityName || '全国'}」没有可投的实习岗（${dist}）`);
      info('智联以社招为主，实习岗很少；可把工作性质切到「不限」「校园」或「全职」再试');
    } else if (typeKey === 'campus') {
      warn(`「${cityName || '全国'}」没有可投的校园岗（${dist}）`);
      info('「校园」多是校招专场，岗位少；可切到「不限」或「实习」再试');
    } else {
      warn(`「${cityName || '全国'}」没有符合条件的岗位（${dist}），换个城市或关键词再试`);
    }
    return null;
  }

  const todo = freshFirst(picked.filter(r => !applied.has(r.id))).slice(0, cfg.zhMax > 0 ? cfg.zhMax : 999);
  info(`去重后待投 ${todo.length} 个`);
  if (!todo.length) { warn('这批岗位都投过了，没有新增（换个关键词或城市再试）'); return null; }
  if (cfg.dryRun) {
    info('（试运行：只列出候选，不实际投递）');
    todo.slice(0, 20).forEach((x, i) => info(`${i + 1}. ${x.title} | ${x.co} | ${x.sal} | ${x.wt}`));
    return { sent: [], failed: [], skipped: picked.length, total: picked.length, dry: true };
  }
  if (!cfg.autoYes) {
    const a = await ask(C.b(`\n开始投递 ${todo.length} 个？(Y/n) `));
    if (/^n/i.test(a)) { warn('已取消'); return null; }
  }

  const sent = [], failed = [];
  let blocked = 0;
  let missCnt = 0;
  let curKw = null;
  let missStreak = 0;      // 连续「列表里找不到」的次数
  let listFirst = true;    // false = 这一轮列表页不可用，后面直接走详情页
  for (let i = 0; i < todo.length; i++) {
    if (STOP_FLAG) { warn('已手动停止，本轮中断'); break; }
    const job = todo[i];
    const tag = `[${i + 1}/${todo.length}]`;
    try {
      let r;
      if (!listFirst && job.url) {
        // 列表页已确认不可用，直接打开岗位页
        r = await zhApplyByDetail(cdp, job);
        curKw = null;
      } else {
        // 卡片只在它所属的关键词结果页里，换了关键词就得重新开列表页
        if (job.kw !== curKw) {
          await cdp.goto(zhSearchUrl(jl, job.kw || '', typeKey, edu), 3200);
          for (let k = 0; k < 10; k++) {
            const n = (await cdp.eval(`document.querySelectorAll('.job-card').length`)) || 0;
            if (n > 0) break;
            await sleep(700);
          }
          curKw = job.kw;
          await sleep(800);
        }
        r = await zhApplyOne(cdp, job);
      }
      // 列表里找不到这张卡片：智联搜索结果实时轮换，重新打开关键词页后原岗位常被挤到后面几页。
      // 只要有详情页地址，就直接打开岗位页投，不要白白跳过。
      // 连续两个都失败说明这一轮的列表页本身没渲染出来，后面直接走详情页，省掉每岗 8 秒的空等。
      if (r.miss && job.url) {
        missStreak++;
        const skipList = missStreak >= 2;
        if (skipList) listFirst = false;
        log(`${tag} ${C.d(skipList ? '列表不可用，改走详情页…' : '列表已轮换，改走详情页…')} ${job.title}`);
        r = await zhApplyByDetail(cdp, job);
        curKw = null;         // 页面已经离开列表页，下一个岗位必须重新开列表
      }
      if (r.ok) {
        sent.push(job); applied.add(job.id); blocked = 0; missStreak = 0;
        listFirst = true;     // 投成功说明列表可用，下一个岗位回到「先试列表」的快路径
        taskSent(job);
        log(`${tag} ${C.g('✔')} ${job.title} ${C.d('|')} ${job.co.slice(0, 14)} ${C.d('|')} ${job.sal} ${C.d('|')} ${job.wt}`);
      } else if (r.dup) {
        applied.add(job.id); missStreak = 0;
        log(`${tag} ${C.d('已投过')} ${job.title}`);
      } else if (r.miss) {
        // 列表轮换 / 岗位下架导致定位不到，不算失败，也不计入连续失败
        missCnt++;
        const why = job.url ? (r.why || '找不到该岗位') : '上次任务的岗位已轮换';
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d(`(${why})`)}`);
      } else {
        blocked++;
        failed.push({ ...job, reason: r.why || '未知' });
        taskFailed(job, r.why || '未知');
        log(`${tag} ${C.r('✘')} ${job.title} (${r.why || ''})`);
        if (blocked >= 5) { err('连续 5 次失败，已停止（可能触发了智联的投递限制）'); ABORTED = true; break; }
      }
    } catch (e) {
      // 续投带进来的旧岗位可能早就下架了，打不开不该算「连续失败」，否则会误触发自动停止
      if (job._seed) {
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`);
        continue;
      }
      blocked++;
      failed.push({ ...job, reason: e.message.slice(0, 60) });
      taskFailed(job, e.message.slice(0, 60));
      log(`${tag} ${C.r('✘')} ${job.title} (${e.message.slice(0, 40)})`);
      if (blocked >= 5) { err('连续 5 个岗位都没能投出去，已停止（多半是登录掉了或页面结构变了；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
    }
    await sleep(900);
  }

  if (missCnt) info(`另有 ${missCnt} 个岗位（列表已轮换、详情页也打不开），已跳过`);

  hist.zhilian = [...applied];
  saveHist(hist);
  taskSkip(picked.length - todo.length + missCnt);
  return { sent, failed, skipped: picked.length - todo.length + missCnt, total: picked.length, aborted: ABORTED };
}

// ------------------------------------------------------------------ 猎聘 liepin.com
// 猎聘是客户端渲染的 SPA：搜索结果在 .jobCardPcContainer 里，城市靠 dq 编码过滤（见 lib/liepin-cities.mjs）。
// 详情页 /job/<id>.shtml 对未登录访客会跳 wow.liepin.com 的登录落地页，所以投递前必须先登录一次。
const LP_TYPE_LABEL = { intern: '实习', fulltime: '全职', parttime: '兼职', all: '不限' };
// 学历要求高低：用来按「不高于我的学历」过滤（学历不限=0）
const LP_EDU_RANK = {
  '学历不限': 0, '不限': 0, '初中及以下': 1, '初中': 1, '中专/中技': 2, '中专': 2,
  '高中': 3, '大专': 4, '本科': 5, '硕士': 6, '博士': 7,
};

/** 搜索结果页地址（dq 决定城市，410=全国） */
function lpSearchUrl(kw, cfg, cityName, page = 0) {
  const dq = lpDq(cityName) || LP_NATIONWIDE_DQ;
  const q = [`key=${encodeURIComponent(kw || '')}`, `dq=${dq}`];
  if (page > 0) q.push(`currentPage=${page}`);
  return `https://www.liepin.com/zhaopin/?${q.join('&')}`;
}

// 抓当前搜索结果页的卡片（不依赖易变的 hash 类名，只认结构 + 语义类）
const LP_CARDS_JS = `(()=>{
      const txt=s=>(s||'').replace(/\\s+/g,' ').trim();
      const cards=[...document.querySelectorAll('.jobCardPcContainer')];
      const items=cards.map(c=>{
        const a=c.querySelector('a[href*="/job/"]');
        const href=a?(a.getAttribute('href')||''):'';
        const id=(href.match(/\\/job\\/(\\d+)\\.shtml/)||[])[1]||'';
        const box=c.querySelector('.jobDetailBox')||c;
        const tb=box.querySelector('.jobTitleBox');
        const tEl=tb?tb.querySelector('div'):null;
        const cityEl=tb?tb.querySelector('span.ellipsis-1'):null;
        const salEl=box.querySelector('.jobTitleBox + span');
        const spans=[...box.querySelectorAll('span')].map(s=>txt(s.innerText)).filter(Boolean);
        const edu=spans.find(t=>/^(学历不限|初中及以下|初中|中专\\/中技|中专|高中|大专|本科|硕士|博士)$/.test(t))||'';
        const exp=spans.find(t=>/经验|应届|在校/.test(t))||'';
        return {
          id,
          title: tEl?txt(tEl.innerText):'',
          city: cityEl?txt(cityEl.innerText).replace(/[【】]/g,''):'',
          sal: salEl?txt(salEl.innerText):'',
          edu, exp,
          co: (box.querySelector('.companyName')||{innerText:''}).innerText.trim(),
          rec: (c.querySelector('.recruiterName')||{innerText:''}).innerText.trim(),
          url: href?href.split('?')[0]:'',
        };
      }).filter(x=>x.id && x.title);
      const next=document.querySelector('.ant-pagination-next');
      return JSON.stringify({items, more: !!next && !/disabled/.test(next.className)});
    })()`;

// 详情页状态：可投（申请职位）、已投过、被登录墙挡住、按钮文案
const LP_APPLY_STATE = `(()=>{
      const clean=s=>(s||'').replace(/\\s+/g,'').trim();
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
        return r.width>2 && r.height>2 && st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)!==0; };
      const bodyTxt=(document.body.innerText||'').replace(/\\s+/g,'');
      const BTN=/^(申请职位|立即申请|投递简历|立即投递|申请该职位|投个简历|我要申请|申请)$/;
      const CHAT=/^(聊一聊|聊聊|沟通)$/;
      const btns=[...document.querySelectorAll('.job-apply-container a,.job-apply-container button,.job-apply-operate a,.job-apply-operate button,button,a')]
        .filter(vis).map(e=>({t:clean(e.innerText), cls:String(e.className||'')}))
        .filter(x=>x.t && x.t.length<=10);
      const apply=btns.find(x=>BTN.test(x.t))||null;
      const chat=btns.find(x=>CHAT.test(x.t))||null;
      // 聊天窗口内「发简历」按钮（新版猎聘的投递入口）
      const sendResume=[...document.querySelectorAll('button,a,[class*="btn"],[class*="operate"]')]
        .filter(vis).find(e=>/^(发简历|发送简历|发送我的简历)$/.test(clean(e.innerText)))||null;
      const msgs=[...document.querySelectorAll('[class*="message"],[class*="toast"],[class*="Message"],[class*="tip"]')]
        .filter(vis).map(e=>clean(e.innerText)).filter(t=>t && t.length<40).slice(0,4);
      return JSON.stringify({
        url: location.href,
        apply: apply? apply.t : '',
        chat: chat? chat.t : '',
        hasSendResume: !!sendResume,
        applied: /已申请|已投递|投递成功|申请成功/.test(bodyTxt),
        loginWall: /wow\\.liepin\\.com/i.test(location.href)
          || (!!document.querySelector('input[type="tel"],input[placeholder*="手机号"],input[placeholder*="验证码"]')
              && /登录\\/注册|获取验证码|扫码登录/.test(bodyTxt)),
        msgs,
        btns: btns.map(x=>x.t).slice(0,16)
      });
    })()`;

/** 点「申请职位」→ 若弹确认框就点确认；返回 'CONFIRMED' / 'NEED_RESUME' / 'NONE' */
const LP_CONFIRM_JS = `(()=>{
      const clean=s=>(s||'').replace(/\\s+/g,'').trim();
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
        return r.width>2 && r.height>2 && st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)!==0; };
      const click=el=>{ el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect();
        const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
        ['mouseenter','mousedown','mouseup','click'].forEach(n=>el.dispatchEvent(new MouseEvent(n,o)));
        el.click(); };
      // 全元素兜底：找文本精确等于「立即投递」的最内层可见元素（不限 button/a，兼容 div/span 做按钮）
      const FINAL=/^(立即投递|确认投递|确认发送|确认发简历|投递|立即发送)$/;
      const pickFinal=()=>{
        const els=[...document.querySelectorAll('*')].filter(vis).filter(e=>{
          const t=clean(e.innerText||''); return t.length<=8 && FINAL.test(t);
        });
        // 取「最内层」（子元素个数最少，通常是真正可点的按钮元素）
        els.sort((a,b)=>(a.querySelectorAll('*').length)-(b.querySelectorAll('*').length));
        return els[0]||null;
      };
      const boxes=[...document.querySelectorAll('.ant-modal,.ant-modal-wrap,[class*="dialog"],[class*="Dialog"],[role="dialog"]')].filter(vis);
      for(const b of boxes){
        const t=clean(b.innerText);
        if(/请先完善|完善简历|创建简历/.test(t)) return 'NEED_RESUME';
        const hit=[...b.querySelectorAll('button,a')].filter(vis)
          .find(x=>/^(确定|确认|确认投递|确认发送|确认发简历|投递|发送|立即投递|立即发送|继续投递|申请)$/.test(clean(x.innerText)));
        if(hit){ click(hit); return 'CONFIRMED'; }
      }
      // 弹窗不在标准 dialog class 里时，全元素兜底点「立即投递」
      const fin=pickFinal();
      if(fin){ click(fin); return 'CONFIRMED'; }
      return 'NONE';
    })()`;

/** 点「立即投递」最后一步：专门处理猎聘「选择附件简历」弹窗，含 iframe 兜底，返回详细状态 */
const LP_CLICK_FINAL_JS = `(()=>{
      const clean=s=>(s||'').replace(/\\s+/g,'').trim();
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
        return r.width>2 && r.height>2 && st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)!==0; };
      const FINAL=/^(立即投递)$/;
      const shoot=el=>{ try{
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(n=>el.dispatchEvent(new MouseEvent(n,o)));
        el.click();
        return true;
      }catch{ return false; } };
      const findIn=doc=>{
        if(!doc) return null;
        const els=[...doc.querySelectorAll('*')].filter(vis)
          .filter(e=>{ const t=clean(e.innerText||''); return t.length<=8 && FINAL.test(t); });
        if(!els.length) return null;
        els.sort((a,b)=>(a.querySelectorAll('*').length)-(b.querySelectorAll('*').length));
        return els[0];
      };
      // 先主文档
      let el=findIn(document);
      // 再遍历 iframe（聊天/弹窗可能在 iframe 里）
      if(!el){
        const frames=[...document.querySelectorAll('iframe')].filter(vis);
        for(const f of frames){
          let d=null; try{ d=f.contentDocument; }catch{ continue; }
          el=findIn(d);
          if(el){ break; }
        }
      }
      if(!el) return 'NO_FINAL_BTN';
      const ok=shoot(el);
      return ok?'CLICKED_FINAL':'SHOOT_FAIL';
    })()`;

/** 点「聊一聊」：打开聊天窗口（新版猎聘的直接投递入口） */
const LP_CHAT_APPLY_JS = `(()=>{
      const clean=s=>(s||'').replace(/\\s+/g,'').trim();
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
        return r.width>2 && r.height>2 && st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)!==0; };
      const click=el=>{ if(!el) return false; el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(n=>el.dispatchEvent(new MouseEvent(n,o)));
        el.click(); return true; };
      // 全元素搜索「聊一聊」，取最内层可见元素（猎聘的按钮可能是 button/span/div 任意一种）
      const RE=/^(聊一聊|聊聊|沟通)$/;
      const els=[...document.querySelectorAll('*')].filter(vis).filter(e=>{
        const t=clean(e.innerText||''); return t.length<=8 && RE.test(t);
      });
      els.sort((a,b)=>(a.querySelectorAll('*').length)-(b.querySelectorAll('*').length));
      const chat=els[0]||null;
      if(!chat) return 'NO_CHAT';
      click(chat);
      return 'CHAT_CLICKED';
    })()`;

/** 聊天窗口内点「发简历」完成投递（猎聘的「发简历」是 span.im-ui-action-button，不是 button/a） */
const LP_SEND_RESUME_JS = `(()=>{
      const clean=s=>(s||'').replace(/\\s+/g,'').trim();
      const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
        return r.width>2 && r.height>2 && st.visibility!=='hidden' && st.display!=='none' && Number(st.opacity)!==0; };
      const click=el=>{ if(!el) return false; el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
        ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(n=>el.dispatchEvent(new MouseEvent(n,o)));
        el.click(); return true; };
      // 全元素搜索「发简历/发送简历」，优先 im-ui-action-button / action-resume 类
      const RE=/^(发简历|发送简历|发送我的简历)$/;
      const els=[...document.querySelectorAll('*')].filter(vis).filter(e=>{
        const t=clean(e.innerText||''); return t.length<=8 && RE.test(t);
      });
      els.sort((a,b)=>{
        const sc=(x)=>{ const c=String(x.className||''); if(/action-resume|action-item/.test(c)) return 0; if(/-title/.test(c)) return 2; if(/im-ui-action/.test(c)) return 1; return 3; };
        const ca=sc(a)-sc(b); if(ca) return ca;
        return (a.querySelectorAll('*').length)-(b.querySelectorAll('*').length);
      });
      const btn=els[0]||null;
      if(!btn) return 'NO_SEND_BTN';
      click(btn);
      return 'SEND_CLICKED';
    })()`;

// 采集：多关键词 × 翻页，全靠解析搜索结果页（猎聘接口有反爬签名，直接调会被 400 拒掉）
async function lpCollect(cdp, cfg, cityName) {
  const pool = new Map();
  let pageErr = '';
  const kws = cfg.lpKeywords || [];
  for (let i = 0; i < kws.length; i++) {
    if (STOP_FLAG) { warn('已手动停止'); break; }
    if (enoughCollected(pool, cfg.lpMax)) {
      log(C.d(`  已采集 ${pool.size} 条，够投 ${cfg.lpMax} 个，停止采集`));
      break;
    }
    const kw = kws[i];
    logPart(C.d(`  [${i + 1}/${kws.length}] 采集「${kw}」... `));
    try {
      await cdp.goto(lpSearchUrl(kw, cfg, cityName, 0), 4200);
    } catch (e) { pageErr = e.message.slice(0, 40); }
    let added = 0, seen = 0;
    for (let p = 0; p < 3; p++) {
      if (STOP_FLAG) break;
      let r = { items: [], more: false };
      try { r = JSON.parse(await cdp.eval(LP_CARDS_JS) || '{}'); } catch (e) { pageErr = e.message.slice(0, 40); }
      for (const x of r.items || []) {
        if (!x.id || !x.title) continue;
        seen++;
        if (!pool.has(x.id)) { pool.set(x.id, { ...x, kw }); added++; }
      }
      if (!r.more || enoughCollected(pool, cfg.lpMax)) break;
      const clicked = await cdp.eval(`(()=>{
        const n=document.querySelector('.ant-pagination-next');
        if(!n || /disabled/.test(n.className)) return 'NOMORE';
        (n.querySelector('button')||n).click();
        return 'OK';})()`);
      if (clicked !== 'OK') break;
      await sleep(2600);
    }
    log(C.d(`本页 ${seen} 条，新增 ${added}，累计 ${pool.size}`));
    await sleep(500);
  }
  return { pool, pageErr };
}

// 技术相关岗位筛选（各平台共用同一份词表）
const LP_BAD = /销售|客服|运营|教师|助教|讲师|编辑|文案|剪辑|美工|人事|行政|财务|会计|出纳|招聘|主播|标注|算法|嵌入式|硬件|结构|电气|机械|测绘|造价|医药|护理|律师|幼师|保育|餐厅|厨师|导购|收银|保安|保洁|库管|仓管|司机|普工|质检|化学|生物|环境|土木|建筑|水电|预算|电工|焊工|模具|数控|汽车|美容|美发|摄影|直播|地推|业务员|店长|督导|翻译|外贸|法务|审计|税务|保险|银行|证券|房产|中介|维修|农林|农业|消防|采样|检测|化验|机电|弱电|强电|测量|施工|安装|售后|驾驶|仓储|物流|物业|餐饮|文员/;
const LP_GOOD = /前端|全栈|Web|web|Vue|React|Node|小程序|H5|FDE|交付|实施|技术支持|驻场|技术顾问|售前|解决方案|客户成功|低代码|数字化|信息化|Python|Java|Golang|Go开发|数据开发|数据分析|AI|人工智能|大模型|Agent|软件开发|软件工程|研发工程|程序员|开发工程师|软件测试|测试工程师|运维|产品助理|项目助理|系统集成|网络工程|信息系统|计算机|信息科技/;

/** 从采集池挑岗位：技术相关 + 工作性质 + 学历不高于所选 */
function lpPick(pool, cfg, cityName) {
  const typeKey = cfg.lpType || 'intern';
  const eduKey = cfg.lpEdu || '不限';
  const eduMax = eduKey === '不限' ? 99 : (LP_EDU_RANK[eduKey] || 99);
  const picked = [];
  for (const x of pool.values()) {
    const t = x.title || '';
    if (!t || t.length < 3) continue;
    if (LP_BAD.test(t) || !LP_GOOD.test(t)) continue;
    const tag = `${x.exp || ''} ${x.edu || ''}`;
    // 工作性质：猎聘没有可靠的「实习」筛选参数，按标题/标签兜一层
    if (typeKey === 'intern' && !/实习|在校|应届/.test(t + tag)) continue;
    if (typeKey === 'fulltime' && /实习|兼职/.test(t)) continue;
    if (typeKey === 'parttime' && !/兼职|临时/.test(t)) continue;
    const rank = LP_EDU_RANK[x.edu] ?? 0;
    if (rank > eduMax) continue;
    if (/2028|28届|29届|博士/.test(t) && !/本科|大专|统招/.test(t)) continue;
    let score = 0;
    if (/前端|全栈|Web|Vue|小程序|H5/.test(t)) score += 12;
    if (/交付|实施|技术支持|售前|解决方案|客户成功|FDE/.test(t)) score += 14;
    if (/AI|人工智能|大模型|Agent/.test(t)) score += 8;
    if (/Python|Java|Golang|数据开发|软件开发|研发|开发工程师/.test(t)) score += 5;
    if (/实习/.test(t + tag)) score += 6;
    picked.push({
      id: x.id, title: t.slice(0, 44), co: x.co || '—', sal: x.sal || '面议',
      city: x.city || cityName || '', edu: x.edu || '', rec: x.rec || '', url: x.url || '', score,
    });
  }
  picked.sort((a, b) => b.score - a.score);
  return picked;
}

async function runLiepin(cdp, cfg, cityObj, _retry = 0, seed = null) {
  if (!_retry) { STOP_FLAG = false; ABORTED = false; }
  const hist = loadHist();
  const applied = new Set(hist.liepin || []);
  const typeKey = cfg.lpType || 'intern';
  const typeLabel = LP_TYPE_LABEL[typeKey] || '实习';
  const edu = cfg.lpEdu || '不限';
  const cityName = cityObj ? String(cityObj.name || '').replace(/[市]$/, '') : '';
  const dq = lpDq(cityName);
  const place = cityName && dq ? cityName : '全国';

  log('');
  log(C.B(`▶ 猎聘 · ${typeLabel}岗 · ${place}`));
  info(`关键词 ${(cfg.lpKeywords || []).length} 组，目标投递 ${cfg.lpMax > 0 ? cfg.lpMax + ' 个' : '不限'}`);
  info(`筛选：工作性质=${typeLabel}${edu !== '不限' ? ' · 学历≤' + edu : ''}${cityName && dq ? ' · 地区=' + cityName : ' · 全国'}`);
  if (cityName && !dq) warn(`猎聘没有「${cityName}」这个城市编码，本次按全国搜（可在左侧换成列表里的城市）`);

  await cdp.attachPage('liepin.com');
  const { pool, pageErr } = await lpCollect(cdp, cfg, cityName && dq ? cityName : '');
  const seededLp = seedPool(pool, seed);
  if (seededLp) info(`沿用上次任务采集的 ${seededLp} 个岗位，继续往下投`);
  taskPool(pool);
  if (!pool.size) {
    if (!_retry && (await loginPending(cdp) || await captchaPending(cdp))) {
      if (!(await waitForLogin(cdp, '猎聘'))) return null;
      return await runLiepin(cdp, cfg, cityObj, 1, seed);
    }
    if (pageErr) err('采集失败：' + pageErr);
    else err(`没搜到岗位：换个关键词，或换城市（猎聘${place === '全国' ? '搜索结果偏一线城市' : '该城市岗位较少'}）`);
    return null;
  }

  const picked = lpPick(pool, cfg, place === '全国' ? '' : place);
  log('');
  ok(`池 ${pool.size} → 符合条件 ${picked.length}`);
  if (!picked.length) {
    warn(`没有符合「${(cfg.lpKeywords || []).join('/')}」的${typeLabel}岗，可换个关键词或把工作性质改成「不限」`);
    return null;
  }

  const todo = freshFirst(picked.filter(r => !applied.has(r.id))).slice(0, cfg.lpMax > 0 ? cfg.lpMax : 999);
  info(`去重后待投 ${todo.length} 个`);
  if (!todo.length) { warn('这批岗位都投过了，没有新增（换个关键词或城市再试）'); return null; }
  if (!cfg.autoYes) {
    const a = await ask(C.b(`\n开始投递 ${todo.length} 个？(Y/n) `));
    if (/^n/i.test(a)) { warn('已取消'); return null; }
  }

  const sent = [], failed = [];
  let blocked = 0;
  for (let i = 0; i < todo.length; i++) {
    if (STOP_FLAG) { warn('已手动停止，本轮中断'); break; }
    const job = todo[i];
    const tag = `[${i + 1}/${todo.length}]`;
    const detailUrl = job.url || `https://www.liepin.com/job/${job.id}.shtml`;
    try {
      await cdp.goto(detailUrl, 3800);
      let st = {};
      try { st = JSON.parse(await cdp.eval(LP_APPLY_STATE) || '{}'); } catch {}

      // 未登录访客会被丢到 wow.liepin.com 的登录落地页：停下等登录，登录后重开详情页
      if (st.loginWall || await loginPending(cdp) || await captchaPending(cdp)) {
        if (!(await waitForLogin(cdp, '猎聘'))) return null;
        await sleep(1200);
        await cdp.goto(detailUrl, 4000);
        try { st = JSON.parse(await cdp.eval(LP_APPLY_STATE) || '{}'); } catch {}
      }

      if (st.loginWall) {
        // 登录了还挡：说明这个号没有查看详情权限，或页面被风控
        blocked++;
        failed.push({ ...job, reason: '详情页要求登录' });
        taskFailed(job, '详情页要求登录');
        log(`${tag} ${C.r('✘')} ${job.title} (详情页要求登录)`);
        if (blocked >= 5) { err('连续 5 个岗位都打不开，已停止（多半是登录态失效或被风控；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
        continue;
      }

      if (st.applied || /已申请|已投递/.test((st.btns || []).join(''))) {
        applied.add(job.id);
        log(`${tag} ${C.d('已投过')} ${job.title}`);
        continue;
      }
      if (!st.apply && !st.chat) {
        if (job._seed) { log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`); continue; }
        // 既没有「申请」也没有「聊一聊」按钮的岗位投不了：记成跳过，并把实际按钮写进日志，方便判断页面改版
        const others = (st.btns || []).filter(t => /聊|沟通|收藏/.test(t)).join('/') || '无按钮';
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(仅支持沟通：' + others + ')')}`);
        continue;
      }

      // 点「申请职位」（有直接投递按钮）或「聊一聊 → 发简历」（新版流程）
      let clicked = '';
      if (st.apply) {
        clicked = await cdp.eval(`(()=>{
        const clean=s=>(s||'').replace(/\\s+/g,'').trim();
        const vis=e=>{ if(!e) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
          return r.width>2 && r.height>2 && st.display!=='none' && st.visibility!=='hidden'; };
        const BTN=/^(申请职位|立即申请|投递简历|立即投递|申请该职位|投个简历|我要申请|申请)$/;
        const el=[...document.querySelectorAll('.job-apply-container a,.job-apply-container button,.job-apply-operate a,.job-apply-operate button,button,a')]
          .filter(vis).find(e=>BTN.test(clean(e.innerText)));
        if(!el) return 'NOBTN';
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect();
        const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
        ['mouseenter','mousedown','mouseup','click'].forEach(n=>el.dispatchEvent(new MouseEvent(n,o)));
        el.click();
        return 'CLICKED';})()`);
        await sleep(2600);
      } else {
        // 新版猎聘：点「聊一聊」即完成投递，无需再点「发简历」
        clicked = await cdp.eval(LP_CHAT_APPLY_JS) || 'NONE';
        await sleep(2600);
      }

      // 确认弹窗（仅「申请职位」流程需要二次确认/选简历；「聊一聊」点完即完成，无需再点）
      let confirm = 'NONE';
      if (st.apply) {
        try { confirm = await cdp.eval(LP_CONFIRM_JS) || 'NONE'; } catch {}
        // 「申请职位」会弹「选简历 / 二次确认」框，弹窗可能异步出现，多轮兜底点
        if (confirm !== 'CONFIRMED') {
          for (let k = 0; k < 4; k++) {
            await sleep(900);
            try {
              const f = await cdp.eval(LP_CLICK_FINAL_JS) || 'NONE';
              if (f === 'CLICKED_FINAL') { confirm = 'CONFIRMED'; break; }
              const c2 = await cdp.eval(LP_CONFIRM_JS) || 'NONE';
              if (c2 === 'CONFIRMED') { confirm = 'CONFIRMED'; break; }
            } catch {}
          }
        }
        if (confirm === 'CONFIRMED') await sleep(2200);
      }

      let after = {};
      try { after = JSON.parse(await cdp.eval(LP_APPLY_STATE) || '{}'); } catch {}
      const sig = [...(after.msgs || []), after.apply || '', after.chat || '', ...(after.btns || [])].join(' | ');
      const sentSig = /已申请|已投递|投递成功|申请成功|简历已发送|已发送简历|简历发送成功|已发简历/.test(sig);
      // 新版猎聘：点「聊一聊」即完成投递，无需再点「发简历」
      const chatDone = clicked === 'CHAT_CLICKED';

      if (after.applied || sentSig || chatDone) {
        sent.push(job); applied.add(job.id); blocked = 0;
        taskSent(job);
        log(`${tag} ${C.g('✔')} ${job.title} ${C.d('|')} ${job.sal} ${C.d('|')} ${job.city || '—'}`);
      } else if (/完善简历|创建简历|填写简历|请先.*简历/.test(sig) || confirm === 'NEED_RESUME') {
        failed.push({ ...job, reason: '需先完善在线简历' });
        taskFailed(job, '需先完善在线简历');
        log(`${tag} ${C.y('需简历')} ${job.title} ${C.d('(请先在猎聘完善在线简历)')}`);
      } else if (/已结束|已下线|停止招聘|不能投递|不可投递|职位已关闭/.test(sig)) {
        log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(岗位已关闭)')}`);
      } else {
        blocked++;
        const why = `点击=${clicked} 确认=${confirm} 结果=${(sig || '无反馈').slice(0, 60)}`;
        failed.push({ ...job, reason: why });
        taskFailed(job, why);
        log(`${tag} ${C.r('✘')} ${job.title} (${(sig || '无反馈').slice(0, 40)})`);
        if (blocked >= 5) { err('连续 5 个岗位都没能投出去，已停止（多半是页面改版或登录掉了；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
      }
    } catch (e) {
      if (job._seed) { log(`${tag} ${C.d('跳过')} ${job.title} ${C.d('(上次任务的岗位已失效)')}`); continue; }
      blocked++;
      failed.push({ ...job, reason: e.message.slice(0, 60) });
      taskFailed(job, e.message.slice(0, 60));
      log(`${tag} ${C.r('✘')} ${job.title} (${e.message.slice(0, 40)})`);
      if (blocked >= 5) { err('连续 5 个岗位都没能投出去，已停止（多半是登录掉了或页面结构变了；任务已存档，可在「历史任务」里继续）'); ABORTED = true; break; }
    }
    await sleep(cfg.delayMs);
  }

  hist.liepin = [...applied];
  saveHist(hist);
  taskSkip(picked.length - todo.length);
  return { sent, failed, skipped: picked.length - todo.length, total: picked.length, aborted: ABORTED };
}

// ------------------------------------------------------------------ 自检
async function selfCheck() {
  log('');
  log(C.B('▶ 环境自检'));
  const br = findBrowser();
  br ? ok(`${br.name} 已安装${br.cached ? '（上次检测已记住）' : ''}：${br.exe}`) : err('未找到 Chrome / Edge（Windows 一般自带 Edge，请确认没有被精简掉）');
  chromeRunning() ? ok('浏览器正在运行') : warn('浏览器未运行（程序会自动启动）');
  const d = await discover();
  if (d.ok) ok(`调试通道正常（端口 ${d.port}，${d.mode}）`);
  else { warn('调试通道未开启'); info('先启动程序中的投递功能，会自动拉起浏览器'); }
  if (d.ok) {
    try {
      const cdp = await getCdp();
      const v = await cdp.send('Browser.getVersion', {}, null);
      ok('CDP 连接成功：' + v.product);
      const { targetInfos } = await cdp.send('Target.getTargets', {}, null);
      const pages = targetInfos.filter(t => t.type === 'page');
      info(`当前 ${pages.length} 个标签页`);
      const hasBoss = pages.some(p => (p.url || '').includes('zhipin'));
      const hasNk = pages.some(p => (p.url || '').includes('nowcoder'));
      const hasLp = pages.some(p => (p.url || '').includes('liepin'));
      hasBoss ? ok('BOSS 标签页存在') : warn('未发现 BOSS 标签页（投递时会自动打开）');
      hasNk ? ok('牛客标签页存在') : warn('未发现牛客标签页');
      hasLp ? ok('猎聘标签页存在') : warn('未发现猎聘标签页（投递时会自动打开）');
    } catch (e) { err('CDP 连接失败：' + e.message); }
  }
  const hist = loadHist();
  info(`历史已投：BOSS ${(hist.boss || []).length} 个，牛客 ${(hist.nowcoder || []).length} 个，智联 ${(hist.zhilian || []).length} 个，猎聘 ${(hist.liepin || []).length} 个`);
  info(`数据目录：${DATA_DIR}`);
}

// ------------------------------------------------------------------ 主菜单
function banner() {
  console.clear?.();
  log('');
  log(C.b('  ╔══════════════════════════════════════════╗'));
  log(C.b('  ║') + C.B('            简递  v1.0                    ') + C.b('║'));
  log(C.b('  ║') + C.d('  BOSS/牛客/智联/猎聘 · 自动采投           ') + C.b('║'));
  log(C.b('  ╚══════════════════════════════════════════╝'));
  log('');
}

async function main() {
  try { process.title = '简递'; } catch {}
  let cfg = loadCfg();

  // ---------- 命令行模式 ----------
  const ARGS = process.argv.slice(2);
  const flag = n => ARGS.includes('--' + n);
  const opt = (n, d) => {
    const a = ARGS.find(x => x.startsWith('--' + n + '='));
    return a ? a.slice(n.length + 3) : d;
  };

  if (flag('help') || flag('h')) {
    log('');
    log(C.B('  简递 · 命令行用法'));
    log('');
    log('   简递.exe                          启动菜单（推荐）');
    log('   简递.exe --check                  环境自检');
    log('   简递.exe --boss --city=南宁       投递 BOSS 指定城市');
    log('   简递.exe --boss --city=南宁 --max=20 --yes');
    log('   简递.exe --nowcoder --max=30 --yes');
    log('   简递.exe --liepin --max=20 --yes   投递猎聘（默认全国）');
    log('   简递.exe --liepin --city=南宁 --max=10');
    log('');
    log(C.d('   可选：--max=N 单次数量  --yes 免确认  --kw="前端 全栈" 自定义关键词（四平台共用）'));
    log(C.d('        --lptype=intern|fulltime|parttime|all  猎聘工作性质'));
    log('');
    process.exit(0);
  }

  if (flag('check')) { await selfCheck(); process.exit(0); }

  if (flag('boss') || flag('nowcoder') || flag('zhilian') || flag('liepin')) {
    cfg.autoYes = flag('yes');
    const m = opt('max', null);
    if (m) { cfg.bossMax = Number(m); cfg.nkMax = Number(m); cfg.zhMax = Number(m); cfg.lpMax = Number(m); }
    const tp = opt('type', null);
    if (tp) cfg.nkRecruitType = tp === 'campus' ? 'campus' : tp === 'all' ? 'all' : 'intern';
    const ztp = opt('zhtype', null);
    if (ztp) cfg.zhType = ZH_TYPE_LABEL[ztp] ? ztp : 'intern';
    const ltp = opt('lptype', null);
    if (ltp) cfg.lpType = LP_TYPE_LABEL[ltp] ? ltp : 'intern';
    const kw = opt('kw', null);
    if (kw) cfg.keywords = kw.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean);
    const d = await ensureChrome(flag('boss') ? 'boss' : flag('zhilian') ? 'zh' : flag('liepin') ? 'lp' : 'nk');
    if (!d.ok) process.exit(1);
    const cdp = await getCdp();
    if (flag('boss')) {
      const name = opt('city', '南宁');
      const city = CITIES.find(c => c.name === name) || CITIES[0];
      const r = await runBoss(cdp, city, cfg);
      if (r) {
        log('');
        ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
        ok('报告：' + writeReport('BOSS', city.name, r.sent, r.skipped, r.failed, r.total));
      }
    } else if (flag('zhilian')) {
      const cityName = opt('city', '南宁');
      const city = findCity(cityName) || findCity('南宁');
      const r = await runZhilian(cdp, cfg, city);
      if (r) {
        log('');
        ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
        ok('报告：' + writeReport('智联', city ? city.name : null, r.sent, r.skipped, r.failed, r.total));
      }
    } else if (flag('liepin')) {
      const cityName = opt('city', null);
      const city = cityName ? { name: cityName } : null;
      const r = await runLiepin(cdp, cfg, city);
      if (r) {
        log('');
        ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
        ok('报告：' + writeReport('猎聘', cityName || null, r.sent, r.skipped, r.failed, r.total));
      }
    } else {
      const cityName = opt('city', '南宁');
      const city = findCity(cityName) || findCity('南宁');
      const r = await runNowcoder(cdp, cfg, city);
      if (r) {
        log('');
        ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
        ok('报告：' + writeReport('牛客', city ? city.name : null, r.sent, r.skipped, r.failed, r.total));
      }
    }
    if (RL) RL.close();
    process.exit(0);
  }

  // ---------- 交互菜单 ----------
  while (true) {
    banner();
    const hist = loadHist();
    log(C.d(`  已投记录：BOSS ${(hist.boss || []).length} · 牛客 ${(hist.nowcoder || []).length} · 智联 ${(hist.zhilian || []).length} · 猎聘 ${(hist.liepin || []).length}`));
    log('');
    log('   ' + C.B('1') + '  BOSS 直聘  · 按城市投递');
    log('   ' + C.B('2') + '  牛客网      · 实习岗一键投');
    log('   ' + C.B('3') + '  智联招聘    · 按工作性质 + 城市投递');
    log('   ' + C.B('4') + '  猎聘        · 中高端岗多，按城市 + 关键词投');
    log('   ' + C.B('5') + '  环境自检');
    log('   ' + C.B('6') + '  修改关键词 / 投递数量 / 筛选条件');
    log('   ' + C.B('7') + '  查看数据目录');
    log('   ' + C.B('0') + '  退出');
    log('');
    const c = await ask(C.b('  请选择 > '));

    if (c === '0') { log('\n  再见 👋\n'); if (RL) RL.close(); process.exit(0); }

    if (c === '5') { await selfCheck(); await pause(); continue; }

    if (c === '7') {
      log('');
      info('程序目录：' + APP_DIR);
      info('数据目录：' + DATA_DIR);
      try {
        const files = fs.readdirSync(DATA_DIR);
        if (files.length) { info('文件：'); files.forEach(f => log(C.d('      ' + f))); }
        else info('（暂无文件）');
      } catch { info('（目录尚未创建）'); }
      log('');
      await pause();
      continue;
    }

    if (c === '6') {
      log('');
      log(C.B('  当前配置'));
      info('检索关键词（四平台共用）：' + (cfg.keywords.length ? cfg.keywords.join('、') : '（未填）'));
      info(`单次投递上限：BOSS ${cfg.bossMax > 0 ? cfg.bossMax : "不限"} · 牛客 ${cfg.nkMax > 0 ? cfg.nkMax : "不限"} · 智联 ${cfg.zhMax > 0 ? cfg.zhMax : "不限"} · 猎聘 ${cfg.lpMax > 0 ? cfg.lpMax : "不限"}`);
      info(`BOSS 求职类型：${BOSS_TYPE_LABEL[bossTypeKey(cfg)]}`);
      info(`智联工作性质：${ZH_TYPE_LABEL[cfg.zhType] || '实习'}`);
      info(`猎聘工作性质：${LP_TYPE_LABEL[cfg.lpType] || '实习'}${cfg.lpEdu && cfg.lpEdu !== '不限' ? ' · 学历≤' + cfg.lpEdu : ''}`);
      log('');
      log('   ' + C.B('1') + ' 改检索关键词（四平台共用 · 空格分隔）');
      log('   ' + C.B('4') + ' 改投递数量');
      log('   ' + C.B('5') + ' 改牛客岗位类型（当前：' + C.b(NK_TYPE_LABEL[cfg.nkRecruitType] || '实习') + '）');
      log('   ' + C.B('6') + ' 改智联工作性质（当前：' + C.b(ZH_TYPE_LABEL[cfg.zhType] || '实习') + '）');
      log('   ' + C.B('7') + ' 改 BOSS 求职类型（当前：' + C.b(BOSS_TYPE_LABEL[bossTypeKey(cfg)]) + '）');
      log('   ' + C.B('8') + ' 改猎聘关键词 / 工作性质 / 学历');
      log('   ' + C.B('9') + ' 恢复默认');
      log('   ' + C.B('0') + ' 返回');
      const s = await ask(C.b('  请选择 > '));
      if (s === '1' || s === '2' || s === '3') {
        // 关键词四个平台通用，1/2/3 都指向同一份（老用户习惯按 2、3 也不会落空）
        const v = await ask('  检索关键词（空格分隔，四平台共用）> ');
        if (v) { cfg.keywords = v.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean); saveCfg(cfg); ok('已保存'); }
      } else if (s === '4') {
        cfg.bossMax = await askNum('  BOSS 单次上限 > ', cfg.bossMax);
        cfg.nkMax = await askNum('  牛客单次上限 > ', cfg.nkMax);
        cfg.zhMax = await askNum('  智联单次上限 > ', cfg.zhMax);
        cfg.lpMax = await askNum('  猎聘单次上限 > ', cfg.lpMax);
        saveCfg(cfg); ok('已保存');
      } else if (s === '5') {
        log('');
        log('   ' + C.B('1') + ' 实习（推荐 · 一键投递）');
        log('   ' + C.B('2') + ' 校招（多数要走网申）');
        log('   ' + C.B('3') + ' 全部职位');
        const t = await ask(C.b('  请选择 > '));
        cfg.nkRecruitType = t === '2' ? 'campus' : t === '3' ? 'all' : 'intern';
        saveCfg(cfg); ok('已设为「' + NK_TYPE_LABEL[cfg.nkRecruitType] + '」');
        if (cfg.nkRecruitType !== 'intern') warn('校招/全部职位里很多是「专场招聘」，只能走企业网申，投递成功率会低很多');
      } else if (s === '6') {
        log('');
        log('   ' + C.B('1') + ' 不限');
        log('   ' + C.B('2') + ' 全职');
        log('   ' + C.B('3') + ' 实习（与智联筛选一致，默认）');
        log('   ' + C.B('4') + ' 兼职/临时');
        log('   ' + C.B('5') + ' 校园');
        const t = await ask(C.b('  请选择 > '));
        cfg.zhType = t === '1' ? 'all' : t === '2' ? 'fulltime' : t === '4' ? 'parttime' : t === '5' ? 'campus' : 'intern';
        saveCfg(cfg); ok('已设为「' + ZH_TYPE_LABEL[cfg.zhType] + '」');
        if (cfg.zhType === 'intern') warn('智联以社招为主，实习岗在多数城市很少');
      } else if (s === '7') {
        log('');
        log('   ' + C.B('1') + ' 不限');
        log('   ' + C.B('2') + ' 全职');
        log('   ' + C.B('3') + ' 兼职');
        log('   ' + C.B('4') + ' 实习（与 BOSS 筛选一致，默认）');
        const t = await ask(C.b('  请选择 > '));
        cfg.bossType = t === '1' ? 'all' : t === '2' ? 'fulltime' : t === '3' ? 'parttime' : 'intern';
        saveCfg(cfg); ok('已设为「' + BOSS_TYPE_LABEL[cfg.bossType] + '」');
        if (cfg.bossType === 'intern') info('BOSS 上实习岗以「150~200 元/天」标价，数量比社招少，可多配几个「XX实习」关键词');
      } else if (s === '8') {
        log('');
        log(C.B('  猎聘设置'));
        log('   ' + C.B('1') + ' 改关键词（四平台共用 · 当前：' + C.d(cfg.keywords.join('、')) + '）');
        log('   ' + C.B('2') + ' 改工作性质（当前：' + C.b(LP_TYPE_LABEL[cfg.lpType] || '实习') + '）');
        log('   ' + C.B('3') + ' 改学历上限（当前：' + C.b(cfg.lpEdu || '不限') + '）');
        const g = await ask(C.b('  请选择 > '));
        if (g === '1') {
          const v = await ask('  检索关键词（空格分隔，四平台共用）> ');
          if (v) { cfg.keywords = v.split(/[\s,，]+/).map(x => x.trim()).filter(Boolean); saveCfg(cfg); ok('已保存'); }
        } else if (g === '2') {
          log('');
          log('   ' + C.B('1') + ' 实习（推荐 · 默认）');
          log('   ' + C.B('2') + ' 全职');
          log('   ' + C.B('3') + ' 兼职');
          log('   ' + C.B('4') + ' 不限');
          const t = await ask(C.b('  请选择 > '));
          cfg.lpType = t === '2' ? 'fulltime' : t === '3' ? 'parttime' : t === '4' ? 'all' : 'intern';
          saveCfg(cfg); ok('已设为「' + LP_TYPE_LABEL[cfg.lpType] + '」');
        } else if (g === '3') {
          log('');
          log('   ' + C.B('1') + ' 不限');
          log('   ' + C.B('2') + ' 大专');
          log('   ' + C.B('3') + ' 本科');
          const t = await ask(C.b('  请选择 > '));
          cfg.lpEdu = t === '2' ? '大专' : t === '3' ? '本科' : '不限';
          saveCfg(cfg); ok('已设为「' + cfg.lpEdu + '」');
        }
      } else if (s === '9') {
        cfg = { ...DEFAULT_CFG }; saveCfg(cfg); ok('已恢复默认');
      }
      await sleep(500);
      continue;
    }

    if (c === '1') {
      log('');
      log(C.B('  选择城市'));
      CITIES.forEach((x, i) => log(`   ${C.B(String(i + 1).padStart(2))}  ${x.name}`));
      log('');
      const idx = await askNum(C.b('  城市编号 > '), 1);
      const city = CITIES[Math.max(0, Math.min(CITIES.length - 1, idx - 1))];
      const d = await ensureChrome('boss');
      if (!d.ok) { await pause(); continue; }
      try {
        const cdp = await getCdp();
        const r = await runBoss(cdp, city, cfg);
        if (r) {
          log('');
          log(C.B('  ── 完成 ──'));
          ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
          const f = writeReport('BOSS', city.name, r.sent, r.skipped, r.failed, r.total);
          ok('报告：' + f);
        }
      } catch (e) { err('运行出错：' + e.message); }
      await pause();
      continue;
    }

    if (c === '2') {
      const d = await ensureChrome('nk');
      if (!d.ok) { await pause(); continue; }
      try {
        const cdp = await getCdp();
        // 牛客也用「上次选的城市」做地区限制（记录为空则全国）
        const city = findCity(cfg.city) || findCity('南宁');
        const r = await runNowcoder(cdp, cfg, city);
        if (r) {
          log('');
          log(C.B('  ── 完成 ──'));
          ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
          const f = writeReport('牛客', city ? city.name : null, r.sent, r.skipped, r.failed, r.total);
          ok('报告：' + f);
        }
      } catch (e) { err('运行出错：' + e.message); }
      await pause();
      continue;
    }

    if (c === '3') {
      const d = await ensureChrome('zh');
      if (!d.ok) { await pause(); continue; }
      try {
        const cdp = await getCdp();
        const city = findCity(cfg.city) || findCity('南宁');
        const r = await runZhilian(cdp, cfg, city);
        if (r) {
          log('');
          log(C.B('  ── 完成 ──'));
          ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
          const f = writeReport('智联', city ? city.name : null, r.sent, r.skipped, r.failed, r.total);
          ok('报告：' + f);
        }
      } catch (e) { err('运行出错：' + e.message); }
      await pause();
      continue;
    }

    if (c === '4') {
      log('');
      log(C.B('  选择城市（猎聘）'));
      log('   ' + C.B('00') + '  全国（推荐 · 岗位最多）');
      LP_CITIES.slice(0, 40).forEach((n, i) => log(`   ${C.B(String(i + 1).padStart(2))}  ${n}`));
      log(C.d('      只列出前 40 个城市，更多城市可在图形界面里搜索'));
      log('');
      const idx = await askNum(C.b('  地区编号 > '), 0);
      const lpName = idx > 0 ? LP_CITIES[Math.max(0, Math.min(LP_CITIES.length - 1, idx - 1))] : '';
      const d = await ensureChrome('lp');
      if (!d.ok) { await pause(); continue; }
      try {
        const cdp = await getCdp();
        const r = await runLiepin(cdp, cfg, lpName ? { name: lpName } : null);
        if (r) {
          log('');
          log(C.B('  ── 完成 ──'));
          ok(`成功 ${r.sent.length} · 失败 ${r.failed.length} · 跳过 ${r.skipped}`);
          const f = writeReport('猎聘', lpName || null, r.sent, r.skipped, r.failed, r.total);
          ok('报告：' + f);
        }
      } catch (e) { err('运行出错：' + e.message); }
      await pause();
      continue;
    }

    // 无效输入
    await sleep(300);
  }
}

// 图形界面模式（AAB_GUI=1）下只作为模块被加载，不启动命令行主流程
if (process.env.AAB_GUI !== '1') main().catch(async e => {
  if (e && e.message === '__EOF__') { try { if (RL) RL.close(); } catch {} process.exit(0); }
  console.error('\n程序异常：', (e && e.message) || e);
  if (process.env.AAB_DEBUG) console.error('详细：', e && e.stack);
  try { if (RL) RL.close(); } catch {}
  // 双击运行时避免窗口一闪而过
  if (process.stdin.isTTY) {
    try { await ask('\n按回车退出...'); } catch {}
  }
  process.exitCode = 1;
});

// ------------------------------------------------------------------ 导出（供图形界面调用）
export {
  runBoss, runNowcoder, runZhilian, runLiepin, selfCheck, ensureChrome, getCdp,
  loadCfg, saveCfg, loadHist, saveHist, writeReport,
  TASK_DIR,
  CITIES, ALL_CITIES, findCity, DEFAULT_CFG, NK_TYPE_LABEL, ZH_TYPE_LABEL, LP_TYPE_LABEL, BOSS_TYPE_LABEL,
  DATA_DIR, APP_DIR, C, sleep,
  applyNkCity, applyNkEdu, zhCode, LP_CITIES, lpDq, lpSearchUrl, lpCollect, lpPick,
};

// 仅用于自动化测试：登录判定与跨标签页同步
export const __test = { loginPending, captchaPending, waitForLogin, loggedInElsewhere, resyncWorkPage, LOGIN_JS, OTHER_TAB_JS, findBrowser, browserCandidates, chromeRunning, startChrome, zhApplyByDetail, zhApplyOne };

// ------------------------------------------------------------------ 智能体
// 复用同一个数据目录、日志管道和浏览器调试连接，不额外起进程、不碰投递主链路
Agt.initAgent({
  dataDir: DATA_DIR,
  log,
  sleep,
  ensureChrome: p => ensureChrome(p),
  getCdp: () => getCdp(),
});

export const agentApi = {
  state: Agt.agentState,
  saveCfg: Agt.agentSaveCfg,
  kbLoad: Agt.kbLoad,
  kbSave: Agt.kbSave,
  kbReset: Agt.kbReset,
  parseResume: Agt.parseResumeFile,
  test: Agt.agentTest,
  tryReply: Agt.agentTryReply,
  start: Agt.agentStart,
  stop: Agt.agentStop,
  scanOnce: Agt.agentScanOnce,
  diag: Agt.agentDiag,
  status: Agt.agentWatchStatus,
};

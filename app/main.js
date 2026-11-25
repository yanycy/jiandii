/**
 * 简递 · 桌面版（Electron 主进程）
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const APP_NAME = '简递';

// ------------------------------------------------------------------ 数据目录
const APP_DIR = app.isPackaged
  ? path.dirname(app.getPath('exe'))
  : path.resolve(__dirname, '..');

// 品牌升级前的目录叫 AutoApplyBot-data，首次启动自动搬过来，历史投递记录不丢
// 注意：不能用 fs.cpSync —— Windows 上复制到中文目录会直接崩进程，改为手写递归
function copyDirSafe(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSafe(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function migrateLegacyData(target) {
  const legacy = path.join(APP_DIR, 'AutoApplyBot-data');
  try {
    if (fs.existsSync(target) && fs.readdirSync(target).length) return;
    if (!fs.existsSync(legacy)) return;
    copyDirSafe(legacy, target);
  } catch {}
}

// 数据默认跟程序放一起；开发/自动化测试可以用 AAB_DATA_DIR 指到临时目录，互不干扰
let DATA_DIR = process.env.AAB_DATA_DIR || path.join(APP_DIR, '简递数据');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  migrateLegacyData(DATA_DIR);
} catch {
  DATA_DIR = path.join(app.getPath('userData'), '简递数据');
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.setPath('userData', path.join(DATA_DIR, '.electron'));
process.env.AAB_GUI = '1';
process.env.AAB_APP_DIR = APP_DIR;
process.env.AAB_DATA_DIR = DATA_DIR;

const core = require('./core.cjs');
const { Updater } = require('./updater');

// ------------------------------------------------------------------ 版本更新
let updater = null;
let forcing = false;      // 强制更新弹窗是否正在显示（此时关窗口要二次确认）
let installing = false;

function getUpdater() {
  if (!updater) {
    updater = new Updater({ appDir: APP_DIR, dataDir: DATA_DIR, currentVer: app.getVersion() });
  }
  return updater;
}

async function runUpdateCheck() {
  if (installing) return { ok: false, reason: 'installing' };
  const u = getUpdater();
  const r = await u.check(core.loadCfg());
  if (!r.ok || !r.available) return r;
  emit('update:available', { manifest: r.manifest, current: r.current });
  return r;
}

function scheduleUpdateChecks() {
  // 启动后 4 秒查一次（不拖慢启动），之后每 10 分钟查一次，
  // 这样即使程序一直开着，发布新版本也会自动弹窗
  setTimeout(() => { if (!running) runUpdateCheck().catch(() => {}); }, 4000);
  setInterval(() => { if (!running) runUpdateCheck().catch(() => {}); }, 10 * 60 * 1000);
}

// ------------------------------------------------------------------ 窗口
let win = null;
let running = false;
let stopRequested = false;   // 本轮是否被用户手动停止
let runSeq = 0;              // 每轮任务一个序号，用于丢弃已被强制收尾的旧结果
let stopTimer = null;        // 6 秒：断开浏览器连接
let stopHardTimer = null;    // 10 秒：强制收工
let stopToken = 0;           // 停止令牌：新一轮开始后，上一轮的收尾定时器必须失效

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#0b0e14',
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0e14',
      symbolColor: '#9aa8bd',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  // 强制更新：窗口关不掉，必须更新完才能退出（任务管理器除外）
  win.on('close', e => {
    if (!forcing) return;
    e.preventDefault();
    emit('update:noclose', true);
  });

  // 开发期：把渲染进程的报错打到终端
  if (process.env.AAB_DEBUG) {
    win.webContents.on('console-message', (e, level, msg) => console.log('[renderer]', msg));
    win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err));
  }

  // 调试：渲染完成后截图并退出（用于开发期验证界面）
  if (process.env.AAB_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // AAB_SHOT_JS：截图前先跑一段界面操作（切 tab、点开某条记录），仅开发期用
          // 返回字符串时会写到 <AAB_SHOT>.txt，方便断言（比如检查发出去的参数）
          if (process.env.AAB_SHOT_JS) {
            const ret = await win.webContents.executeJavaScript(process.env.AAB_SHOT_JS);
            if (typeof ret === 'string' && ret) {
              try { fs.writeFileSync(process.env.AAB_SHOT + '.txt', ret, 'utf8'); } catch {}
            }
            await new Promise(r => setTimeout(r, Number(process.env.AAB_SHOT_WAIT) || 700));
          }
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.AAB_SHOT, img.toPNG());
        } catch (e) { console.error(e); }
        app.quit();
      }, 2200);
    });
  }

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ 日志管道
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let lineBuf = '';
let pending = '';   // 尚未换行的进度行（如「[3/18] 采集「前端」... 」）

core.setLogSink(text => {
  if (text.startsWith('\u0001')) {
    const seg = text.slice(1);
    if (!pending) { pending = seg; emit('log', { mode: 'begin', text: seg }); }
    else { pending += seg; emit('log', { mode: 'append', text: seg }); }
    return;
  }
  let s = text;
  if (pending) {
    const nl = s.indexOf('\n');
    if (nl < 0) { pending += s; emit('log', { mode: 'append', text: s }); return; }
    const merged = pending + s.slice(0, nl);
    pending = '';
    emit('log', { mode: 'replace', text: merged });
    s = s.slice(nl + 1);
  }
  lineBuf += s;
  const parts = lineBuf.split(/\r?\n/);
  lineBuf = parts.pop() || '';
  for (const line of parts) emit('log', { mode: 'line', text: line });
  if (lineBuf.length > 600) { emit('log', { mode: 'line', text: lineBuf }); lineBuf = ''; }
});

// ------------------------------------------------------------------ IPC
ipcMain.handle('app:state', () => {
  const cfg = core.loadCfg();
  const hist = core.loadHist();
  return {
    cfg,
    cities: core.CITIES,
    allCities: core.ALL_CITIES,
    counts: {
      boss: (hist.boss || []).length,
      nowcoder: (hist.nowcoder || []).length,
      zhilian: (hist.zhilian || []).length,
      liepin: (hist.liepin || []).length,
    },
    dataDir: DATA_DIR,
    running,
    version: app.getVersion(),
    updateUrl: core.loadCfg().updateUrl || '',
    updateSource: (() => { try { return getUpdater().resolveSource(cfg).src; } catch { return ''; } })(),
    nkTypes: core.NK_TYPE_LABEL,
    lpCities: core.LP_CITIES,
    tasks: listTasks(),
  };
});

ipcMain.handle('cfg:save', (e, cfg) => {
  try { core.saveCfg(cfg); return { ok: true }; }
  catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('app:openDir', () => { shell.openPath(DATA_DIR); return true; });
ipcMain.handle('app:openPath', (e, p) => {
  if (typeof p === 'string' && fs.existsSync(p)) shell.openPath(p);
  return true;
});

ipcMain.handle('app:chromeStatus', async () => {
  try {
    const d = await require('./core.cjs').__discover ? null : null;
    return { ok: true };
  } catch { return { ok: false }; }
});

ipcMain.on('run:start', async (evt, opts) => {
  if (running) { emit('run:error', '任务正在运行中'); return; }

  // ---------------- 断点续投：条件与已采集岗位都以任务记录为准 ----------------
  // 界面上可能已经改过表单，这里统一用历史任务里的快照覆盖，避免「续投」跑成另一个任务
  let prev = null;
  if (opts && opts.resumeFrom) {
    prev = core.taskLoad(opts.resumeFrom);
    if (!prev) { emit('run:error', '这条历史任务已不存在（可能被清理了）'); return; }
    // 只有「没跑完」的任务才允许续投：已完成/没采到岗位的再点继续只会白跑一轮
    const ST_TXT = { running: '正在运行', stopped: '已停止', done: '已完成', failed: '出错停了', empty: '没有可投岗位' };
    if (prev.status !== 'stopped' && prev.status !== 'failed') {
      emit('run:error', `这条任务${ST_TXT[prev.status] || '已经结束'}，不能再继续。想再投一次请直接点「开始投递」开一条新任务`);
      return;
    }
    if (prev.resumedBy) {
      emit('run:error', '这条任务已经续投过了，请打开它续出来的那条新任务，或直接点「开始投递」');
      return;
    }
    opts.platform = prev.platform || opts.platform;
    opts.keywords = Array.isArray(prev.keywords) && prev.keywords.length ? prev.keywords : opts.keywords;
    opts.city = prev.city || '';
    if (opts.platform === 'boss' && prev.type) opts.bossType = prev.type;
    if (opts.platform === 'nk') {
      if (prev.type) opts.nkType = prev.type;
      if (prev.edu) opts.nkEdu = prev.edu;
    }
    if (opts.platform === 'zh') {
      if (prev.type) opts.zhType = prev.type;
      if (prev.edu) opts.zhEdu = prev.edu;
    }
    if (opts.platform === 'lp') {
      if (prev.type) opts.lpType = prev.type;
      if (prev.edu) opts.lpEdu = prev.edu;
    }
    // 原任务目标是 50 个、已投 12 个 → 这次只补剩下的 38 个
    const alreadySent = (prev.stats && Number(prev.stats.sent)) || 0;
    const remain = prev.max > 0 ? prev.max - alreadySent : -1;
    if (prev.max > 0 && remain <= 0) {
      emit('run:error', `这条任务的目标 ${prev.max} 个已经投满了，不用再继续；想再投请直接点「开始投递」`);
      return;
    }
    opts.max = remain > 0 ? remain : 0;
    emit('log', { mode: 'line', text: `\u001b[36m  ↻ 继续任务：沿用「${prev.platformName || prev.platform}」上次的条件与 ${(prev.pool || []).length} 个已采集岗位（已投 ${alreadySent}，本次补投最多 ${opts.max || '不限'}）\u001b[0m` });
  }

  // 关键词必须由用户填写：新装用户默认是空的，不要偷偷用内置词跑
  const kws = Array.isArray(opts.keywords) ? opts.keywords.map(s => String(s).trim()).filter(Boolean) : [];
  if (!kws.length) {
    emit('run:error', '还没有填写检索关键词 —— 在左侧「检索关键词」里填几个，用空格分隔');
    return;
  }
  opts.keywords = kws;

  running = true;
  stopRequested = false;
  // 上一轮的「停止收尾」定时器必须立刻作废，否则它会在本轮中途触发，把任务强行改成已停止
  stopToken++;
  clearTimeout(stopTimer); stopTimer = null;
  clearTimeout(stopHardTimer); stopHardTimer = null;
  const seq = ++runSeq;
  emit('state', { running: true, platform: opts.platform });

  let taskId = '';
  try {
    core.resetStop();
    const cfg = core.loadCfg();
    const raw = Number(opts.max);
    // 0 或空 = 不限（由平台自身上限兜底：BOSS 150/天，牛客无硬限制）
    const max = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 999) : 999;
    cfg.bossMax = max;
    cfg.nkMax = max;
    cfg.zhMax = max;
    cfg.lpMax = max;
    cfg.autoYes = true;
    // 关键词四个平台共用：一份写进全部平台字段
    cfg.keywords = opts.keywords.slice();
    cfg.bossKeywords = opts.keywords.slice();
    cfg.nkKeywords = opts.keywords.slice();
    cfg.zhKeywords = opts.keywords.slice();
    cfg.lpKeywords = opts.keywords.slice();
    if (opts.platform === 'boss') {
      if (opts.bossType) cfg.bossType = opts.bossType;
    } else if (opts.platform === 'zh') {
      if (opts.zhType) cfg.zhType = opts.zhType;
      if (opts.zhEdu) cfg.zhEdu = opts.zhEdu;
    } else if (opts.platform === 'lp') {
      if (opts.lpType) cfg.lpType = opts.lpType;
      if (opts.lpEdu) cfg.lpEdu = opts.lpEdu;
    } else {
      if (opts.nkType) cfg.nkRecruitType = opts.nkType;
      if (opts.nkEdu) cfg.nkEdu = opts.nkEdu;
    }
    if (opts.platform === 'lp') {
      // 猎聘城市是它自己一套编码，不能走 findCity；空 = 全国
      cfg.lpCity = opts.city ? String(opts.city) : '';
    } else if (opts.city) cfg.city = String(opts.city);
    core.saveCfg(cfg);

    // 任务快照：从这一刻开始，每次采集/投递都会落盘，停止后可以接着来
    const meta = taskMeta(opts.platform, opts, max);
    taskId = core.taskBegin({ ...meta, resumedFrom: prev ? prev.id : '' });
    if (prev) core.taskMarkResumed(prev.id, taskId);
    const seed = prev && Array.isArray(prev.pool) && prev.pool.length ? prev.pool : null;
    // 种子池先落盘：续投后如果马上就停，新任务也要能拿着这批岗位再续一次
    if (seed) core.taskPool(seed);

    const pre = await core.ensureChrome(opts.platform);
    if (!pre.ok) {
      throw new Error(pre.noBrowser
        ? '没找到 Chrome 或 Edge。请先装任意一个浏览器（Windows 一般自带 Edge），装好后再点「开始投递」'
        : '浏览器调试通道未就绪，请查看运行日志里的排查提示');
    }
    const cdp = await core.getCdp();

    let result = null;
    let reportFile = null;
    const city = core.findCity(opts.city) || null;
    if (opts.platform === 'boss') {
      const c = city || core.CITIES[0];
      result = await core.runBoss(cdp, c, cfg, 0, seed);
      if (result) reportFile = core.writeReport('BOSS', c.name, result.sent, result.skipped, result.failed, result.total);
    } else if (opts.platform === 'zh') {
      result = await core.runZhilian(cdp, cfg, city, 0, seed);
      if (result) reportFile = core.writeReport('智联', city ? city.name : null, result.sent, result.skipped, result.failed, result.total);
    } else if (opts.platform === 'lp') {
      // 猎聘城市走它自己的 dq 编码，名字不带「市」，不能走 findCity
      const lpCity = opts.city ? { name: String(opts.city) } : null;
      result = await core.runLiepin(cdp, cfg, lpCity, 0, seed);
      if (result) reportFile = core.writeReport('猎聘', lpCity ? lpCity.name : null, result.sent, result.skipped, result.failed, result.total);
    } else {
      result = await core.runNowcoder(cdp, cfg, city, 0, seed);
      if (result) reportFile = core.writeReport('牛客', city ? city.name : null, result.sent, result.skipped, result.failed, result.total);
    }

    if (seq !== runSeq) return;   // 已被强制收尾，结果作废（避免重复重置界面）

    // 程序自己中断的（连续失败 / 额度用尽）不能记成「已完成」，否则既看不出中断、也没法继续投
    const aborted = !!(result && result.aborted);
    const finalStatus = stopRequested || aborted ? 'stopped' : (result ? 'done' : 'empty');
    const ended = core.taskEnd(finalStatus, reportFile);
    const tid = (ended && ended.id) || taskId;

    if (!result) {
      emit('run:done', {
        ok: false,
        msg: stopRequested ? '已手动停止'
          : (prev ? '这批岗位都投过了，没有新增。换个关键词或城市再开一轮' : '本轮没有可投递的岗位'),
        sent: 0, failed: 0, skipped: 0, total: 0, reportFile: null, taskId: tid,
        stopped: !!stopRequested,
      });
    } else {
      emit('run:done', {
        ok: true,
        sent: result.sent.length,
        failed: result.failed.length,
        skipped: result.skipped,
        total: result.total,
        stopped: stopRequested,
        aborted,
        items: result.sent.slice(0, 500).map(x => ({
          title: x.title, sal: x.sal, co: x.co, city: x.city,
        })),
        reportFile,
        taskId: tid,
      });
    }
  } catch (err) {
    // 已经被强制收尾（10 秒兜底已发过 run:done），这里不能再改界面/改任务状态
    if (seq !== runSeq) return;
    // 手动停止导致的报错（浏览器连接被主动断开）不算故障
    const ended = core.taskEnd(stopRequested ? 'stopped' : 'failed');
    const tid = (ended && ended.id) || taskId;
    if (stopRequested) {
      emit('run:done', { ok: false, msg: '已手动停止', sent: 0, failed: 0, skipped: 0, total: 0, reportFile: null, taskId: tid, stopped: true });
    } else {
      emit('run:error', (err && err.message) || String(err));
    }
  } finally {
    clearTimeout(stopTimer); stopTimer = null;
    clearTimeout(stopHardTimer); stopHardTimer = null;
    if (seq === runSeq) {
      running = false;
      emit('state', { running: false });
    }
  }
});

ipcMain.on('run:stop', () => {
  if (!running) { emit('run:error', '当前没有正在执行的任务'); return; }
  stopRequested = true;
  core.requestStop();
  pending = '';      // 丢掉没换行的半截进度（「采集「xx」... 」），否则停止后会留在界面上
  lineBuf = '';
  emit('log', { mode: 'line', text: '\u001b[33m  ! 已发送停止指令，正在收尾…\u001b[0m' });

  // 采集/翻页这类操作可能正卡在一次页面请求里，光靠标志位收不了尾。
  // 6 秒还没结束就强制断开浏览器连接（会让挂起的请求立刻报错退出）；
  // 10 秒还没结束就直接收工，保证界面一定从「正在停止」里出来。
  // 两个定时器都带令牌：用户停止后马上又点「开始/继续」时，旧定时器必须失效，
  // 否则会在新一轮跑到一半时突然把界面改成「已停止」（这就是「莫名其妙停止」的来源）
  const token = ++stopToken;
  clearTimeout(stopTimer);
  clearTimeout(stopHardTimer);
  stopTimer = setTimeout(() => {
    if (token !== stopToken || !running) return;
    emit('log', { mode: 'line', text: '\u001b[33m  ! 收尾超时，正在断开浏览器连接…\u001b[0m' });
    try { core.forceCloseCdp(); } catch {}
  }, 6000);

  stopHardTimer = setTimeout(() => {
    if (token !== stopToken || !running) return;
    stopHardTimer = null;
    runSeq++;                       // 让还在跑的旧任务结果被丢弃
    running = false;
    // 兜底收尾也要把任务状态落成「已停止」，否则历史任务里会一直显示运行中
    let tid = '';
    try { const ended = core.taskEnd('stopped'); tid = (ended && ended.id) || ''; } catch {}
    emit('state', { running: false });
    emit('run:done', { ok: false, msg: '已手动停止', sent: 0, failed: 0, skipped: 0, total: 0, reportFile: null, taskId: tid, stopped: true });
  }, 10000);
});

ipcMain.on('app:quit', () => {
  if (forcing) { emit('update:noclose', true); return; }
  app.quit();
});

// ------------------------------------------------------------------ 更新 IPC
ipcMain.handle('update:check', async () => {
  try { return await runUpdateCheck(); }
  catch (e) { return { ok: false, reason: 'error', msg: e.message }; }
});

ipcMain.handle('update:download', async (e, version) => {
  const u = getUpdater();
  const m = u.manifest;
  if (!m || m.version !== version) return { ok: false, msg: '更新信息已失效，请重新检查' };
  try {
    const r = await u.download(m, p => emit('update:progress', p));
    return { ok: true, file: r.file, size: r.size };
  } catch (err) {
    return { ok: false, msg: (err && err.message) || String(err) };
  }
});

ipcMain.handle('update:install', () => {
  const u = getUpdater();
  if (!u.downloaded) return { ok: false, msg: '安装包还没下载完成' };
  try {
    installing = true;
    const r = u.install(u.downloaded.file, { unlock: () => { forcing = false; } });
    if (r.dev) installing = false;
    return r;
  } catch (e) {
    installing = false;
    return { ok: false, msg: e.message };
  }
});

ipcMain.handle('update:cancel', () => { try { getUpdater().cancel(); } catch {} return true; });


ipcMain.handle('update:openFile', () => {
  const u = getUpdater();
  if (u.downloaded && fs.existsSync(u.downloaded.file)) shell.showItemInFolder(u.downloaded.file);
  return true;
});

ipcMain.on('update:forcing', (e, on) => { forcing = !!on; });

// 主题切换：同步原生标题栏按钮与窗口底色
ipcMain.on('theme:set', (e, t) => {
  if (!win) return;
  const light = t === 'light';
  try {
    win.setTitleBarOverlay({
      color: light ? '#fbfbfd' : '#151920',
      symbolColor: light ? '#5f6a7c' : '#98a2b3',
      height: 44,
    });
    win.setBackgroundColor(light ? '#f6f7f9' : '#12151b');
  } catch {}
});

// ------------------------------------------------------------------ 报告 / 历史任务
const PLAT_NAME = { boss: 'BOSS 直聘', nk: '牛客网', zh: '智联招聘', lp: '猎聘' };

function typeLabelOf(platform, type) {
  if (!type) return '';
  if (platform === 'boss') return core.BOSS_TYPE_LABEL[type] || type;
  if (platform === 'zh') return core.ZH_TYPE_LABEL[type] || type;
  if (platform === 'lp') return core.LP_TYPE_LABEL[type] || type;
  return core.NK_TYPE_LABEL[type] || type;
}

function taskMeta(platform, opts, max) {
  const type = platform === 'boss' ? opts.bossType
    : platform === 'zh' ? opts.zhType
      : platform === 'lp' ? opts.lpType
        : opts.nkType;
  const edu = platform === 'zh' ? opts.zhEdu
    : platform === 'lp' ? opts.lpEdu
      : platform === 'nk' ? opts.nkEdu : '';
  return {
    platform,
    platformName: PLAT_NAME[platform] || platform,
    city: opts.city || '',
    type: type || '',
    typeLabel: typeLabelOf(platform, type),
    edu: edu && edu !== '不限' ? edu : '',
    keywords: opts.keywords || [],
    max: Number(opts.max) || 0,
  };
}

function listReports() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('投递报告_') && f.endsWith('.md'))
      .map(f => {
        const st = fs.statSync(path.join(DATA_DIR, f));
        const m = f.match(/投递报告_(.+?)_(\d{8}_\d{4})\.md/);
        return {
          file: f,
          path: path.join(DATA_DIR, f),
          platform: m ? m[1] : f,
          time: m ? m[2] : '',
          size: st.size,
          mtime: st.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 40);
  } catch { return []; }
}

function pickTask(t) {
  return {
    id: t.id,
    legacy: false,
    platform: t.platform || '',
    platformName: t.platformName || PLAT_NAME[t.platform] || t.platform || '',
    city: t.city || '',
    type: t.type || '',
    typeLabel: t.typeLabel || typeLabelOf(t.platform, t.type),
    edu: t.edu || '',
    keywords: Array.isArray(t.keywords) ? t.keywords : [],
    max: t.max || 0,
    status: t.status || 'done',
    createdAt: t.createdAt || 0,
    updatedAt: t.updatedAt || 0,
    stats: t.stats || { collected: 0, sent: 0, failed: 0, skipped: 0 },
    reportFile: t.reportFile || '',
    resumedFrom: t.resumedFrom || '',
    resumedBy: t.resumedBy || '',
  };
}

function listTasks() {
  const out = [];
  try { for (const t of core.taskListRaw()) out.push(pickTask(t)); } catch {}
  // 老版本只留了 .md 报告，没有任务快照：补成只读条目，历史不丢
  const known = new Set(out.map(t => t.reportFile).filter(Boolean));
  for (const r of listReports()) {
    if (known.has(r.file)) continue;
    out.push({
      id: 'legacy:' + r.file,
      legacy: true,
      platform: '',
      // 文件名里的「牛客_深圳」直接当展示名，下划线换成间隔点
      platformName: String(r.platform || '').replace(/_/g, ' · '),
      city: '', type: '', typeLabel: '', edu: '',
      keywords: [], max: 0,
      status: 'done',
      createdAt: r.mtime, updatedAt: r.mtime,
      stats: { collected: 0, sent: 0, failed: 0, skipped: 0 },
      reportFile: r.file,
      resumedFrom: '', resumedBy: '',
    });
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 60);
}

ipcMain.handle('report:read', (e, file) => {
  try {
    const p = path.join(DATA_DIR, path.basename(file));
    if (!fs.existsSync(p)) return { ok: false };
    return { ok: true, content: fs.readFileSync(p, 'utf8') };
  } catch (err) { return { ok: false, msg: err.message }; }
});

ipcMain.handle('task:list', () => listTasks());

ipcMain.handle('task:get', (e, id) => {
  const key = String(id || '');
  if (key.startsWith('legacy:')) {
    const f = key.slice(7);
    const t = listTasks().find(x => x.id === key);
    if (!t) return { ok: false, msg: '这条记录不存在' };
    return { ok: true, task: t };
  }
  const t = core.taskLoad(key);
  if (!t) return { ok: false, msg: '任务记录不存在（可能被清理了）' };
  return { ok: true, task: { ...pickTask(t), pool: t.pool || [], sentItems: t.sentItems || [], failedItems: t.failedItems || [] } };
});

ipcMain.handle('task:delete', (e, id) => {
  const key = String(id || '');
  if (key.startsWith('legacy:')) return { ok: false, msg: '旧版报告不能在这里删除，可以到数据目录里删' };
  try { return { ok: core.taskRemove(key) }; } catch { return { ok: false }; }
});

// 任务结束后关掉投递专用的浏览器窗口。
// 只关「命令行里带专用 profile 目录」的那个，用户自己平时用的浏览器不受影响。
ipcMain.handle('browser:close', async () => {
  if (running) return { ok: false, msg: '任务还在运行，先点停止再关浏览器' };
  try {
    const r = await core.closeBrowser();
    if (r.ok) emit('log', { mode: 'line', text: '\u001b[32m  ✔ 已关闭投递浏览器\u001b[0m' });
    return r;
  } catch (e) {
    return { ok: false, msg: e.message };
  }
});

// ------------------------------------------------------------------ 智能体（知识库 + AI 自动回复）
// 逻辑全在 lib/agent.mjs（打包进 core.cjs），这里只做 IPC 转发，保持投递主链路不动
const AGENT = core.agentApi;

ipcMain.handle('agent:state', () => { try { return AGENT.state(); } catch (e) { return { ok: false, msg: e.message }; } });
ipcMain.handle('agent:kb', () => { try { return AGENT.kbLoad(); } catch (e) { return { ok: false, msg: e.message }; } });
ipcMain.handle('agent:kbSave', (e, patch) => { try { return AGENT.kbSave(patch || {}); } catch (err) { return { ok: false, msg: err.message }; } });
ipcMain.handle('agent:kbReset', (e, kind) => { try { return AGENT.kbReset(kind); } catch (err) { return { ok: false, msg: err.message }; } });
ipcMain.handle('agent:cfgSave', (e, patch) => { try { return AGENT.saveCfg(patch || {}); } catch (err) { return { ok: false, msg: err.message }; } });
ipcMain.handle('agent:test', () => AGENT.test());
ipcMain.handle('agent:try', (e, text) => AGENT.tryReply(text));
ipcMain.handle('agent:start', async () => { try { return await AGENT.start(); } catch (e) { return { ok: false, msg: e.message }; } });
ipcMain.handle('agent:stop', () => { try { return AGENT.stop(); } catch (e) { return { ok: false, msg: e.message }; } });
ipcMain.handle('agent:scan', () => AGENT.scanOnce());
ipcMain.handle('agent:diag', () => AGENT.diag());
ipcMain.handle('agent:openKbDir', () => {
  try { shell.openPath(AGENT.state().kbDir); } catch {}
  return true;
});

// 选一份简历解析成文本，顺手写进知识库（扫描件/旧版 doc 会明确提示改粘贴）
ipcMain.handle('agent:upload', async () => {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择简历文件',
    filters: [
      { name: '简历文件', extensions: ['txt', 'md', 'docx', 'pdf'] },
      { name: '全部文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  let p;
  try { p = AGENT.parseResume(file); } catch (e) { return { ok: false, msg: e.message }; }
  if (!p || !p.ok) return { ok: false, msg: (p && p.msg) || '解析失败' };
  try { AGENT.kbSave({ resume: p.text }); } catch {}
  emit('log', { mode: 'line', text: `\u001b[36m  · 简历已解析：${path.basename(file)}（${p.text.length} 字）\u001b[0m` });

  // 解析完立刻把能确定的信息填进结构化档案，省得再手抄一遍
  let profile = null, profileSource = '';
  try {
    const f = await AGENT.profileFromResume(p.text);
    if (f && f.ok) { profile = f.profile; profileSource = f.source || ''; }
  } catch (e) {
    emit('log', { mode: 'line', text: `\u001b[33m  · 自动建档没成功：${e.message}\u001b[0m` });
  }

  return { ok: true, text: p.text, warn: p.warn || '', file: path.basename(file), profile, profileSource };
});

// ------------------------------------------------------------------ 生命周期
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    // 上次被强杀/崩溃时留下的「运行中」任务，启动时统一改成「已停止」，否则永远续不了
    try {
      for (const t of core.taskListRaw()) {
        if (t.status === 'running') core.taskMarkStopped(t.id);
      }
    } catch {}
    createWindow();
    scheduleUpdateChecks();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => {
    // 值守是常驻循环，窗口关了必须一起停，否则后台还在往 BOSS 发消息
    try { AGENT.stop(); } catch {}
    if (process.platform !== 'darwin') app.quit();
  });
}

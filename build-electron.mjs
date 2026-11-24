/**
 * 打包 Electron 桌面版
 * 产物：投递工具/桌面版/一键投递助手.exe
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'node_modules', 'electron', 'dist');
const OUT = path.join(ROOT, '投递工具', '桌面版');
const TMP_DATA = path.join(ROOT, '投递工具', '.tmp-data');
const APP_NAME = '简递.exe';

const log = m => console.log('  ' + m);

function robocopy(args) {
  try {
    execFileSync('robocopy', args, { stdio: 'ignore' });
  } catch (e) {
    // robocopy 退出码 0-7 都算成功
    if (typeof e.status === 'number' && e.status <= 7) return;
    throw e;
  }
}

if (!fs.existsSync(path.join(SRC, 'electron.exe'))) {
  console.error('未找到 Electron 运行时，请先 npm i -D electron');
  process.exit(1);
}

// 1) 编译核心
log('编译核心逻辑...');
execFileSync(process.execPath, [
  path.join(__dirname, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  'auto-apply.mjs', '--bundle', '--platform=node', '--target=node20',
  '--format=cjs', '--outfile=app/core.cjs', '--log-level=error',
], { cwd: __dirname, stdio: 'inherit' });

// 2) 迁出数据目录（避免被镜像复制清掉）
const dataDir = path.join(OUT, '简递数据');
const legacyData = path.join(OUT, 'AutoApplyBot-data');
if (!fs.existsSync(dataDir) && fs.existsSync(legacyData)) {
  try {
    fs.renameSync(legacyData, dataDir);
    log('数据目录已改名：AutoApplyBot-data → 简递数据');
  } catch (e) {
    console.error('数据目录改名失败（可能有进程占用）：' + e.message);
    console.error('请先关掉正在运行的程序，再重新打包');
    process.exit(1);
  }
}
let hasData = false;
if (fs.existsSync(dataDir)) {
  log('暂存数据目录...');
  if (fs.existsSync(TMP_DATA)) robocopy([TMP_DATA, dataDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);
  robocopy([dataDir, TMP_DATA, '/E', '/MOVE', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);
  hasData = true;
}

// 3) 镜像复制 Electron 运行时（会清空目标里多余的旧文件）
log('复制 Electron 运行时（约 250MB，稍等）...');
fs.mkdirSync(OUT, { recursive: true });
robocopy([SRC, OUT, '/MIR', '/XD', 'locales', '/XF', 'default_app.asar',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/R:1', '/W:1']);

// 只保留中文/英文语言包（其余 53 个可省约 47MB）
const srcLoc = path.join(SRC, 'locales');
const outLoc = path.join(OUT, 'locales');
const EMPTY = path.join(__dirname, '.empty');
fs.mkdirSync(EMPTY, { recursive: true });
fs.mkdirSync(outLoc, { recursive: true });
robocopy([EMPTY, outLoc, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);  // 清空
for (const f of ['zh-CN.pak', 'en-US.pak']) {
  const s = path.join(srcLoc, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(outLoc, f));
}

// 4) 放置应用代码
log('写入应用文件...');
const appDir = path.join(OUT, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
robocopy([path.join(__dirname, 'app'), appDir, '/MIR', '/XD', 'node_modules',
  '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);

// 4.5) resources/app.asar 的优先级高于 app 目录。
// 以前用 electron-builder 打安装包时在这里留过一份 app.asar，
// 结果 exe 一直加载旧界面（改了代码却没生效）。这个文件常被系统锁住，
// 既删不掉也改不了名（EBUSY），但可以打开句柄写入，所以用「打新包再灌进去」。
const staleAsar = path.join(OUT, 'resources', 'app.asar');
if (fs.existsSync(staleAsar)) {
  log('发现残留的 app.asar，用新代码覆盖（否则会加载旧界面）...');
  const tmpAsar = path.join(os.tmpdir(), 'jiandi-app.asar');
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'),
      'pack', path.join(__dirname, 'app'), tmpAsar,
    ], { stdio: 'ignore' });

    const buf = fs.readFileSync(tmpAsar);
    const fd = fs.openSync(staleAsar, 'r+');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    try { fs.unlinkSync(tmpAsar); } catch {}
    log(`app.asar 已更新（${(buf.length / 1024).toFixed(0)} KB）`);
  } catch (e) {
    log('⚠ app.asar 覆盖失败：' + e.message);
    log('  请在任务管理器里结束「简递.exe」后重新打包');
  }
}

// 5) 重命名可执行文件
const exeSrc = path.join(OUT, 'electron.exe');
const exeDst = path.join(OUT, APP_NAME);
if (fs.existsSync(exeSrc)) {
  if (fs.existsSync(exeDst)) fs.unlinkSync(exeDst);
  fs.renameSync(exeSrc, exeDst);
}

// 5.5) 给 exe 写入应用图标。
// electron-builder 用 --prepackaged 打安装包时不会重新设置 exe 图标
// （它认为应用已打包好），而这里只是把 electron.exe 改名，图标还是
// Electron 默认的「原子」图标。必须用 rcedit 手动写入，否则安装后
// 桌面快捷方式/任务栏会显示成 Electron 默认图标。
// 注意：老版 rcedit 用非 Unicode API，读不了中文路径，所以先复制到
// 系统临时目录（纯 ASCII 路径）改完再覆盖回来。
const iconFile = path.join(__dirname, 'build', 'icon.ico');
if (fs.existsSync(exeDst) && fs.existsSync(iconFile)) {
  const rcedit = path.join(__dirname, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  if (fs.existsSync(rcedit)) {
    log('写入应用图标...');
    try {
      const tmpExe = path.join(os.tmpdir(), 'jiandi-icon.exe');
      const tmpIco = path.join(os.tmpdir(), 'jiandi-icon.ico');
      fs.copyFileSync(exeDst, tmpExe);
      fs.copyFileSync(iconFile, tmpIco);
      execFileSync(rcedit, [tmpExe, '--set-icon', tmpIco], { stdio: 'ignore' });
      fs.copyFileSync(tmpExe, exeDst);
      fs.unlinkSync(tmpExe);
      fs.unlinkSync(tmpIco);
      log('图标已写入（icon.ico）');
    } catch (e) {
      log('⚠ 图标写入失败：' + e.message);
    }
  } else {
    log('⚠ 未找到 rcedit.exe，跳过图标写入');
  }
}

// 6) 恢复数据目录
if (hasData) {
  robocopy([TMP_DATA, dataDir, '/E', '/MOVE', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);
  log('数据目录已恢复（历史投递记录保留）');
} else {
  const legacy = path.join(ROOT, '投递工具', 'AutoApplyBot-data');
  if (fs.existsSync(legacy)) {
    robocopy([legacy, dataDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS']);
    log('已导入历史投递记录');
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

// 7) 统计
function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else { try { total += fs.statSync(fp).size; } catch {} }
    }
  }
  return total;
}
log(`完成：${OUT}`);
log(`体积：${(dirSize(OUT) / 1024 / 1024).toFixed(0)} MB`);

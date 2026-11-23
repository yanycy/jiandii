/**
 * 简递 · 发布一次更新（可选直传阿里云 OSS）
 *
 * 用法：
 *   node 发布更新.mjs --exe="..\安装包\简递-Setup-1.0.1.exe" --version=1.0.1 \
 *                     --notes="修复已知问题|新增广西人才网筛选" [--force] [--min=1.0.0] [--oss]
 *
 *   --oss        生成清单后直接传到 OSS（凭证读 oss.config.json / 环境变量）
 *   --check      只检查 OSS 配置和连通性，不上传
 *   --dry-run    走完流程但不真正上传
 *
 * 上传后的结构：
 *   https://jiandid.oss-cn-shenzhen.aliyuncs.com/latest.json
 *   https://jiandid.oss-cn-shenzhen.aliyuncs.com/releases/简递-Setup-1.0.1.exe
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as oss from './oss.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = n => args.includes('--' + n);
const opt = (n, d = null) => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.slice(n.length + 3) : d;
};

const useOss = flag('oss') || flag('upload');
const checkOnly = flag('check');
const dryRun = flag('dry-run');

if (flag('help') || flag('h') || (!opt('exe') && !checkOnly)) {
  console.log(`
  简递 · 发布更新

  node 发布更新.mjs --exe="安装包路径" [选项]

    --version=1.0.1        版本号（不填则从文件名猜）
    --notes="修复A|新增B"   更新说明，用 | 或换行分隔
    --force                强制更新（用户不能跳过）
    --min=1.0.0            最低支持版本，低于它的客户端强制更新
    --oss                  生成清单后直传阿里云 OSS（推荐）
    --check                只检查 OSS 凭证与连通性
    --dry-run              全流程演练，不真正上传
    --url-base=地址         不上传时的下载前缀，例如 https://cdn.xx.com/jiandi
    --out=目录              清单输出目录，默认与安装包同目录
    --dir=releases         OSS 上存放安装包的目录，默认 releases
    --endpoint=域名         OSS 自定义域名 / CDN（默认用 <bucket>.oss-<region>.aliyuncs.com）
    --acl=public-read      上传后的对象权限，默认 public-read

  OSS 凭证（三选一，从上往下优先）：
    1. 环境变量 OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET
    2. 本目录的 oss.config.json
    3. 同目录 oss.config.example.json 复制改名为 oss.config.json 再填
`);
  process.exit(0);
}

// ------------------------------------------------------------------ OSS 配置
const ossCfg = oss.loadConfig({
  accessKeyId: opt('ak-id'),
  accessKeySecret: opt('ak-secret'),
  bucket: opt('bucket'),
  region: opt('region'),
  dir: opt('dir'),
  endpoint: opt('endpoint'),
  acl: opt('acl'),
}, __dirname);

if (checkOnly) {
  console.log('');
  console.log('  简递 · OSS 配置检查');
  console.log('    配置文件   ' + (ossCfg.configFile || '（未使用配置文件）'));
  console.log('    Bucket     ' + (ossCfg.bucket || '（未设置）'));
  console.log('    区域        ' + ossCfg.region);
  console.log('    接入地址   https://' + oss.endpointHost(ossCfg));
  console.log('    AK         ' + (ossCfg.accessKeyId ? ossCfg.accessKeyId.slice(0, 6) + '****' + ossCfg.accessKeyId.slice(-4) : '（未设置）'));
  console.log('');
  if (!ossCfg.accessKeyId || !ossCfg.accessKeySecret) {
    console.log('  ✘ 还没有配置 AccessKey。');
    console.log('    把 oss.config.example.json 复制成 oss.config.json，填上 AccessKey ID / Secret。');
    process.exit(1);
  }
  try {
    const r = await oss.testCredentials(ossCfg);
    if (r.ok) {
      console.log('  ✔ 凭证有效，可以上传');
    } else {
      console.log('  ✘ 凭证校验失败：' + r.msg);
      console.log('    常见原因：AK 写错 / 该 RAM 用户没有 oss:ListObjects 权限（不影响上传）/ 系统时间不准');
    }
  } catch (e) {
    console.log('  ✘ 连不上 OSS：' + e.message);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ 参数
const exe = opt('exe');
const exePath = path.resolve(exe);
if (!fs.existsSync(exePath)) {
  console.error('✘ 找不到安装包：' + exePath);
  process.exit(1);
}
const fileName = path.basename(exePath);

function guessVersion() {
  const v = opt('version');
  if (v) return v.replace(/^v/i, '').trim();
  const m = fileName.match(/(\d+\.\d+\.\d+)/);
  if (m) return m[1];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'app', 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {}
  console.error('✘ 无法确定版本号，请加 --version=1.0.1');
  process.exit(1);
}

const version = guessVersion();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('✘ 版本号格式应为 主.次.修，例如 1.0.1（当前：' + version + '）');
  process.exit(1);
}

const notes = (opt('notes', '') || '').split(/\||\r?\n/).map(s => s.trim()).filter(Boolean);
const force = flag('force');
const minVersion = opt('min', '') || '';

const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', c => h.update(c));
    rs.on('end', () => resolve(h.digest('hex')));
    rs.on('error', reject);
  });
}

// ------------------------------------------------------------------ 计算
console.log('');
console.log('  简递 · 发布更新  v' + version + (force ? '  【强制】' : '  【可选】'));
console.log('');

const size = fs.statSync(exePath).size;
process.stdout.write('  计算校验值... ');
const hash = await sha256(exePath);
console.log('完成');
console.log('    安装包  ' + fileName + '  ' + mb(size));
console.log('    SHA256  ' + hash.slice(0, 32) + '…');
if (notes.length) console.log('    说明    ' + notes.join(' / '));
console.log('');

// ------------------------------------------------------------------ 清单
const dir = ossCfg.dir || 'releases';
const installerKey = `${dir}/${fileName}`;
const manifestKey = 'latest.json';

const urlBase = (opt('url-base', '') || '').replace(/\/+$/, '');
const url = useOss
  ? oss.publicUrl(ossCfg, installerKey)
  : (urlBase ? `${urlBase}/${encodeURIComponent(fileName)}` : fileName);

const manifest = {
  version,
  force,
  minVersion,
  pubDate: new Date().toISOString().slice(0, 10),
  notes,
  url,
  size,
  sha256: hash,
};

const outDir = path.resolve(opt('out', path.dirname(exePath)));
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'latest.json');
fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('  ✔ 本地清单已生成：' + outFile);

// ------------------------------------------------------------------ 上传
if (!useOss) {
  console.log('');
  console.log('  下一步：加上 --oss 直接传到阿里云 OSS，或手动把这两个文件放到静态目录：');
  console.log('    ' + outFile);
  console.log('    ' + exePath);
  console.log('');
  process.exit(0);
}

if (dryRun) {
  console.log('');
  console.log('  （演练模式，不上传）将上传到：');
  console.log('    ' + oss.publicUrl(ossCfg, installerKey));
  console.log('    ' + oss.publicUrl(ossCfg, manifestKey));
  console.log('');
  process.exit(0);
}

try {
  oss.assertConfig(ossCfg);
} catch (e) {
  console.log('');
  console.log('  ✘ ' + e.message);
  console.log('    在 ' + path.join(__dirname, 'oss.config.json') + ' 里填上，或设置环境变量。');
  console.log('    先跑一次  node 发布更新.mjs --check  可以看到缺什么。');
  process.exit(1);
}

// 1) 安装包
process.stdout.write('\n  上传安装包... ');
const t0 = Date.now();
let lastPct = -1;
const res1 = await oss.putFile(ossCfg, {
  key: installerKey,
  file: exePath,
  contentType: 'application/octet-stream',
  cacheControl: 'public, max-age=604800',
  acl: ossCfg.acl || 'public-read',
  onProgress: (sent, total) => {
    const pct = Math.floor(sent / total * 100);
    if (pct >= lastPct + 10) { lastPct = pct; process.stdout.write('\r  上传安装包... ' + pct + '%'); }
  },
}).catch(e => { console.log('\n  ✘ ' + e.message); process.exit(1); });

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('\r  上传安装包... 100%   ' + mb(size) + ' / ' + secs + 's');
console.log('    ' + res1.url);

// 2) 清单（不缓存，客户端每次都能拿到最新）
process.stdout.write('  上传清单... ');
const res2 = await oss.putText(ossCfg, {
  key: manifestKey,
  text: JSON.stringify(manifest, null, 2) + '\n',
  contentType: 'application/json; charset=utf-8',
  cacheControl: 'no-cache, no-store, must-revalidate',
  acl: ossCfg.acl || 'public-read',
}).catch(e => { console.log('\n  ✘ ' + e.message); process.exit(1); });
console.log('完成');
console.log('    ' + res2.url);

// 3) 匿名验证：模拟用户端直接下载
process.stdout.write('\n  验证外网可访问... ');
const probe = await oss.publicGet(res2.url);
if (probe.ok) {
  let v = '';
  try { v = JSON.parse(probe.text).version || ''; } catch {}
  console.log('正常');
  if (v && v !== version) {
    console.log('    ⚠ 读回来的版本是 ' + v + '，不是 ' + version + '，可能有 CDN 缓存，稍等几分钟再看');
  }
} else if (probe.status === 403) {
  console.log('被拒绝（403）');
  console.log('');
  console.log('  文件传上去了，但存储桶不允许匿名读取，用户端下不到。任选一种改法：');
  console.log('    A. 控制台 → jiandid → 读写权限 → 设为「公共读」（最快）');
  console.log('    B. 只放开这两个对象：在上面的文件上点「更多 → 设置读写权限 → 公共读」');
  console.log('    C. 保持私有，加 Bucket 授权策略（把 releases/* 和 latest.json 放开）');
  console.log('       策略模板见 更新发布指南.md');
} else {
  console.log('失败（' + (probe.status || probe.msg) + '）');
}

console.log('');
console.log('  ──────────────────────────────────────────────');
console.log('  发布完成');
console.log('    清单地址  ' + res2.url);
console.log('    安装包    ' + res1.url);
console.log('');
console.log('  把这个地址填进客户端：');
console.log('    ' + res2.url);
console.log('  （已打包的程序默认就读这个地址，不用手填）');
console.log('');

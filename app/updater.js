/**
 * 简递 · 版本更新
 *
 * 更新源优先级：
 *   1. 环境变量 JIANDI_UPDATE_URL（调试用）
 *   2. 程序目录下的 update-source.json  { "url": "..." }
 *   3. config.json 里的 updateUrl
 *   4. 内置地址（阿里云 OSS，发布脚本 发布更新.mjs --oss 就传到这里）
 * 支持 http(s) 地址，也支持本地文件路径 / file://（局域网共享、离线包）
 *
 * 清单（latest.json）字段：
 *   version     新版本号，如 "1.0.1"
 *   url         安装包地址，可写相对路径（相对清单所在位置）
 *   notes       更新说明，字符串数组或字符串
 *   force       true = 强制更新
 *   minVersion  低于该版本的客户端强制更新
 *   sha256      安装包校验值（可选，强烈建议）
 *   size        安装包字节数（可选，用于进度与校验）
 *   pubDate     发布日期（可选）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, net } = require('electron');

// ------------------------------------------------------------------ 版本号
function parseVer(v) {
  const m = String(v || '').trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' };
}

/** a>b 返回 1，相等 0，a<b 返回 -1 */
function cmpVer(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    if (x.n[i] !== y.n[i]) return x.n[i] > y.n[i] ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;          // 1.0.0 > 1.0.0-beta
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

const isHttp = s => /^https?:\/\//i.test(String(s || ''));

/** 内置更新源：阿里云 OSS（发布脚本 发布更新.mjs --oss 默认传到这里） */
const BUILTIN_SOURCE = 'https://jiandidi.oss-cn-shenzhen.aliyuncs.com/latest.json';

function joinUrl(base, rel) {
  if (isHttp(rel)) return rel;
  if (/^file:/i.test(rel)) return rel;
  if (/^[a-zA-Z]:[\\/]/.test(rel)) return rel;
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

/** 清单地址 → 本地可读路径（非 http 时） */
function toLocalPath(src) {
  if (/^file:/i.test(src)) return decodeURIComponent(src.replace(/^file:\/\/\/?/i, ''));
  return src;
}

function readLocalFile(p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取更新清单超时')), timeoutMs);
    fs.readFile(toLocalPath(p), 'utf8', (err, txt) => {
      clearTimeout(timer);
      err ? reject(err) : resolve(txt);
    });
  });
}

/** 支持 3 次重定向的 GET 文本 */
function httpGetText(url, timeoutMs = 15000, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 4) return reject(new Error('重定向次数过多'));
    let req;
    try {
      req = net.request({ method: 'GET', url, redirect: 'manual' });
    } catch (e) { return reject(e); }

    const timer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error('连不上更新服务器'));
    }, timeoutMs);

    req.on('response', res => {
      const code = res.statusCode;
      const loc = res.headers.location;
      if (code >= 300 && code < 400 && loc) {
        clearTimeout(timer);
        res.resume();
        const next = Array.isArray(loc) ? loc[0] : loc;
        return httpGetText(joinUrl(url, next), timeoutMs, hop + 1).then(resolve, reject);
      }
      if (code !== 200) {
        clearTimeout(timer);
        res.resume();
        return reject(new Error(`更新服务器返回 ${code}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      res.on('error', e => { clearTimeout(timer); reject(e); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

// ------------------------------------------------------------------ 状态
class Updater {
  /**
   * @param {object} o
   * @param {string} o.appDir       程序目录
   * @param {string} o.dataDir      数据目录
   * @param {string} o.currentVer   当前版本
   */
  constructor({ appDir, dataDir, currentVer }) {
    this.appDir = appDir;
    this.dataDir = dataDir;
    this.currentVer = currentVer;
    this.stateFile = path.join(dataDir, 'update_state.json');
    this.state = this._loadState();
    this.manifest = null;
    this.downloaded = null;     // { file, version }
    this.request = null;
    this.canceled = false;
  }

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; }
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch {}
  }

  /** 当前生效的更新源 */
  resolveSource(cfg = {}) {
    const env = process.env.JIANDI_UPDATE_URL;
    if (env) return { src: env, from: 'env' };

    const side = path.join(this.appDir, 'update-source.json');
    try {
      if (fs.existsSync(side)) {
        const j = JSON.parse(fs.readFileSync(side, 'utf8'));
        if (j && j.url) return { src: String(j.url), from: 'update-source.json' };
      }
    } catch {}

    if (cfg.updateUrl && String(cfg.updateUrl).trim()) {
      return { src: String(cfg.updateUrl).trim(), from: 'config' };
    }
    return { src: BUILTIN_SOURCE, from: 'builtin' };
  }

  /**
   * 检查更新
   * @returns {Promise<{ok:boolean, reason?:string, available?:boolean, forced?:boolean,
   *   manifest?:object, current?:string, source?:string}>}
   */
  async check(cfg = {}) {
    const { src, from } = this.resolveSource(cfg);
    if (!src) return { ok: false, reason: 'no-source', current: this.currentVer };

    let raw;
    try {
      raw = isHttp(src) ? await httpGetText(src) : await readLocalFile(src);
    } catch (e) {
      return { ok: false, reason: 'fetch', msg: e.message, source: src, current: this.currentVer };
    }

    let j;
    try { j = JSON.parse(String(raw).replace(/^\uFEFF/, '')); }
    catch { return { ok: false, reason: 'parse', msg: '更新清单格式错误', source: src }; }

    if (!j || !j.version) {
      return { ok: false, reason: 'parse', msg: '更新清单缺少 version 字段', source: src };
    }

    const base = isHttp(src) ? src : 'file:///' + toLocalPath(src).replace(/\\/g, '/').replace(/^\//, '');
    const notes = Array.isArray(j.notes) ? j.notes
      : (typeof j.notes === 'string' ? j.notes.split(/\r?\n/).filter(Boolean) : []);
    const manifest = {
      version: String(j.version).trim().replace(/^v/i, ''),
      notes,
      force: j.force === true,
      minVersion: j.minVersion ? String(j.minVersion) : '',
      url: j.url ? joinUrl(base, String(j.url)) : '',
      sha256: j.sha256 ? String(j.sha256).toLowerCase() : '',
      size: Number(j.size) || 0,
      pubDate: j.pubDate ? String(j.pubDate) : '',
      source: src,
      from,
    };

    const newer = cmpVer(manifest.version, this.currentVer) > 0;
    // 强制更新的两种来源：清单写了 force，或当前版本低于最低支持版本
    const belowMin = manifest.minVersion
      ? cmpVer(this.currentVer, manifest.minVersion) < 0
      : false;
    manifest.forced = manifest.force || belowMin;
    manifest.forcedBy = manifest.force ? 'force' : (belowMin ? 'minVersion' : '');

    this.state.lastCheck = new Date().toISOString();
    this._saveState();

    if (!newer) return { ok: true, available: false, current: this.currentVer, source: src, manifest };

    this.manifest = manifest;
    return { ok: true, available: true, forced: manifest.forced, manifest, current: this.currentVer, source: src };
  }

  get skipped() { return this.state.skippedVersion || ''; }

  skip(version) {
    this.state.skippedVersion = String(version || '');
    this._saveState();
  }

  /** 下载安装包；onProgress({received,total,pct,speed}) */
  async download(manifest, onProgress = () => {}) {
    if (!manifest || !manifest.url) throw new Error('更新清单里没有安装包地址');
    this.canceled = false;

    const dir = path.join(app.getPath('temp'), 'jiandi-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `jiandi-setup-${manifest.version.replace(/[^\w.-]/g, '_')}.exe`);

    // 已经下过同一版本且大小对得上，直接复用
    if (this.downloaded && this.downloaded.version === manifest.version && fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (!manifest.size || st.size === manifest.size) return { file, size: st.size };
    }

    if (!isHttp(manifest.url)) {
      const srcPath = toLocalPath(manifest.url);
      if (!fs.existsSync(srcPath)) throw new Error('安装包不存在：' + srcPath);
      fs.copyFileSync(srcPath, file);
      const size = fs.statSync(file).size;
      onProgress({ received: size, total: size, pct: 100, speed: 0 });
      return await this._finish(file, manifest, size);
    }

    const size = await this._streamDownload(manifest.url, file, manifest.size, onProgress);
    return await this._finish(file, manifest, size);
  }

  async _finish(file, manifest, size) {
    if (manifest.size && size !== manifest.size) {
      try { fs.unlinkSync(file); } catch {}
      throw new Error(`安装包大小不符（应为 ${manifest.size}，实际 ${size}）`);
    }
    if (manifest.sha256) {
      const hash = await new Promise((res, rej) => {
        const h = crypto.createHash('sha256');
        const rs = fs.createReadStream(file);
        rs.on('data', c => h.update(c));
        rs.on('end', () => res(h.digest('hex')));
        rs.on('error', rej);
      });
      if (hash !== manifest.sha256) {
        try { fs.unlinkSync(file); } catch {}
        throw new Error('安装包校验失败，文件可能不完整');
      }
    }
    this.downloaded = { file, version: manifest.version, size };
    return { file, size };
  }

  _streamDownload(url, file, expectedSize, onProgress, hop = 0) {
    return new Promise((resolve, reject) => {
      if (hop > 4) return reject(new Error('下载重定向次数过多'));

      const req = net.request({ method: 'GET', url, redirect: 'manual' });
      this.request = req;

      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; this.request = null; fn(v); };

      req.on('response', res => {
        const code = res.statusCode;
        const loc = res.headers.location;
        if (code >= 300 && code < 400 && loc) {
          res.resume();
          const next = Array.isArray(loc) ? loc[0] : loc;
          return this._streamDownload(joinUrl(url, next), file, expectedSize, onProgress, hop + 1)
            .then(v => done(resolve, v), e => done(reject, e));
        }
        if (code !== 200) {
          res.resume();
          return done(reject, new Error(`下载失败（HTTP ${code}）`));
        }

        const total = Number(res.headers['content-length']) || expectedSize || 0;
        let received = 0;
        let lastEmit = 0;
        let lastBytes = 0;
        let lastTime = Date.now();

        const ws = fs.createWriteStream(file);
        ws.on('error', e => { try { req.abort(); } catch {} done(reject, e); });

        res.on('data', chunk => {
          const buf = Buffer.from(chunk);
          received += buf.length;
          ws.write(buf);
          const now = Date.now();
          if (now - lastEmit > 180) {
            const dt = (now - lastTime) / 1000;
            const speed = dt > 0 ? (received - lastBytes) / dt : 0;
            lastEmit = now; lastTime = now; lastBytes = received;
            onProgress({
              received, total,
              pct: total ? Math.min(99.5, +(received / total * 100).toFixed(1)) : 0,
              speed,
            });
          }
        });

        res.on('end', () => {
          ws.end(() => {
            onProgress({ received, total, pct: 100, speed: 0 });
            done(resolve, received);
          });
        });
        res.on('error', e => { try { ws.destroy(); } catch {} done(reject, e); });
      });

      req.on('error', e => {
        if (this.canceled) return done(reject, new Error('已取消'));
        done(reject, e);
      });

      req.end();
    });
  }

  cancel() {
    this.canceled = true;
    try { this.request && this.request.abort(); } catch {}
    this.request = null;
  }

  /**
   * 启动安装程序并退出应用。
   * 用 cmd 延时 2 秒再启动，给本进程留出完全退出的时间，
   * 否则安装程序会因为「程序正在运行」而卡住。
   * unlock：退出前解除「强制更新禁止关闭」的锁定，否则 app.quit() 会被窗口拦住。
   */
  install(file, opts = {}) {
    if (!file || !fs.existsSync(file)) throw new Error('安装包不存在，请重新下载');
    if (!app.isPackaged && !process.env.JIANDI_ALLOW_DEV_INSTALL) {
      return { ok: true, dev: true, file };
    }
    const cmd = `ping -n 3 127.0.0.1 >nul & start "" "${file}"`;
    const child = spawn('cmd.exe', ['/c', cmd], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    setTimeout(() => {
      try { opts.unlock && opts.unlock(); } catch {}
      try { app.quit(); } catch {}
    }, 300);
    return { ok: true, file };
  }
}

module.exports = { Updater, cmpVer, parseVer };

// 精简 CDP 客户端：直连 Chrome 9222，不依赖外部代理
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// 端口是否真的有人在听（DevToolsActivePort 可能是上次运行留下的旧文件）
export function portOpen(port, timeout = 700) {
  return new Promise(res => {
    let done = false;
    const s = net.connect({ port, host: '127.0.0.1' });
    const fin = v => { if (done) return; done = true; try { s.destroy(); } catch {} res(v); };
    s.setTimeout(timeout);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

function userDataDirs() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const out = [];
  // 我们专用目录优先
  out.push(path.join(la, 'AutoApplyBot', 'chrome-profile'));
  // Chrome 默认
  out.push(path.join(la, 'Google', 'Chrome', 'User Data'));
  // Edge
  out.push(path.join(la, 'Microsoft', 'Edge', 'User Data'));
  return out;
}

function readDevToolsActivePort() {
  for (const d of userDataDirs()) {
    try {
      const f = path.join(d, 'DevToolsActivePort');
      if (!fs.existsSync(f)) continue;
      const txt = fs.readFileSync(f, 'utf8').trim().split(/\r?\n/);
      const port = Number(txt[0]);
      const wsPath = (txt[1] || '').trim();
      if (port > 0) return { port, wsPath, dir: d };
    } catch {}
  }
  return null;
}

async function tryJsonVersion(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: ac.signal,
      headers: { Host: `127.0.0.1:${port}` },
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.webSocketDebuggerUrl) return { port, wsUrl: j.webSocketDebuggerUrl };
  } catch {}
  return null;
}

async function tryJsonList(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    if (Array.isArray(j)) return j;
  } catch {}
  return null;
}

// 9222 是惯例端口；往后多扫几个，用户在别的端口开过也能直接接上
const COMMON_PORTS = [9222, 9223, 9224, 9225, 9226, 9227, 9228, 9229, 9230, 9231, 9232, 9333, 9444];

// 找出可用的 browser 级 ws 地址
export async function discover() {
  // 允许用 AAB_CDP_PORT 指定端口（逗号分隔），便于和已开着的浏览器对接
  const extra = String(process.env.AAB_CDP_PORT || '')
    .split(/[,;\s]+/).map(x => Number(x)).filter(n => n > 0);
  // 1) DevToolsActivePort 文件（最可靠，Chrome 157 也适用）
  const dap = readDevToolsActivePort();
  if (dap && dap.wsPath && await portOpen(dap.port)) {
    // 光看 TCP 通不够：9222 这类常见端口常被别的程序占着，必须确认对端真的是 Chrome
    const v = await tryJsonVersion(dap.port);
    if (v) return { ok: true, port: v.port, wsUrl: v.wsUrl, mode: 'DevToolsActivePort', profileDir: dap.dir };
  }
  // 2) HTTP 端点在部分版本可用
  const ports = [...new Set([...extra, dap?.port, ...COMMON_PORTS].filter(Boolean))];
  for (const p of ports) {
    if (!(await portOpen(p))) continue;
    const v = await tryJsonVersion(p);
    if (v) return { ok: true, port: v.port, wsUrl: v.wsUrl, mode: 'json/version' };
  }
  return { ok: false, ports };
}

// CDP 连接：扁平会话（sessionId 路由）
export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
    this.session = null;
    this.targetId = null;
  }

  async connect(timeout = 30000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const to = setTimeout(() => {
        if (settled) return; settled = true;
        try { ws.close(); } catch {}
        reject(new Error('CDP 连接超时（Chrome 可能未就绪）'));
      }, timeout);

      ws.addEventListener('open', () => {
        if (settled) return; settled = true;
        clearTimeout(to);
        resolve();
      });
      ws.addEventListener('error', ev => {
        if (settled) return; settled = true;
        clearTimeout(to);
        reject(new Error('CDP 连接失败: ' + (ev.message || 'WebSocket error')));
      });
      ws.addEventListener('close', () => {
        for (const { reject: rj } of this.pending.values()) rj(new Error('CDP 连接已断开'));
        this.pending.clear();
      });
      ws.addEventListener('message', ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
          else rs(msg.result);
        }
      });
    });
  }

  send(method, params = {}, sessionId = this.session, timeout = 45000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, timeout);
      this.pending.set(id, {
        resolve: v => { clearTimeout(to); resolve(v); },
        reject: e => { clearTimeout(to); reject(e); },
      });
      try { this.ws.send(JSON.stringify(payload)); }
      catch (e) { clearTimeout(to); this.pending.delete(id); reject(e); }
    });
  }

  // 找已有 page target，没有就新建
  async attachPage(urlHint) {
    this.hint = urlHint;
    const { targetInfos } = await this.send('Target.getTargets', {}, null);
    const pages = targetInfos.filter(t => t.type === 'page');
    let hit = urlHint ? pages.find(t => (t.url || '').includes(urlHint)) : null;
    // 优先复用上次的 target（仍在则继续用）
    if (!hit && this.targetId) hit = pages.find(t => t.targetId === this.targetId);
    // 没有明确 hint 才退而求其次
    if (!hit && !urlHint) hit = pages[0];
    if (!hit) {
      const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, null);
      this.targetId = targetId;
    } else {
      this.targetId = hit.targetId;
    }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: this.targetId, flatten: true }, null);
    this.session = sessionId;
    return this.targetId;
  }

  // 会话失效（页面被销毁/跳转重建）时恢复
  async ensure() {
    try {
      const { targetInfos } = await this.send('Target.getTargets', {}, null);
      const alive = targetInfos.some(t => t.targetId === this.targetId && t.type === 'page');
      if (!alive) { await this.attachPage(this.hint); return 'reattached'; }
      // 试探一次，确认 session 有效
      await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }, this.session, 8000);
      return 'ok';
    } catch (e) {
      if (/Session with given id|Cannot find context|Target closed|No target with given id/i.test(e.message)) {
        await this.attachPage(this.hint);
        return 'recovered';
      }
      throw e;
    }
  }

  // 列出所有 page target（多标签页场景：用户常在新标签页里登录）
  async listPages() {
    const { targetInfos } = await this.send('Target.getTargets', {}, null);
    return targetInfos.filter(t => t.type === 'page');
  }

  // 在「别的标签页」上求值，不动当前工作会话（用完立刻 detached）
  async evalIn(targetId, expr, awaitPromise = false, timeout = 15000) {
    let sessionId = null;
    try {
      ({ sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, null));
      const r = await this.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      }, sessionId, timeout);
      if (r.exceptionDetails) return undefined;
      return r.result?.value;
    } catch {
      return undefined;
    } finally {
      if (sessionId) { try { await this.send('Target.detachFromTarget', { sessionId }, null, 5000); } catch {} }
    }
  }

  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url }, null);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, null);
    this.targetId = targetId;
    this.session = sessionId;
    return targetId;
  }

  async eval(expr, awaitPromise = false) {
    try {
      return await this._evalOnce(expr, awaitPromise);
    } catch (e) {
      if (/Session with given id|Cannot find context|Target closed|No target with given id/i.test(e.message)) {
        await this.attachPage(this.hint);
        return await this._evalOnce(expr, awaitPromise);
      }
      throw e;
    }
  }

  async _evalOnce(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const m = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'js error';
      throw new Error(m);
    }
    return r.result?.value;
  }

  async goto(url, waitMs = 3000) {
    // 记下最近一次「业务页面」地址：登录等待结束后要靠它把页面拉回来
    if (!/passport\.|login\.|\/login|\/signin|\/register/i.test(url)) this.lastWorkUrl = url;
    try {
      await this.send('Page.enable').catch(() => {});
      await this.send('Page.navigate', { url });
    } catch (e) {
      if (/Session with given id|Cannot find context|Target closed/i.test(e.message)) {
        await this.attachPage(this.hint);
        await this.send('Page.enable').catch(() => {});
        await this.send('Page.navigate', { url });
      } else throw e;
    }
    await sleep(waitMs);
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function connect(opts = {}) {
  let lastErr = null;
  const tries = opts.tries ?? 1;   // 默认不重试：每次重连都会让 Chrome 弹一次授权框
  for (let i = 0; i < tries; i++) {
    const d = await discover();
    if (!d.ok) { lastErr = new Error('未发现可用的 Chrome 调试端口'); await sleep(1200); continue; }
    const cdp = new CDP(d.wsUrl);
    try {
      await cdp.connect(opts.timeout || 90000);
      return { ok: true, cdp, info: d };
    } catch (e) {
      lastErr = e;
      try { cdp.close(); } catch {}
      if (i < tries - 1) await sleep(1500);
    }
  }
  return { ok: false, err: lastErr, info: await discover() };
}

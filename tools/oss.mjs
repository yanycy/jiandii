/**
 * 极简阿里云 OSS 客户端（零依赖，只用 node 内置模块）
 *
 * 只做发布更新需要的三件事：上传文件、上传文本、探测对象是否存在。
 * 签名用 OSS V4（OSS4-HMAC-SHA256），与官方 SDK ali-oss 的算法逐字段一致，
 * 不需要 npm i 任何包，不受内网/代理环境影响。
 *
 * 凭证来源优先级：命令行参数 > 环境变量 > oss.config.json
 *   OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET / OSS_BUCKET / OSS_REGION / OSS_DIR
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';

// ------------------------------------------------------------------ 基础工具
const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** 与 SDK 一致的编码：encodeURIComponent 后再补 !'()* */
export function encodeString(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** UTC: 20260101T120000Z */
function isoDate(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 区域写法归一："oss-cn-shenzhen" 和 "cn-shenzhen" 都接受 */
export function normalizeRegion(region) {
  const r = String(region || '').trim();
  return r.startsWith('oss-') ? r.slice(4) : r;
}

// ------------------------------------------------------------------ 配置
/**
 * 读取配置：参数 > 环境变量 > oss.config.json
 * @param {object} cli 命令行传进来的覆盖项
 * @param {string} baseDir 从哪个目录找 oss.config.json
 */
export function loadConfig(cli = {}, baseDir = process.cwd()) {
  let fileCfg = {};
  const candidates = [
    path.join(baseDir, 'oss.config.json'),
    path.join(baseDir, '..', 'oss.config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) { fileCfg = JSON.parse(fs.readFileSync(p, 'utf8')); fileCfg.__file = p; break; }
    } catch (e) {
      throw new Error('oss.config.json 格式有误：' + e.message);
    }
  }

  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== '');
  const cfg = {
    accessKeyId: pick(cli.accessKeyId, process.env.OSS_ACCESS_KEY_ID, fileCfg.accessKeyId),
    accessKeySecret: pick(cli.accessKeySecret, process.env.OSS_ACCESS_KEY_SECRET, fileCfg.accessKeySecret),
    bucket: pick(cli.bucket, process.env.OSS_BUCKET, fileCfg.bucket, 'jiandidi'),
    region: normalizeRegion(pick(cli.region, process.env.OSS_REGION, fileCfg.region, 'cn-shenzhen')),
    dir: String(pick(cli.dir, process.env.OSS_DIR, fileCfg.dir, 'releases')).replace(/^\/+|\/+$/g, ''),
    endpoint: pick(cli.endpoint, process.env.OSS_ENDPOINT, fileCfg.endpoint),   // 自定义域名 / CDN
    internal: cli.internal !== undefined ? !!cli.internal : !!fileCfg.internal,   // 走内网 endpoint
    acl: pick(cli.acl, fileCfg.acl, 'public-read'),
    configFile: fileCfg.__file || '',
  };
  return cfg;
}

export function assertConfig(cfg) {
  const miss = [];
  if (!cfg.accessKeyId) miss.push('accessKeyId');
  if (!cfg.accessKeySecret) miss.push('accessKeySecret');
  if (!cfg.bucket) miss.push('bucket');
  if (miss.length) {
    const e = new Error('OSS 配置缺少：' + miss.join('、'));
    e.code = 'NO_CREDENTIALS';
    throw e;
  }
}

/** 服务端地址：https://<bucket>.oss-<region>.aliyuncs.com */
export function endpointHost(cfg) {
  if (cfg.endpoint) {
    try { return new URL(cfg.endpoint).host; } catch { return cfg.endpoint; }
  }
  return `${cfg.bucket}.${cfg.internal ? 'oss-' + cfg.region + '-internal' : 'oss-' + cfg.region}.aliyuncs.com`;
}

/** 对外可访问的地址（自定义域名优先） */
export function publicUrl(cfg, key) {
  const base = cfg.endpoint
    ? cfg.endpoint.replace(/\/+$/, '')
    : `https://${cfg.bucket}.oss-${cfg.region}.aliyuncs.com`;
  return base + '/' + key.split('/').map(encodeString).join('/');
}

// ------------------------------------------------------------------ 签名
/** 构造 V4 Authorization（算法与 ali-oss 的 signUtils 一致） */
export function signV4({ method, key, bucket, region, accessKeyId, accessKeySecret, headers }) {
  const date = headers['x-oss-date'];
  const onlyDate = date.split('T')[0];
  const scope = `${onlyDate}/${region}/oss/aliyun_v4_request`;

  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);

  // Canonical URI
  const canonicalUri = encodeString(`/${bucket}/${key || ''}`).replace(/%2F/g, '/');

  // Canonical Headers：content-type / content-md5 / 所有 x-oss-*
  const names = Object.keys(lower)
    .filter(k => k === 'content-type' || k === 'content-md5' || k.startsWith('x-oss-'))
    .sort();
  const canonicalHeaders = names.map(k => `${k}:${lower[k].trim()}\n`).join('');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    '',                                   // Canonical Query String（本次无子资源参数）
    canonicalHeaders,
    '',                                   // Additional Headers（未额外指定）
    lower['x-oss-content-sha256'] || 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'OSS4-HMAC-SHA256',
    date,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('aliyun_v4' + accessKeySecret, onlyDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'oss');
  const kSigning = hmac(kService, 'aliyun_v4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `OSS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},Signature=${signature}`;
}

// ------------------------------------------------------------------ HTTP
function send(urlStr, { method = 'GET', headers = {}, bodyFile = null, bodyBuffer = null, timeout = 120000, onProgress = null }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers,
      timeout,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(new Error('连接 OSS 超时')); });
    req.on('error', reject);

    if (bodyFile) {
      const stat = fs.statSync(bodyFile);
      let sent = 0;
      const rs = fs.createReadStream(bodyFile);
      rs.on('data', c => {
        sent += c.length;
        if (onProgress) onProgress(sent, stat.size);
      });
      rs.on('error', e => { req.destroy(e); });
      rs.pipe(req);
    } else if (bodyBuffer) {
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

function errText(res) {
  const m = /<Message>([\s\S]*?)<\/Message>/.exec(res.text || '');
  const c = /<Code>([\s\S]*?)<\/Code>/.exec(res.text || '');
  if (m) return `${c ? c[1] + '：' : ''}${m[1]}`;
  return `HTTP ${res.status}`;
}

// ------------------------------------------------------------------ 上传
/**
 * 上传一个文件
 * @returns {Promise<{key:string, url:string, size:number, status:number}>}
 */
export async function putFile(cfg, { key, file, contentType = 'application/octet-stream', cacheControl = '', acl = null, onProgress = null, retry = 2 }) {
  assertConfig(cfg);
  const size = fs.statSync(file).size;
  const host = endpointHost(cfg);

  let attempt = 0;
  for (;;) {
    attempt++;
    const headers = {
      'x-oss-date': isoDate(),
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
      'Content-Type': contentType,
      'Content-Length': size,
      Host: host,
      'User-Agent': 'jiandi-release/1.0',
    };
    if (cacheControl) headers['Cache-Control'] = cacheControl;
    if (acl) headers['x-oss-object-acl'] = acl;

    headers.Authorization = signV4({
      method: 'PUT', key, bucket: cfg.bucket, region: cfg.region,
      accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, headers,
    });

    try {
      const res = await send(`https://${host}/${key.split('/').map(encodeString).join('/')}`, {
        method: 'PUT', headers, bodyFile: file, onProgress,
      });

      if (res.status === 200) {
        return { key, url: publicUrl(cfg, key), size, status: 200 };
      }

      // 5xx / 网络抖动重试；4xx 直接报错
      const retryable = res.status >= 500;
      if (retryable && attempt <= retry) {
        await new Promise(r => setTimeout(r, 800 * attempt));
        continue;
      }
      const err = new Error(`上传失败（${errText(res)}）`);
      err.status = res.status;
      throw err;
    } catch (e) {
      if (e.status) throw e;
      if (attempt <= retry) {
        await new Promise(r => setTimeout(r, 800 * attempt));
        continue;
      }
      throw new Error('上传中断：' + e.message);
    }
  }
}

/** 上传一段文本（用于 latest.json） */
export async function putText(cfg, { key, text, contentType = 'application/json; charset=utf-8', cacheControl = '', acl = null }) {
  assertConfig(cfg);
  const host = endpointHost(cfg);
  const buf = Buffer.from(text, 'utf8');

  const headers = {
    'x-oss-date': isoDate(),
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'Content-Type': contentType,
    'Content-Length': buf.length,
    Host: host,
    'User-Agent': 'jiandi-release/1.0',
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  if (acl) headers['x-oss-object-acl'] = acl;

  headers.Authorization = signV4({
    method: 'PUT', key, bucket: cfg.bucket, region: cfg.region,
    accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, headers,
  });

  const res = await send(`https://${host}/${key.split('/').map(encodeString).join('/')}`, {
    method: 'PUT', headers, bodyBuffer: buf,
  });
  if (res.status !== 200) throw new Error(`上传失败（${errText(res)}）`);
  return { key, url: publicUrl(cfg, key), size: buf.length, status: 200 };
}

/** 匿名 GET，用来验证「手机上/别人电脑上能不能直接下」 */
export async function publicGet(urlStr) {
  try {
    const res = await send(urlStr, { method: 'GET', timeout: 20000 });
    return { ok: res.status === 200, status: res.status, text: res.text.slice(0, 4000) };
  } catch (e) {
    return { ok: false, status: 0, msg: e.message };
  }
}

/** 探测凭证是否有效（不带签名会返回 403，带错签名返回 SignatureDoesNotMatch） */
export async function testCredentials(cfg) {
  assertConfig(cfg);
  const host = endpointHost(cfg);
  const headers = {
    'x-oss-date': isoDate(),
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
    'Content-Type': 'application/octet-stream',
    'Content-Length': 0,
    Host: host,
  };
  headers.Authorization = signV4({
    method: 'GET', key: '', bucket: cfg.bucket, region: cfg.region,
    accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, headers,
  });
  const res = await send(`https://${host}/`, { method: 'GET', headers, timeout: 20000 });
  if (res.status === 200) return { ok: true };
  return { ok: false, msg: errText(res), status: res.status };
}

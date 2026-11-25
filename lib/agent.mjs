/**
 * 简递 · 智能体模块
 *
 * 职责：
 *   1. 本地知识库（简历原文 / 结构化档案 / 标准问答 / 回复规则）的读写与解析
 *   2. DeepSeek 调用（OpenAI 兼容协议），失败有明确降级提示
 *   3. BOSS 直聘聊天页值守：扫描未读 → 生成回复 → 随机延迟 → 自动发送 → 去重与限频
 *
 * 设计约束（对应方案文档「关键边界」）：
 *   - 不碰采集/投递/登录逻辑，本模块独立挂在旁边
 *   - API Key 与知识库只存本地（简递数据/），不进代码、不进仓库、不进日志
 *   - 页面元素一律「先抓真实 DOM 再定位」，定位失败返回可诊断的原因而不是静默失败
 *
 * 运行环境由 auto-apply.mjs 通过 initAgent() 注入，避免与入口文件循环依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractPdfText } from './pdftext.mjs';

// ------------------------------------------------------------------ 运行环境
let ENV = {
  dataDir: '',
  log: () => {},
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  ensureChrome: null,
  getCdp: null,
};

export function initAgent(env) {
  ENV = { ...ENV, ...env };
  try { kbEnsure(); } catch {}
}

const AI = m => { try { ENV.log(`[AI] ${m}`); } catch {} };

// ------------------------------------------------------------------ 路径
const kbDir = () => path.join(ENV.dataDir, '知识库');
const agDir = () => path.join(ENV.dataDir, '智能体');
const F = {
  resume: () => path.join(kbDir(), 'resume.txt'),
  profile: () => path.join(kbDir(), 'profile.json'),
  qa: () => path.join(kbDir(), 'qa.md'),
  rules: () => path.join(kbDir(), 'rules.md'),
  cfg: () => path.join(agDir(), 'agent.json'),
  records: () => path.join(agDir(), 'replied.json'),
  diag: () => path.join(agDir(), 'dom-diag.json'),
};

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

// ------------------------------------------------------------------ 默认内容
const DEFAULT_PROFILE = {
  name: '', gender: '', degree: '', major: '', years: '', status: '',
  expectRole: '', expectCity: '', skills: [], projects: [], intro: '', extra: '',
};

const DEFAULT_QA = `# 标准问答（AI 优先按这里的口径回复，问法相近就算命中）

## 期望薪资
- 问：期望薪资多少 / 薪资要求
- 答：按岗位预算来就可以，我主要看成长和项目匹配度，方便的话您可以说下这个岗位的薪资范围。

## 能实习多久 / 到岗时间
- 问：能实习几个月 / 什么时候能到岗
- 答：可以稳定实习 3 个月以上，每周到岗 5 天，随时可以入职。

## 是否在读 / 学历
- 问：你现在是大几 / 什么学历 / 还在读书吗
- 答：我目前是本科在读（2026 届），课程已经修完，可以全职实习。

## 为什么投这个岗位
- 问：为什么想来我们公司 / 为什么投这个岗位
- 答：岗位方向和我的项目经历比较匹配，想在这个方向长期做下去，看到贵司在招就投了。

## 有没有相关经验
- 问：做过类似项目吗 / 有几年经验
- 答：做过相关的课程和实战项目，简历里有写，具体细节我可以再详细说。
`;

const DEFAULT_RULES = `# 回复规则

## 语气
- 礼貌、简洁、像本人打字，不用书面语和客套模板。
- 每次只说一段话，60 字以内，不发多条。

## 绝对禁止（硬约束）
- 不得承诺具体薪资数字、不得承诺转正/涨薪/期权。
- 不得虚构学历、公司、项目、获奖、工作年限。
- 不得说「我是 AI / 机器人 / 自动回复」。
- 不得索要或提供身份证、银行卡等隐私信息。
- 不主动发链接、不主动谈远程/兼职等未确认的安排。

## 不确定时
- 资料里没有的信息，统一回：这个我确认一下再回复您。
`;

function defaultCfg() {
  return {
    enabled: false,            // 值守开关（运行期状态，落盘用于崩溃恢复提示）
    autoSend: true,            // true = 直接发送；false = 只生成草稿写日志
    apiKey: '',                // 只存本地
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxChars: 60,
    delayMin: 20,              // 每条回复前随机延迟（秒），压风控
    delayMax: 90,
    maxPerHour: 3,             // 单会话每小时最多回几条
    maxPerTick: 3,             // 每轮最多处理几个会话
    pollSec: 20,               // 轮询间隔（秒）
    blacklist: ['系统通知', '小助手', '客服', 'BOSS直聘团队', '简历助手', '智能助手'],
  };
}

// ------------------------------------------------------------------ 知识库
export function kbEnsure() {
  ensureDir(kbDir());
  ensureDir(agDir());
  const writeIfMissing = (file, content) => {
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, content, 'utf8'); } catch {}
  };
  writeIfMissing(F.resume(), '');
  writeIfMissing(F.profile(), JSON.stringify(DEFAULT_PROFILE, null, 2));
  writeIfMissing(F.qa(), DEFAULT_QA);
  writeIfMissing(F.rules(), DEFAULT_RULES);
  return kbDir();
}

function readText(file, def = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return def; }
}

function readProfile() {
  try {
    const raw = JSON.parse(readText(F.profile(), '{}'));
    return { ...DEFAULT_PROFILE, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch { return { ...DEFAULT_PROFILE }; }
}

export function kbLoad() {
  kbEnsure();
  return {
    resume: readText(F.resume(), ''),
    profile: readProfile(),
    qa: readText(F.qa(), DEFAULT_QA),
    rules: readText(F.rules(), DEFAULT_RULES),
    dir: kbDir(),
  };
}

export function kbSave(patch = {}) {
  kbEnsure();
  if (typeof patch.resume === 'string') fs.writeFileSync(F.resume(), patch.resume, 'utf8');
  if (patch.profile && typeof patch.profile === 'object') {
    const p = { ...readProfile(), ...patch.profile };
    if (Array.isArray(p.skills)) p.skills = p.skills.map(s => String(s).trim()).filter(Boolean);
    if (Array.isArray(p.projects)) p.projects = p.projects.map(s => String(s).trim()).filter(Boolean);
    fs.writeFileSync(F.profile(), JSON.stringify(p, null, 2), 'utf8');
  }
  if (typeof patch.qa === 'string') fs.writeFileSync(F.qa(), patch.qa, 'utf8');
  if (typeof patch.rules === 'string') fs.writeFileSync(F.rules(), patch.rules, 'utf8');
  AI(`知识库已保存（简历 ${readText(F.resume(), '').length} 字）`);
  return { ok: true, dir: kbDir() };
}

export function kbReset(kind) {
  kbEnsure();
  if (kind === 'qa') fs.writeFileSync(F.qa(), DEFAULT_QA, 'utf8');
  if (kind === 'rules') fs.writeFileSync(F.rules(), DEFAULT_RULES, 'utf8');
  if (kind === 'profile') fs.writeFileSync(F.profile(), JSON.stringify(DEFAULT_PROFILE, null, 2), 'utf8');
  return kbLoad();
}

// ------------------------------------------------------------------ 简历解析
// UTF-8 文本：直接读
function parsePlain(buf) {
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s;
}

// DOCX：本质是 zip，取 word/document.xml 后把段落转成换行
function readZipEntries(buf) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function readZipFile(buf, entry) {
  try {
    const p = entry.localOff;
    if (buf.readUInt32LE(p) !== 0x04034b50) return null;
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    return null;
  } catch { return null; }
}

const XML_ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };

function parseDocx(buf) {
  const entries = readZipEntries(buf);
  const target = entries.find(e => e.name === 'word/document.xml') || entries.find(e => /word\/document\d*\.xml$/.test(e.name));
  if (!target) return '';
  const raw = readZipFile(buf, target);
  if (!raw) return '';
  let xml = raw.toString('utf8');
  // 域代码（页码/目录之类）和修订删除的内容不是正文，先去掉
  xml = xml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '');
  xml = xml.replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, '');
  xml = xml.replace(/<w:tab[^>]*\/>/g, '\t');
  xml = xml.replace(/<w:br[^>]*\/>/g, '\n');
  xml = xml.replace(/<\/w:p>/g, '\n');
  // 简历模板基本都用表格排版，保留单元格/行的分隔，不然字段会粘成一句
  xml = xml.replace(/<\/w:tc>/g, '\t');
  xml = xml.replace(/<\/w:tr>/g, '\n');
  xml = xml.replace(/<\/w:tbl>/g, '\n');
  xml = xml.replace(/<[^>]+>/g, '');
  xml = xml.replace(/&[a-z]+;/g, m => XML_ENTITY[m] || m);
  return xml
    .replace(/[ \t]*\t[ \t]*/g, '\t')
    .replace(/\t{2,}/g, '\t')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// PDF：取文字层（含 CID/Identity-H 字体的 ToUnicode 反查），扫描件会返回明确原因
const PDF_REASON = {
  notpdf: '这个文件不像是 PDF（扩展名和内容对不上）',
  broken: 'PDF 结构损坏，读不出内容',
  encrypted: 'PDF 设了打开密码/加密保护，请先解除密码另存一份',
  nopage: 'PDF 里没找到页面内容',
  notext: '这个 PDF 没有文字层（多半是扫描件 / 图片导出的 PDF），请把简历内容粘贴到下方文本框',
  lowquality: 'PDF 文字层解析不出有效内容（可能是特殊字体或扫描件），请把简历内容粘贴到下方文本框',
};

function parsePdf(buf) {
  const r = extractPdfText(buf);
  if (!r.ok) return { ok: false, msg: PDF_REASON[r.reason] || 'PDF 解析失败，请把简历内容粘贴到下方文本框' };
  return { ok: true, text: r.text };
}

/**
 * 解析简历文件，返回 { ok, text, warn }
 * 支持 .txt/.md/.docx/.pdf
 */
export function parseResumeFile(file) {
  try {
    const ext = path.extname(file).toLowerCase();
    const buf = fs.readFileSync(file);
    if (ext === '.txt' || ext === '.md' || ext === '.markdown' || ext === '.json') {
      return { ok: true, text: parsePlain(buf) };
    }
    if (ext === '.docx') {
      const text = parseDocx(buf);
      if (!text) return { ok: false, msg: '这个 docx 里没读到文字（可能是图片版简历），请把内容粘贴到下方文本框' };
      return { ok: true, text };
    }
    if (ext === '.pdf') {
      const r = parsePdf(buf);
      if (!r.ok) return { ok: false, msg: r.msg };
      const warn = r.text.length < 200 ? 'PDF 里读到的文字偏少，建议看一眼再保存' : '';
      return { ok: true, text: r.text, warn };
    }
    if (ext === '.doc') {
      return { ok: false, msg: '旧版 .doc 是二进制格式，读不了正文内容。请在 Word / WPS 里「另存为 .docx」后上传，或直接把内容粘贴到文本框' };
    }
    return { ok: false, msg: `不支持的文件类型 ${ext || '(无扩展名)'}，请上传 pdf / docx / txt / md` };
  } catch (e) {
    return { ok: false, msg: '读取文件失败：' + (e && e.message) };
  }
}

// ---------------------------------------------------------------- 自动建档
// 解析完简历立刻把能确定的信息填进「结构化档案」，不用再手打一遍
const PROFILE_SYS = `你在做简历信息抽取。只输出一个 JSON 对象，不要解释，不要代码块以外的任何文字。
字段与要求：
- name：姓名
- gender：性别（男/女，没有就空）
- degree：最高学历（博士/硕士/本科/大专/专科/中专/高中）
- major：专业
- years：经验年限或身份（应届 / 实习 / 1 年 / 3 年）
- status：求职身份（实习 / 应届 / 社招）
- expectRole：期望工作方向，可以有多个，用「 / 」连接，例如「Web前端 / 实施工程师」
- expectCity：期望城市（简历没写期望城市时，用现所在地/意向城市）
- skills：技能字符串数组（语言、框架、工具、中间件都算，最多 15 个）
- projects：项目经历字符串数组，每条格式「时间 公司/项目：做了什么，结果如何」，最多 6 条
- intro：自我介绍，120 字以内，尽量用简历原文，不要吹
简历里没有的信息给空字符串或空数组，绝对不要编造。`;

function looseJson(s) {
  let t = String(s || '').trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

const toStr = v => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const toArr = v => (Array.isArray(v)
  ? v.map(toStr).filter(Boolean)
  : String(v || '').split(/[、,，;；\n]+/).map(s => s.trim()).filter(Boolean));

const SKILL_WORDS = ['HTML', 'CSS', 'JavaScript', 'TypeScript', 'Vue', 'React', 'Nuxt', 'UniApp', '小程序', 'Node',
  'Java', 'SpringBoot', 'Spring', 'Python', 'MySQL', 'Redis', 'MongoDB', 'Git', 'Linux', 'Docker', 'Electron',
  'ElementPlus', 'Element', 'Bootstrap', 'jQuery', 'SQL', 'PHP', 'Go', 'C++', 'C#', 'Flutter', 'Android',
  'Figma', 'Axure', 'Photoshop', 'Nginx', 'Kafka', 'Webpack', 'Vite', 'Pinia', 'Vuex'];

// 没有 Key 或调用失败时的本地兜底：能认出几个算几个
function profileByRules(text) {
  const t = String(text || '');
  const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
  const grab = res => { for (const re of res) { const m = re.exec(t); if (m && toStr(m[1])) return toStr(m[1]); } return ''; };

  const name = grab([/姓\s*名[:：|]?\s*([\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z .]{1,20})/])
    || (/^[\u4e00-\u9fa5]{2,4}$/.test(lines[0] || '') ? lines[0] : '');
  const degree = grab([/(博士|硕士|本科|大专|专科|中专|高中)/]);
  const major = (grab([/(?:^|\n)\s*专\s*业[:：|]\s*([^\n|，,]{2,24})/, /专\s*业[:：|]\s*([^\n|，,]{2,24})/]) || '').trim();
  const status = grab([/(应届毕业生|应届|实习生|实习|社招|在校)/]).replace('毕业生', '');
  const years = grab([/(\d{1,2})\s*年(?:以上)?(?:工作)?经验/]);
  const city = (grab([/(?:期望城市|意向城市|现居地|现所在地|所在地)[:：|]\s*([^\s\n|，,：:]{2,12})/]) || '').replace(/(邮箱|电话|手机|性别).*$/, '');
  const role = (grab([/(?:意向岗位|期望岗位|目标岗位|期望工作方向|求职意向)[:：|]\s*([^\n]{2,40})/]) || '')
    .replace(/^(?:意向岗位|期望岗位|目标岗位|期望工作方向|求职意向)[:：|]?\s*/, '');

  const skills = SKILL_WORDS.filter(s => new RegExp(s.replace(/[+]/g, '\\+'), 'i').test(t)).slice(0, 15);

  const introM = /(?:自我评价|个人评价|自我描述)[:：]?\s*\n?([\s\S]{10,400}?)(?:\n\s*(?:求职意向|工作经验|实习经历|工作经历|教育经历|项目经历|相关技能|技能|荣誉|在校经历)\s*|$)/.exec(t);
  const intro = introM ? toStr(introM[1]).replace(/\s*\n\s*/g, ' ').slice(0, 200) : '';

  return {
    name, degree, major,
    years: years ? years + ' 年' : (status === '应届' ? '应届' : ''),
    status: status === '实习生' ? '实习' : status,
    expectRole: role, expectCity: city, skills, projects: [], intro,
  };
}

function normalizeProfile(p) {
  return {
    name: toStr(p.name).slice(0, 20),
    gender: toStr(p.gender).slice(0, 4),
    degree: toStr(p.degree).slice(0, 10),
    major: toStr(p.major).slice(0, 30),
    years: toStr(p.years).slice(0, 20),
    status: toStr(p.status).slice(0, 10),
    expectRole: toStr(p.expectRole).slice(0, 80),
    expectCity: toStr(p.expectCity).slice(0, 20),
    skills: toArr(p.skills).slice(0, 20).map(s => s.slice(0, 24)),
    projects: toArr(p.projects).slice(0, 8).map(s => s.slice(0, 150)),
    intro: toStr(p.intro).slice(0, 400),
    extra: toStr(p.extra).slice(0, 200),
  };
}

/**
 * 从简历原文抽取结构化档案并落盘。
 * 有 Key 用模型抽（准），没有就本地规则（能用）。
 * @returns {{ok:boolean, profile?:object, source?:'ai'|'rule', msg?:string}}
 */
export async function profileFromResume(text) {
  const src = String(text || '').trim();
  if (src.length < 20) return { ok: false, msg: '简历内容太少，没法建档' };
  const cfg = cfgLoad();
  let got = null, source = 'rule';

  if (cfg.apiKey) {
    try {
      const out = await llmChat([
        { role: 'system', content: PROFILE_SYS },
        { role: 'user', content: '简历原文：\n' + src.slice(0, 6000) },
      ], { maxTokens: 900, temperature: 0.1, timeout: 45000 });
      const p = looseJson(out && out.content);
      if (p) { got = p; source = 'ai'; }
    } catch (e) {
      AI('AI 抽取档案失败，改用本地规则：' + e.message);
    }
  }
  if (!got) got = profileByRules(src);

  const next = normalizeProfile(got);
  const old = readProfile();
  const merged = { ...old };
  for (const k of Object.keys(next)) {
    const v = next[k];
    const empty = Array.isArray(v) ? !v.length : !v;
    if (!empty) merged[k] = v;      // 只覆盖有值的字段，用户手填的不清空
  }
  kbSave({ profile: merged });
  AI(`档案已自动填写（${source === 'ai' ? 'AI 抽取' : '本地规则'}）：${merged.name || '未识别姓名'} / ${merged.degree || '—'} / ${merged.expectRole || '—'}`);
  return { ok: true, profile: merged, source };
}


// ------------------------------------------------------------------ 设置
// API Key 单独存在用户目录（%APPDATA%\简递\secret.json），不放在安装目录里的数据文件夹。
// 这样覆盖安装 / 换版本 / 清理 简递数据 都不会把 Key 弄丢，也不会跟着知识库被拷来拷去。
function secretFile() {
  const base = process.env.APPDATA || process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Roaming') : '');
  return path.join(base || ENV.dataDir, '简递', 'secret.json');
}

function keyFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(secretFile(), 'utf8')) || {};
    return String(j.apiKey || '').trim();
  } catch { return ''; }
}

function keyToDisk(k) {
  try {
    const f = secretFile();
    ensureDir(path.dirname(f));
    if (!k) { try { fs.unlinkSync(f); } catch {} return; }
    fs.writeFileSync(f, JSON.stringify({ apiKey: k, updatedAt: Date.now() }, null, 2), 'utf8');
  } catch {}
}

let keyMigrated = false;

function cfgLoad() {
  ensureDir(agDir());
  let raw = {};
  let rawOk = false;
  try { raw = JSON.parse(readText(F.cfg(), '{}')) || {}; rawOk = true; } catch {}
  const cfg = { ...defaultCfg(), ...raw };
  const diskKey = keyFromDisk();
  if (diskKey) {
    cfg.apiKey = diskKey;
  } else if (cfg.apiKey && !keyMigrated) {
    // 老版本把 Key 存在 简递数据/智能体/agent.json 里，搬一次到用户目录
    keyMigrated = true;
    keyToDisk(cfg.apiKey);
    if (rawOk && raw.apiKey) {
      try { fs.writeFileSync(F.cfg(), JSON.stringify({ ...raw, apiKey: '' }, null, 2), 'utf8'); } catch {}
    }
  }
  cfg.delayMin = clampNum(cfg.delayMin, 1, 600, 20);
  cfg.delayMax = clampNum(cfg.delayMax, cfg.delayMin, 900, 90);
  cfg.maxPerHour = clampNum(cfg.maxPerHour, 1, 50, 3);
  cfg.maxPerTick = clampNum(cfg.maxPerTick, 1, 10, 3);
  cfg.pollSec = clampNum(cfg.pollSec, 10, 600, 20);
  cfg.maxChars = clampNum(cfg.maxChars, 20, 200, 60);
  return cfg;
}

function clampNum(v, min, max, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function cfgSave(patch = {}) {
  const cfg = { ...cfgLoad(), ...patch };
  ensureDir(agDir());
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    keyToDisk(patch.apiKey || '');
    cfg.apiKey = patch.apiKey || '';
  }
  const onDisk = { ...cfg, apiKey: '' };   // 密钥不进 agent.json
  fs.writeFileSync(F.cfg(), JSON.stringify(onDisk, null, 2), 'utf8');
  return cfg;
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}

// 给界面用的状态（绝不返回完整 Key）
export function agentState() {
  const cfg = cfgLoad();
  const kb = kbLoad();
  const p = kb.profile;
  const filled = ['name', 'degree', 'major', 'expectRole', 'intro'].filter(k => String(p[k] || '').trim()).length;
  return {
    ok: true,
    enabled: cfg.enabled,
    autoSend: cfg.autoSend,
    hasKey: !!cfg.apiKey,
    keyMask: maskKey(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    maxChars: cfg.maxChars,
    delayMin: cfg.delayMin,
    delayMax: cfg.delayMax,
    maxPerHour: cfg.maxPerHour,
    pollSec: cfg.pollSec,
    kbDir: kb.dir,
    kb: {
      resumeLen: (kb.resume || '').length,
      profileFilled: filled,
      hasQa: (kb.qa || '').trim().length > 40,
      hasRules: (kb.rules || '').trim().length > 20,
    },
    watch: {
      running: WATCH.running,
      lastScan: WATCH.lastScan,
      lastError: WATCH.lastError,
      stats: WATCH.stats,
    },
  };
}

export function agentSaveCfg(patch = {}) {
  const clean = {};
  if (typeof patch.apiKey === 'string' && patch.apiKey && !/^[•*]+$/.test(patch.apiKey) && !patch.apiKey.includes('••')) {
    clean.apiKey = patch.apiKey.trim();
  }
  if (typeof patch.clearKey === 'boolean' && patch.clearKey) clean.apiKey = '';
  for (const k of ['baseUrl', 'model']) {
    if (typeof patch[k] === 'string' && patch[k].trim()) clean[k] = patch[k].trim();
  }
  for (const k of ['maxChars', 'delayMin', 'delayMax', 'maxPerHour', 'pollSec', 'temperature']) {
    if (patch[k] !== undefined) clean[k] = Number(patch[k]);
  }
  for (const k of ['autoSend']) {
    if (typeof patch[k] === 'boolean') clean[k] = patch[k];
  }
  if (Array.isArray(patch.blacklist)) clean.blacklist = patch.blacklist.map(s => String(s).trim()).filter(Boolean);
  const cfg = cfgSave(clean);
  AI(`设置已保存（模型 ${cfg.model}${clean.apiKey ? ' · Key 已更新' : ''}）`);
  return agentState();
}

// ------------------------------------------------------------------ 模型调用
function apiUrl(cfg) {
  const base = String(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

async function llmChat(messages, opt = {}) {
  const cfg = cfgLoad();
  if (!cfg.apiKey) throw new Error('还没填 DeepSeek API Key（在「值守与设置」里填，只存本地）');
  const body = {
    model: cfg.model || 'deepseek-v4-flash',
    messages,
    temperature: opt.temperature ?? cfg.temperature,
    max_tokens: opt.maxTokens ?? 400,
    stream: false,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opt.timeout ?? 60000);
  let res;
  try {
    res = await fetch(apiUrl(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('调用模型超时（60 秒），检查网络后重试');
    throw new Error('连不上模型接口：' + ((e && e.message) || '网络错误'));
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const detail = (json && json.error && (json.error.message || json.error.type)) || text.slice(0, 200) || '';
    if (res.status === 401) throw new Error('Key 无效或已过期（401），请检查 API Key');
    if (res.status === 402) throw new Error('账户余额不足（402），请到 platform.deepseek.com 充值');
    if (res.status === 429) throw new Error('调用太频繁被限流（429），稍等一会再试');
    if (res.status === 404) throw new Error('接口地址或模型名不对（404）：' + detail);
    throw new Error(`模型接口报错 ${res.status}：${detail}`);
  }
  const content = json && json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : '';
  if (!content) throw new Error('模型返回为空，稍后重试');
  return { content, usage: (json && json.usage) || null, model: (json && json.model) || body.model };
}

export async function agentTest() {
  try {
    const r = await llmChat([
      { role: 'system', content: '你是一个连通性测试助手，只回答被要求的内容。' },
      { role: 'user', content: '只回复四个字：连接正常' },
    ], { temperature: 0, maxTokens: 20, timeout: 30000 });
    AI(`模型连通测试通过（${r.model}）`);
    return { ok: true, msg: `连接正常 · 模型 ${r.model}`, usage: r.usage };
  } catch (e) {
    AI('模型连通测试失败：' + e.message);
    return { ok: false, msg: e.message };
  }
}

// ------------------------------------------------------------------ 提示词
function profileText(p) {
  const L = [];
  const push = (k, v) => { const s = String(v == null ? '' : v).trim(); if (s) L.push(`${k}：${s}`); };
  push('姓名', p.name);
  push('性别', p.gender);
  push('学历', p.degree);
  push('专业', p.major);
  push('工作/实习年限', p.years);
  push('当前身份', p.status);
  push('期望工作方向', p.expectRole);
  push('期望城市', p.expectCity);
  if (Array.isArray(p.skills) && p.skills.length) push('技能', p.skills.join('、'));
  if (Array.isArray(p.projects) && p.projects.length) push('项目经历', p.projects.join('；'));
  push('自我介绍', p.intro);
  push('补充说明', p.extra);
  return L.join('\n');
}

function buildSystemPrompt(kb, cfg) {
  const resume = String(kb.resume || '').slice(0, 8000);
  const prof = profileText(kb.profile || {});
  return [
    '你是求职者本人的求职助理，正在 BOSS 直聘上代替他回复招聘方 HR 的消息。',
    '',
    '【唯二的事实来源】只能使用下面「个人档案」「简历原文」「标准问答」里出现过的信息，',
    '任何没写到的内容都必须按「回复规则」的兜底话术处理，绝对不能编造。',
    '',
    '【个人档案】',
    prof || '（未填写）',
    '',
    '【简历原文】',
    resume || '（未上传）',
    '',
    '【标准问答】',
    String(kb.qa || '').slice(0, 3000) || '（无）',
    '',
    '【回复规则】',
    String(kb.rules || '').slice(0, 3000) || '（无）',
    '',
    '【输出要求】',
    `1. 只说一段话，${cfg.maxChars} 字以内，口语化、礼貌，像真人打字。`,
    '2. 不要用 Markdown、不要列点、不要加引号或「回复：」这类前缀。',
    '3. 不要自称 AI、机器人、助手，不要说这是自动回复。',
    '4. 不承诺具体薪资数字，被问薪资就按标准问答的口径回。',
    '5. 不虚构任何学历、公司、项目、获奖、年限。',
    '6. 只输出要发出去的那段话本身，不要解释。',
  ].join('\n');
}

function cleanReply(s, maxChars) {
  let t = String(s || '').trim();
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/,'');
  t = t.replace(/^(回复|答复|答)[:：]\s*/, '');
  t = t.replace(/^["'「『]+|["'」』]+$/g, '');
  t = t.replace(/\*\*/g, '').replace(/^\s*[-*]\s+/gm, '');
  t = t.replace(/\s*\n+\s*/g, ' ').trim();
  if (t.length > maxChars) {
    // 超长就在最近的句读处截断，避免半句话
    const cut = t.slice(0, maxChars);
    const i = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    t = i >= maxChars * 0.5 ? cut.slice(0, i + 1) : cut;
  }
  return t.trim();
}

async function composeReply({ message, history }, cfg) {
  const kb = kbLoad();
  if (!String(kb.resume || '').trim() && !String(profileText(kb.profile).trim())) {
    throw new Error('知识库还是空的：先在「知识库」里上传简历或填写档案，否则 AI 只能瞎编');
  }
  const ctx = (history || []).slice(-6).map(m => `${m.role === 'me' ? '我' : 'HR'}：${m.text}`).join('\n');
  const messages = [
    { role: 'system', content: buildSystemPrompt(kb, cfg) },
    { role: 'user', content: [
      ctx ? '【最近的对话】\n' + ctx : '',
      '【HR 刚发来的消息】\n' + message,
      '',
      '请写出我要回复的那段话。',
    ].filter(Boolean).join('\n\n') },
  ];
  const r = await llmChat(messages, { maxTokens: 300 });
  const reply = cleanReply(r.content, cfg.maxChars);
  if (!reply) throw new Error('模型没给出可用回复，稍后重试');
  return reply;
}

// 试运行：只生成不发送，用来验证「AI 是否认识你」
export async function agentTryReply(text) {
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, msg: '先输入一条 HR 可能发来的消息' };
  const cfg = cfgLoad();
  try {
    const reply = await composeReply({ message: msg, history: [] }, cfg);
    AI(`试生成回复：「${msg.slice(0, 30)}」→「${reply}」`);
    return { ok: true, reply };
  } catch (e) {
    AI('试生成失败：' + e.message);
    return { ok: false, msg: e.message };
  }
}

// ------------------------------------------------------------------ 去重 / 限频记录
function recordsLoad() {
  try {
    const raw = JSON.parse(readText(F.records(), '{}'));
    return {
      replied: (raw && raw.replied) || {},   // key -> 时间戳
      conv: (raw && raw.conv) || {},         // 会话名 -> [时间戳]
    };
  } catch { return { replied: {}, conv: {} }; }
}

function recordsSave(rec) {
  try {
    const keys = Object.keys(rec.replied || {});
    if (keys.length > 800) {
      keys.sort((a, b) => rec.replied[a] - rec.replied[b]);
      for (const k of keys.slice(0, keys.length - 800)) delete rec.replied[k];
    }
    const now = Date.now();
    for (const name of Object.keys(rec.conv || {})) {
      rec.conv[name] = (rec.conv[name] || []).filter(t => now - t < 6 * 3600 * 1000).slice(-30);
    }
    ensureDir(agDir());
    fs.writeFileSync(F.records(), JSON.stringify(rec, null, 2), 'utf8');
  } catch {}
}

function repliedBefore(key) { return !!recordsLoad().replied[key]; }

function markReplied(name, key) {
  const rec = recordsLoad();
  rec.replied[key] = Date.now();
  rec.conv[name] = (rec.conv[name] || []).concat(Date.now());
  recordsSave(rec);
}

function hitHourlyCap(name, maxPerHour) {
  const rec = recordsLoad();
  const now = Date.now();
  const list = (rec.conv[name] || []).filter(t => now - t < 3600 * 1000);
  return list.length >= maxPerHour;
}

// ------------------------------------------------------------------ 页面脚本
const PAGE_HELPERS = `
  const clean=s=>(s||'').replace(/\\s+/g,' ').trim();
  const vis=e=>{ if(!e||!e.getBoundingClientRect) return false; const r=e.getBoundingClientRect(); const st=getComputedStyle(e);
    return r.width>2 && r.height>2 && st.display!=='none' && st.visibility!=='hidden' && Number(st.opacity)!==0; };
`;

// 扫描会话列表：只取「有未读数字」的会话
const SCAN_JS = `(()=>{${PAGE_HELPERS}
  const out={url:location.href, convs:[], diag:{}};
  const listSels=['ul.chat-user-list','.chat-user-list','[class*="chat-user-list"]','[class*="user-list"]','[class*="conversation"]'];
  let list=null;
  for(const s of listSels){ const el=document.querySelector(s); if(el&&el.querySelectorAll('li').length){ list=el; break; } }
  out.diag.listClass=list?String(list.className||''):'';
  const items=list?[...list.querySelectorAll('li')].filter(vis):[];
  out.diag.itemCount=items.length;
  items.forEach((li,i)=>{
    // 列表项结构：.figure>img(+.notice-badge) / .text>span.time / .title-box>.name-box>.name-text / .last-msg>.last-msg-text
    const nameEl=li.querySelector('.name-text')||li.querySelector('.name-box')||li.querySelector('[class*="name"]');
    const msgEl=li.querySelector('.last-msg-text')||li.querySelector('.last-msg')||li.querySelector('.text');
    const badgeEl=li.querySelector('.notice-badge,[class*="unread"]');
    const timeEl=li.querySelector('.time');
    const badge=clean(badgeEl&&badgeEl.innerText);
    out.convs.push({
      i,
      name:clean(nameEl&&nameEl.innerText).slice(0,20),
      preview:clean(msgEl&&msgEl.innerText).slice(0,80),
      time:clean(timeEl&&timeEl.innerText).slice(0,20),
      badge,
      unread: /^\\d+\\+?$/.test(badge) ? parseInt(badge,10)||1 : (badge?'?':0),
    });
  });
  out.diag.sampleItems=items.slice(0,2).map(li=>(li.outerHTML||'').slice(0,500));
  return JSON.stringify(out);
})()`;

function openConvJs(name) {
  // 会话列表是虚拟滚动（ul[role=group] 用 padding 撑高），scrollIntoView 会触发重建，
  // 之前那种「滚完立刻点旧节点」的做法点的是已脱离文档的元素 → 看起来点了其实没打开。
  // 所以：滚 → 等一拍 → 重新按名字找 → 再点。
  return `(async()=>{${PAGE_HELPERS}
    const want=${JSON.stringify(name)};
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const findItem=()=>{
      const lis=[...document.querySelectorAll('.user-list li[role="listitem"], ul[role="group"] li, .user-list-content li')].filter(vis);
      const nameOf=li=>{ const n=li.querySelector('.name-text')||li.querySelector('.name-box')||li.querySelector('[class*="name"]'); return clean(n&&n.innerText); };
      for(const li of lis){ if(nameOf(li)===want) return li; }
      for(const li of lis){ const s=nameOf(li); if(s && (s.startsWith(want)||want.startsWith(s))) return li; }
      return null;
    };
    let hit=findItem();
    if(!hit) return 'NO_ITEM';
    hit.scrollIntoView({block:'center'});
    await sleep(280);
    hit=findItem();
    if(!hit) return 'NO_ITEM_AFTER_SCROLL';
    const r=hit.getBoundingClientRect();
    const o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,view:window};
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(n=>hit.dispatchEvent(new MouseEvent(n,o)));
    hit.click();
    return 'OPENED';
  })()`;
}

// 读当前打开的会话：消息在 .chat-message > .message-item，
// 角色看 class（item-friend=HR / item-myself=我），拿不到就看气泡左右位置。
const READ_CONV_JS = `(()=>{${PAGE_HELPERS}
  const pane=document.querySelector('.chat-conversation')||document.body;
  const paneRect=pane.getBoundingClientRect();
  const topEl=pane.querySelector('.top-info-content .name-text')||pane.querySelector('.top-info-content [class*="name"]');
  const topName=clean(topEl&&topEl.innerText).slice(0,40);
  const selEl=document.querySelector('.user-list .friend-content.selected .name-text')||document.querySelector('.user-list .friend-content.selected .name-box');
  const selectedName=clean(selEl&&selEl.innerText).slice(0,40);

  let box=document.querySelector('.chat-message')||document.querySelector('.chat-record .chat-message');
  if(!box){ for(const s of ['.chat-message-list','[class*="message-list"]','[class*="message-container"]']){ const el=document.querySelector(s); if(el){ box=el; break; } } }

  const msgs=[];
  if(box){
    const items=[...box.querySelectorAll('.message-item, [class*="message-item"]')].filter(vis);
    for(const it of items.slice(-16)){
      const cls=String(it.className||'');
      const body=it.querySelector('.text-content')||it.querySelector('.message-text');
      const kind=body?'text':(it.querySelector('.message-emoji,.item-image')?'emoji':(it.querySelector('.item-resume,.item-jobdesc')?'card':'other'));
      let text=clean(body&&body.innerText);
      if(!text && kind==='emoji') text='[表情]';
      if(!text && kind==='card') text='[卡片消息]';
      if(!text) continue;                       // 只有时间的分隔行，跳过
      let role='';
      if(/item-myself|myself/i.test(cls)) role='me';
      else if(/item-friend|friend/i.test(cls)) role='them';
      else {
        const br=(body||it).getBoundingClientRect();
        role=(br.width && (br.left+br.width/2) > (paneRect.left+paneRect.width/2)) ? 'me' : 'them';
      }
      msgs.push({ role, text: text.slice(0,300), kind, cls: cls.slice(0,48) });
    }
  }
  const inputs=[...document.querySelectorAll('#chat-input,.chat-input,[contenteditable="true"],textarea')].filter(vis);
  const sendBtns=[...document.querySelectorAll('button,[role="button"],[class*="send"]')].filter(vis)
    .filter(b=>/^发送$/.test(clean(b.innerText))||/send/i.test(String(b.className||'')));
  return JSON.stringify({
    url:location.href,
    topName,
    selectedName,
    msgs,
    hasInput: inputs.length>0,
    hasSend: sendBtns.length>0,
    diag: {
      msgCount: msgs.length,
      boxClass: box?String(box.className||''):'',
      inputClass: inputs[0]?String(inputs[0].className||'')+'|'+inputs[0].tagName:'',
      sendText: sendBtns[0]?clean(sendBtns[0].innerText)||String(sendBtns[0].className||''):'',
    },
  });
})()`;

function sendReplyJs(text) {
  return `(()=>{${PAGE_HELPERS}
    const want=${JSON.stringify(text)};
    const cands=[...document.querySelectorAll('#chat-input,.chat-input,[contenteditable="true"],textarea')].filter(vis);
    if(!cands.length) return 'NO_INPUT';
    cands.sort((a,b)=>{
      const sc=x=>{ const c=String(x.className||''); if(/chat-input|chat-editor|editor/.test(c)) return 0;
        if(x.getAttribute&&x.getAttribute('contenteditable')==='true') return 1; return 2; };
      const d=sc(a)-sc(b); if(d) return d;
      const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return rb.width*rb.height-ra.width*ra.height;
    });
    const input=cands[0];
    input.focus();
    input.click();
    if(input.tagName==='TEXTAREA'||input.tagName==='INPUT'){
      input.value=want;
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      // contenteditable：用 insertText 才能触发 Vue/React 的输入监听
      try{
        const sel=window.getSelection(); const rng=document.createRange();
        rng.selectNodeContents(input); sel.removeAllRanges(); sel.addRange(rng);
        input.innerHTML='';
        let ok=false;
        try{ ok=document.execCommand('insertText', false, want); }catch{}
        if(!ok || !clean(input.innerText)){
          input.textContent=want;
          input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:want}));
        }
      }catch(e){
        input.textContent=want;
        input.dispatchEvent(new InputEvent('input',{bubbles:true}));
      }
    }
    const btns=[...document.querySelectorAll('button,[role="button"],[class*="send"]')].filter(vis);
    let send=btns.find(b=>/^发送$/.test(clean(b.innerText)));
    if(!send) send=btns.find(b=>/send/i.test(String(b.className||'')));
    if(send){ send.click(); return 'CLICKED'; }
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    return 'ENTER';
  })()`;
}

// 页面结构诊断：定位失败时用它抓真实 DOM，而不是靠猜
const DIAG_JS = `(()=>{${PAGE_HELPERS}
  const dump=(sel,n)=>{ try{ return [...document.querySelectorAll(sel)].filter(vis).slice(0,n).map(e=>({
    tag:e.tagName, cls:String(e.className||'').slice(0,90),
    text:clean(e.innerText).slice(0,80),
    childCount:e.querySelectorAll('*').length,
    box:{w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)},
    html:(e.outerHTML||'').slice(0,600),
  })); }catch{ return []; } };
  return JSON.stringify({
    url: location.href,
    title: document.title,
    convTitle: (()=>{ const e=document.querySelector('.top-info-content .name-text'); return e?clean(e.innerText):''; })(),
    listCandidates: dump('ul.chat-user-list,[class*="chat-user-list"],[class*="user-list"],[class*="conversation"]',3),
    msgCandidates: dump('.chat-message,[class*="message-list"],[class*="chat-message"]',3),
    msgItems: dump('.chat-message .message-item',4),
    inputCandidates: dump('#chat-input,.chat-input,[contenteditable="true"],textarea',4),
    sendCandidates: dump('button,[role="button"]',12),
  }, null, 1);
})()`;

// ------------------------------------------------------------------ 值守
const CHAT_URL = 'https://www.zhipin.com/web/geek/chat';

const WATCH = {
  running: false,
  busy: false,
  timer: null,
  targetId: '',
  lastScan: 0,
  lastError: '',
  caughtUp: false,
  stats: { replied: 0, failed: 0, skipped: 0 },
};

// 点开过但没读到内容（页面还没渲染完/被虚拟列表挤掉）的会话。
// BOSS 一打开会话就会把未读标记清掉，不记住重试的话这条消息就永远丢了。
const PENDING = new Map();

async function ensureCdp() {
  if (!ENV.getCdp) throw new Error('内部错误：CDP 未注入');
  return await ENV.getCdp();
}

async function ensureChatTarget(cdp) {
  const pages = await cdp.listPages();
  const hit = pages.find(p => (p.url || '').includes('/web/geek/chat'));
  if (hit) { WATCH.targetId = hit.targetId; return hit.targetId; }
  if (WATCH.targetId) {
    const alive = pages.some(p => p.targetId === WATCH.targetId);
    if (alive) return WATCH.targetId;
  }
  AI('没找到 BOSS 聊天页，新开一个聊天标签页…');
  const { targetId } = await cdp.send('Target.createTarget', { url: CHAT_URL }, null);
  WATCH.targetId = targetId;
  await ENV.sleep(6000);
  return targetId;
}

async function evalInChat(cdp, expr, awaitPromise = false, timeout = 20000) {
  const tid = await ensureChatTarget(cdp);
  const v = await cdp.evalIn(tid, expr, awaitPromise, timeout);
  return v;
}

function isBlacklisted(name, cfg) {
  const n = String(name || '');
  if (!n) return true;
  return (cfg.blacklist || []).some(b => b && n.includes(b));
}

const SPAM_RE = /(系统|通知|验证码|活动|优惠|广告|推荐你|简历已查看|已查看你的简历|附件简历|请先|无法投递)/;

function randomInt(min, max) {
  const a = Math.max(0, Math.floor(min));
  const b = Math.max(a, Math.floor(max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

async function readConv(cdp) {
  const raw = await evalInChat(cdp, READ_CONV_JS);
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

const nameMatch = (a, b) => {
  const x = String(a || '').trim(), y = String(b || '').trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
};

// 点开会话后消息区是异步渲染的（先出 loading 再出 .chat-message），
// 固定睡 1.4 秒会读到空列表 —— 所以在超时窗口内轮询到「名字对得上且有条目」为止。
async function waitConvReady(cdp, name, tries = 10) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const c = await readConv(cdp);
    if (c) {
      last = c;
      const who = String(c.selectedName || c.topName || '');
      const okName = !who || nameMatch(who, name);
      if (c.msgs && c.msgs.length && okName) return c;
      if (i === 2 && who && !okName) {
        AI(`打开的会话是「${who}」，不是「${name}」，重试点击…`);
        await evalInChat(cdp, openConvJs(name), true);
      }
    }
    await ENV.sleep(600);
  }
  return last;
}

async function processConv(cdp, conv, cfg) {
  const name = conv.name;
  const opened = await evalInChat(cdp, openConvJs(name), true);
  if (opened !== 'OPENED') {
    AI(`打开会话失败（${name}）：${opened}`);
    WATCH.stats.failed++;
    return;
  }

  const conv2 = await waitConvReady(cdp, name);
  if (!conv2) {
    if ((PENDING.get(name) || 0) < 3) PENDING.set(name, (PENDING.get(name) || 0) + 1);
    AI(`读取会话内容失败（${name}），加入重试队列`);
    WATCH.stats.failed++;
    return;
  }

  const who = String(conv2.selectedName || conv2.topName || '');
  if (who && !nameMatch(who, name)) {
    if ((PENDING.get(name) || 0) < 3) PENDING.set(name, (PENDING.get(name) || 0) + 1);
    AI(`会话没切过去（当前「${who}」，目标「${name}」），为免回错人本轮跳过，下轮重试`);
    WATCH.stats.skipped++;
    return;
  }

  const msgs = conv2.msgs || [];
  const texts = msgs.filter(m => m.kind === 'text' && m.text);
  if (!texts.length) {
    const n = (PENDING.get(name) || 0) + 1;
    if (n <= 3) PENDING.set(name, n); else PENDING.delete(name);
    AI(`会话「${name}」打开后没读到文字消息（共 ${msgs.length} 条，可能只有表情/卡片），${n <= 3 ? '下一轮重试' : '放弃'}`);
    WATCH.stats.skipped++;
    return;
  }
  PENDING.delete(name);

  const last = texts[texts.length - 1];
  if (last.role === 'me') { WATCH.stats.skipped++; return; }          // 已回复过
  if (SPAM_RE.test(last.text)) { WATCH.stats.skipped++; return; }

  const key = `${name}|${last.text.slice(0, 60)}`;
  if (repliedBefore(key)) { WATCH.stats.skipped++; return; }
  if (hitHourlyCap(name, cfg.maxPerHour)) {
    AI(`「${name}」本小时已达 ${cfg.maxPerHour} 条上限，跳过`);
    WATCH.stats.skipped++;
    return;
  }

  let reply = '';
  try {
    reply = await composeReply({ message: last.text, history: msgs }, cfg);
  } catch (e) {
    AI(`生成回复失败（${name}）：${e.message}`);
    WATCH.stats.failed++;
    WATCH.lastError = e.message;
    return;
  }

  AI(`「${name}」HR：${last.text.slice(0, 40)}`);
  AI(`拟回复：${reply}`);

  if (!cfg.autoSend) {
    AI('当前是「只生成草稿」模式，没有发送。确认内容无误后可在设置里打开自动发送');
    markReplied(name, key);
    WATCH.stats.skipped++;
    return;
  }

  // 模拟真人节奏：随机延迟，降低风控概率
  const wait = randomInt(cfg.delayMin, cfg.delayMax);
  AI(`等待 ${wait} 秒后发送（随机延迟，模拟真人）…`);
  for (let i = 0; i < wait; i += 5) {
    if (!WATCH.running) return;
    await ENV.sleep(Math.min(5, wait - i) * 1000);
  }

  if (!conv2.hasInput) {
    AI('没找到聊天输入框（页面结构可能变了），本条跳过。可点「抓取页面结构」把诊断发我看');
    WATCH.stats.failed++;
    return;
  }

  const sent = await evalInChat(cdp, sendReplyJs(reply));
  if (sent !== 'CLICKED' && sent !== 'ENTER') {
    AI(`发送失败（${name}）：${sent}；本条跳过`);
    WATCH.stats.failed++;
    return;
  }
  await ENV.sleep(1800);

  // 校验：最后一条应当是自己发出去的那句
  let check = null;
  try { check = JSON.parse((await evalInChat(cdp, READ_CONV_JS)) || '{}'); } catch {}
  const lastAfter = check && check.msgs && check.msgs[check.msgs.length - 1];
  if (lastAfter && lastAfter.role === 'me' && lastAfter.text.includes(reply.slice(0, 8))) {
    AI(`已回复「${name}」：${reply}`);
    markReplied(name, key);
    WATCH.stats.replied++;
  } else {
    AI(`已点击发送，但没在会话里确认到这条内容（可能还在发送中）：${reply}`);
    markReplied(name, key);
    WATCH.stats.replied++;
  }
}

async function tick() {
  if (!WATCH.running || WATCH.busy) return;
  WATCH.busy = true;
  const cfg = cfgLoad();
  try {
    const cdp = await ensureCdp();
    const raw = await evalInChat(cdp, SCAN_JS);
    let scan = null;
    try { scan = JSON.parse(raw || '{}'); } catch {}
    WATCH.lastScan = Date.now();
    if (!scan) { WATCH.lastError = '聊天页没有返回数据（可能还没加载完）'; return; }

    const url = String(scan.url || '');
    if (!/zhipin\.com/.test(url)) {
      AI(`当前标签页不是 BOSS（${url.slice(0, 60)}），本轮跳过`);
      return;
    }
    if (!scan.diag || !scan.diag.itemCount) {
      WATCH.lastError = '没扫到会话列表（页面结构可能变了）';
      AI('没扫到会话列表。如果是首次使用，请先在浏览器里登录 BOSS 并打开聊天页；否则可能是页面结构变了，点「抓取页面结构」');
      return;
    }

    const unread = (scan.convs || [])
      .filter(c => c.unread > 0)
      .filter(c => !isBlacklisted(c.name, cfg))
      .filter(c => !SPAM_RE.test(c.preview || ''));

    // 之前点开却没读到内容的，优先补回来（未读标记已经被点掉了）
    const retry = [...PENDING.keys()]
      .filter(n => !unread.some(c => c.name === n))
      .map(n => ({ name: n, preview: '', time: '', unread: 1, retry: true }));

    const targets = [...retry, ...unread].slice(0, cfg.maxPerTick);

    // 一个没有未读时的兜底：刚启动/刚开值守时，补处理「最新一条还没回复的会话」，
    // 只在本次运行做一次，避免反复翻旧账。
    if (!targets.length && !WATCH.caughtUp) {
      WATCH.caughtUp = true;
      const fresh = (scan.convs || [])
        .filter(c => !isBlacklisted(c.name, cfg))
        .filter(c => /^(刚刚|今天|\d{1,2}:\d{2}|昨天)/.test(c.time || ''))
        .filter(c => !SPAM_RE.test(c.preview || ''));
      if (fresh.length) {
        AI(`本轮没有未读，补处理最近一条会话：${fresh[0].name}`);
        targets.push(fresh[0]);
      }
    }

    if (targets.length) AI(`本轮发现 ${targets.length} 个待处理会话：${targets.map(t => t.name).join('、')}`);
    for (const c of targets) {
      if (!WATCH.running) break;
      try { await processConv(cdp, c, cfg); }
      catch (e) { WATCH.stats.failed++; WATCH.lastError = e.message; AI('处理会话出错：' + e.message); }
      await ENV.sleep(randomInt(2000, 5000));
    }
    WATCH.lastError = '';
  } catch (e) {
    WATCH.lastError = e.message;
    AI('值守本轮出错：' + e.message);
  } finally {
    WATCH.busy = false;
  }
}

function schedule() {
  clearTimeout(WATCH.timer);
  if (!WATCH.running) return;
  const cfg = cfgLoad();
  WATCH.timer = setTimeout(async () => {
    if (!WATCH.running) return;
    try { await tick(); } catch {}
    schedule();
  }, Math.max(10, cfg.pollSec) * 1000);
  if (WATCH.timer.unref) WATCH.timer.unref();
}

export async function agentStart() {
  if (WATCH.running) return { ok: true, msg: '值守已在运行' };
  const cfg = cfgLoad();
  if (!cfg.apiKey) return { ok: false, msg: '先填 DeepSeek API Key 再开启值守' };
  const kb = kbLoad();
  if (!String(kb.resume || '').trim() && !profileText(kb.profile).trim()) {
    return { ok: false, msg: '知识库还是空的：先上传简历或填写档案，否则生成的回复没有依据' };
  }

  AI('正在启动智能体值守…');
  try {
    if (ENV.ensureChrome) {
      const pre = await ENV.ensureChrome('boss');
      if (!pre || !pre.ok) return { ok: false, msg: '浏览器没启动起来，先解决浏览器问题再开值守' };
    }
    const cdp = await ensureCdp();
    await ensureChatTarget(cdp);
  } catch (e) {
    return { ok: false, msg: '连浏览器失败：' + e.message };
  }

  cfgSave({ enabled: true });
  WATCH.running = true;
  WATCH.caughtUp = false;
  WATCH.stats = { replied: 0, failed: 0, skipped: 0 };
  AI(`值守已开启：每 ${cfg.pollSec} 秒扫一次未读，${cfg.autoSend ? '自动发送' : '只生成草稿'}，单会话每小时最多 ${cfg.maxPerHour} 条`);
  AI('提醒：自动回复违反平台用户协议，存在账号被限流的风险，请自行评估；程序已做随机延迟与限频降低概率');
  // 首轮扫描放到后台跑：生成+随机延迟可能几十秒，不能把界面卡在「启动中」
  tick().catch(() => {});
  schedule();
  return { ok: true, msg: '值守已开启' };
}

export function agentStop() {
  const was = WATCH.running;
  WATCH.running = false;
  clearTimeout(WATCH.timer);
  WATCH.timer = null;
  try { cfgSave({ enabled: false }); } catch {}
  if (was) AI('值守已停止');
  return { ok: true, msg: was ? '值守已停止' : '值守本来就没运行' };
}

// 手动扫一轮（不等待随机延迟太长时用）：立即执行一次扫描
export async function agentScanOnce() {
  const cfg = cfgLoad();
  if (!cfg.apiKey) return { ok: false, msg: '先填 API Key' };
  try {
    const cdp = await ensureCdp();
    await ensureChatTarget(cdp);
    const raw = await evalInChat(cdp, SCAN_JS);
    const scan = JSON.parse(raw || '{}');
    const convs = (scan.convs || []).filter(c => c.unread > 0);
    AI(`手动扫描：会话 ${ (scan.convs || []).length } 个，未读 ${convs.length} 个${convs.length ? '：' + convs.map(c => c.name).join('、') : ''}`);
    return { ok: true, convs, diag: scan.diag };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

// 页面结构诊断（定位不到元素时用来核实真实 DOM）
export async function agentDiag() {
  try {
    const cdp = await ensureCdp();
    await ensureChatTarget(cdp);
    const raw = await evalInChat(cdp, DIAG_JS);
    let data = null;
    try { data = JSON.parse(raw || 'null'); } catch {}
    if (!data) return { ok: false, msg: '聊天页没有返回结构数据（页面可能没加载完）' };
    ensureDir(agDir());
    const file = F.diag();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    const sendTexts = (data.sendCandidates || []).map(x => x.text).filter(Boolean).slice(0, 8);
    AI(`页面结构已抓取：会话列表 ${(data.listCandidates || []).length} 个候选，消息区 ${(data.msgCandidates || []).length} 个，输入框 ${(data.inputCandidates || []).length} 个，按钮文案 ${sendTexts.join(' / ')}`);
    AI(`完整结构已存到：${file}`);
    return { ok: true, file, summary: { url: data.url, sendTexts } };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

export function agentWatchStatus() {
  return { running: WATCH.running, lastScan: WATCH.lastScan, lastError: WATCH.lastError, stats: { ...WATCH.stats } };
}

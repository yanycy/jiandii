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
    autoAgreeResume: true,     // HR 请求发附件简历时自动点「同意」并附一段自我介绍
    apiKey: '',                // 只存本地
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxChars: 60,
    delayMin: 20,              // 每条回复前随机延迟（秒），压风控
    delayMax: 90,
    maxPerHour: 3,             // 单会话每小时最多回几条
    maxPerTick: 3,             // 每轮最多处理几个会话
    pollSec: 30,               // 轮询间隔（秒）：上次扫完 30 秒后再扫一次未读
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
  cfg.pollSec = clampNum(cfg.pollSec, 10, 600, 30);
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
    autoAgreeResume: cfg.autoAgreeResume !== false,
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
  for (const k of ['autoSend', 'autoAgreeResume']) {
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

export async function llmChat(messages, opt = {}) {
  const cfg = cfgLoad();
  if (!cfg.apiKey) throw new Error('还没填 DeepSeek API Key（在「值守与设置」里填，只存本地）');
  const body = {
    model: cfg.model || 'deepseek-v4-flash',
    messages,
    temperature: opt.temperature ?? cfg.temperature,
    max_tokens: opt.maxTokens ?? 400,
    stream: false,
  };
  // DeepSeek 的推理模型会把「思考过程」也算进 max_tokens。判定/抽取这类任务不需要推理，
  // 关掉后 reasoning_tokens 归零，既不会被挤断内容，也快 3~4 倍。
  if (opt.noThink) body.thinking = { type: 'disabled' };
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
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message ? choice.message.content : '';
  if (!content) {
    // finish_reason=length 说明推理把 token 额度吃光了，正文一个字都还没输出
    if (choice && choice.finish_reason === 'length') {
      throw new Error('模型输出被截断（推理占满了 token 上限），可重试或减少一次判定的条数');
    }
    throw new Error('模型返回为空，稍后重试');
  }
  return { content, usage: (json && json.usage) || null, model: (json && json.model) || body.model, finish: choice && choice.finish_reason };
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

function buildSystemPrompt(kb, cfg, maxChars = cfg.maxChars) {
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
    `1. 只说一段话，${maxChars} 字以内，口语化、礼貌，像真人打字。`,
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

function jobLine(job) {
  if (!job) return '';
  const bits = [job.title, job.salary, job.city, job.company].filter(Boolean);
  const line = bits.join('｜');
  return line || job.raw || '';
}

async function composeReply({ message, history, job, mode }, cfg) {
  const kb = kbLoad();
  if (!String(kb.resume || '').trim() && !String(profileText(kb.profile).trim())) {
    throw new Error('知识库还是空的：先在「知识库」里上传简历或填写档案，否则 AI 只能瞎编');
  }
  const ctx = (history || []).slice(-6).map(m => `${m.role === 'me' ? '我' : 'HR'}：${m.text}`).join('\n');
  const jl = jobLine(job);
  const intro = mode === 'resume-intro';
  const ask = intro
    ? [
      '【当前在聊的岗位】' + (jl || '（页面没取到岗位信息，就按简历里的求职方向写）'),
      '【刚刚发生的事】HR 发了「想要一份您的附件简历」的请求卡片，我已经点了「同意」，附件简历已经发过去了。',
      '【现在要写的内容】紧跟在这条同意之后的一小段自我介绍。',
      '要求：紧扣上面这个岗位——先一句对上岗位职责/关键词，再从简历里挑 1~2 段最贴合的实测经历（做过什么、用什么做的、结果怎样），',
      '不要复述整份简历，不要罗列所有技能，不要提薪资和「已发送简历」这类废话，最后一句轻一点（如「简历您先看，细节随时聊」）。',
      '字数 80~140 字，口语化，像真人打完字发出去的。',
    ].join('\n')
    : '';
  const limit = intro ? Math.max(cfg.maxChars, 140) : cfg.maxChars;
  const messages = [
    { role: 'system', content: buildSystemPrompt(kb, cfg, limit) },
    { role: 'user', content: [
      jl ? '【当前在聊的岗位】' + jl : '',
      ctx ? '【最近的对话】\n' + ctx : '',
      '【HR 刚发来的消息】\n' + message,
      '',
      intro ? ask : '请写出我要回复的那段话。',
    ].filter(Boolean).join('\n\n') },
  ];
  // 回复/介绍都不需要推理；不开 thinking:disabled 时 reasoning_content 会挤满
  // max_tokens，导致 content 为空被判「模型输出被截断」，自动回复偶发失败。
  const r = await llmChat(messages, { maxTokens: intro ? 420 : 300, noThink: true });
  const reply = cleanReply(r.content, limit);
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

// 只记「这条已处理」用于去重，不计入单会话每小时发送配额
function markSeen(key) {
  const rec = recordsLoad();
  rec.replied[key] = Date.now();
  recordsSave(rec);
}

// 真正发出去一条消息才调用：既去重，也计入限频
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
// 真实结构：div.user-list > div.user-list-content(滚动容器) > ul[role=group] > li[role=listitem]
// 列表是虚拟滚动（ul 用 padding 撑高），所以每轮都要重新取节点，不能缓存 li。
const SCAN_JS = `(()=>{${PAGE_HELPERS}
  const out={url:location.href, convs:[], diag:{}};
  const items=[...document.querySelectorAll('.user-list li[role="listitem"], ul[role="group"] li[role="listitem"], .user-list li')].filter(vis);
  out.diag.itemCount=items.length;
  const scroller=document.querySelector('.user-list-content')||document.querySelector('.user-list');
  out.diag.scrollTop=scroller?Math.round(scroller.scrollTop):-1;
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

// 关键教训：BOSS 的会话项只认「真实鼠标事件」。用 JS 里 dispatchEvent(new MouseEvent)
// 或 el.click() 都是 isTrusted=false 的合成事件，看起来点成功（返回 OPENED），页面却完全不动，
// 于是日志一直刷「打开的是 X，不是 Y」。所以这里只负责「滚到可视区 + 量坐标」，
// 真正的点击交给 CDP Input.dispatchMouseEvent（真事件）。
const PREP_CONV_JS = (name) => `(async()=>{${PAGE_HELPERS}
  const want=${JSON.stringify(name)};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const listItems=()=>[...document.querySelectorAll('.user-list li[role="listitem"], ul[role="group"] li[role="listitem"], .user-list li')].filter(vis);
  const nameOf=li=>{ const n=li.querySelector('.name-text')||li.querySelector('.name-box'); return clean(n&&n.innerText); };
  const find=()=>{
    const lis=listItems();
    for(const li of lis){ if(nameOf(li)===want) return li; }
    for(const li of lis){ const s=nameOf(li); if(s && (s.startsWith(want)||want.startsWith(s))) return li; }
    return null;
  };
  let li=find();
  if(!li){
    // 名单是虚拟滚动，目标可能在可视窗口外面：先把列表滚回顶部再找
    const sc=document.querySelector('.user-list-content');
    if(sc){ sc.scrollTop=0; }
    await sleep(320);
    li=find();
  }
  if(!li) return JSON.stringify({ok:false,why:'NO_ITEM',count:listItems().length});
  li.scrollIntoView({block:'center'});
  await sleep(300);
  li=find();
  if(!li) return JSON.stringify({ok:false,why:'GONE_AFTER_SCROLL'});
  const box=e=>{ if(!e) return null; const r=e.getBoundingClientRect();
    if(!(r.width>2&&r.height>2)) return null; return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}; };
  const figure=li.querySelector('.figure')||li.querySelector('.figure img');
  const friend=li.querySelector('.friend-content')||li;
  const top=clean(((document.querySelector('.top-info-content .name-text')||{}).innerText));
  return JSON.stringify({
    ok:true,
    name:nameOf(li),
    top,
    avatar:box(figure),
    row:box(friend),
    li:box(li),
    badge:clean(((li.querySelector('.notice-badge')||{}).innerText)),
  });
})()`;

// 读当前打开的会话：消息在 .chat-message > .message-item，
// 角色看 class（item-friend=HR / item-myself=我），拿不到就看气泡左右位置。
const READ_CONV_JS = `(()=>{${PAGE_HELPERS}
  const pane=document.querySelector('.chat-conversation')||document.body;
  const paneRect=pane.getBoundingClientRect();
  const topEl=pane.querySelector('.top-info-content .name-text')||pane.querySelector('.top-info-content [class*="name"]');
  const topName=clean(topEl&&topEl.innerText).slice(0,40);
  const selEl=document.querySelector('.user-list .friend-content.selected .name-text')||document.querySelector('.user-list .friend-content.selected .name-box');
  const selectedName=clean(selEl&&selEl.innerText).slice(0,40);
  // 会话头部就是当前在聊的岗位：position-name / salary / city（公司名在 .base-info 的第二个 span）
  const jobEl=document.querySelector('.chat-position-content');
  const job={
    title:clean((document.querySelector('.chat-position-content .position-name')||{}).innerText).slice(0,60),
    salary:clean((document.querySelector('.chat-position-content .salary')||{}).innerText).slice(0,30),
    city:clean((document.querySelector('.chat-position-content .city')||{}).innerText).slice(0,20),
    // 公司名在 .base-info 里排第 2 个（第 1 个是 HR 姓名，最后是「招聘HR」这类职位）
    // 注意：clean() 已经把空白塌成单个空格，这里直接按空格切，别再写正则（模板字符串会把 \s 吃掉）
    company:(()=>{ const t=clean(((document.querySelector('.top-info-content .base-info')||{}).innerText)||'');
      const parts=t.split(' ').filter(Boolean); return (parts[1]||'').slice(0,40); })(),
    raw:clean(jobEl&&jobEl.innerText).replace(/查看职位\s*$/,'').slice(0,120),
  };

  let box=document.querySelector('.chat-message')||document.querySelector('.chat-record .chat-message');
  if(!box){ for(const s of ['.chat-message-list','[class*="message-list"]','[class*="message-container"]']){ const el=document.querySelector(s); if(el){ box=el; break; } } }

  const msgs=[];
  const cards=[];
  if(box){
    // 消息区也是滚动容器：先滚到底，保证「最后一条」是最新的
    try{ box.scrollTop=box.scrollHeight; }catch{}
    const items=[...box.querySelectorAll('.message-item, [class*="message-item"]')].filter(vis);
    for(const it of items.slice(-16)){
      const cls=String(it.className||'');
      const body=it.querySelector('.text-content')||it.querySelector('.message-text');
      const cardEl=it.querySelector('.message-card-wrap');
      const kind=body?'text':(it.querySelector('.message-emoji,.item-image')?'emoji':(cardEl?'card':(it.querySelector('.item-resume,.item-jobdesc')?'card':'other')));
      let text=clean(body&&body.innerText);
      if(!text && kind==='emoji') text='[表情]';
      if(!text && cardEl){
        const title=clean((cardEl.querySelector('.message-card-top-title,.message-card-top-text')||{}).innerText);
        const btns=[...cardEl.querySelectorAll('.card-btn')].map(b=>clean(b.innerText)).filter(Boolean);
        text='[卡片]'+title+(btns.length?'（'+btns.join('/')+'）':'');
        cards.push({ mid:String(it.getAttribute('data-mid')||''), title, btns, fromFriend:/item-friend|friend/i.test(cls) });
      }
      if(!text && kind==='card') text='[卡片消息]';
      if(!text) continue;                       // 只有时间的分隔行，跳过
      let role='';
      if(/item-myself|myself/i.test(cls)) role='me';
      else if(/item-friend|friend/i.test(cls)) role='them';
      else {
        const br=(body||it).getBoundingClientRect();
        role=(br.width && (br.left+br.width/2) > (paneRect.left+paneRect.width/2)) ? 'me' : 'them';
      }
      msgs.push({ role, text: text.slice(0,300), kind, cls: cls.slice(0,48), mid: String(it.getAttribute('data-mid')||'') });
    }
  }
  const inputs=[...document.querySelectorAll('#chat-input,.chat-input,[contenteditable="true"],textarea')].filter(vis);
  const sendBtns=[...document.querySelectorAll('button,[role="button"],[class*="send"]')].filter(vis)
    .filter(b=>/^发送$/.test(clean(b.innerText))||/send/i.test(String(b.className||'')));

  // ---- 「同意接收附件简历」：HR 发来的卡片里有 同意/拒绝，底部操作条还有一组 btn-agree ----
  const RESUME_RE=/附件简历|发一份简历|简历过来|发送简历|发一下简历|接受简历/;
  const box2=e=>{ if(!e) return null; const r=e.getBoundingClientRect();
    if(!(r.width>2&&r.height>2)) return null; return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; };
  const cardAgree=[];
  for(const c of [...document.querySelectorAll('.message-card-wrap')].filter(vis)){
    const title=clean((c.querySelector('.message-card-top-title,.message-card-top-text')||{}).innerText);
    if(!RESUME_RE.test(title)) continue;
    const btn=[...c.querySelectorAll('.card-btn')].find(b=>/^同意$/.test(clean(b.innerText)));
    if(!btn || !vis(btn)) continue;
    const host=c.closest('.message-item');
    cardAgree.push({ mid:String((host&&host.getAttribute('data-mid'))||''), title, at:box2(btn),
      mine: !!(host && /item-myself/.test(String(host.className||''))) });
  }
  const barAgree=[...document.querySelectorAll('.op .btn-agree,.op .btn.btn-agree')].filter(vis).map(box2).filter(Boolean);
  const barRefuse=[...document.querySelectorAll('.op .btn-refuse')].filter(vis).length;
  const hasResumeAsk = cardAgree.length>0 || (barAgree.length>0 && barRefuse>0);

  return JSON.stringify({
    url:location.href,
    topName,
    selectedName,
    job,
    msgs,
    cards,
    resumeAsk: hasResumeAsk ? { fromCard: cardAgree, bar: barAgree } : null,
    hasInput: inputs.length>0,
    hasSend: sendBtns.length>0,
    diag: {
      msgCount: msgs.length,
      boxClass: box?String(box.className||''):'',
      inputClass: inputs[0]?String(inputs[0].className||'')+'|'+inputs[0].tagName:'',
      sendText: sendBtns[0]?clean(sendBtns[0].innerText)||String(sendBtns[0].className||''):'',
      cardCount: cardAgree.length,
    },
  });
})()`;

// 输入框 / 发送按钮的位置与状态（真实点击前先量坐标）
const INPUT_INFO_JS = `(()=>{${PAGE_HELPERS}
  const box=e=>{ if(!e) return null; const r=e.getBoundingClientRect();
    if(!(r.width>2&&r.height>2)) return null; return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; };
  const cands=[...document.querySelectorAll('#chat-input,.chat-input,[contenteditable="true"],textarea')].filter(vis);
  const input=cands.find(e=>e.id==='chat-input'||/chat-input/.test(String(e.className||'')))||cands[0];
  const send=[...document.querySelectorAll('button.btn-sure-v2,button.btn-send,button,[role="button"]')].filter(vis)
    .find(b=>/^发送$/.test(clean(b.innerText)));
  return JSON.stringify({
    input: box(input),
    inputText: clean(input&&input.innerText).slice(0,200),
    focused: (document.activeElement && (document.activeElement.id || String(document.activeElement.className||''))) || '',
    send: box(send),
    sendDisabled: send ? /disabled/.test(String(send.className||'')) : true,
  });
})()`;
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
  session: '',
  sessionFor: '',
  lastScan: 0,
  lastFront: 0,
  lastFrontTarget: '',
  lastError: '',
  lastJsError: '',
  caughtUp: false,
  stats: { replied: 0, failed: 0, skipped: 0, agreed: 0 },
};

// 点开过但没读到内容（页面还没渲染完/被虚拟列表挤掉）的会话。
// BOSS 一打开会话就会把未读标记清掉，不记住重试的话这条消息就永远丢了。
const PENDING = new Map();

async function ensureCdp() {
  if (!ENV.getCdp) throw new Error('内部错误：CDP 未注入');
  return await ENV.getCdp();
}

async function ensureChatTarget(cdp, forceFront = false) {
  const pages = await cdp.listPages();
  const hit = pages.find(p => (p.url || '').includes('/web/geek/chat'));
  let tid = '', changed = false;
  if (hit) tid = hit.targetId;
  else if (WATCH.targetId && pages.some(p => p.targetId === WATCH.targetId)) {
    // 之前那个标签页还在，但已经跳走了（比如点去看了职位详情）→ 拉回消息页
    tid = WATCH.targetId;
    changed = true;
    AI('把 BOSS 标签页切回消息页…');
    await cdp.send('Target.activateTarget', { targetId: tid }, null).catch(() => {});
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true }, null);
    await cdp.send('Page.navigate', { url: CHAT_URL }, sessionId).catch(() => {});
    try { await cdp.send('Target.detachFromTarget', { sessionId }, null, 5000); } catch {}
    await ENV.sleep(4000);
  } else {
    AI('没找到 BOSS 消息页，新开一个聊天标签页…');
    const r = await cdp.send('Target.createTarget', { url: CHAT_URL }, null);
    tid = r.targetId;
    changed = true;
    await ENV.sleep(6000);
  }
  if (WATCH.targetId !== tid) { WATCH.session = ''; WATCH.sessionFor = ''; changed = true; }
  WATCH.targetId = tid;
  // 消息页必须在最前面：后台标签页会被浏览器降频，虚拟列表和未读角标根本不更新
  await frontChat(cdp, tid, forceFront || changed);
  return tid;
}

// 把 BOSS 消息页放到前台（真窗口可见，才有真实渲染和真实点击坐标）。
// 一轮 tick 里会发几十条指令，必须节流，否则会不停抢用户焦点。
async function frontChat(cdp, tid, force = false) {
  const now = Date.now();
  if (!force && WATCH.lastFrontTarget === tid && now - WATCH.lastFront < 20000) return;
  WATCH.lastFront = now;
  WATCH.lastFrontTarget = tid;
  try {
    await cdp.send('Target.activateTarget', { targetId: tid }, null);
  } catch {}
  try {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true }, null);
    await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
    await cdp.send('Target.detachFromTarget', { sessionId }, null, 5000).catch(() => {});
  } catch {}
}

// 复用一个常驻会话：每轮扫描要发好几次指令，反复 attach/detach 又慢又容易和输入事件抢。
// 会话一旦建立就直接复用，不再每次都 listPages / 置前；只有 tick 开头会强制校验一次。
async function chatSession(cdp) {
  if (WATCH.session && WATCH.sessionFor && WATCH.sessionFor === WATCH.targetId) {
    return { tid: WATCH.targetId, sid: WATCH.session };
  }
  const tid = await ensureChatTarget(cdp, true);
  if (WATCH.session && WATCH.sessionFor === tid) return { tid, sid: WATCH.session };
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: tid, flatten: true }, null);
  WATCH.session = sessionId;
  WATCH.sessionFor = tid;
  return { tid, sid: sessionId };
}

function isSessionGone(msg) {
  return /Session with given id|Cannot find context|Target closed|No target with given id|Inspected target navigated/i.test(String(msg || ''));
}

async function evalInChat(cdp, expr, awaitPromise = false, timeout = 20000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let sid = '';
    try {
      ({ sid } = await chatSession(cdp));
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      }, sid, timeout);
      if (r.exceptionDetails) {
        const m = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'js error';
        WATCH.lastJsError = String(m).slice(0, 200);
        return undefined;
      }
      return r.result?.value;
    } catch (e) {
      if (isSessionGone(e.message) && attempt === 0) {
        WATCH.session = ''; WATCH.sessionFor = '';
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}

// 真实鼠标点击（CDP Input）。JS 里 dispatch 的合成事件 isTrusted=false，
// BOSS 的会话切换 / 同意按钮 / 发送按钮都只认这种真事件。
async function mouseClick(cdp, pt) {
  const { sid } = await chatSession(cdp);
  const x = Math.round(pt.x), y = Math.round(pt.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid, 8000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sid, 8000);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sid, 8000);
}

const KEYMAP = {
  a: { code: 'KeyA', vk: 65 },
  Enter: { code: 'Enter', vk: 13 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
};

async function pressKey(cdp, key, modifiers = 0) {
  const { sid } = await chatSession(cdp);
  const m = KEYMAP[key] || { code: key, vk: 0 };
  const base = { key, code: m.code, windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk, modifiers };
  const text = key === 'Enter' ? '\r' : undefined;
  await cdp.send('Input.dispatchKeyEvent', {
    type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...base,
    ...(text ? { text, unmodifiedText: text } : {}),
  }, sid, 8000);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid, 8000);
}

function isBlacklisted(name, cfg) {
  const n = String(name || '');
  if (!n) return true;
  return (cfg.blacklist || []).some(b => b && n.includes(b));
}

// 只过滤系统/平台类的噪音。注意不要把「附件简历」写进来：
// HR 请求发简历的卡片预览就是「我想要一份您的附件简历，您是否同意」，写进来会把最该回的会话过滤掉。
const SPAM_RE = /(系统|通知|验证码|活动|优惠|广告|推荐你|简历已查看|已查看你的简历|请先|无法投递)/;

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
async function waitConvReady(cdp, name, tries = 12) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const c = await readConv(cdp);
    if (c) {
      last = c;
      const who = String(c.selectedName || c.topName || '');
      const okName = !who || nameMatch(who, name);
      if (c.msgs && c.msgs.length && okName) return c;
    }
    await ENV.sleep(500);
  }
  return last;
}

// 点「对应的 HR 头像」切会话：真鼠标事件，头像 → 会话行 → 整行 三级兜底。
// 点完必须等标题真的变成目标名字才算成功，否则就是点空了
//（之前日志里刷屏的「打开的是 X，不是 Y」就是这么来的：合成事件返回 OPENED，页面一动不动）。
async function openConv(cdp, name) {
  let why = 'NOT_SWITCHED';
  for (let round = 0; round < 2; round++) {
    const raw = await evalInChat(cdp, PREP_CONV_JS(name), true);
    let p = null;
    try { p = JSON.parse(raw || 'null'); } catch {}
    if (!p || !p.ok) {
      why = (p && p.why) || 'NO_ITEM';
      if (why === 'NO_ITEM') break;
      continue;
    }
    if (p.top && nameMatch(p.top, name)) return { ok: true, already: true, who: p.top };
    const points = [p.avatar, p.row, p.li].filter(Boolean);
    const labels = ['avatar', 'row', 'li'];
    for (let i = 0; i < points.length; i++) {
      await mouseClick(cdp, points[i]);
      const who = await waitSwitch(cdp, name, 6);
      if (who) return { ok: true, who, by: labels[i] };
    }
    why = 'CLICK_NO_EFFECT';
    await ENV.sleep(400);
  }
  return { ok: false, why };
}

async function waitSwitch(cdp, name, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const c = await readConv(cdp);
    if (c) {
      const who = String(c.selectedName || c.topName || '');
      if (who && nameMatch(who, name)) return who;
    }
    await ENV.sleep(400);
  }
  return '';
}

// 点「同意」接收附件简历：先点卡片里的同意，不行再点底部操作条的同意
async function agreeResume(cdp, ask) {
  const points = [];
  for (const c of (ask && ask.fromCard) || []) if (c.at) points.push({ at: c.at, by: 'card' });
  for (const at of (ask && ask.bar) || []) points.push({ at, by: 'bar' });
  for (const p of points) {
    await mouseClick(cdp, p.at);
    await ENV.sleep(1500);
    const after = await readConv(cdp);
    if (!after) return { ok: true, by: p.by, unconfirmed: true };
    if (!after.resumeAsk) return { ok: true, by: p.by };
  }
  return { ok: false, why: points.length ? 'STILL_ASKING' : 'NO_BUTTON' };
}

// 真键盘打字 + 真鼠标点发送。
// 之前用 execCommand / el.click() 都是合成事件：输入框看着有字、按钮点了却没反应。
async function sendByInput(cdp, text) {
  const info = async () => {
    const raw = await evalInChat(cdp, INPUT_INFO_JS);
    try { return JSON.parse(raw || 'null'); } catch { return null; }
  };
  let st = await info();
  if (!st || !st.input) return { ok: false, why: 'NO_INPUT' };
  await mouseClick(cdp, st.input);
  await ENV.sleep(220);
  st = await info();
  // 焦点确实落在输入框里，才敢用 Ctrl+A / Backspace 清残留草稿（真按键才和 Vue v-model 同步），
  // 否则不乱按键，避免把别处的选中内容删掉
  if (st && st.inputText && /chat-input/.test(String(st.focused || ''))) {
    await pressKey(cdp, 'a', 2);
    await pressKey(cdp, 'Backspace');
    await ENV.sleep(150);
  }
  const { sid } = await chatSession(cdp);
  await cdp.send('Input.insertText', { text }, sid, 15000);
  await ENV.sleep(500);
  st = await info();
  if (!st || !st.inputText) return { ok: false, why: 'TYPE_FAILED' };
  // 有旧草稿没清掉时，宁可不发，也别把「草稿+新内容」一起发出去。
  // 用宽松比较：容忍首尾空白和内容编辑器的细微字符转换，但抓得住明显更长的前缀残留。
  const want = String(text).trim();
  if (st.inputText.length > want.length + 2 || !st.inputText.includes(want.slice(0, 8))) {
    AI(`输入框里疑似混入了旧草稿，本条放弃发送：${st.inputText.slice(0, 30)}`);
    await pressKey(cdp, 'a', 2);
    await pressKey(cdp, 'Backspace');
    return { ok: false, why: 'DIRTY_INPUT' };
  }
  if (st.send && !st.sendDisabled) {
    await mouseClick(cdp, st.send);
    return { ok: true, why: 'CLICKED' };
  }
  await pressKey(cdp, 'Enter');
  await ENV.sleep(700);
  const st2 = await info();
  if (st2 && st2.inputText) return { ok: false, why: 'SEND_DISABLED' };
  return { ok: true, why: 'ENTER' };
}

async function processConv(cdp, conv, cfg) {
  const name = conv.name;
  const opened = await openConv(cdp, name);
  if (!opened.ok) {
    AI(`打开「${name}」的会话失败（${opened.why}）`);
    if ((PENDING.get(name) || 0) < 3) PENDING.set(name, (PENDING.get(name) || 0) + 1);
    WATCH.stats.failed++;
    return;
  }
  if (opened.by) {
    const by = opened.by === 'avatar' ? '头像' : opened.by === 'row' ? '会话行' : '整行';
    AI(`已点${by}打开「${name}」`);
  }

  let conv2 = await waitConvReady(cdp, name);
  if (!conv2 || !conv2.msgs || !conv2.msgs.length) {
    if ((PENDING.get(name) || 0) < 3) PENDING.set(name, (PENDING.get(name) || 0) + 1);
    AI(`会话「${name}」打开了但消息没渲染出来，下一轮重试`);
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
  PENDING.delete(name);

  const job = conv2.job || null;
  if (jobLine(job)) AI(`当前岗位：${jobLine(job)}`);

  // ---- 1) HR 发了「想要一份您的附件简历」的卡片：先点同意，再补一段贴合岗位的自我介绍 ----
  if (conv2.resumeAsk && cfg.autoAgreeResume !== false) {
    const c0 = (conv2.resumeAsk.fromCard || [])[0];
    const key0 = `简历同意|${name}|${(c0 && c0.mid) || ''}`;
    if (!repliedBefore(key0)) {
      const r = await agreeResume(cdp, conv2.resumeAsk);
      if (!r.ok) {
        AI(`点「同意」没生效（${r.why}）。若反复失败，去 BOSS「我的简历」确认已上传附件简历`);
        WATCH.stats.failed++;
        WATCH.lastError = '同意接收简历失败';
        return;
      }
      markSeen(key0);
      // 同意（+介绍）已经回应了 HR 这次的请求，把最后一条文字也标记掉，
      // 免得下轮把「方便发一份简历过来吗？」当成没回过的普通消息又回一遍
      const lastText = (conv2.msgs || []).filter(m => m.kind === 'text' && m.text).slice(-1)[0];
      if (lastText && lastText.role !== 'me') markSeen(`${name}|${lastText.text.slice(0, 60)}`);
      WATCH.stats.agreed++;
      AI(`已点「同意」接收「${name}」的附件简历（${r.by === 'card' ? '卡片按钮' : '底部按钮'}）`);
      conv2 = (await readConv(cdp)) || conv2;

      let intro = '';
      try {
        intro = await composeReply({
          message: '（HR 请求发一份附件简历，我已经点了同意，附件简历已发出）',
          history: conv2.msgs || [],
          job,
          mode: 'resume-intro',
        }, cfg);
      } catch (e) {
        AI(`生成自我介绍失败：${e.message}，这次只同意、不带话术`);
      }
      if (!intro) return;
      AI(`自我介绍（贴合「${job.title || '当前岗位'}」）：${intro}`);
      if (!cfg.autoSend) {
        AI('当前是「只生成草稿」模式，自我介绍没有发送');
        return;
      }
      if (hitHourlyCap(name, cfg.maxPerHour)) {
        AI(`「${name}」本小时已达 ${cfg.maxPerHour} 条上限：同意已点，自我介绍本轮不发送`);
        return;
      }
      const wait = randomInt(cfg.delayMin, cfg.delayMax);
      AI(`等待 ${wait} 秒后发送自我介绍…`);
      for (let i = 0; i < wait; i += 5) {
        if (!WATCH.running) return;
        await ENV.sleep(Math.min(5, wait - i) * 1000);
      }
      const s = await sendByInput(cdp, intro);
      if (s.ok) {
        markReplied(name, `${name}|${intro.slice(0, 60)}`);
        WATCH.stats.replied++;
        AI(`已发送给「${name}」：${intro}`);
      } else {
        AI(`发送自我介绍失败（${s.why}）`);
        WATCH.stats.failed++;
      }
      return;
    }
  }

  // ---- 2) 普通文字回复 ----
  const msgs = conv2.msgs || [];
  const texts = msgs.filter(m => m.kind === 'text' && m.text);
  if (!texts.length) {
    AI(`会话「${name}」里没有文字消息（只有卡片/表情），跳过`);
    WATCH.stats.skipped++;
    return;
  }

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
    reply = await composeReply({ message: last.text, history: msgs, job }, cfg);
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

  const sent = await sendByInput(cdp, reply);
  if (!sent.ok) {
    AI(`发送失败（${name}）：${sent.why}；本条跳过`);
    WATCH.stats.failed++;
    return;
  }
  await ENV.sleep(1600);

  // 校验：最后一条应当是自己发出去的那句
  const check = (await readConv(cdp)) || null;
  const lastAfter = check && check.msgs && check.msgs[check.msgs.length - 1];
  if (lastAfter && lastAfter.role === 'me' && lastAfter.text.includes(reply.slice(0, 6))) {
    AI(`已回复「${name}」：${reply}`);
  } else {
    AI(`已点发送，但没在会话里确认到这条内容（可能还在发送中）：${reply}`);
  }
  markReplied(name, key);
  WATCH.stats.replied++;
}


async function scanOnce(cdp) {
  // 消息页必须在前台且已登录渲染完，未读角标才是实时的
  await ensureChatTarget(cdp, true);
  let scan = null;
  for (let i = 0; i < 2; i++) {
    const raw = await evalInChat(cdp, SCAN_JS);
    try { scan = JSON.parse(raw || 'null'); } catch { scan = null; }
    if (scan && scan.diag && scan.diag.itemCount) return scan;
    if (i === 0) await ENV.sleep(1500);
  }
  return scan;
}

async function tick() {
  if (!WATCH.running || WATCH.busy) return;
  WATCH.busy = true;
  const cfg = cfgLoad();
  try {
    const cdp = await ensureCdp();
    const scan = await scanOnce(cdp);
    WATCH.lastScan = Date.now();
    if (!scan) { WATCH.lastError = '消息页没有返回数据（可能还没加载完）'; return; }

    const url = String(scan.url || '');
    if (!/zhipin\.com/.test(url)) {
      AI(`当前标签页不是 BOSS（${url.slice(0, 60)}），重新打开消息页…`);
      WATCH.targetId = '';
      WATCH.session = ''; WATCH.sessionFor = '';
      await ensureChatTarget(cdp, true);
      return;
    }
    if (!scan.diag || !scan.diag.itemCount) {
      WATCH.lastError = '没扫到会话列表（可能未登录或页面结构变了）';
      AI('没扫到会话列表。先在浏览器里登录 BOSS 并打开消息页；若界面正常，点「抓取页面结构」把诊断发我');
      return;
    }

    const convs = scan.convs || [];
    const unread = convs
      .filter(c => c.unread > 0)
      .filter(c => !isBlacklisted(c.name, cfg))
      .filter(c => !SPAM_RE.test(c.preview || ''));
    AI(`扫描完成：会话 ${convs.length} 个，未读 ${convs.filter(c => c.unread > 0).length} 个`);

    // 之前点开却没读到内容的，优先补回来（未读标记已经被点掉了）
    const retry = [...PENDING.keys()]
      .filter(n => !unread.some(c => c.name === n))
      .map(n => ({ name: n, preview: '', time: '', unread: 1, retry: true }));

    const targets = [...retry, ...unread].slice(0, cfg.maxPerTick);

    // 一个没有未读时的兜底：刚启动/刚开值守时，补处理「最新一条还没回复的会话」，
    // 只在本次运行做一次，避免反复翻旧账。
    if (!targets.length && !WATCH.caughtUp) {
      WATCH.caughtUp = true;
      const fresh = convs
        .filter(c => !isBlacklisted(c.name, cfg))
        .filter(c => /^(刚刚|今天|\d{1,2}:\d{2}|昨天)/.test(c.time || ''))
        .filter(c => !SPAM_RE.test(c.preview || ''));
      if (fresh.length) {
        AI(`本轮没有未读，补处理最近一条会话：${fresh[0].name}`);
        targets.push(fresh[0]);
      }
    }

    if (targets.length) AI(`本轮待处理 ${targets.length} 个：${targets.map(t => t.name).join('、')}`);
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

// 固定节拍轮询：上一轮跑得久也不会把间隔拉长，保证「每 N 秒看一眼」
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
    await ensureChatTarget(cdp, true);
    // 顺手确认消息页真的渲染出来了
    const raw = await evalInChat(cdp, SCAN_JS);
    let scan = null;
    try { scan = JSON.parse(raw || '{}'); } catch {}
    if (!scan || !scan.diag || !scan.diag.itemCount) {
      AI('消息页已打开，但还没扫到会话列表：确认浏览器里已登录 BOSS，且没停在登录页');
    } else {
      AI(`消息页已置前，当前扫到 ${scan.diag.itemCount} 个会话`);
    }
  } catch (e) {
    return { ok: false, msg: '连浏览器失败：' + e.message };
  }

  cfgSave({ enabled: true });
  WATCH.running = true;
  WATCH.caughtUp = false;
  WATCH.stats = { replied: 0, failed: 0, skipped: 0, agreed: 0 };
  AI(`值守已开启：每 ${cfg.pollSec} 秒把 BOSS 消息页置前并扫一次未读，${cfg.autoSend ? '自动发送' : '只生成草稿'}，单会话每小时最多 ${cfg.maxPerHour} 条`);
  AI(`遇到 HR 发「想要一份您的附件简历」的卡片会自动点「同意」，并补一段贴合当前岗位的自我介绍`);
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
    await ensureChatTarget(cdp, true);
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
    await ensureChatTarget(cdp, true);
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

// 仅供自测脚本（tools/watch-selftest.mjs）调用，界面逻辑不依赖它
export const __watchTest = {
  openConv, waitConvReady, readConv, scanOnce, sendByInput, agreeResume, ensureChatTarget,
  composeReply, cfgLoad,
};

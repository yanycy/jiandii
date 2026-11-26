// 验证「贴合岗位的自我介绍」生成：临时数据目录 + 代表性简历，不连浏览器、不发消息、不污染真实知识库
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import * as Agt from '../lib/agent.mjs';

const tmp = path.join(os.tmpdir(), 'jd-intro-selftest-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });

Agt.initAgent({
  dataDir: tmp,
  log: m => console.log(m),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
});

// 用聊天记录里"我"发过的真实背景做样本（浓缩版）
const RESUME = [
  '2027届 本科 计算机科学与技术',
  '技术栈：Vue3 / Nuxt3 / Java / Python / MySQL / Electron',
  '项目经历：',
  '- 能源企业官网 + 微信小程序双端项目：独立对接客户需求、负责从开发到上线交付全流程',
  '- Python / Electron 自动化采集工具：客户现场部署、排查环境问题、写使用文档',
  '- AI 文档自动生成系统：独立交付的第三个客户项目',
  '其他：可全国驻场，12 月底到岗，可实习到毕业',
  '求职方向：前端开发 / 全栈 / 技术支持 / 软件实施',
].join('\n');

Agt.kbSave({ resume: RESUME, profile: { name: '同学', degree: '本科', major: '计算机科学与技术', expectRole: '软件实施/前端开发' } });

const T = Agt.__watchTest;
const cfg = T.cfgLoad();
console.log('模型:', cfg.model, '| 有 Key:', !!cfg.apiKey, '| 简历字数:', RESUME.length);

const jobs = [
  { title: '软件实施实习生（支持转正）', salary: '200-250元/天', city: '上海', company: '新视窗' },
  { title: '前端开发实习生', salary: '150-200元/天', city: '南宁', company: '某科技' },
];
const history = [
  { role: 'them', text: '方便发一份简历过来吗？' },
  { role: 'them', text: '[卡片]我想要一份您的附件简历，您是否同意（拒绝/同意）' },
];

for (const job of jobs) {
  console.log(`\n--- 岗位：${job.title}（${job.city}） ---`);
  const t0 = Date.now();
  try {
    const intro = await T.composeReply({
      message: '（HR 请求发一份附件简历，我已经点了同意，附件简历已发出）',
      history,
      job,
      mode: 'resume-intro',
    }, cfg);
    console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${intro.length} 字`);
    console.log('结果:', intro);
  } catch (e) {
    console.log('生成失败:', e.message);
    process.exitCode = 1;
  }
}

// 只清理本脚本自己写进去的文件（不做递归删除）
for (const rel of ['知识库/resume.txt', '知识库/profile.json']) {
  try { fs.unlinkSync(path.join(tmp, rel)); } catch {}
}
process.exit(process.exitCode || 0);

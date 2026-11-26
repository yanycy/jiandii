// 值守自测：只用真实浏览器验证「扫未读 / 点头像切会话 / 识别简历卡片」，
// 不点同意、不发消息，避免给真人 HR 发东西。
import path from 'node:path';
import { connect } from '../lib/cdp.mjs';
import * as Agt from '../lib/agent.mjs';

const d = await connect({ tries: 2 });
if (!d.ok) {
  console.log('连不上 Chrome 调试端口，先启动浏览器');
  process.exit(1);
}
const cdp = d.cdp;

Agt.initAgent({
  dataDir: path.resolve('简递数据'),
  log: m => console.log(m),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  getCdp: async () => cdp,
});

const T = Agt.__watchTest;
const which = process.argv[2] || 'all';

if (which === 'scan' || which === 'all') {
  const scan = await T.scanOnce(cdp);
  console.log('--- scan ---');
  console.log('url', scan && scan.url);
  console.log('itemCount', scan && scan.diag && scan.diag.itemCount, 'scrollTop', scan && scan.diag && scan.diag.scrollTop);
  const all = (scan && scan.convs) || [];
  const unread = all.filter(c => c.unread > 0);
  console.log('未读', unread.length, unread.slice(0, 8).map(c => `${c.name}(${c.badge})`));
  console.log('前 6 个', all.slice(0, 6).map(c => `${c.name} u=${c.unread} ${c.time} ${c.preview.slice(0, 14)}`));
}

if (which === 'open' || which === 'all') {
  const cur = await T.readConv(cdp);
  console.log('--- 当前会话 ---', cur && (cur.selectedName || cur.topName));
  console.log('job', JSON.stringify(cur && cur.job));
  console.log('resumeAsk', JSON.stringify(cur && cur.resumeAsk));
  const name = process.argv[3] || ((cur && cur.topName) === '骆女士' ? '姜女士' : '骆女士');
  const r = await T.openConv(cdp, name);
  console.log('--- openConv ---', name, JSON.stringify(r));
  const t0 = Date.now();
  const after = await T.waitConvReady(cdp, name);
  console.log(`--- waitConvReady 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ---`);
  console.log('会话标题', after && (after.selectedName || after.topName), '| 消息数', after && after.msgs && after.msgs.length);
  console.log('当前岗位', JSON.stringify(after && after.job));
  console.log('简历请求卡片', JSON.stringify(after && after.resumeAsk));
}

if (which === 'read') {
  const cur = await T.readConv(cdp);
  console.log(JSON.stringify(cur, null, 1).slice(0, 3500));
}

// 只生成草稿，绝不发送：验证「历史简历卡片不会吞掉普通回复」
if (which === 'draft') {
  const name = process.argv[3] || '韦女士';
  Agt.kbSave({
    resume: '黄选，2027届计算机专业。独立交付能源企业官网+小程序双端项目、Python/Electron 自动化采集工具、AI 文档自动生成系统。技术栈 Vue3/Nuxt3/Java/Python/MySQL，可全国驻场，12月底到岗，能实习到毕业。',
    profile: {
      name: '黄选', degree: '本科', major: '计算机科学与技术', status: '2027届',
      expectRole: '前端开发 / 软件实施', expectCity: '南宁',
      skills: ['Vue3', 'Nuxt3', 'Java', 'Python', 'MySQL'],
      intro: '可全国驻场，12月底到岗，能实习到毕业。',
    },
  });
  const cfg = { ...T.cfgLoad(), autoSend: false, autoAgreeResume: true, delayMin: 0, delayMax: 0, maxPerHour: 99, maxChars: 80 };
  const before = await T.readConv(cdp);
  const lastBefore = ((before && before.msgs) || []).filter(m => m.kind === 'text').slice(-1)[0];
  console.log('--- draft 测试（不会发送）---');
  console.log('resumeAsk', JSON.stringify(before && before.resumeAsk));
  console.log('HR 最后一条', JSON.stringify(lastBefore && lastBefore.text));
  await T.processConv(cdp, { name, preview: '', time: '', unread: 1 }, cfg);
  const after = await T.readConv(cdp);
  const lastAfter = ((after && after.msgs) || []).filter(m => m.kind === 'text').slice(-1)[0];
  console.log('处理后最后一条', JSON.stringify(lastAfter && { role: lastAfter.role, text: lastAfter.text }));
  console.log('--- draft 测试结束：没有发送任何消息 ---');
}

cdp.close();
process.exit(0);

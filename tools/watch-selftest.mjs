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

cdp.close();
process.exit(0);

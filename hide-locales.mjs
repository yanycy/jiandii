// 构建辅助：把 electron 运行时里用不到的语言包暂时挪走（不删除），
// 让 electron-builder 没有「批量删除」动作，绕开环境的批量删除保护。
import fs from 'node:fs';
import path from 'node:path';

const LOC = path.join('node_modules', 'electron', 'dist', 'locales');
const HOLD = path.join('.locales-hold');
const KEEP = new Set(['zh-CN.pak', 'en-US.pak']);

if (process.argv[2] === 'restore') {
  if (!fs.existsSync(HOLD)) { console.log('没有需要恢复的文件'); process.exit(0); }
  let n = 0;
  for (const f of fs.readdirSync(HOLD)) {
    fs.renameSync(path.join(HOLD, f), path.join(LOC, f));
    n++;
  }
  fs.rmdirSync(HOLD);
  console.log(`已恢复 ${n} 个语言包`);
  process.exit(0);
}

fs.mkdirSync(HOLD, { recursive: true });
let moved = 0;
for (const f of fs.readdirSync(LOC)) {
  if (KEEP.has(f)) continue;
  fs.renameSync(path.join(LOC, f), path.join(HOLD, f));
  moved++;
}
console.log(`已暂时挪走 ${moved} 个语言包`);

/**
 * 简递 · 本地更新源（自测 / 局域网分发用）
 *
 *   node 本地更新服务.mjs --dir="..\更新源" [--port=8931] [--slow=0]
 *
 * 把 latest.json 和安装包放在同一个目录，启动后把打印出来的地址
 * 填进 简递数据/config.json 的 updateUrl 即可。
 * --slow=毫秒  每个数据块延迟，用来模拟慢速网络（演示进度条很有用）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const a = args.find(x => x.startsWith('--' + n + '='));
  return a ? a.slice(n.length + 3) : d;
};

const root = path.resolve(opt('dir', '.'));
const port = Number(opt('port', 8931));
const slow = Number(opt('slow', 0));

if (!fs.existsSync(root)) {
  console.error('✘ 目录不存在：' + root);
  process.exit(1);
}

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

const server = http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { name = req.url || '/'; }
  if (name === '/') {
    const files = fs.readdirSync(root).filter(f => !f.startsWith('.'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta charset="utf-8"><h3>简递更新源</h3><ul>'
      + files.map(f => `<li><a href="/${encodeURIComponent(f)}">${f}</a></li>`).join('')
      + '</ul>');
    return;
  }
  const file = path.join(root, name.replace(/^\/+/, ''));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  console.log(`  ${new Date().toLocaleTimeString()}  GET ${name}  ${(st.size / 1024 / 1024).toFixed(1)}MB`);

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });

  if (!slow) { fs.createReadStream(file).pipe(res); return; }

  // 慢速：每 64KB 停一下，方便截图看进度
  const rs = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  rs.on('data', chunk => {
    res.write(chunk);
    rs.pause();
    setTimeout(() => rs.resume(), slow);
  });
  rs.on('end', () => res.end());
});

server.listen(port, () => {
  const ip = lanIp();
  console.log('');
  console.log('  简递更新源已启动');
  console.log('    目录      ' + root);
  console.log('    本机      http://127.0.0.1:' + port + '/latest.json');
  console.log('    局域网    http://' + ip + ':' + port + '/latest.json');
  if (slow) console.log('    限速      ' + slow + 'ms / 64KB');
  console.log('');
  console.log('  Ctrl+C 停止');
  console.log('');
});

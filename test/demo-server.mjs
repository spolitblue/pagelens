// 本地演示页：node test/demo-server.mjs
// 然后浏览器打开 http://127.0.0.1:8777
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'sample-page.html'));
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
});

const port = Number(process.env.PORT || 8777);
server.listen(port, '127.0.0.1', () => {
  console.log(`PageLens 演示页：http://127.0.0.1:${port}/`);
  console.log('保持这个窗口开着，打开上面的地址，点右下角 PageLens 气泡。');
});

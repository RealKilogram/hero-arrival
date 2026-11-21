// 简易本地服务：给直播姬 / OBS 的「浏览器源」用
// 提供静态素材 + SSE 推送播放指令
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8'
};

function createLiveServer(opts) {
  const root = opts.root;
  const log = opts.log || (() => {});
  const basePort = opts.port || 17321;
  let clients = [];
  let seq = 0;
  let server = null;
  let port = basePort;

  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      res.writeHead(400).end('bad request');
      return;
    }
    const p = decodeURIComponent(url.pathname);

    if (p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 1000\n\n');
      res.write(': hello\n\n');
      clients.push(res);
      log('[live] client connected, total', clients.length);
      const timer = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
      }, 20000);
      req.on('close', () => {
        clearInterval(timer);
        clients = clients.filter((c) => c !== res);
        log('[live] client gone, total', clients.length);
      });
      return;
    }

    if (p === '/play') {
      seq += 1;
      const clip = url.searchParams.get('clip') || '';
      const payload = 'data: ' + JSON.stringify({ seq, clip }) + '\n\n';
      clients.forEach((c) => {
        try { c.write(payload); } catch (e) { /* ignore */ }
      });
      log('[live] play ->', clip || '(default)', clients.length, 'client(s)');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('ok ' + seq);
      return;
    }

    if (p === '/seq') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(String(seq));
      return;
    }

    // 静态文件
    let rel = p === '/' ? (opts.index || 'index.html') : p.replace(/^\/+/, '');
    const file = path.join(root, rel);
    const rootResolved = path.resolve(root);
    if (!path.resolve(file).startsWith(rootResolved)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found: ' + rel);
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': rel.startsWith('frames/') ? 'public, max-age=3600' : 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handle);
      s.once('error', reject);
      s.listen(p, '127.0.0.1', () => resolve(s));
    });
  }

  async function start() {
    for (let i = 0; i < 10; i++) {
      const p = basePort + i;
      try {
        server = await listen(p);
        port = p;
        log('[live] server on http://127.0.0.1:' + port + '/');
        return port;
      } catch (e) {
        log('[live] port', p, 'busy:', e.code);
      }
    }
    log('[live] no free port');
    return null;
  }

  function trigger(clipId) {
    if (!server) return;
    const q = clipId ? '?clip=' + encodeURIComponent(clipId) : '';
    http.get('http://127.0.0.1:' + port + '/play' + q, (r) => r.resume()).on('error', () => {});
  }

  function stop() {
    clients.forEach((c) => { try { c.end(); } catch (e) { /* ignore */ } });
    clients = [];
    if (server) server.close();
    server = null;
  }

  return {
    start,
    stop,
    trigger,
    get port() { return port; },
    get running() { return !!server; },
    get clients() { return clients.length; }
  };
}

module.exports = { createLiveServer };

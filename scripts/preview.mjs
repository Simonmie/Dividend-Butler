import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const directory = await mkdtemp(join(tmpdir(), 'dividend-preview-'));
const bundle = join(directory, 'backend.cjs');
await build({ entryPoints: ['src/application.ts', 'src/storage.ts'], outdir: directory, bundle: true, platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' } });
const require = createRequire(bundle);
const { Application } = require(join(directory, 'application.cjs'));
const { Store } = require(join(directory, 'storage.cjs'));
const app = new Application(new Store(join(directory, 'account')));
await app.initialize();
const port = 4317;
const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) throw new Error('不允许的主机');
    if (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin)) throw new Error('不允许的请求来源');
    if (request.url === '/api/action' && request.method === 'POST') {
      let text = '';
      for await (const chunk of request) { text += chunk.toString(); if (text.length > 10000) throw new Error('请求过大'); }
      const input = JSON.parse(text);
      await app.reload();
      if (input.type === 'refresh') await app.refresh(true);
      else if (input.type !== 'ready') {
        if (['import', 'export'].includes(input.type)) throw new Error('备份操作请在实际编辑器中测试');
        await app.execute(input.type, input.payload, input.revision);
        if (app.view().state.settings.online && ['settings', 'addFund'].includes(input.type)) await app.refresh();
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(app.view())); return;
    }
    const routes = { '/': null, '/panel.js': ['dist/panel.js', 'text/javascript'], '/panel.css': ['dist/panel.css', 'text/css'] };
    const asset = routes[request.url];
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'" });
      response.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><title>红利管家 Beta 本地验证</title><div id="app"></div><script src="/panel.js"></script></html>');
    } else if (asset) { response.writeHead(200, { 'Content-Type': asset[1] }); response.end(await readFile(resolve(asset[0]))); }
    else { response.writeHead(404); response.end(); }
  } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
});
server.listen(port, '127.0.0.1', () => console.log(`验证面板 http://127.0.0.1:${port} ，使用临时账本，不会修改真实投资数据。`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { void rm(directory, { recursive: true, force: true }).then(() => process.exit(0)); }); });

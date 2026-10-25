// 截图弹窗 UI + 采集扩展运行时错误（用于人工检查）
// 用法：node test/popup-shot.mjs [输出路径]
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(tmpdir(), 'btg-popup.png');
const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html' });
  r.end('<h1>' + q.url + '</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'btg-shot-'));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  pipe: true,
  enableExtensions: [join(ROOT, 'extension')],
  userDataDir: profile,
  args: ['--no-first-run'],
});
const errors = [];
try {
  const t = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15000 });
  const sw = await t.worker();
  sw.on('console', (m) => ['error', 'warn'].includes(m.type()) && errors.push(`[sw ${m.type()}] ${m.text()}`));
  const extId = new URL(t.url()).host;
  await sw.evaluate(async (BASE) => {
    const f = await chrome.bookmarks.create({ parentId: '1', title: '前端文档' });
    const g = await chrome.bookmarks.create({ parentId: '1', title: '工作' });
    await chrome.bookmarks.create({ parentId: f.id, title: 'MDN Web Docs', url: BASE + '/mdn' });
    await chrome.bookmarks.create({ parentId: g.id, title: '周报', url: BASE + '/weekly' });
    await chrome.bookmarks.create({ parentId: '1', title: '根目录书签', url: BASE + '/root' });
    await chrome.bookmarks.create({ parentId: g.id, title: 'Q4 规划（飞书文档）', url: BASE + '/docx-sample' });
  }, BASE);
  const p = await browser.newPage();
  const cdp = await p.createCDPSession();
  for (const u of ['/mdn', '/weekly', '/root']) {
    await cdp.send('Page.navigate', { url: BASE + u, transitionType: 'auto_bookmark' });
    await new Promise((r) => setTimeout(r, 400));
  }
  // 弹窗记录里展示“文档”组记录（截图用，不访问真实飞书）
  await sw.evaluate(async () => {
    const { logs = [] } = await chrome.storage.session.get('logs');
    logs.unshift({ time: Date.now(), action: 'created', group: '文档', bookmark: 'Q4 规划（飞书文档）', kind: 'docs' });
    logs.unshift({ time: Date.now(), action: 'joined', group: '文档', bookmark: 'bytedance.larkoffice.com/wiki/wikcnXXX', via: 'auto', kind: 'docs' });
    await chrome.storage.session.set({ logs });
  });
  await sw.evaluate(() => globalThis.__btg.idle());
  const popup = await browser.newPage();
  popup.on('console', (m) => ['error', 'warn'].includes(m.type()) && errors.push(`[popup ${m.type()}] ${m.text()}`));
  popup.on('pageerror', (e) => errors.push(`[popup pageerror] ${e.message}`));
  await popup.setViewport({ width: 320, height: 520, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 500));
  // 切换一个设置，验证保存
  await popup.select('#titleStyle', 'path');
  await new Promise((r) => setTimeout(r, 300));
  const saved = await sw.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.titleStyle);
  await popup.select('#titleStyle', 'name');
  // 修改文档组名，验证保存（含去空白）
  await popup.click('#docGroupTitle', { count: 3 });
  await popup.type('#docGroupTitle', '  云文档  ');
  await popup.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 300));
  const savedDoc = await sw.evaluate(async () => (await chrome.storage.sync.get('settings')).settings.docGroupTitle);
  await popup.click('#docGroupTitle', { count: 3 });
  await popup.type('#docGroupTitle', '文档');
  await popup.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 300));
  const h = await popup.evaluate(() => document.documentElement.scrollHeight);
  await popup.setViewport({ width: 320, height: h, deviceScaleFactor: 2 });
  await popup.screenshot({ path: out });
  const logs = await popup.$$eval('#logs li', (els) => els.map((e) => e.textContent));
  console.log(JSON.stringify({ out, saved, savedDoc, logs, errors }, null, 1));
} finally {
  await browser.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

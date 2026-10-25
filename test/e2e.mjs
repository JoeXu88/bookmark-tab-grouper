// 端到端测试：用临时 Chrome 配置加载扩展，模拟各种“从书签打开”的场景并断言分组结果。
// 运行：npm run test:e2e        （HEADFUL=1 可看到浏览器窗口；CHROME_PATH 可指定 Chrome 路径）
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const CHROME =
  process.env.CHROME_PATH ||
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(
    existsSync,
  );

// ---------- 本地测试站点 ----------
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/redir') {
    res.writeHead(302, { location: '/landing' });
    return res.end();
  }
  if (u.pathname === '/docx/redir') {
    // 模拟飞书文档未登录时跳转到登录页
    res.writeHead(302, { location: '/accounts/page/login?redirect=1' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (u.pathname === '/hub') {
    // 普通网页上的飞书文档链接（非书签打开）
    return res.end(`<!doctype html><title>hub</title>
      <a id="doc" href="https://bytedance.feishu.cn/docx/doxcnLinked">doc</a>
      <a id="docnew" target="_blank" href="https://bytedance.larkoffice.com/sheets/shtcnNew">sheet in new tab</a>
      <a id="min" href="https://bytedance.feishu.cn/minutes/obcnLinked">minutes</a>`);
  }
  if (u.pathname === '/next/messenger') {
    // 飞书网页（非文档页），站内用 pushState 切到文档
    return res.end(`<!doctype html><title>messenger</title>
      <button id="spa" onclick="history.pushState({}, '', '/docx/doxcnSpa')">open doc</button>`);
  }
  if (u.pathname === '/accounts/sso') {
    // 登录完成后用 JS 跳回文档（client_redirect）
    return res.end(`<!doctype html><title>sso</title><script>
      setTimeout(() => location.replace(new URLSearchParams(location.search).get('next')), 50);</script>`);
  }
  res.end(`<!doctype html><title>${u.pathname}</title><h1>${u.pathname}${u.search}</h1><a id="l" href="/linked">link</a>`);
}

// ---------- 模拟飞书域名：本机 HTTPS（自签证书）+ host-resolver-rules 把飞书域名映射到本机 ----------
const certDir = mkdtempSync(join(tmpdir(), 'btg-cert-'));
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')],
  { stdio: 'ignore' },
);
const docServer = https.createServer(
  { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
  handler,
);
await new Promise((r) => docServer.listen(0, '127.0.0.1', r));
const DOC_PORT = docServer.address().port;
const HOST_RULES = ['*.feishu.cn', 'feishu.cn', '*.larkoffice.com', '*.larksuite.com']
  .map((h) => `MAP ${h} 127.0.0.1:${DOC_PORT}`)
  .join(', ');

// ---------- 启动浏览器 ----------
const profile = mkdtempSync(join(tmpdir(), 'btg-e2e-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: profile,
  protocolTimeout: 30000,
  acceptInsecureCerts: true,
  args: ['--no-first-run', '--no-default-browser-check', `--host-resolver-rules=${HOST_RULES}`, '--ignore-certificate-errors'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sw;
async function getSW() {
  const t = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), {
    timeout: 15000,
  });
  return t.worker();
}
// SW 可能被 Chrome 回收重启：句柄失效时自动重新获取
async function ev(fn, ...args) {
  try {
    return await sw.evaluate(fn, ...args);
  } catch (e) {
    if (!/detached|Target closed|Session closed/i.test(String(e?.message))) throw e;
    sw = await getSW();
    return sw.evaluate(fn, ...args);
  }
}

// ---------- 工具函数 ----------
let uid = 0;
async function newWindow() {
  const tag = `w${++uid}`;
  const win = await ev((url) => chrome.windows.create({ url, focused: true }), `${BASE}/blank?${tag}`);
  return win.id;
}
async function closeWindow(windowId) {
  await ev((id) => chrome.windows.remove(id).catch(() => {}), windowId);
}

/** 在指定窗口新建一个标签，返回 { tabId, page } */
async function newTab(windowId) {
  const tag = `t${++uid}`;
  const url = `${BASE}/blank?${tag}`;
  const tab = await ev((windowId, url) => chrome.tabs.create({ windowId, url, active: true }), windowId, url);
  const target = await browser.waitForTarget((t) => t.url() === url, { timeout: 10000 });
  const page = await target.page();
  return { tabId: tab.id, page };
}

/** 用 CDP 以指定 transitionType 导航（auto_bookmark 等同于浏览器内部“打开书签”的导航类型） */
async function navigate(page, url, transitionType = 'auto_bookmark') {
  const cdp = await page.createCDPSession();
  const done = page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).catch(() => {});
  await cdp.send('Page.navigate', { url, transitionType });
  await done;
  await cdp.detach().catch(() => {});
}

async function openBookmark(windowId, url) {
  const t = await newTab(windowId);
  await navigate(t.page, url);
  return t;
}

async function state(windowId) {
  return ev(async (windowId) => {
    await globalThis.__btg.idle();
    const tabs = await chrome.tabs.query({ windowId });
    const groups = await chrome.tabGroups.query({ windowId });
    return {
      tabs: tabs.map((t) => ({ id: t.id, url: t.pendingUrl || t.url, groupId: t.groupId })),
      groups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color })),
    };
  }, windowId);
}

async function waitFor(windowId, pred, timeout = 6000) {
  const start = Date.now();
  let s;
  while (Date.now() - start < timeout) {
    s = await state(windowId);
    if (pred(s)) return s;
    await sleep(100);
  }
  return s;
}

const groupOf = (s, tabId) => {
  const t = s.tabs.find((x) => x.id === tabId);
  return t && t.groupId !== -1 ? s.groups.find((g) => g.id === t.groupId) : null;
};

async function setSettings(patch) {
  await ev(async (patch) => {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...settings, ...patch } });
    await new Promise((r) => setTimeout(r, 100));
    await globalThis.__btg.idle();
  }, patch);
}
async function resetSettings() {
  await ev(async () => {
    await chrome.storage.sync.set({
      settings: {
        enabled: true,
        groupBy: 'parent',
        titleStyle: 'name',
        rootBookmarks: 'skip',
        moveFromOtherGroups: true,
        colorByFolder: true,
        syncTitleOnRename: true,
        docGroupEnabled: true,
        docGroupTitle: '文档',
        docGroupScope: 'any',
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    await globalThis.__btg.idle();
  });
}

// ---------- 断言与结果 ----------
const results = [];
let current;
function check(cond, msg, detail) {
  if (!cond) {
    current.ok = false;
    current.fails.push(detail ? `${msg} -> ${JSON.stringify(detail)}` : msg);
  }
}
async function scenario(name, fn) {
  current = { name, ok: true, fails: [] };
  const t0 = Date.now();
  try {
    await resetSettings();
    await fn();
  } catch (e) {
    current.ok = false;
    current.fails.push(`异常: ${e?.stack || e}`);
  }
  current.ms = Date.now() - t0;
  results.push(current);
  console.log(`${current.ok ? 'PASS' : 'FAIL'}  ${name} (${current.ms}ms)`);
  for (const f of current.fails) console.log(`      - ${f}`);
}

// ---------- 准备书签 ----------
try {
  sw = await getSW();
  const B = await ev(async (base) => {
    const mk = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, url });
    const work = await mk('1', 'Work');
    const docs = await mk(work.id, 'Docs');
    const personal = await mk('1', 'Personal');
    const pdocs = await mk(personal.id, 'Docs');
    const news = await mk('2', 'News'); // 其他书签下的文件夹
    const special = await mk('1', 'Dev*Tools?');
    const ids = {
      work: work.id,
      docs: docs.id,
      personal: personal.id,
      pdocs: pdocs.id,
      news: news.id,
      special: special.id,
    };
    const urls = {
      w1: `${base}/work1`,
      w2: `${base}/work2`,
      w3: `${base}/work3`,
      d1: `${base}/docs1`,
      pd1: `${base}/pdocs1`,
      n1: `${base}/news1`,
      root: `${base}/rootbm`,
      redir: `${base}/redir`,
      loose: `${base}/loose/`,
      sp: `${base}/special`,
      dup: `${base}/dup`,
    };
    await mk(work.id, 'W1', urls.w1);
    await mk(work.id, 'W2', urls.w2);
    await mk(work.id, 'W3', urls.w3);
    await mk(docs.id, 'D1', urls.d1);
    await mk(pdocs.id, 'PD1', urls.pd1);
    await mk(news.id, 'N1', urls.n1);
    await mk('1', 'Root BM', urls.root);
    await mk(work.id, 'Redirect', urls.redir);
    await mk(personal.id, 'Loose', urls.loose);
    await mk(special.id, 'SP', urls.sp);
    await mk(work.id, 'Dup-old', urls.dup);
    await new Promise((r) => setTimeout(r, 20));
    await mk(personal.id, 'Dup-new', urls.dup);
    // 飞书 / Lark 云文档书签（分散在不同文件夹，含根目录）
    const docs2 = {
      workDoc: 'https://bytedance.larkoffice.com/docx/doxcnWork1',
      personalSheet: 'https://bytedance.feishu.cn/sheets/shtcnP1?sheet=a1',
      rootBase: 'https://bytedance.feishu.cn/base/bascnR1?table=tbl1&view=vew1',
      wiki: 'https://bytedance.larkoffice.com/wiki/wikcnW1',
      slides: 'https://example.larksuite.com/slides/sldcnS1',
      minutes: 'https://bytedance.feishu.cn/minutes/obcnM1', // 妙记：不算文档
      redirDoc: 'https://bytedance.feishu.cn/docx/redir', // 跳转到登录页
    };
    await mk(work.id, 'Work Doc', docs2.workDoc);
    await mk(personal.id, 'Personal Sheet', docs2.personalSheet);
    await mk('1', 'Root Base', docs2.rootBase);
    await mk(docs.id, 'Wiki', docs2.wiki);
    await mk(news.id, 'Slides', docs2.slides);
    await mk(work.id, 'Minutes', docs2.minutes);
    await mk(news.id, 'Redirect Doc', docs2.redirDoc);
    Object.assign(urls, docs2);
    return { ids, urls };
  }, BASE);
  const U = B.urls;

  await scenario('同一书签文件夹的两个书签 -> 同一标签组（组名=文件夹名）', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    const b = await openBookmark(w, U.w2);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId) && groupOf(s, b.tabId));
    const ga = groupOf(s, a.tabId);
    const gb = groupOf(s, b.tabId);
    check(ga && ga.title === 'Work', '第一个标签应在 Work 组', ga);
    check(ga && gb && ga.id === gb.id, '两个标签应在同一组', { ga, gb });
    check(s.groups.length === 1, '窗口内只应有 1 个组', s.groups);
    await closeWindow(w);
  });

  await scenario('不同文件夹 -> 不同标签组；颜色按文件夹固定', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    const b = await openBookmark(w, U.d1);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId) && groupOf(s, b.tabId));
    check(groupOf(s, a.tabId)?.title === 'Work', 'W1 -> Work', groupOf(s, a.tabId));
    check(groupOf(s, b.tabId)?.title === 'Docs', 'D1 -> Docs（直接所在文件夹）', groupOf(s, b.tabId));
    check(groupOf(s, a.tabId)?.id !== groupOf(s, b.tabId)?.id, '两个组应不同', s.groups);
    // 再开一个同文件夹的书签，颜色不变
    const c = await openBookmark(w, U.w2);
    const s2 = await waitFor(w, (s) => groupOf(s, c.tabId));
    check(groupOf(s2, c.tabId)?.color === groupOf(s, a.tabId)?.color, '同文件夹颜色一致', s2.groups);
    await closeWindow(w);
  });

  await scenario('普通链接 / 手动输入导航 -> 不分组', async () => {
    const w = await newWindow();
    const a = await newTab(w);
    await navigate(a.page, U.w1, 'link');
    const b = await newTab(w);
    await navigate(b.page, U.w2, 'typed');
    await sleep(800);
    const s = await state(w);
    check(!groupOf(s, a.tabId) && !groupOf(s, b.tabId), '非书签导航不应分组', s);
    await closeWindow(w);
  });

  await scenario('书签打开后在页面内点链接 -> 留在原组（不被移出）', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await Promise.all([a.page.waitForNavigation({ timeout: 10000 }), a.page.click('#l')]);
    await sleep(600);
    const s = await state(w);
    check(groupOf(s, a.tabId)?.title === 'Work', '点击站内链接后仍在 Work 组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('书签栏根目录的书签 -> 默认不分组；开启后归入根目录组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.root);
    await sleep(800);
    let s = await state(w);
    check(!groupOf(s, a.tabId), '默认不分组', groupOf(s, a.tabId));
    await setSettings({ rootBookmarks: 'group' });
    const b = await openBookmark(w, U.root);
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    const rootTitle = await ev(async () => (await chrome.bookmarks.get('1'))[0].title);
    check(groupOf(s, b.tabId)?.title === rootTitle, `开启后应归入「${rootTitle}」组`, groupOf(s, b.tabId));
    await closeWindow(w);
  });

  await scenario('服务端 302 重定向 -> 按书签原始地址归组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.redir);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId));
    const tab = s.tabs.find((t) => t.id === a.tabId);
    check(tab?.url.endsWith('/landing'), '应已重定向到 /landing', tab);
    check(groupOf(s, a.tabId)?.title === 'Work', '重定向后仍归入 Work', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('宽松匹配：书签带末尾斜杠，实际地址不带', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.loose.replace(/\/$/, ''));
    const s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === 'Personal', '应归入 Personal', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('同名文件夹（Work/Docs 与 Personal/Docs）-> 两个独立组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.d1);
    const b = await openBookmark(w, U.pd1);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId) && groupOf(s, b.tabId));
    const ga = groupOf(s, a.tabId);
    const gb = groupOf(s, b.tabId);
    check(ga?.title === 'Docs' && gb?.title === 'Docs', '两组都叫 Docs', { ga, gb });
    check(ga && gb && ga.id !== gb.id, '但应是不同的组', { ga, gb });
    const c = await openBookmark(w, U.d1);
    const s2 = await waitFor(w, (s) => groupOf(s, c.tabId));
    check(groupOf(s2, c.tabId)?.id === ga?.id, '再次打开 Work/Docs 的书签应进入 Work/Docs 的组', groupOf(s2, c.tabId));
    await closeWindow(w);
  });

  await scenario('组名含 * ? 等特殊字符 -> 正常复用同一组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.sp);
    const b = await openBookmark(w, U.sp);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId) && groupOf(s, b.tabId));
    check(groupOf(s, a.tabId)?.title === 'Dev*Tools?', '组名正确', groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.id === groupOf(s, b.tabId)?.id, '复用同一组', s.groups);
    await closeWindow(w);
  });

  await scenario('同一网址被多个文件夹收藏 -> 取最近添加的那个', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.dup);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === 'Personal', '应归入最近添加的 Personal', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('同时打开同一文件夹的 3 个书签（并发）-> 只建 1 个组', async () => {
    const w = await newWindow();
    const tabs = [await newTab(w), await newTab(w), await newTab(w)];
    await Promise.all([navigate(tabs[0].page, U.w1), navigate(tabs[1].page, U.w2), navigate(tabs[2].page, U.w3)]);
    const s = await waitFor(w, (s) => tabs.every((t) => groupOf(s, t.tabId)));
    const ids = new Set(tabs.map((t) => groupOf(s, t.tabId)?.id));
    check(ids.size === 1 && !ids.has(undefined), '3 个标签应在同一组', s);
    check(s.groups.length === 1, '只应有 1 个组', s.groups);
    await closeWindow(w);
  });

  await scenario('多窗口：每个窗口各自建同名组', async () => {
    const w1 = await newWindow();
    const w2 = await newWindow();
    const a = await openBookmark(w1, U.w1);
    const b = await openBookmark(w2, U.w2);
    const s1 = await waitFor(w1, (s) => groupOf(s, a.tabId));
    const s2 = await waitFor(w2, (s) => groupOf(s, b.tabId));
    check(groupOf(s1, a.tabId)?.title === 'Work' && groupOf(s2, b.tabId)?.title === 'Work', '两个窗口都有 Work 组', {
      a: groupOf(s1, a.tabId),
      b: groupOf(s2, b.tabId),
    });
    await closeWindow(w1);
    await closeWindow(w2);
  });

  await scenario('已在本扩展的 A 组中，再从 B 文件夹书签导航 -> 移到 B 组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await navigate(a.page, U.pd1);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId)?.title === 'Docs');
    check(groupOf(s, a.tabId)?.title === 'Docs', '应移到 Personal/Docs 组', groupOf(s, a.tabId));
    check(!s.groups.some((g) => g.title === 'Work'), '空的 Work 组应被 Chrome 自动移除', s.groups);
    await closeWindow(w);
  });

  await scenario('用户自建组 + 关闭“已在其他组时也移动” -> 不移动', async () => {
    const w = await newWindow();
    await setSettings({ moveFromOtherGroups: false });
    const a = await newTab(w);
    const mine = await ev(async (tabId) => {
      const id = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(id, { title: 'Mine' });
      return id;
    }, a.tabId);
    await navigate(a.page, U.w1);
    await sleep(800);
    let s = await state(w);
    check(groupOf(s, a.tabId)?.id === mine, '应留在用户的 Mine 组', groupOf(s, a.tabId));
    await setSettings({ moveFromOtherGroups: true });
    await navigate(a.page, U.w2);
    s = await waitFor(w, (s) => groupOf(s, a.tabId)?.title === 'Work');
    check(groupOf(s, a.tabId)?.title === 'Work', '开启后应移到 Work 组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('设置：顶层文件夹分组 + 完整路径组名', async () => {
    const w = await newWindow();
    await setSettings({ groupBy: 'top' });
    const a = await openBookmark(w, U.d1);
    let s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === 'Work', 'groupBy=top: Work/Docs/D1 -> Work', groupOf(s, a.tabId));
    await setSettings({ groupBy: 'parent', titleStyle: 'path' });
    const b = await openBookmark(w, U.pd1);
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, b.tabId)?.title === 'Personal / Docs', 'titleStyle=path', groupOf(s, b.tabId));
    await closeWindow(w);
  });

  await scenario('关闭插件 -> 不分组', async () => {
    const w = await newWindow();
    await setSettings({ enabled: false });
    const a = await openBookmark(w, U.w1);
    await sleep(800);
    const s = await state(w);
    check(!groupOf(s, a.tabId), '停用时不应分组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('书签文件夹改名 -> 组名同步；用户手动改过的组名不覆盖', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.n1);
    const b = await openBookmark(w, U.sp);
    let s = await waitFor(w, (s) => groupOf(s, a.tabId) && groupOf(s, b.tabId));
    const gb = groupOf(s, b.tabId);
    await ev((id) => chrome.tabGroups.update(id, { title: '我的工具' }), gb.id);
    await ev(
      async (ids) => {
        await chrome.bookmarks.update(ids.news, { title: 'News 2' });
        await chrome.bookmarks.update(ids.special, { title: 'Tools Renamed' });
      },
      B.ids,
    );
    s = await waitFor(w, (s) => groupOf(s, a.tabId)?.title === 'News 2');
    check(groupOf(s, a.tabId)?.title === 'News 2', '组名应同步为 News 2', groupOf(s, a.tabId));
    check(groupOf(s, b.tabId)?.title === '我的工具', '手动改过的组名应保留', groupOf(s, b.tabId));
    await ev(
      async (ids) => {
        await chrome.bookmarks.update(ids.news, { title: 'News' });
        await chrome.bookmarks.update(ids.special, { title: 'Dev*Tools?' });
      },
      B.ids,
    );
    await closeWindow(w);
  });

  await scenario('会话映射丢失（模拟 SW 重启）-> 按同名组接管，不重复建组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await ev(() => chrome.storage.session.remove('groupMap'));
    const b = await openBookmark(w, U.w2);
    const s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, a.tabId)?.id === groupOf(s, b.tabId)?.id, '应接管已有的 Work 组', s.groups);
    check(s.groups.length === 1, '不应新建重复组', s.groups);
    await closeWindow(w);
  });

  await scenario('Service Worker 被终止后重新唤醒 -> 仍正常分组并复用原组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    // 终止扩展 SW（等价于 Chrome 空闲 30 秒后自动回收），确认内存状态清空后仍能工作
    const oldTargetUrl = sw.url();
    await sw.close();
    const gone = await (async () => {
      for (let i = 0; i < 50; i++) {
        if (!browser.targets().some((t) => t.type() === 'service_worker' && t.url() === oldTargetUrl)) return true;
        await sleep(100);
      }
      return false;
    })();
    check(gone, 'SW 应已被终止');
    // 不经过扩展创建新标签，由书签导航事件唤醒 SW
    const p2 = await browser.newPage();
    await navigate(p2, U.w2);
    sw = await getSW();
    let info;
    for (let i = 0; i < 60; i++) {
      info = await ev(async (url) => {
        await globalThis.__btg.idle();
        const [t] = await chrome.tabs.query({ url });
        if (!t) return null;
        const g = t.groupId !== -1 ? await chrome.tabGroups.get(t.groupId) : null;
        return { id: t.id, windowId: t.windowId, groupId: t.groupId, title: g?.title };
      }, U.w2);
      if (info?.groupId > 0) break;
      await sleep(100);
    }
    check(info?.title === 'Work', '唤醒后的 SW 应把标签归入 Work 组', info);
    if (info?.windowId === w) {
      const s = await state(w);
      check(info.groupId === groupOf(s, a.tabId)?.id, '同窗口应复用原 Work 组', { info, groups: s.groups });
    }
    await p2.close();
    await closeWindow(w);
  });

  await scenario('真实浏览器路径：在书签管理器（chrome://bookmarks）中双击 / 全部打开', async () => {
    // 用 puppeteer 自己的页面打开书签管理器（chrome.windows.create 出来的后台窗口在 headless 下会被节流）
    const page = await browser.newPage();
    await page.goto(`chrome://bookmarks/?id=${B.ids.work}`, { waitUntil: 'load' });
    await page.bringToFront();
    await sleep(600);
    const mgr = await ev(async () => (await chrome.tabs.query({ url: 'chrome://bookmarks/*' }))[0]);
    const w = mgr.windowId;
    const tabId = mgr.id;
    // Work 文件夹内容：Docs(文件夹)、W1、W2、W3、Redirect、Dup-old
    const items = await page.$$('bookmarks-app >>> bookmarks-list >>> bookmarks-item');
    check(items.length >= 4, '书签管理器应列出 Work 文件夹内容', items.length);
    // 双击 W1（第 2 项）：在新标签打开
    await items[1].click({ count: 2 });
    let s = await waitFor(w, (s) => s.tabs.some((t) => /\/work1$/.test(t.url) && t.groupId !== -1), 8000);
    const g1 = groupOf(s, s.tabs.find((t) => /\/work1$/.test(t.url))?.id);
    check(g1?.title === 'Work', '双击 W1 -> Work 组', { g1, tabs: s.tabs });
    // 选中 W2 + W3 后 Cmd/Ctrl+Enter 一次打开多个（双击打开的新标签会抢到前台，先把管理器切回来）
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.bringToFront();
    await sleep(300);
    const items2 = await page.$$('bookmarks-app >>> bookmarks-list >>> bookmarks-item');
    await items2[2].click();
    await page.keyboard.down('Shift');
    await items2[3].click();
    await page.keyboard.up('Shift');
    await page.keyboard.down(mod);
    await page.keyboard.press('Enter');
    await page.keyboard.up(mod);
    s = await waitFor(
      w,
      (s) => ['work2', 'work3'].every((n) => s.tabs.some((t) => t.url.endsWith('/' + n) && t.groupId !== -1)),
      8000,
    );
    const g2 = groupOf(s, s.tabs.find((t) => /\/work2$/.test(t.url))?.id);
    const g3 = groupOf(s, s.tabs.find((t) => /\/work3$/.test(t.url))?.id);
    check(g2?.id === g1?.id && g3?.id === g1?.id, 'W2、W3 应加入同一个 Work 组', { g1, g2, g3, groups: s.groups });
    check(s.groups.length === 1, '只应有 1 个组', s.groups);
    check(!groupOf(s, tabId), '书签管理器标签本身不应被分组');
    // 清理：关闭本场景打开的标签
    await ev(async (keep) => {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((t) => /\/work[123]$/.test(t.url) || t.url.startsWith('chrome://bookmarks')).map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
      void keep;
    }, tabId);
  });

  await scenario('文档规则：不同文件夹（含根目录）的飞书文档 / 表格 / 多维表格 / 知识库 / 幻灯片 -> 同一个「文档」组', async () => {
    const w = await newWindow();
    const names = ['workDoc', 'personalSheet', 'rootBase', 'wiki', 'slides'];
    const tabs = [];
    for (const n of names) tabs.push(await openBookmark(w, U[n]));
    const s = await waitFor(w, (s) => tabs.every((t) => groupOf(s, t.tabId)));
    const gs = tabs.map((t) => groupOf(s, t.tabId));
    check(gs.every((g) => g?.title === '文档'), '全部应在「文档」组', gs);
    check(new Set(gs.map((g) => g?.id)).size === 1, '应是同一个组', gs);
    check(s.groups.length === 1, '窗口内只应有「文档」一个组（不再按文件夹建组）', s.groups);
    check(gs[0]?.color === 'blue', '文档组颜色固定为蓝色', gs[0]);
    await closeWindow(w);
  });

  await scenario('文档规则：与文件夹组共存；非文档链接（妙记）仍按文件夹分组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.w1); // Work 普通网页
    const b = await openBookmark(w, U.workDoc); // Work 下的飞书文档
    const c = await openBookmark(w, U.minutes); // Work 下的妙记
    const s = await waitFor(w, (s) => [a, b, c].every((t) => groupOf(s, t.tabId)));
    check(groupOf(s, a.tabId)?.title === 'Work', '普通网页 -> Work', groupOf(s, a.tabId));
    check(groupOf(s, b.tabId)?.title === '文档', '飞书文档 -> 文档', groupOf(s, b.tabId));
    check(groupOf(s, c.tabId)?.id === groupOf(s, a.tabId)?.id, '妙记不算文档 -> Work', groupOf(s, c.tabId));
    await closeWindow(w);
  });

  await scenario('文档规则：文档跳转到登录页后仍归入「文档」组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.redirDoc);
    const s = await waitFor(w, (s) => groupOf(s, a.tabId));
    const tab = s.tabs.find((t) => t.id === a.tabId);
    check(tab?.url.includes('/accounts/page/login'), '应已跳转到登录页', tab);
    check(groupOf(s, a.tabId)?.title === '文档', '仍归入「文档」组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('文档规则：自定义组名（已有组同步改名）/ 关闭后回到按文件夹分组', async () => {
    const w = await newWindow();
    const a = await openBookmark(w, U.workDoc);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await setSettings({ docGroupTitle: '飞书云文档' });
    let s = await waitFor(w, (s) => groupOf(s, a.tabId)?.title === '飞书云文档');
    check(groupOf(s, a.tabId)?.title === '飞书云文档', '已有的文档组应同步改名', groupOf(s, a.tabId));
    const b = await openBookmark(w, U.personalSheet);
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, b.tabId)?.id === groupOf(s, a.tabId)?.id, '新打开的文档加入改名后的组', s.groups);
    await setSettings({ docGroupEnabled: false });
    const c = await openBookmark(w, U.wiki);
    s = await waitFor(w, (s) => groupOf(s, c.tabId));
    check(groupOf(s, c.tabId)?.title === 'Docs', '关闭后按文件夹（Work/Docs）分组', groupOf(s, c.tabId));
    await closeWindow(w);
  });

  await scenario('文档规则：书签管理器打开飞书文档 -> 「文档」组', async () => {
    const page = await browser.newPage();
    await page.goto(`chrome://bookmarks/?id=${B.ids.personal}`, { waitUntil: 'load' });
    await page.bringToFront();
    await sleep(600);
    const mgr = await ev(async () => (await chrome.tabs.query({ url: 'chrome://bookmarks/*' }))[0]);
    const items = await page.$$('bookmarks-app >>> bookmarks-list >>> bookmarks-item');
    const titles = await Promise.all(
      items.map((it) => it.evaluate((el) => el.shadowRoot?.querySelector('#website-title')?.textContent?.trim())),
    );
    const idx = titles.indexOf('Personal Sheet');
    check(idx >= 0, '应在书签管理器中找到 Personal Sheet', titles);
    if (idx >= 0) {
      await items[idx].click({ count: 2 });
      const s = await waitFor(mgr.windowId, (s) => s.tabs.some((t) => t.url.includes('/sheets/') && t.groupId !== -1), 8000);
      const t = s.tabs.find((t) => t.url.includes('/sheets/'));
      check(groupOf(s, t?.id)?.title === '文档', '应进入「文档」组', { g: groupOf(s, t?.id), tabs: s.tabs });
    }
    await ev(async () => {
      const tabs = await chrome.tabs.query({});
      const ids = tabs.filter((t) => t.url.includes('/sheets/') || t.url.startsWith('chrome://bookmarks')).map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
    });
  });

  // ---------- 非书签打开的飞书文档 ----------
  const FS = 'https://bytedance.feishu.cn';
  const findTab = (s, re) => s.tabs.find((t) => re.test(t.url));

  await scenario('非书签：网页里点飞书文档链接（同标签 / 新标签）-> 「文档」组；妙记链接不归组', async () => {
    const w = await newWindow();
    const a = await newTab(w);
    await navigate(a.page, `${BASE}/hub`, 'typed');
    await Promise.all([a.page.waitForNavigation({ timeout: 10000 }), a.page.click('#doc')]);
    let s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === '文档', '同标签点开的文档 -> 文档组', { g: groupOf(s, a.tabId), tabs: s.tabs });
    const b = await newTab(w);
    await navigate(b.page, `${BASE}/hub`, 'typed');
    await b.page.click('#docnew');
    s = await waitFor(w, (s) => {
      const t = findTab(s, /shtcnNew/);
      return t && t.groupId !== -1;
    });
    const nt = findTab(s, /shtcnNew/);
    check(groupOf(s, nt?.id)?.id === groupOf(s, a.tabId)?.id, '新标签打开的表格 -> 同一个文档组', { nt, groups: s.groups });
    const c = await newTab(w);
    await navigate(c.page, `${BASE}/hub`, 'typed');
    await Promise.all([c.page.waitForNavigation({ timeout: 10000 }), c.page.click('#min')]);
    await sleep(800);
    s = await state(w);
    check(!groupOf(s, c.tabId), '妙记链接不归组', groupOf(s, c.tabId));
    check(!groupOf(s, b.tabId), '放链接的 hub 页本身不归组', groupOf(s, b.tabId));
    await closeWindow(w);
  });

  await scenario('非书签：地址栏输入 / 飞书站内切换（pushState）/ 登录后 JS 跳回文档 -> 「文档」组', async () => {
    const w = await newWindow();
    const a = await newTab(w);
    await navigate(a.page, `${FS}/wiki/wikcnTyped`, 'typed');
    let s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === '文档', '地址栏输入 -> 文档组', groupOf(s, a.tabId));

    const b = await newTab(w);
    await navigate(b.page, `${FS}/next/messenger`, 'typed');
    await sleep(500);
    s = await state(w);
    check(!groupOf(s, b.tabId), '飞书消息页（非文档）不归组', groupOf(s, b.tabId));
    await b.page.click('#spa');
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, b.tabId)?.id === groupOf(s, a.tabId)?.id, '站内 pushState 切到文档 -> 文档组', {
      g: groupOf(s, b.tabId),
      url: findTab(s, /doxcnSpa/)?.url,
    });

    const c = await newTab(w);
    const next = encodeURIComponent(`${FS}/docx/doxcnSso`);
    const done = c.page.waitForFunction(() => location.pathname.startsWith('/docx/'), { timeout: 10000 });
    await navigate(c.page, `${FS}/accounts/sso?next=${next}`, 'typed');
    await done;
    s = await waitFor(w, (s) => groupOf(s, c.tabId));
    check(groupOf(s, c.tabId)?.title === '文档', '登录页 JS 跳回文档 -> 文档组', { g: groupOf(s, c.tabId), tabs: s.tabs });
    await closeWindow(w);
  });

  await scenario('非书签：手动移出组后不再自动拉回；新开的文档标签不受影响', async () => {
    const w = await newWindow();
    const a = await newTab(w);
    await navigate(a.page, `${FS}/docx/doxcnD1`, 'typed');
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await ev((id) => chrome.tabs.ungroup(id), a.tabId); // 用户手动移出
    await navigate(a.page, `${FS}/docx/doxcnD2`, 'link'); // 同一标签继续打开别的文档
    await sleep(800);
    let s = await state(w);
    check(!groupOf(s, a.tabId), '被手动移出的标签不应再被自动归组', groupOf(s, a.tabId));
    const b = await newTab(w);
    await navigate(b.page, `${FS}/docx/doxcnD3`, 'typed');
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, b.tabId)?.title === '文档', '新开的文档标签照常归组', groupOf(s, b.tabId));
    // 书签打开不受“手动移出”影响（书签是明确意图）
    await navigate(a.page, U.workDoc);
    s = await waitFor(w, (s) => groupOf(s, a.tabId));
    check(groupOf(s, a.tabId)?.title === '文档', '从书签打开时照常归组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('非书签：文档在用户自建组里 -> 不移动', async () => {
    const w = await newWindow();
    const a = await newTab(w);
    const mine = await ev(async (tabId) => {
      const id = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(id, { title: '我的项目' });
      return id;
    }, a.tabId);
    await navigate(a.page, `${FS}/sheets/shtcnMine`, 'typed');
    await sleep(800);
    const s = await state(w);
    check(groupOf(s, a.tabId)?.id === mine, '应留在用户的「我的项目」组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('生效范围=仅书签：非书签文档不归组，书签文档照常；改回后刷新也不打乱已有标签', async () => {
    const w = await newWindow();
    await setSettings({ docGroupScope: 'bookmark' });
    const a = await newTab(w);
    await navigate(a.page, `${FS}/docx/doxcnScope`, 'typed');
    await sleep(800);
    let s = await state(w);
    check(!groupOf(s, a.tabId), '仅书签：地址栏打开的文档不归组', groupOf(s, a.tabId));
    const b = await openBookmark(w, U.personalSheet);
    s = await waitFor(w, (s) => groupOf(s, b.tabId));
    check(groupOf(s, b.tabId)?.title === '文档', '仅书签：书签打开的文档照常归组', groupOf(s, b.tabId));
    await setSettings({ docGroupScope: 'any' });
    await a.page.reload({ waitUntil: 'load' });
    await sleep(800);
    s = await state(w);
    check(!groupOf(s, a.tabId), '刷新不触发自动归组', groupOf(s, a.tabId));
    await closeWindow(w);
  });

  await scenario('弹窗「立即整理」：已打开的未分组文档标签归入「文档」组，普通网页和用户组不动', async () => {
    const w = await newWindow();
    await setSettings({ docGroupScope: 'bookmark' }); // 先让它们保持未分组
    const d1 = await newTab(w);
    await navigate(d1.page, `${FS}/docx/doxcnSw1`, 'typed');
    const d2 = await newTab(w);
    await navigate(d2.page, `${FS}/base/bascnSw2`, 'typed');
    const n = await newTab(w);
    await navigate(n.page, `${BASE}/plain`, 'typed');
    const u = await newTab(w);
    await navigate(u.page, `${FS}/docx/doxcnSw3`, 'typed');
    const mine = await ev(async (tabId) => {
      const id = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(id, { title: 'Mine' });
      return id;
    }, u.tabId);
    await sleep(500);
    const extId = new URL(sw.url()).host;
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await popup.click('#sweepDocs');
    await popup.waitForFunction(() => /已整理/.test(document.getElementById('status').textContent), { timeout: 5000 });
    const status = await popup.$eval('#status', (e) => e.textContent);
    await popup.close();
    const s = await waitFor(w, (s) => groupOf(s, d1.tabId) && groupOf(s, d2.tabId));
    check(/已整理 2 个/.test(status), '弹窗提示整理了 2 个', status);
    check(groupOf(s, d1.tabId)?.title === '文档' && groupOf(s, d1.tabId)?.id === groupOf(s, d2.tabId)?.id, 'd1、d2 进入同一文档组', s.groups);
    check(!groupOf(s, n.tabId), '普通网页不动', groupOf(s, n.tabId));
    check(groupOf(s, u.tabId)?.id === mine, '用户组里的文档不动', groupOf(s, u.tabId));
    await closeWindow(w);
  });

  await scenario('防误判：书签网址通过普通链接打开（dateLastUsed 未更新）-> 不分组', async () => {
    const w = await newWindow();
    // 先通过书签打开一次，让 dateLastUsed 有值
    const a = await openBookmark(w, U.w3);
    await waitFor(w, (s) => groupOf(s, a.tabId));
    await sleep(3500); // 超过容忍窗口
    // 再在新标签中以普通链接方式打开同一网址
    const b = await newTab(w);
    await navigate(b.page, U.w3, 'link');
    await sleep(800);
    const s = await state(w);
    check(!groupOf(s, b.tabId), '普通链接打开书签网址不应分组', groupOf(s, b.tabId));
    await closeWindow(w);
  });
} finally {
  await browser.close().catch(() => {});
  server.close();
  docServer.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(certDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 个场景，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);

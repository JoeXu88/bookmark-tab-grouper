import {
  DEFAULT_SETTINGS,
  DOC_GROUP_ID,
  ROOT_NODE_ID,
  buildCandidateUrls,
  colorForTarget,
  docGroupTarget,
  isActiveMainFrame,
  isAutoDocCandidate,
  isBookmarkOpen,
  isDocUrl,
  looseUrlKey,
  mapKey,
  mayBeBookmarkOpen,
  normalizeSettings,
  pickBookmark,
  resolveAutoDocTarget,
  resolveDocTarget,
  resolveGroupTarget,
  shortUrlLabel,
  titleForChain,
  usedDuringNavigation,
} from './lib/core.js';

const PENDING_TTL_MS = 60_000;
const LOG_LIMIT = 30;

// ---------- 串行队列：避免并发打开多个书签时重复建组 ----------
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task).catch((e) => console.warn('[BTG]', e));
  queue = run;
  return run;
}

// ---------- 设置 ----------
let settingsCache = null;
async function getSettings() {
  if (!settingsCache) {
    const stored = await chrome.storage.sync.get('settings');
    settingsCache = normalizeSettings(stored.settings);
  }
  return settingsCache;
}

// ---------- 会话状态（storage.session：service worker 休眠后仍保留，浏览器重启清空） ----------
async function getGroupMap() {
  const { groupMap } = await chrome.storage.session.get('groupMap');
  return groupMap || {};
}
async function setGroupMap(map) {
  await chrome.storage.session.set({ groupMap: map });
}

async function addLog(entry) {
  const { logs = [] } = await chrome.storage.session.get('logs');
  logs.unshift({ time: Date.now(), ...entry });
  await chrome.storage.session.set({ logs: logs.slice(0, LOG_LIMIT) });
}

// ---------- 书签查询 ----------
let looseIndex = null; // Map<looseKey, BookmarkTreeNode[]>
function invalidateBookmarkCache() {
  looseIndex = null;
}

async function getLooseIndex() {
  if (looseIndex) return looseIndex;
  const index = new Map();
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.url) {
        const key = looseUrlKey(n.url);
        if (key) {
          if (!index.has(key)) index.set(key, []);
          index.get(key).push(n);
        }
      }
      if (n.children) walk(n.children);
    }
  };
  walk(await chrome.bookmarks.getTree());
  looseIndex = index;
  return index;
}

async function findBookmark(candidates) {
  // 1) 精确匹配
  for (const url of candidates) {
    const hit = pickBookmark(await searchExact(url));
    if (hit) return hit;
  }
  // 2) 宽松匹配：忽略协议、www.、hash、末尾斜杠
  const index = await getLooseIndex();
  for (const url of candidates) {
    const key = looseUrlKey(url);
    const hit = key && pickBookmark(index.get(key));
    if (hit) return hit;
  }
  return null;
}

async function searchExact(url) {
  try {
    return await chrome.bookmarks.search({ url });
  } catch {
    return []; // 非法 URL（如部分内部页面）会抛错，忽略
  }
}

/**
 * 从书签管理器 / 侧边栏等入口打开时 transitionType 为 link，
 * 此时只认“网址精确命中书签且该书签的 dateLastUsed 在本次导航期间被更新”的情况，避免误判普通链接。
 */
async function findRecentlyUsedBookmark(candidates, navStartedAt) {
  const now = Date.now();
  for (const url of candidates) {
    const nodes = (await searchExact(url)).filter((n) => usedDuringNavigation(n, navStartedAt, now));
    const hit = pickBookmark(nodes);
    if (hit) return hit;
  }
  return null;
}

/** 返回 [id 对应节点, 父, 祖父, ..., 根文件夹]（不含 id 为 '0' 的虚拟根） */
async function getAncestors(folderId) {
  const chain = [];
  let id = folderId;
  for (let i = 0; id && id !== ROOT_NODE_ID && i < 64; i++) {
    const [node] = await chrome.bookmarks.get(id);
    if (!node) break;
    chain.push(node);
    id = node.parentId;
  }
  return chain;
}

// ---------- 标签组 ----------
async function getGroup(groupId) {
  try {
    return await chrome.tabGroups.get(groupId);
  } catch {
    return null;
  }
}

/** Chrome 在用户拖拽标签时会拒绝编辑，短暂重试 */
async function withRetry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message || e);
      if (i >= tries - 1 || !/cannot be edited right now|dragging/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

/** 找到 (窗口, 文件夹) 对应的标签组：先用会话映射，再按同名组接管 */
async function findGroupFor(windowId, target, map) {
  const key = mapKey(windowId, target.folderId);
  const entry = map[key];
  if (entry) {
    const g = await getGroup(entry.groupId);
    if (g && g.windowId === windowId) return g.id;
    delete map[key];
  }
  const usedByOthers = new Set(
    Object.entries(map)
      .filter(([k]) => k !== key)
      .map(([, v]) => v.groupId),
  );
  // tabGroups.query 的 title 是模式匹配（* ? 等有特殊含义），这里手动做精确比较
  const sameTitle = (await chrome.tabGroups.query({ windowId })).filter((g) => g.title === target.title);
  const adopt = sameTitle.find((g) => !usedByOthers.has(g.id));
  if (adopt) {
    map[key] = { groupId: adopt.id, folderId: target.folderId, windowId, title: target.title };
    return adopt.id;
  }
  return null;
}

function isOwnedGroup(map, groupId) {
  return Object.values(map).some((v) => v.groupId === groupId);
}

// ---------- 由本扩展放进组的标签：tabId -> groupId（用于识别用户手动移出） ----------
async function getPlacedTabs() {
  const { placedTabs } = await chrome.storage.session.get('placedTabs');
  return placedTabs || {};
}
async function setPlacedTabs(placed) {
  await chrome.storage.session.set({ placedTabs: placed });
}

/** 取标签并检查是否可分组（固定标签、弹出窗口等跳过） */
async function getGroupableTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { skip: 'tab-gone' };
  }
  if (tab.pinned) return { skip: 'skip-pinned' };
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win || win.type !== 'normal') return { skip: 'skip-window-type' };
  return { tab };
}

/** 把标签放进目标组（已有则加入，没有则新建），并更新会话映射 */
async function moveToTarget(tab, target, groupId, settings, map) {
  if (groupId != null) {
    await withRetry(() => chrome.tabs.group({ tabIds: tab.id, groupId }));
    if (tab.active) await chrome.tabGroups.update(groupId, { collapsed: false }).catch(() => {});
    return { action: 'joined', groupId };
  }
  const newId = await withRetry(() =>
    chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } }),
  );
  const props = { title: target.title };
  if (target.color || settings.colorByFolder) props.color = colorForTarget(target);
  await chrome.tabGroups.update(newId, props);
  map[mapKey(tab.windowId, target.folderId)] = {
    groupId: newId,
    folderId: target.folderId,
    windowId: tab.windowId,
    title: target.title,
  };
  return { action: 'created', groupId: newId };
}

// ---------- 核心流程 ----------
/**
 * 书签打开的标签：按文档规则或书签文件夹归组。
 * @param {number} tabId
 * @param {string[]} candidates 候选网址
 * @param {{ via?: 'transition' | 'recent-use', navStartedAt?: number }} opts
 */
async function processBookmarkNavigation(tabId, candidates, opts = {}) {
  const settings = await getSettings();
  if (!settings.enabled) return { action: 'disabled' };

  const via = opts.via || 'transition';
  const bookmark =
    via === 'recent-use'
      ? await findRecentlyUsedBookmark(candidates, opts.navStartedAt)
      : await findBookmark(candidates);
  // 不是书签：再看是不是飞书文档（非书签打开也归入“文档”组）
  if (!bookmark) return processAutoDocNavigation(tabId, candidates);

  // 规则优先：飞书文档 / 表格 / 多维表格等统一归入“文档”组（书签原地址或实际地址任一命中即可）
  const target =
    resolveDocTarget([bookmark.url, ...candidates], settings) ||
    resolveGroupTarget(await getAncestors(bookmark.parentId), settings);
  if (!target) {
    await addLog({ action: 'skip-root', group: null, bookmark: bookmark.title, via });
    return { action: 'skip-root', bookmark: bookmark.title };
  }

  const { tab, skip } = await getGroupableTab(tabId);
  if (skip) return { action: skip };

  const map = await getGroupMap();
  const groupId = await findGroupFor(tab.windowId, target, map);

  let result;
  if (groupId != null && tab.groupId === groupId) {
    result = { action: 'already-in-group', groupId };
  } else if (tab.groupId !== -1 && !settings.moveFromOtherGroups && !isOwnedGroup(map, tab.groupId)) {
    result = { action: 'skip-user-group', groupId: tab.groupId };
  } else {
    result = await moveToTarget(tab, target, groupId, settings, map);
  }
  await setGroupMap(map);
  if (result.action !== 'skip-user-group') {
    const placed = await getPlacedTabs();
    placed[tabId] = result.groupId;
    await setPlacedTabs(placed);
  }
  await addLog({ action: result.action, group: target.title, bookmark: bookmark.title, via, kind: target.kind });
  return { ...result, title: target.title, folderId: target.folderId, via, kind: target.kind || 'folder' };
}

/**
 * 非书签打开的飞书文档（点链接、地址栏、飞书客户端跳转、飞书内页面切换等）自动归入“文档”组。
 * 比书签路径更克制：
 *  - 不把标签从用户自己建的组里移走；
 *  - 用户把某个标签从组里移出 / 取消分组后，这个标签以后不再自动归组（新开的标签不受影响）。
 */
async function processAutoDocNavigation(tabId, urls) {
  const settings = await getSettings();
  if (!settings.enabled) return { action: 'disabled' };
  const target = resolveAutoDocTarget(urls, settings);
  if (!target) return { action: 'not-doc' };

  const { tab, skip } = await getGroupableTab(tabId);
  if (skip) return { action: skip };

  const map = await getGroupMap();
  const groupId = await findGroupFor(tab.windowId, target, map);
  if (groupId != null && tab.groupId === groupId) {
    await setGroupMap(map);
    return { action: 'already-in-group', groupId };
  }
  const placed = await getPlacedTabs();
  if (tabId in placed && tab.groupId !== placed[tabId]) {
    return { action: 'skip-dismissed' }; // 曾被本扩展放进组，现在不在那个组了 → 用户手动移走的
  }
  if (tab.groupId !== -1 && !isOwnedGroup(map, tab.groupId)) {
    return { action: 'skip-user-group', groupId: tab.groupId };
  }
  const result = await moveToTarget(tab, target, groupId, settings, map);
  await setGroupMap(map);
  placed[tabId] = result.groupId;
  await setPlacedTabs(placed);
  const url = urls[urls.length - 1];
  await addLog({ action: result.action, group: target.title, bookmark: shortUrlLabel(url), via: 'auto', kind: 'docs' });
  return { ...result, title: target.title, folderId: target.folderId, via: 'auto', kind: 'docs' };
}

/** 手动整理：把所有窗口中未分组（或在本扩展文件夹组中）的飞书文档标签归入“文档”组 */
async function sweepDocTabs() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.docGroupEnabled) return { grouped: 0, reason: 'disabled' };
  const target = docGroupTarget(settings);
  const map = await getGroupMap();
  const placed = await getPlacedTabs();
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const byWindow = new Map();
  for (const t of tabs) {
    if (t.pinned || !isDocUrl(t.url || t.pendingUrl)) continue;
    if (t.groupId !== -1 && !isOwnedGroup(map, t.groupId)) continue; // 用户自己的组不动
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(t);
  }
  let grouped = 0;
  for (const [windowId, list] of byWindow) {
    let groupId = await findGroupFor(windowId, target, map);
    const ids = list.filter((t) => t.groupId !== groupId || groupId == null).map((t) => t.id);
    if (!ids.length) continue;
    if (groupId == null) {
      groupId = await withRetry(() => chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }));
      await chrome.tabGroups.update(groupId, { title: target.title, color: colorForTarget(target) });
      map[mapKey(windowId, target.folderId)] = { groupId, folderId: target.folderId, windowId, title: target.title };
    } else {
      await withRetry(() => chrome.tabs.group({ tabIds: ids, groupId }));
    }
    for (const id of ids) placed[id] = groupId;
    grouped += ids.length;
  }
  await setGroupMap(map);
  await setPlacedTabs(placed);
  if (grouped) await addLog({ action: 'swept', group: target.title, bookmark: `${grouped} 个标签`, via: 'sweep', kind: 'docs' });
  return { grouped };
}

/** 书签文件夹改名/移动或设置变化后，同步标签组标题（仅限用户未手动改过的组） */
async function syncGroupTitles() {
  const settings = await getSettings();
  const map = await getGroupMap();
  let changed = false;
  for (const [key, entry] of Object.entries(map)) {
    const g = await getGroup(entry.groupId);
    if (!g) {
      delete map[key];
      changed = true;
      continue;
    }
    let title;
    if (entry.folderId === DOC_GROUP_ID) {
      title = settings.docGroupTitle; // 文档组：跟随设置里的组名
    } else {
      if (!settings.syncTitleOnRename) continue;
      let chain;
      try {
        chain = await getAncestors(entry.folderId);
      } catch {
        continue; // 文件夹已删除：保留组，不再同步
      }
      if (!chain.length) continue;
      title = titleForChain(chain, settings.titleStyle);
    }
    if (title !== entry.title && g.title === entry.title) {
      await chrome.tabGroups.update(g.id, { title }).catch(() => {});
      entry.title = title;
      changed = true;
    }
  }
  if (changed) await setGroupMap(map);
}

// ---------- 事件监听（必须在顶层同步注册） ----------
const pendingNav = new Map(); // tabId -> { urls: string[], at: number, startedAt: number }

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (!isActiveMainFrame(d)) return;
  const prev = pendingNav.get(d.tabId);
  const fresh = prev && Date.now() - prev.at < PENDING_TTL_MS;
  const urls = fresh ? prev.urls : [];
  urls.push(d.url);
  pendingNav.set(d.tabId, { urls, at: Date.now(), startedAt: fresh ? prev.startedAt : Date.now() });
});

chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (isActiveMainFrame(d)) pendingNav.delete(d.tabId);
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (!isActiveMainFrame(d)) return;
  const pending = pendingNav.get(d.tabId);
  pendingNav.delete(d.tabId);
  const fresh = pending && Date.now() - pending.at < PENDING_TTL_MS;
  const candidates = buildCandidateUrls(fresh ? pending.urls : [], d.url);
  if (isBookmarkOpen(d)) {
    enqueue(() => processBookmarkNavigation(d.tabId, candidates, { via: 'transition' }));
  } else if (mayBeBookmarkOpen(d)) {
    // 先按书签管理器路径识别；不是书签时内部会回落到文档自动归组
    enqueue(() =>
      processBookmarkNavigation(d.tabId, candidates, {
        via: 'recent-use',
        navStartedAt: fresh ? pending.startedAt : undefined,
      }),
    );
  } else if (isAutoDocCandidate(d) && candidates.some(isDocUrl)) {
    // 登录后跳回文档（client_redirect）、表单提交后跳转等
    enqueue(() => processAutoDocNavigation(d.tabId, candidates));
  }
});

// 飞书网页是单页应用：站内切换到文档时不触发 onCommitted，只触发 onHistoryStateUpdated
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (!isActiveMainFrame(d) || !isAutoDocCandidate(d) || !isDocUrl(d.url)) return;
  enqueue(() => processAutoDocNavigation(d.tabId, [d.url]));
});

chrome.webNavigation.onTabReplaced.addListener(({ replacedTabId, tabId }) => {
  const p = pendingNav.get(replacedTabId);
  if (p) {
    pendingNav.delete(replacedTabId);
    pendingNav.set(tabId, p);
  }
  enqueue(async () => {
    const placed = await getPlacedTabs();
    if (replacedTabId in placed) {
      placed[tabId] = placed[replacedTabId];
      delete placed[replacedTabId];
      await setPlacedTabs(placed);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingNav.delete(tabId);
  enqueue(async () => {
    const placed = await getPlacedTabs();
    if (tabId in placed) {
      delete placed[tabId];
      await setPlacedTabs(placed);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'sweepDocTabs') {
    enqueue(sweepDocTabs).then((r) => sendResponse(r || { grouped: 0, reason: 'error' }));
    return true; // 异步响应
  }
  return false;
});

chrome.tabGroups.onRemoved.addListener((group) =>
  enqueue(async () => {
    const map = await getGroupMap();
    let changed = false;
    for (const [k, v] of Object.entries(map)) {
      if (v.groupId === group.id) {
        delete map[k];
        changed = true;
      }
    }
    if (changed) await setGroupMap(map);
  }),
);

chrome.windows.onRemoved.addListener((windowId) =>
  enqueue(async () => {
    const map = await getGroupMap();
    for (const [k, v] of Object.entries(map)) if (v.windowId === windowId) delete map[k];
    await setGroupMap(map);
  }),
);

for (const ev of [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onImportEnded,
]) {
  ev.addListener(invalidateBookmarkCache);
}
chrome.bookmarks.onChanged.addListener(() => enqueue(syncGroupTitles));
chrome.bookmarks.onMoved.addListener(() => enqueue(syncGroupTitles));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    settingsCache = normalizeSettings(changes.settings.newValue);
    enqueue(syncGroupTitles);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS } });
});

// 供调试/测试使用（在 service worker 控制台可调用）
globalThis.__btg = {
  processBookmarkNavigation,
  processAutoDocNavigation,
  sweepDocTabs,
  syncGroupTitles,
  getGroupMap,
  getPlacedTabs,
  getSettings,
  idle: () => queue,
};

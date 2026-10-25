// 纯逻辑函数：不依赖 chrome.* API，便于单元测试。

export const ROOT_NODE_ID = '0';

// 不含 grey，避免与 Chrome 默认灰色混淆
export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const UNTITLED_FOLDER = '未命名文件夹';

export const DEFAULT_DOC_GROUP_TITLE = '文档';
export const DOC_GROUP_ID = '__docs__'; // 文档组在会话映射里的虚拟“文件夹 id”
export const DOC_GROUP_COLOR = 'blue';
const MAX_TITLE_LEN = 40;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  groupBy: 'parent', // 'parent' 直接所在文件夹 | 'top' 顶层文件夹
  titleStyle: 'name', // 'name' 文件夹名 | 'path' 完整路径
  rootBookmarks: 'skip', // 书签栏/其他书签根目录下的书签：'skip' 不分组 | 'group' 按根目录分组
  moveFromOtherGroups: true, // 标签页已在其他（非本扩展创建的）标签组时，是否移动
  colorByFolder: true, // 按文件夹固定颜色
  syncTitleOnRename: true, // 书签文件夹改名/移动后同步更新标签组名
  docGroupEnabled: true, // 飞书文档 / 表格 / 多维表格等统一归入一个组（优先于按文件夹分组）
  docGroupTitle: DEFAULT_DOC_GROUP_TITLE, // 该组的名字
  docGroupScope: 'any', // 'any' 任何方式打开的飞书文档都归组 | 'bookmark' 仅从书签打开时归组
  restoreOnHistoryNav: true, // 前进 / 后退时，把标签放回该页面当时所在的组
});

const ENUMS = {
  groupBy: ['parent', 'top'],
  titleStyle: ['name', 'path'],
  rootBookmarks: ['skip', 'group'],
  docGroupScope: ['any', 'bookmark'],
};

/** 合并并校验设置，非法值回退到默认值 */
export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!(key in raw)) continue;
    const def = DEFAULT_SETTINGS[key];
    const val = raw[key];
    if (typeof def === 'boolean') {
      if (typeof val === 'boolean') out[key] = val;
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(val)) out[key] = val;
    } else if (typeof def === 'string' && typeof val === 'string') {
      const s = val.trim().slice(0, MAX_TITLE_LEN);
      if (s) out[key] = s;
    }
  }
  return out;
}

// ---------- 飞书 / Lark 云文档识别 ----------
// 域名：feishu.cn、larkoffice.com、larksuite.com 及其子域（如 bytedance.feishu.cn、xxx.larkoffice.com）
export const DOC_DOMAINS = ['feishu.cn', 'feishu.net', 'larkoffice.com', 'larksuite.com'];
// 路径第一段：文档、旧版文档、知识库、电子表格、多维表格、幻灯片、思维笔记、云盘文件/文件夹、画板
const DOC_PATH_PREFIXES = new Set([
  'docx',
  'doc',
  'docs',
  'wiki',
  'sheets',
  'sheet',
  'base',
  'bitable',
  'slides',
  'mindnote',
  'mindnotes',
  'file',
  'drive',
  'board',
]);
// 这些前缀后面再跟一段文档类型，如 /share/base/form/xxx（多维表格表单分享）、/space/doc/xxx（旧版）
const DOC_WRAPPER_PREFIXES = new Set(['share', 'space']);

/** 是否为飞书 / Lark 云文档类网址（不含飞书官网、开放平台、妙记、日历等非文档页面） */
export function isDocUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (!DOC_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  const seg = u.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
  if (!seg.length) return false;
  if (DOC_PATH_PREFIXES.has(seg[0])) return true;
  return DOC_WRAPPER_PREFIXES.has(seg[0]) && DOC_PATH_PREFIXES.has(seg[1]);
}

/** “文档”组的分组目标 */
export function docGroupTarget(settings) {
  const s = normalizeSettings(settings);
  return { folderId: DOC_GROUP_ID, title: s.docGroupTitle, color: DOC_GROUP_COLOR, kind: 'docs' };
}

/** 若命中文档规则，返回“文档”组目标；否则 null。urls 中任一命中即可（书签原地址、跳转前后地址） */
export function resolveDocTarget(urls, settings) {
  const s = normalizeSettings(settings);
  if (!s.docGroupEnabled) return null;
  if (!(urls || []).some(isDocUrl)) return null;
  return docGroupTarget(s);
}

/** 非书签打开（点链接、地址栏、飞书客户端跳转、飞书内页面切换等）时，是否按文档规则自动归组 */
export function resolveAutoDocTarget(urls, settings) {
  const s = normalizeSettings(settings);
  if (s.docGroupScope !== 'any') return null;
  return resolveDocTarget(urls, s);
}

// 刷新（含浏览器重启恢复标签）、前进/后退、子框架导航不触发自动归组，避免打乱用户已有布局
const AUTO_DOC_EXCLUDED_TRANSITIONS = new Set(['reload', 'auto_subframe', 'manual_subframe']);

/** 该导航（onCommitted / onHistoryStateUpdated）是否需要检查文档自动归组 */
export function isAutoDocCandidate(d) {
  if (!d || AUTO_DOC_EXCLUDED_TRANSITIONS.has(d.transitionType)) return false;
  if ((d.transitionQualifiers || []).includes('forward_back')) return false;
  return /^https?:/.test(d.url || '');
}

/** 用于记录展示的简短网址：主机名 + 路径前两段 */
export function shortUrlLabel(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    const s = `${u.hostname}/${seg}`;
    return s.length > 60 ? `${s.slice(0, 57)}...` : s;
  } catch {
    return String(url || '').slice(0, 60);
  }
}

/** 是否为当前可见页面的主框架导航（排除 iframe、预渲染中的页面；预渲染被激活时 lifecycle 为 active，会被接受） */
export function isActiveMainFrame(d) {
  if (!d) return false;
  if (d.documentLifecycle && d.documentLifecycle !== 'active') return false;
  if (d.frameType) return d.frameType === 'outermost_frame';
  return d.frameId === 0;
}

/** 是否为“从书签打开”的导航；前进/后退回到书签页不算 */
export function isBookmarkOpen(d) {
  if (!d || d.transitionType !== 'auto_bookmark') return false;
  const q = d.transitionQualifiers || [];
  return !q.includes('forward_back');
}

// 书签管理器（chrome://bookmarks）、侧边栏等入口打开书签时，transitionType 是 "link" 而不是 "auto_bookmark"，
// 但 Chrome 会在导航开始时更新该书签的 dateLastUsed。用它作为第二个识别信号。
const NON_BOOKMARK_TRANSITIONS = new Set(['auto_bookmark', 'reload', 'auto_subframe', 'manual_subframe', 'form_submit']);

/** 非 auto_bookmark 的导航，是否值得再用 dateLastUsed 检查一次 */
export function mayBeBookmarkOpen(d) {
  if (!d || NON_BOOKMARK_TRANSITIONS.has(d.transitionType)) return false;
  const q = d.transitionQualifiers || [];
  if (q.includes('forward_back') || q.includes('client_redirect')) return false;
  return /^https?:|^file:|^ftp:/.test(d.url || '');
}

export const RECENT_USE_SLACK_MS = 3000; // SW 唤醒延迟、时钟误差容忍
export const RECENT_USE_FALLBACK_MS = 30000; // 未记录到导航开始时间时的回看窗口

/** 书签的 dateLastUsed 是否落在本次导航期间 */
export function usedDuringNavigation(node, navStartedAt, now) {
  const t = node?.dateLastUsed;
  if (!t) return false;
  const start = Number.isFinite(navStartedAt) ? navStartedAt : now - RECENT_USE_FALLBACK_MS;
  return t >= start - RECENT_USE_SLACK_MS && t <= now + 1000;
}

/** 生成候选 URL：先 onBeforeNavigate 记下的原始地址（重定向前，按发生顺序），再最终提交地址；去重 */
export function buildCandidateUrls(beforeNavigateUrls, committedUrl) {
  const list = [...(beforeNavigateUrls || [])];
  if (committedUrl) list.push(committedUrl);
  return [...new Set(list.filter(Boolean))];
}

/** 宽松 URL 键：忽略协议、www.、hash、末尾斜杠、主机大小写 */
export function looseUrlKey(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const port = u.port ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${port}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** 同一 URL 被多个书签收藏时：优先最近打开（dateLastUsed），其次最近添加 */
export function pickBookmark(nodes) {
  const list = (nodes || []).filter((n) => n && n.url && n.parentId);
  if (!list.length) return null;
  return [...list].sort(
    (a, b) => (b.dateLastUsed || 0) - (a.dateLastUsed || 0) || (b.dateAdded || 0) - (a.dateAdded || 0),
  )[0];
}

/**
 * chain[0] 为目标文件夹，chain[last] 为根文件夹（书签栏/其他书签等，parentId === '0'）
 */
export function titleForChain(chain, titleStyle) {
  if (!chain?.length) return UNTITLED_FOLDER;
  if (chain.length === 1) return chain[0].title || UNTITLED_FOLDER;
  if (titleStyle === 'path') {
    const names = chain
      .slice(0, -1)
      .reverse()
      .map((n) => n.title || UNTITLED_FOLDER);
    return names.join(' / ');
  }
  return chain[0].title || UNTITLED_FOLDER;
}

/**
 * 根据书签的祖先链计算目标分组。
 * @param ancestors [直接父文件夹, 祖父, ..., 根文件夹]
 * @returns {{folderId: string, title: string} | null}
 */
export function resolveGroupTarget(ancestors, settings) {
  const s = normalizeSettings(settings);
  if (!ancestors?.length) return null;
  if (ancestors.length === 1) {
    if (s.rootBookmarks !== 'group') return null;
    return { folderId: ancestors[0].id, title: titleForChain(ancestors, s.titleStyle) };
  }
  const idx = s.groupBy === 'top' ? ancestors.length - 2 : 0;
  const chain = ancestors.slice(idx);
  return { folderId: chain[0].id, title: titleForChain(chain, s.titleStyle) };
}

/** 分组颜色：规则组用固定颜色，文件夹组按 id 计算 */
export function colorForTarget(target) {
  return target?.color || colorForFolder(target?.folderId);
}

/** 按文件夹 id 计算稳定颜色（FNV-1a） */
export function colorForFolder(folderId) {
  let h = 0x811c9dc5;
  for (const ch of String(folderId)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

export function mapKey(windowId, folderId) {
  return `${windowId}:${folderId}`;
}

// ---------- 前进 / 后退时恢复分组 ----------
export const HISTORY_PER_TAB = 30; // 每个标签最多记住多少个页面的分组状态

/** 是否为前进 / 后退导航 */
export function isHistoryNav(d) {
  return !!d && (d.transitionQualifiers || []).includes('forward_back');
}

/** 历史记录的键：去掉 #hash，其余保持原样 */
export function historyKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '');
  }
}

/**
 * 页面分组状态的快照
 * @param {number} groupId 标签当前 groupId（-1 表示未分组）
 * @param {{groupId:number, folderId:string, title:string}|undefined} ownedEntry 若该组由本扩展创建，对应的映射条目
 */
export function snapshotGroupState(groupId, ownedEntry) {
  if (groupId === -1 || groupId == null) return { g: 'none' };
  if (ownedEntry) return { g: 'ext', folderId: ownedEntry.folderId, title: ownedEntry.title };
  return { g: 'user', groupId };
}

/**
 * 前进 / 后退回到某个页面时，决定怎么处理分组。
 * 原则：每个页面记住自己当时所在的组；但只纠正“本扩展造成的”分组，用户自己的整理不动。
 * @param want 该页面记录的状态（snapshotGroupState 的结果），没有记录则为 undefined
 * @param cur  { groupId, owned: 当前组是否本扩展创建, dismissed: 用户是否手动移出过, userGroupAlive: want 指向的用户组是否还在同一窗口 }
 * @returns 'no-history' | 'skip-user-group' | 'skip-dismissed' | 'to-ext' | 'to-user' | 'ungroup' | 'none'
 */
export function decideHistoryRestore(want, cur) {
  if (!want) return 'no-history';
  if (cur.groupId !== -1 && !cur.owned) return 'skip-user-group'; // 当前在用户自己的组里：不动
  if (cur.groupId === -1 && cur.dismissed) return 'skip-dismissed'; // 用户手动移出过：不动
  if (want.g === 'ext') return 'to-ext'; // 放回本扩展的组（不存在则重建）
  if (!cur.owned) return 'none'; // 当前未分组、目标也不是本扩展的组：不动
  if (want.g === 'user' && cur.userGroupAlive) return 'to-user'; // 放回用户原来的组
  return 'ungroup'; // 该页面当时未分组：移出本扩展的组
}

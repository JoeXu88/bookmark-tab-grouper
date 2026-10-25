import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  DOC_GROUP_ID,
  GROUP_COLORS,
  buildCandidateUrls,
  colorForFolder,
  colorForTarget,
  decideHistoryRestore,
  historyKey,
  isActiveMainFrame,
  isAutoDocCandidate,
  isBookmarkOpen,
  isDocUrl,
  isHistoryNav,
  looseUrlKey,
  mayBeBookmarkOpen,
  normalizeSettings,
  pickBookmark,
  resolveAutoDocTarget,
  resolveDocTarget,
  resolveGroupTarget,
  shortUrlLabel,
  snapshotGroupState,
  titleForChain,
  usedDuringNavigation,
} from '../extension/lib/core.js';

const bar = { id: '1', title: 'Bookmarks bar', parentId: '0' };
const work = { id: '10', title: 'Work', parentId: '1' };
const docs = { id: '11', title: 'Docs', parentId: '10' };

test('normalizeSettings: 默认值与非法值回退', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const s = normalizeSettings({ enabled: false, groupBy: 'top', titleStyle: 'bad', colorByFolder: 'yes', extra: 1 });
  assert.equal(s.enabled, false);
  assert.equal(s.groupBy, 'top');
  assert.equal(s.titleStyle, 'name');
  assert.equal(s.colorByFolder, true);
  assert.ok(!('extra' in s));
});

test('isActiveMainFrame: 排除 iframe / 预渲染', () => {
  assert.ok(isActiveMainFrame({ frameId: 0, documentLifecycle: 'active', frameType: 'outermost_frame' }));
  assert.ok(isActiveMainFrame({ frameId: 0 }));
  assert.ok(!isActiveMainFrame({ frameId: 3, frameType: 'sub_frame' }));
  assert.ok(!isActiveMainFrame({ frameId: 3 }));
  assert.ok(!isActiveMainFrame({ frameId: 0, documentLifecycle: 'prerender' }));
  assert.ok(!isActiveMainFrame({ frameId: 7, documentLifecycle: 'prerender', frameType: 'outermost_frame' }));
  assert.ok(!isActiveMainFrame({ frameId: 0, documentLifecycle: 'active', frameType: 'fenced_frame' }));
  assert.ok(!isActiveMainFrame(null));
});

test('isBookmarkOpen: 仅 auto_bookmark，且排除前进/后退', () => {
  assert.ok(isBookmarkOpen({ transitionType: 'auto_bookmark', transitionQualifiers: [] }));
  assert.ok(isBookmarkOpen({ transitionType: 'auto_bookmark', transitionQualifiers: ['server_redirect'] }));
  assert.ok(!isBookmarkOpen({ transitionType: 'auto_bookmark', transitionQualifiers: ['forward_back'] }));
  assert.ok(!isBookmarkOpen({ transitionType: 'link', transitionQualifiers: [] }));
  assert.ok(!isBookmarkOpen({ transitionType: 'typed' }));
});

test('buildCandidateUrls: 原始地址优先、去重', () => {
  assert.deepEqual(buildCandidateUrls(['http://a.com/', 'https://a.com/'], 'https://www.a.com/home'), [
    'http://a.com/',
    'https://a.com/',
    'https://www.a.com/home',
  ]);
  assert.deepEqual(buildCandidateUrls(['https://a.com/'], 'https://a.com/'), ['https://a.com/']);
  assert.deepEqual(buildCandidateUrls(undefined, 'https://b.com/'), ['https://b.com/']);
});

test('looseUrlKey: 忽略协议 / www / hash / 末尾斜杠', () => {
  assert.equal(looseUrlKey('https://www.Example.com/path/#x'), looseUrlKey('http://example.com/path'));
  assert.notEqual(looseUrlKey('https://a.com/p?x=1'), looseUrlKey('https://a.com/p?x=2'));
  assert.equal(looseUrlKey('chrome://bookmarks'), null);
  assert.equal(looseUrlKey('not a url'), null);
});

test('pickBookmark: 优先最近打开，其次最近添加，排除文件夹', () => {
  const a = { id: 'a', url: 'u', parentId: '1', dateAdded: 1, dateLastUsed: 5 };
  const b = { id: 'b', url: 'u', parentId: '2', dateAdded: 9 };
  const c = { id: 'c', url: 'u', parentId: '3', dateAdded: 3, dateLastUsed: 7 };
  assert.equal(pickBookmark([a, b, c]).id, 'c');
  assert.equal(pickBookmark([b, { id: 'd', url: 'u', parentId: '4', dateAdded: 2 }]).id, 'b');
  assert.equal(pickBookmark([{ id: 'f', title: 'folder', parentId: '1' }]), null);
  assert.equal(pickBookmark([]), null);
});

test('titleForChain: 名称 / 路径', () => {
  assert.equal(titleForChain([docs, work, bar], 'name'), 'Docs');
  assert.equal(titleForChain([docs, work, bar], 'path'), 'Work / Docs');
  assert.equal(titleForChain([bar], 'path'), 'Bookmarks bar');
  assert.equal(titleForChain([{ id: '5', title: '', parentId: '1' }, bar], 'name'), '未命名文件夹');
});

test('resolveGroupTarget: 直接文件夹 / 顶层文件夹 / 根目录', () => {
  assert.deepEqual(resolveGroupTarget([docs, work, bar], {}), { folderId: '11', title: 'Docs' });
  assert.deepEqual(resolveGroupTarget([docs, work, bar], { groupBy: 'top' }), { folderId: '10', title: 'Work' });
  assert.deepEqual(resolveGroupTarget([docs, work, bar], { titleStyle: 'path' }), {
    folderId: '11',
    title: 'Work / Docs',
  });
  assert.equal(resolveGroupTarget([bar], {}), null);
  assert.deepEqual(resolveGroupTarget([bar], { rootBookmarks: 'group' }), { folderId: '1', title: 'Bookmarks bar' });
  assert.equal(resolveGroupTarget([], {}), null);
});

test('colorForFolder: 稳定且在合法范围内', () => {
  assert.equal(colorForFolder('42'), colorForFolder('42'));
  for (let i = 0; i < 50; i++) assert.ok(GROUP_COLORS.includes(colorForFolder(String(i))));
  const distinct = new Set(Array.from({ length: 50 }, (_, i) => colorForFolder(String(i))));
  assert.ok(distinct.size >= 4);
});

test('mayBeBookmarkOpen: 书签管理器路径（link）进入二次判定，刷新/前进后退/子框架不进入', () => {
  assert.ok(mayBeBookmarkOpen({ transitionType: 'link', transitionQualifiers: [], url: 'https://a.com' }));
  assert.ok(mayBeBookmarkOpen({ transitionType: 'typed', transitionQualifiers: [], url: 'http://a.com' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'auto_bookmark', url: 'https://a.com' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'reload', url: 'https://a.com' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'link', transitionQualifiers: ['forward_back'], url: 'https://a.com' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'link', transitionQualifiers: ['client_redirect'], url: 'https://a.com' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'link', url: 'chrome://bookmarks/' }));
  assert.ok(!mayBeBookmarkOpen({ transitionType: 'form_submit', url: 'https://a.com' }));
});

test('usedDuringNavigation: dateLastUsed 须落在本次导航期间', () => {
  const now = 1_000_000;
  assert.ok(usedDuringNavigation({ dateLastUsed: now - 100 }, now - 500, now));
  assert.ok(usedDuringNavigation({ dateLastUsed: now - 600 }, now - 500, now), '容忍少量提前');
  assert.ok(!usedDuringNavigation({ dateLastUsed: now - 10_000 }, now - 500, now), '太早：之前打开过');
  assert.ok(!usedDuringNavigation({}, now - 500, now), '从未打开过');
  assert.ok(usedDuringNavigation({ dateLastUsed: now - 20_000 }, undefined, now), '无导航开始时间时回看 30s');
  assert.ok(!usedDuringNavigation({ dateLastUsed: now - 40_000 }, undefined, now));
  assert.ok(!usedDuringNavigation({ dateLastUsed: now + 60_000 }, now - 500, now), '未来时间');
});

test('isDocUrl: 飞书 / Lark 各类云文档链接', () => {
  const yes = [
    'https://bytedance.larkoffice.com/docx/doxcnAbc123',
    'https://bytedance.feishu.cn/wiki/wikcnXYZ?from=from_copylink',
    'https://xxx.feishu.cn/sheets/shtcn123?sheet=abc',
    'https://xxx.feishu.cn/base/bascn123?table=tbl1&view=vew1',
    'https://example.larksuite.com/slides/sldcn1',
    'https://xxx.feishu.cn/mindnotes/bmncn1',
    'https://xxx.feishu.cn/docs/doccn1',
    'https://xxx.feishu.cn/doc/doccn1',
    'https://xxx.feishu.cn/file/boxcn1',
    'https://xxx.feishu.cn/drive/folder/fldcn1',
    'https://xxx.feishu.cn/share/base/form/shrcn1',
    'https://feishu.cn/docx/doxcn1',
    'http://bytedance.feishu.cn/DOCX/abc',
  ];
  for (const u of yes) assert.ok(isDocUrl(u), u);
  const no = [
    'https://www.feishu.cn/',
    'https://www.feishu.cn/product/docs',
    'https://open.feishu.cn/document/server-docs/docs/docs-overview',
    'https://xxx.feishu.cn/minutes/obcn1',
    'https://applink.feishu.cn/client/message/link/open?token=1',
    'https://xxx.feishu.cn/calendar',
    'https://docs.google.com/document/d/1/edit',
    'https://notfeishu.cn/docx/abc',
    'https://feishu.cn.evil.com/docx/abc',
    'https://example.com/docx/abc',
    'chrome://bookmarks',
    'not a url',
    '',
  ];
  for (const u of no) assert.ok(!isDocUrl(u), u);
});

test('resolveDocTarget: 开关 / 自定义组名 / 任一网址命中', () => {
  const doc = 'https://bytedance.larkoffice.com/docx/abc';
  const other = 'https://example.com/a';
  assert.deepEqual(resolveDocTarget([doc], {}), { folderId: DOC_GROUP_ID, title: '文档', color: 'blue', kind: 'docs' });
  assert.equal(resolveDocTarget([other], {}), null);
  assert.equal(resolveDocTarget([doc], { docGroupEnabled: false }), null);
  assert.equal(resolveDocTarget([other, doc], { docGroupTitle: '飞书' }).title, '飞书');
  assert.equal(resolveDocTarget([], {}), null);
  assert.equal(resolveDocTarget(undefined, {}), null);
});

test('normalizeSettings: 文档组名去空白、截断、空值回退默认', () => {
  assert.equal(normalizeSettings({ docGroupTitle: '  云文档  ' }).docGroupTitle, '云文档');
  assert.equal(normalizeSettings({ docGroupTitle: '   ' }).docGroupTitle, '文档');
  assert.equal(normalizeSettings({ docGroupTitle: 123 }).docGroupTitle, '文档');
  assert.equal(normalizeSettings({ docGroupTitle: 'x'.repeat(100) }).docGroupTitle.length, 40);
  assert.equal(normalizeSettings({ docGroupEnabled: 'no' }).docGroupEnabled, true);
});

test('colorForTarget: 规则组固定颜色，文件夹组按 id', () => {
  assert.equal(colorForTarget({ folderId: DOC_GROUP_ID, color: 'blue' }), 'blue');
  assert.equal(colorForTarget({ folderId: '42' }), colorForFolder('42'));
});

test('resolveAutoDocTarget: 生效范围 any / bookmark', () => {
  const doc = 'https://bytedance.larkoffice.com/docx/abc';
  assert.equal(resolveAutoDocTarget([doc], {}).title, '文档');
  assert.equal(resolveAutoDocTarget([doc], { docGroupScope: 'bookmark' }), null);
  assert.equal(resolveAutoDocTarget([doc], { docGroupEnabled: false }), null);
  assert.equal(resolveAutoDocTarget(['https://example.com/'], {}), null);
  assert.equal(normalizeSettings({ docGroupScope: 'weird' }).docGroupScope, 'any');
});

test('isAutoDocCandidate: 刷新 / 前进后退 / 子框架 / 非 http 排除', () => {
  const u = 'https://x.feishu.cn/docx/a';
  assert.ok(isAutoDocCandidate({ transitionType: 'link', transitionQualifiers: [], url: u }));
  assert.ok(isAutoDocCandidate({ transitionType: 'typed', transitionQualifiers: ['from_address_bar'], url: u }));
  assert.ok(isAutoDocCandidate({ transitionType: 'link', transitionQualifiers: ['client_redirect'], url: u }));
  assert.ok(isAutoDocCandidate({ transitionType: 'auto_toplevel', url: u }));
  assert.ok(!isAutoDocCandidate({ transitionType: 'reload', url: u }));
  assert.ok(!isAutoDocCandidate({ transitionType: 'link', transitionQualifiers: ['forward_back'], url: u }));
  assert.ok(!isAutoDocCandidate({ transitionType: 'auto_subframe', url: u }));
  assert.ok(!isAutoDocCandidate({ transitionType: 'link', url: 'chrome://newtab/' }));
  assert.ok(!isAutoDocCandidate(null));
});

test('shortUrlLabel: 主机 + 前两段路径', () => {
  assert.equal(shortUrlLabel('https://bytedance.larkoffice.com/docx/doxcnABC?x=1#h'), 'bytedance.larkoffice.com/docx/doxcnABC');
  assert.equal(shortUrlLabel('https://a.feishu.cn/'), 'a.feishu.cn/');
  assert.ok(shortUrlLabel('https://a.feishu.cn/' + 'x'.repeat(100)).length <= 60);
  assert.equal(shortUrlLabel('bad'), 'bad');
});

test('isHistoryNav / historyKey', () => {
  assert.ok(isHistoryNav({ transitionType: 'auto_bookmark', transitionQualifiers: ['forward_back'] }));
  assert.ok(isHistoryNav({ transitionType: 'typed', transitionQualifiers: ['forward_back', 'from_address_bar'] }));
  assert.ok(!isHistoryNav({ transitionType: 'auto_bookmark', transitionQualifiers: [] }));
  assert.ok(!isHistoryNav(null));
  assert.equal(historyKey('https://a.com/p?x=1#h'), 'https://a.com/p?x=1');
  assert.notEqual(historyKey('https://a.com/p?x=1'), historyKey('https://a.com/p?x=2'));
  assert.equal(historyKey('bad'), 'bad');
});

test('snapshotGroupState: 未分组 / 本扩展组 / 用户组', () => {
  assert.deepEqual(snapshotGroupState(-1), { g: 'none' });
  assert.deepEqual(snapshotGroupState(5, { groupId: 5, folderId: '__docs__', title: '文档' }), {
    g: 'ext',
    folderId: '__docs__',
    title: '文档',
  });
  assert.deepEqual(snapshotGroupState(7, undefined), { g: 'user', groupId: 7 });
});

test('decideHistoryRestore: 只纠正本扩展造成的分组', () => {
  const ext = { g: 'ext', folderId: '__docs__', title: '文档' };
  const none = { g: 'none' };
  const user = { g: 'user', groupId: 9 };
  const inOwned = { groupId: 3, owned: true, dismissed: false, userGroupAlive: false };
  const ungrouped = { groupId: -1, owned: false, dismissed: false, userGroupAlive: false };
  assert.equal(decideHistoryRestore(ext, inOwned), 'to-ext');
  assert.equal(decideHistoryRestore(none, inOwned), 'ungroup');
  assert.equal(decideHistoryRestore(user, { ...inOwned, userGroupAlive: true }), 'to-user');
  assert.equal(decideHistoryRestore(user, inOwned), 'ungroup');
  assert.equal(decideHistoryRestore(ext, { groupId: 4, owned: false }), 'skip-user-group');
  assert.equal(decideHistoryRestore(ext, ungrouped), 'to-ext');
  assert.equal(decideHistoryRestore(ext, { ...ungrouped, dismissed: true }), 'skip-dismissed');
  assert.equal(decideHistoryRestore(none, ungrouped), 'none');
  assert.equal(decideHistoryRestore(user, { ...ungrouped, userGroupAlive: true }), 'none');
  assert.equal(decideHistoryRestore(undefined, inOwned), 'no-history');
  assert.equal(normalizeSettings({}).restoreOnHistoryNav, true);
  assert.equal(normalizeSettings({ restoreOnHistoryNav: false }).restoreOnHistoryNav, false);
});

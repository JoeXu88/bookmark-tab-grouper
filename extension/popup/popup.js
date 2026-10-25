import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/core.js';

const ACTION_TEXT = {
  created: '新建组',
  joined: '加入组',
  'already-in-group': '已在组内',
  'skip-root': '根目录书签，未分组',
  'skip-user-group': '已在其他组，未移动',
  swept: '整理到',
  restored: '恢复到',
  'restored-ungroup': '恢复为未分组',
};

const VIA_TEXT = {
  'recent-use': '（书签管理器）',
  auto: '（非书签）',
  history: '（前进/后退）',
};

const $ = (id) => document.getElementById(id);
const keys = Object.keys(DEFAULT_SETTINGS);

function render(settings) {
  for (const key of keys) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = settings[key];
    else if (document.activeElement !== el) el.value = settings[key];
  }
  $('settings').classList.toggle('disabled', !settings.enabled);
  $('rules').classList.toggle('disabled', !settings.enabled);
  for (const id of ['docGroupTitle', 'docGroupScope', 'sweepDocs']) {
    $(id).closest('.row').classList.toggle('off', !settings.docGroupEnabled);
  }
}

function readForm() {
  const raw = {};
  for (const key of keys) {
    const el = $(key);
    if (!el) continue;
    raw[key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return normalizeSettings(raw);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLogs(logs) {
  const ul = $('logs');
  ul.replaceChildren();
  if (!logs?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无记录';
    ul.append(li);
    return;
  }
  for (const log of logs) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(log.time);
    const text = document.createElement('span');
    text.className = 'text';
    const action = ACTION_TEXT[log.action] || log.action;
    const via = VIA_TEXT[log.via] || '';
    text.textContent = log.group
      ? `${action}「${log.group}」· ${log.bookmark ?? ''}${via}`
      : `${action} · ${log.bookmark ?? ''}${via}`;
    text.title = text.textContent;
    li.append(time, text);
    ul.append(li);
  }
}

let statusTimer;
function flash(msg) {
  $('status').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('status').textContent = ''), 1500);
}

async function init() {
  const { settings } = await chrome.storage.sync.get('settings');
  render(normalizeSettings(settings));
  const { logs } = await chrome.storage.session.get('logs');
  renderLogs(logs);

  for (const key of keys) {
    $(key)?.addEventListener('change', async () => {
      const next = readForm();
      if (document.activeElement === $(key) && $(key).type === 'text') $(key).value = next[key];
      render(next);
      await chrome.storage.sync.set({ settings: next });
      flash('已保存');
    });
  }
  // 文本框回车即保存
  $('docGroupTitle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  $('sweepDocs').addEventListener('click', async () => {
    const btn = $('sweepDocs');
    btn.disabled = true;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'sweepDocTabs' });
      flash(r?.grouped ? `已整理 ${r.grouped} 个文档标签` : '没有需要整理的文档标签');
    } catch (e) {
      flash(`整理失败：${e?.message || e}`);
    } finally {
      btn.disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.logs) renderLogs(changes.logs.newValue);
  });
}

init();

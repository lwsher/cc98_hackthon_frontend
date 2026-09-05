// ============================================================
// 侧边滑动面板外壳：头部 + 4 个 Tab + 内容区
//   renderers: { search, subscribe, notif, settings } 各自渲染到 body
//   面板定位锚定悬浮按钮；SPA 换页导致面板被清时由 main.js 负责重挂
// ============================================================
import { SESSION_KEYS } from '../../shared/constants.js';

const PANEL_ID = 'cc98-ai-panel';
const PANEL_SIZE_KEY = 'panelSize'; // 面板宽高，存 storage.local，刷新后保留

const TABS = [
  { key: 'search', label: '搜索' },
  { key: 'subscribe', label: '订阅' },
  { key: 'notif', label: '通知' },
  { key: 'settings', label: '设置' },
];

let singleton = null;
let globalListenersBound = false;

// 把面板摆到按钮旁边（默认上方、右对齐；上方放不下就放下方），并夹在视口内
function positionPanelNearButton(panel) {
  const btn = document.getElementById('cc98-ai-float-btn');
  if (!btn) return;
  const brect = btn.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 12;
  const w = panel.offsetWidth || 480;
  const h = panel.offsetHeight || 640;

  let left = brect.right - w;
  let top = brect.top - gap - h;
  left = Math.max(8, Math.min(left, vw - w - 8));
  if (top < 8) top = brect.bottom + gap;
  top = Math.max(8, Math.min(top, vh - h - 8));

  panel.style.left = Math.round(left) + 'px';
  panel.style.top = Math.round(top) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

// 让面板右下角手柄可拖动调整大小，尺寸夹在合理范围并存入 storage
function makeResizable(panel, handle) {
  let resizing = false;
  let startX = 0, startY = 0, startW = 0, startH = 0;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = panel.offsetWidth;
    startH = panel.offsetHeight;
    panel.classList.add('resizing');
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
  });

  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(320, Math.min(vw - 16, startW + (e.clientX - startX)));
    const h = Math.max(200, Math.min(vh - 100, startH + (e.clientY - startY)));
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.style.maxWidth = 'none';
    panel.style.maxHeight = 'none';
  });

  function end(e) {
    if (!resizing) return;
    resizing = false;
    panel.classList.remove('resizing');
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    try {
      chrome.storage.local.set({ [PANEL_SIZE_KEY]: { width: panel.offsetWidth, height: panel.offsetHeight } }).catch(() => {});
    } catch (_) {}
  }
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// 恢复上次拖到的宽高（异步；没存过就用默认尺寸）
function applyPanelSize(panel) {
  try {
    chrome.storage.local.get(PANEL_SIZE_KEY).then((o) => {
      const s = o && o[PANEL_SIZE_KEY];
      if (s && typeof s.width === 'number' && typeof s.height === 'number') {
        panel.style.width = s.width + 'px';
        panel.style.height = s.height + 'px';
        panel.style.maxWidth = 'none';
        panel.style.maxHeight = 'none';
      }
    }).catch(() => {});
  } catch (e) { /* 静默 */ }
}

// 只在面板创建时读取一次开合状态，不监听变化：
// 已打开的其他 CC98 页面保持原样，新页面 / 刷新 / SPA 重挂载时才恢复。
function readPanelOpenState() {
  try {
    return chrome.storage.session
      .get(SESSION_KEYS.PANEL_OPEN)
      .then((o) => !!(o && o[SESSION_KEYS.PANEL_OPEN]))
      .catch(() => false);
  } catch (e) {
    return Promise.resolve(false);
  }
}

function savePanelOpenState(isOpen) {
  try {
    chrome.storage.session
      .set({ [SESSION_KEYS.PANEL_OPEN]: !!isOpen })
      .catch(() => {});
  } catch (e) { /* 静默 */ }
}

export function createSidePanel({ renderers }) {
  if (singleton && document.getElementById(PANEL_ID)) return singleton;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="cc98-panel-head">
      <span class="cc98-panel-title">CC98 AI+</span>
      <button id="cc98-ai-close" class="cc98-panel-close" type="button" title="关闭">✕</button>
    </div>
    <div class="cc98-panel-tabs"></div>
    <div class="cc98-panel-body"></div>
    <div class="cc98-panel-resize" title="拖动调整大小"></div>`;
  document.body.appendChild(panel);

  makeResizable(panel, panel.querySelector('.cc98-panel-resize'));
  applyPanelSize(panel);

  const tabsEl = panel.querySelector('.cc98-panel-tabs');
  const bodyEl = panel.querySelector('.cc98-panel-body');

  const tabBtns = {};
  let activeKey = 'search';
  // 防止异步读取旧状态时覆盖用户刚刚在当前页面执行的开合操作。
  let visibilityChangedLocally = false;

  for (const t of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cc98-tab';
    b.dataset.tab = t.key;
    b.textContent = t.label;
    b.addEventListener('click', () => setActiveTab(t.key));
    tabsEl.appendChild(b);
    tabBtns[t.key] = b;
  }

  function setActiveTab(key) {
    activeKey = key;
    for (const k in tabBtns) tabBtns[k].classList.toggle('active', k === key);
    const render = renderers && renderers[key];
    if (render) {
      try {
        render(bodyEl);
      } catch (e) {
        bodyEl.innerHTML = `<div class="cc98-error">渲染失败：${e && e.message ? e.message : e}</div>`;
      }
    }
  }

  function applyOpenState(isOpen) {
    panel.classList.toggle('open', isOpen);
    if (isOpen) {
      // 不重渲染当前 Tab：上次结果原样保留，关闭再打开不丢
      requestAnimationFrame(() => positionPanelNearButton(panel));
    }
  }
  function open() {
    visibilityChangedLocally = true;
    applyOpenState(true);
    savePanelOpenState(true);
  }
  function close() {
    visibilityChangedLocally = true;
    applyOpenState(false);
    savePanelOpenState(false);
  }
  function toggle() {
    panel.classList.contains('open') ? close() : open();
  }
  function isOpen() {
    return panel.classList.contains('open');
  }

  panel.querySelector('#cc98-ai-close').addEventListener('click', close);

  bindGlobalListeners();

  setActiveTab('search'); // 预渲染，让首次打开有内容

  singleton = { open, close, toggle, isOpen, setActiveTab, getActiveTab: () => activeKey, getBody: () => bodyEl };
  readPanelOpenState().then((isOpen) => {
    if (visibilityChangedLocally || !document.body.contains(panel)) return;
    applyOpenState(isOpen);
  });
  return singleton;
}

// 全局监听只绑一次（按 ID 现查，面板重建后仍有效，避免重复绑定）
function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;

  // 点击面板外关闭（悬浮按钮除外，避免和 toggle 冲突）
  document.addEventListener('click', (e) => {
    const p = document.getElementById(PANEL_ID);
    if (!p || !p.classList.contains('open')) return;
    if (p.contains(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('#' + PANEL_ID)) return;
    if (e.target && e.target.closest && e.target.closest('#cc98-ai-float-btn')) return;
    if (singleton) singleton.close();
  });

  // 按钮拖动 / 窗口缩放时，面板若开着就跟随按钮
  const follow = () => {
    const p = document.getElementById(PANEL_ID);
    if (p && p.classList.contains('open')) positionPanelNearButton(p);
  };
  window.addEventListener('cc98-fb-moved', follow);
  window.addEventListener('resize', follow);
}

export function getSidePanel() {
  return singleton;
}

import './styles.css';
import * as store from './store.js';
import * as backend from './backend.js';
import { handleDelegation } from './delegation.js';
import { toolInfo, describeStatus } from './tools.js';
import { TerminalView, isMac } from './terminal.js';
import { THEMES, THEME_LIST, THEME_GROUPS, DEFAULT_THEME, FONT_LIST } from './themes.js';
import { fontFamily, loadFont } from './fonts.js';
import { usageTotals, formatTokens, formatLimitReset, formatLimitCountdown, headerAllowances, trackResets, takeDueResets } from './usage.js';

const loaded = store.loadState(localStorage);
const state = loaded.state;
if (!state.settings.reopenChats) store.closeAllChats(state);
let notice = loaded.problem;
let tools = null;
let toolsCheck = 0;
let usage = null;
let usageError = '';
let homePath = '';
const missingFolders = new Set();
const panes = new Map();
const handoffs = [];
let refreshToolsDialog = null;
// The chosen font is used once its files have loaded; until then the system font stands in.
let currentFont = fontFamily('system');
let shownTheme = null;

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chatById = id => state.chats.find(c => c.id === id);
const projectById = id => state.projects.find(p => p.id === id);
const projectPath = chat => chat?.projectId ? projectById(chat.projectId)?.path ?? '' : '';
const shortPath = path => homePath && path?.startsWith(homePath) ? '~' + path.slice(homePath.length) : path ?? '';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const page = () => store.currentPage(state);
const pageProjectId = () => state.page === store.INDIVIDUAL ? null : state.page;
const pageName = key => key === store.INDIVIDUAL ? 'Individual chats' : projectById(key)?.name ?? '';
const projectName = chat => chat.projectId ? projectById(chat.projectId)?.name ?? '' : 'individual';
const stateLabels = { closed: 'closed', starting: 'starting', working: 'working', waiting: 'needs you', done: 'done', ready: 'ready', stopped: 'stopped', failed: 'couldn’t start' };
const chatState = id => panes.get(id)?.display ?? 'closed';
// Three dots that move while an AI works.
const dots = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
const stateMark = shown => shown === 'working' ? `<span class="run-dot is-working">${dots}</span>` : `<span class="run-dot is-${shown}"></span>`;

function save() {
  if (!store.saveState(localStorage, state)) notice = 'Unable to save: local storage is unavailable or full.';
}
function update() { save(); render(); }

function renderSkeleton() {
  $('#app').innerHTML = `<div class="workbench">
    <header class="app-header"><strong><span class="accent">[≡]</span> AI WORKBENCH</strong><span class="header-page" id="header-page"></span>
      <button class="header-button" id="usage-button" data-action="usage" aria-haspopup="dialog" title="AI subscription allowances, reset times, and token usage"></button>
      <button class="header-button tools-button" id="tools-button" data-action="tools" title="Connect your AI tools"></button>
      <button class="header-button update-button" id="update-button" data-action="settings" title="A new version of AI Workbench is ready to install" hidden></button>
      <button class="header-button" data-action="settings" title="Settings">settings</button></header>
    <div class="workspace"><aside class="sidebar" id="sidebar" aria-label="Projects and chats"></aside><main>
      <div class="workspace-toolbar" id="toolbar"></div>
      <nav class="open-tabs" id="tabs" aria-label="Open chats"></nav>
      <div class="panes" id="panes"></div>
      <div class="panes-empty" id="panes-empty" hidden></div>
    </main>
    <div class="dock-resizer" id="dock-resizer" title="Drag to resize" hidden></div>
    <aside class="dock" id="dock" aria-label="Pinned" hidden></aside></div>
    <footer class="app-status" id="status"></footer>
  </div><div class="parked" id="parked" hidden></div><div class="menu" id="menu" role="menu" hidden></div>
  <div class="usage-panel" id="usage-panel" role="dialog" aria-label="Usage" hidden></div>`;
}

// The app's colors come from the theme as CSS variables; light themes also switch the
// browser's own controls (scroll bars, form fields) to their light look.
function applyTheme() {
  if (shownTheme === state.theme) return;
  shownTheme = state.theme;
  const theme = THEMES[state.theme] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.ui)) root.style.setProperty(`--${name}`, value);
  root.style.setProperty('color-scheme', theme.light ? 'light' : 'dark');
  root.dataset.theme = theme.id;
  root.dataset.tone = theme.light ? 'light' : 'dark';
}

async function applyFont() {
  const wanted = state.settings.font;
  const family = await loadFont(wanted);
  if (state.settings.font !== wanted) return;
  currentFont = family;
  document.documentElement.style.setProperty('--mono', family);
  panes.forEach(pane => pane.view.setFont(family));
}

function render() {
  applyTheme();
  document.body.classList.toggle('flash-on', state.settings.flash);
  document.documentElement.style.setProperty('--dock-width', `${state.settings.dockWidth}px`);
  renderHeader();
  renderSidebar();
  renderToolbar();
  renderTabs();
  syncPanes();
  renderEmpty();
  renderStatus();
  renderUsage();
}

function renderHeader() {
  const project = projectById(state.page);
  $('#header-page').innerHTML = `${escape(pageName(state.page))} <span class="dim">${escape(project ? shortPath(project.path) : homePath ? '~' : '')}</span>`;
  const toolDots = store.AI_TOOLS.map(t => `<span class="dot is-${describeStatus(tools?.[t]).level}" style="--tool:${toolInfo[t].color}" title="${toolInfo[t].name}: ${describeStatus(tools?.[t]).text}"></span>`).join('');
  const label = !backend.isDesktop ? 'AI tools' : tools ? `AI tools · ${store.AI_TOOLS.filter(t => tools[t]?.path).length}/4` : 'AI tools · checking';
  $('#tools-button').innerHTML = `${toolDots}<span>${label}</span>`;
  const allowances = headerAllowances(usage);
  $('#usage-button').innerHTML = `AI usage${allowances.map(t => ` <span class="usage-chip ${t.usedPercent >= 80 ? 'high' : ''}" style="--tool:${toolInfo[t.id].color}">${toolInfo[t.id].tag} ${Math.round(t.usedPercent)}%${t.stale ? '*' : ''}</span>`).join('')}`;
  $('#usage-button').setAttribute('aria-expanded', String(!$('#usage-panel').hidden));
}

function chatRow(c, depth = 0) {
  const shown = chatState(c.id);
  const pinned = store.isPinned(state, c.id);
  const selected = !pinned && page().active === c.id && store.pageKeyOf(c) === state.page;
  return `<div class="chat-item ${selected ? 'selected' : ''}" style="margin-left:${Math.min(depth, 8) * 14}px"><button class="chat-row" data-action="open-chat" data-id="${escape(c.id)}" title="${escape(c.title)} · ${stateLabels[shown]} — double-click to rename">
    ${stateMark(shown)}
    <span class="tool-tag" style="--tool:${toolInfo[c.tool].color}">${toolInfo[c.tool].tag}</span>
    <span class="chat-title">${escape(c.title)}</span>${pinned ? '<span class="pin-mark">pinned</span>' : ''}</button>
    <button class="row-remove" data-action="remove-chat" data-id="${escape(c.id)}" aria-label="Remove ${escape(c.title)}" title="Remove from the list (the conversation is kept)">×</button></div>`;
}

function renderSidebar() {
  const sidebar = $('#sidebar');
  const scroll = sidebar.scrollTop;
  const projects = state.projects.map(p => {
    const collapsed = state.collapsed.includes(p.id);
    const chats = state.chats.filter(c => c.projectId === p.id);
    return `<section class="project ${state.page === p.id ? 'current' : ''}">
      <div class="project-row">
        <button class="caret-button" data-action="toggle-project" data-id="${escape(p.id)}" aria-expanded="${!collapsed}" title="${collapsed ? 'Show' : 'Hide'} chats"><span class="caret"></span></button>
        <button class="project-name" data-action="go-page" data-page="${escape(p.id)}" title="${escape(p.path)}">${escape(p.name)}${collapsed && chats.length ? `<span class="count">${chats.length}</span>` : ''}</button>
        <button class="icon-button" data-action="new-chat" data-project="${escape(p.id)}" title="New chat in ${escape(p.name)}">+</button>
        <button class="icon-button" data-action="project-menu" data-id="${escape(p.id)}" title="Project options">···</button>
      </div>
      ${collapsed ? '' : `<div class="project-path" title="${escape(p.path)}">${escape(shortPath(p.path))}${missingFolders.has(p.id) ? ' <span class="warn">· folder not found</span>' : ''}</div>
      ${store.chatTree(chats).map(({ chat, depth }) => chatRow(chat, depth)).join('') || `<button class="add-chat" data-action="new-chat" data-project="${escape(p.id)}">+ new chat</button>`}`}
    </section>`;
  }).join('');
  const standalone = state.chats.filter(c => c.projectId === null);
  sidebar.innerHTML = `<div class="section-heading"><span>PROJECTS</span><button class="icon-button" data-action="add-project" title="Add a project folder">+</button></div>
    ${projects || '<p class="sidebar-hint">Add a project folder, or drop one here.</p>'}
    <div class="section-heading standalone-heading ${state.page === store.INDIVIDUAL ? 'current' : ''}"><button class="heading-link" data-action="go-page" data-page="${store.INDIVIDUAL}">INDIVIDUAL CHATS</button><button class="icon-button" data-action="new-chat" data-project="" title="New chat without a project">+</button></div>
    ${store.chatTree(standalone).map(({ chat, depth }) => chatRow(chat, depth)).join('') || '<p class="sidebar-hint">Chats without a project run in your home folder.</p>'}`;
  sidebar.scrollTop = scroll;
}

function renderToolbar() {
  const current = page();
  $('#toolbar').innerHTML = `<div class="layout-controls" role="group" aria-label="Layout">${store.LAYOUTS.map(l => `<button data-action="layout" data-layout="${l}" class="${current.layout === l ? 'selected' : ''}" aria-pressed="${current.layout === l}">${l}</button>`).join('')}</div>
    <span class="dim toolbar-count">${current.open.length} open${state.pinned.length ? ` · ${state.pinned.length} pinned` : ''}</span>
    <button class="primary" data-action="new-chat" data-project="${escape(pageProjectId() ?? '')}">+ new chat</button>`;
}

function renderTabs() {
  const current = page();
  $('#tabs').innerHTML = current.open.map(id => {
    const c = chatById(id);
    const shown = chatState(id);
    return `<div class="open-tab ${current.active === id ? 'selected' : ''} is-${shown}" style="--tool:${toolInfo[c.tool].color}">
      <button data-action="focus" data-id="${escape(id)}" title="${escape(toolInfo[c.tool].name)} · ${escape(c.title)} · ${stateLabels[shown]}">${stateMark(shown)}<span class="tab-tool">${toolInfo[c.tool].tag}</span> ${escape(c.title)}</button>
      <button class="tab-close" data-action="close" data-id="${escape(id)}" aria-label="Close ${escape(c.title)}" title="Close (the conversation is kept)">×</button></div>`;
  }).join('');
}

function renderStatus() {
  const shown = store.runningChatIds(state).map(chatState);
  const count = name => shown.filter(s => s === name).length;
  const running = [...panes.values()].filter(p => p.view.status === 'running').length;
  const [working, waiting, done] = [count('working'), count('waiting'), count('done')];
  const parts = [`${running} running`];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(`<button class="status-jump is-waiting" data-action="jump" data-state="waiting">${waiting} need${waiting === 1 ? 's' : ''} you</button>`);
  if (done) parts.push(`<button class="status-jump is-done" data-action="jump" data-state="done">${done} done</button>`);
  const summary = notice ? escape(notice) : backend.isDesktop ? parts.join(' · ') : escape(backend.desktopOnly);
  const copy = isMac ? '⌘C copies' : 'Ctrl+C copies a selection';
  $('#status').innerHTML = `<span class="status-summary">${summary}</span>
    <span class="hints">Shift+Enter new line · ${copy} · drop files on a chat to insert their paths · Ctrl+Tab next chat</span>`;
  updateWindowTitle(waiting, done);
}

let windowTitle = 'AI Workbench';
function updateWindowTitle(waiting, done) {
  const parts = [waiting && `${waiting} need${waiting === 1 ? 's' : ''} you`, done && `${done} done`].filter(Boolean);
  const title = ['AI Workbench', ...parts].join(' · ');
  if (title !== windowTitle) backend.setWindowTitle(windowTitle = title);
}

// A desktop notification for a chat you aren't looking at, at most once every few seconds each.
const notified = new Map();
function notifyChat(chat, waiting) {
  if (!state.settings.notifications) return;
  const key = `${chat.id}:${waiting}`;
  if (Date.now() - (notified.get(key) ?? 0) < 5000) return;
  notified.set(key, Date.now());
  backend.notify(`${toolInfo[chat.tool].name} ${waiting ? 'needs you' : 'finished'}`, `${chat.title} · ${chat.projectId ? projectName(chat) : 'no project'}`);
  if (!document.hasFocus()) backend.requestAttention();
}

function renderEmpty() {
  const empty = $('#panes-empty');
  empty.hidden = page().open.length > 0;
  if (empty.hidden) return;
  if (!state.projects.length && !state.chats.length) {
    const ready = tools ? store.AI_TOOLS.filter(t => tools[t]?.path).length : null;
    empty.innerHTML = `<div class="welcome"><h1>Welcome to AI Workbench</h1>
      <p>Run Claude Code, Codex, Antigravity CLI and OpenCode side by side, each working in your project folder.</p>
      <ol class="steps">
        <li class="${ready ? 'done' : ''}"><span class="step">1</span><div><strong>Connect your AI tools</strong><p>${ready === null ? (backend.isDesktop ? 'Checking which tools are installed…' : backend.desktopOnly) : `${ready} of 4 installed on this computer.`}</p></div><button data-action="tools">${ready ? 'review' : 'connect'}</button></li>
        <li><span class="step">2</span><div><strong>Add a project folder</strong><p>The AI works inside this folder.</p></div><button data-action="add-project">add project</button></li>
        <li><span class="step">3</span><div><strong>Start a chat</strong><p>Pick an AI. Its conversation is saved and picks up where it left off.</p></div><button data-action="new-chat" data-project="">new chat</button></li>
      </ol></div>`;
  } else {
    const pinnedNote = state.pinned.length ? ' Pinned chats stay on the right on every page.' : '';
    empty.innerHTML = `<div class="welcome compact"><strong>No chats open in ${escape(pageName(state.page))}.</strong><p>Open one from the sidebar, or start a new one.${pinnedNote}</p><button class="primary" data-action="new-chat" data-project="${escape(pageProjectId() ?? '')}">+ new chat</button></div>`;
  }
}

// Panes hold live terminals, so they are kept across renders and only created or removed when chats open or close.
class Pane {
  constructor(chat) {
    this.chatId = chat.id;
    this.el = document.createElement('article');
    this.el.className = 'pane';
    this.el.dataset.pane = chat.id;
    this.el.innerHTML = `<header class="pane-header" title="Drag onto another pane to swap them">
        <span class="tool-tag"></span><span class="pane-title"></span><span class="pane-project"></span><span class="agent-state"></span><span class="pane-cwd"></span>
        <button class="small-button" data-action="attach" data-id="${escape(chat.id)}" title="Insert file paths into the prompt">+ file</button>
        <button class="small-button pin-button" data-action="pin" data-id="${escape(chat.id)}"></button>
        <button class="small-button" data-action="pane-menu" data-id="${escape(chat.id)}" title="More">···</button>
        <button class="small-button" data-action="close" data-id="${escape(chat.id)}" title="Close (the conversation is kept)">×</button>
      </header>
      <div class="pane-body"><div class="terminal-host"></div><div class="pane-overlay" hidden></div></div>`;
    this.unseen = false;
    this.view = new TerminalView(this.el.querySelector('.terminal-host'), {
      theme: state.theme,
      fontSize: state.settings.fontSize,
      fontFamily: currentFont,
      tool: chat.tool === 'shell' ? null : store.engineOf(chat.tool),
      onFocus: () => activate(this.chatId),
      onStatus: () => { this.renderOverlay(); this.renderState(); renderSidebar(); renderTabs(); renderStatus(); },
      onEvent: event => this.handleEvent(event),
      onAgentState: (next, previous) => this.agentChanged(next, previous),
    });
    this.update();
    this.renderState();
  }

  get chat() { return chatById(this.chatId); }

  // On screen right now: on the current page or in the dock, not parked with another page.
  get visible() { return this.el.offsetParent !== null; }

  // starting, working, waiting (for you), done (finished while you were elsewhere), ready, stopped or failed.
  get display() {
    const { status, agent } = this.view;
    if (status === 'idle' || status === 'starting') return 'starting';
    if (status === 'failed') return 'failed';
    if (status !== 'running') return 'stopped';
    if (this.chat?.tool === 'shell') return 'ready';
    if (agent.state === 'idle') return this.unseen ? 'done' : 'ready';
    return agent.state;
  }

  renderState() {
    const shown = this.display;
    const label = this.el.querySelector('.agent-state');
    label.innerHTML = shown === 'working' ? `working${dots}` : stateLabels[shown];
    label.className = `agent-state is-${shown}`;
    this.el.dataset.state = shown;
  }

  agentChanged(next, previous) {
    const watched = document.hasFocus() && this.visible;
    const pinned = store.isPinned(state, this.chatId);
    if (next === 'idle' && previous === 'working') this.unseen = !(watched && (pinned || page().active === this.chatId));
    else if (next !== 'idle') this.unseen = false;
    this.renderState();
    renderSidebar();
    renderTabs();
    renderStatus();
    const finished = next === 'idle' && previous === 'working';
    if (!watched && this.chat && (next === 'waiting' || finished)) notifyChat(this.chat, next === 'waiting');
  }

  seen() {
    if (!this.unseen) return;
    this.unseen = false;
    this.renderState();
    renderSidebar();
    renderTabs();
    renderStatus();
  }

  update() {
    const chat = this.chat;
    if (!chat) return;
    const info = toolInfo[chat.tool];
    const pinned = store.isPinned(state, chat.id);
    this.el.style.setProperty('--tool', info.color);
    this.el.querySelector('.tool-tag').textContent = info.tag;
    this.el.querySelector('.tool-tag').title = chat.tool === 'local' ? `${chat.model} on ${chat.server}, in OpenCode` : info.name;
    this.el.querySelector('.pane-title').textContent = chat.title;
    // In the dock a chat could belong to any project, so its header names it.
    this.el.querySelector('.pane-project').textContent = pinned ? `· ${projectName(chat)}` : '';
    const cwd = projectPath(chat) || homePath;
    this.el.querySelector('.pane-cwd').textContent = pinned ? '' : shortPath(cwd);
    this.el.querySelector('.pane-cwd').title = cwd;
    const pin = this.el.querySelector('.pin-button');
    pin.textContent = pinned ? 'unpin' : 'pin';
    pin.title = pinned ? 'Unpin: move back to its project page' : 'Pin: keep this chat on the right on every page';
  }

  handleEvent(event) {
    const chat = this.chat;
    if (event.type === 'session' && chat) { chat.sessionId = event.id; save(); }
    if (event.type === 'restart') this.start();
  }

  start({ fresh = false } = {}) {
    const chat = this.chat;
    if (!chat) return;
    if (fresh) store.startNewConversation(chat);
    store.ensureSessionId(chat);
    save();
    if (this.view.status !== 'idle') this.view.reset();
    const shell = chat.tool === 'shell', local = chat.tool === 'local';
    const engine = store.engineOf(chat.tool);
    // A local-model chat runs OpenCode with its own server and model, without OpenCode's extra options
    // (a --model there would pick a different model).
    return this.view.start({ kind: shell ? 'shell' : 'chat', chatId: chat.id, tool: shell ? null : engine, sessionId: chat.sessionId,
      knownSessions: state.chats.filter(c => c.id !== chat.id && c.sessionId).map(c => c.sessionId),
      cwd: projectPath(chat) || null, toolPath: state.toolPaths[engine] ?? null,
      local: local ? { server: chat.server, model: chat.model } : null,
      extraArgs: shell || local ? [] : store.splitArgs(state.settings.toolArgs[chat.tool] ?? '') })
      .then(() => this.view.status === 'running' && this.chatId === page().active && this.visible && this.view.focus());
  }

  renderOverlay() {
    const overlay = this.el.querySelector('.pane-overlay');
    const { status, error, exitCode } = this.view;
    const chat = this.chat;
    if (!chat || (status !== 'exited' && status !== 'failed')) { overlay.hidden = true; return; }
    const id = escape(chat.id);
    const name = toolInfo[chat.tool].name;
    overlay.hidden = false;
    overlay.className = `pane-overlay ${status}`;
    if (status === 'exited') {
      const shell = chat.tool === 'shell';
      overlay.innerHTML = `<span>${shell ? 'The terminal closed' : `${name} stopped`}${exitCode ? ` (exit code ${exitCode})` : ''}.</span>
        <button data-action="resume" data-id="${id}">${shell ? 'restart' : 'resume'}</button>
        ${shell ? '' : `<button data-action="new-conversation" data-id="${id}">new conversation</button>`}<span class="dim">or press Enter</span>`;
      return;
    }
    const buttons = [];
    if (backend.isDesktop) buttons.push(`<button data-action="resume" data-id="${id}">try again</button>`);
    if (/isn't installed|isn't at/.test(error)) buttons.push('<button class="primary" data-action="tools">set up AI tools</button>');
    if (/^Folder not found/.test(error) && chat.projectId) buttons.push(`<button data-action="edit-project" data-id="${escape(chat.projectId)}">change folder</button>`);
    overlay.innerHTML = `<div class="overlay-card"><strong>${escape(name)} couldn’t start</strong><p>${escape(error)}</p><div>${buttons.join('')}</div></div>`;
  }

  insertPaths(paths) {
    if (this.view.status !== 'running' || !paths.length) return;
    const base = this.chat?.tool === 'shell' ? '' : projectPath(this.chat);
    this.view.paste(paths.map(path => quotePath(relativeTo(path, base))).join(' ') + ' ');
  }

  dispose() {
    this.view.dispose();
    this.el.remove();
  }
}

function relativeTo(path, base) {
  if (!base) return path;
  const root = /[\\/]$/.test(base) ? base : base + (base.includes('\\') && !base.includes('/') ? '\\' : '/');
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function quotePath(path) {
  if (/^[\w@%+=:,./\\-]+$/.test(path)) return path;
  return isWindowsPath(path) ? `"${path}"` : `'${path.replace(/'/g, `'\\''`)}'`;
}
const isWindowsPath = path => /^[A-Za-z]:\\/.test(path) || path.startsWith('\\\\');

// Every running chat has a pane: on the current page, in the dock if pinned, or parked out of
// sight while its page isn't shown, still running.
function syncPanes() {
  const running = new Set(store.runningChatIds(state));
  for (const [id, pane] of panes) {
    if (!running.has(id) || !chatById(id)) { pane.dispose(); panes.delete(id); }
  }
  const created = [];
  for (const id of running) {
    if (panes.has(id)) continue;
    const pane = new Pane(chatById(id));
    panes.set(id, pane);
    created.push(pane);
  }
  const grid = $('#panes'), dock = $('#dock'), parked = $('#parked');
  const onPage = new Set(page().open);
  for (const [id, pane] of panes) {
    pane.update();
    const home = store.isPinned(state, id) ? dock : onPage.has(id) ? grid : parked;
    if (pane.el.parentElement !== home) home.append(pane.el);
  }
  renderDock();
  layoutPanes();
  // Start once the layout is in place so each terminal opens at its real size; restored panes start a moment apart.
  created.forEach((pane, i) => setTimeout(() => panes.get(pane.chatId) === pane && pane.start(), i * 250));
}

function layoutPanes() {
  const container = $('#panes');
  const current = page();
  const visible = current.layout === 'focus' ? current.open.filter(id => id === current.active) : current.open;
  const n = visible.length;
  let cols = 1, rows = 1;
  if (current.layout === 'grid') { cols = n <= 1 ? 1 : n <= 4 ? 2 : 3; rows = Math.max(1, Math.ceil(n / cols)); }
  if (current.layout === 'columns') cols = Math.max(1, n);
  container.style.gridTemplateColumns = current.layout === 'columns' ? `repeat(${cols}, minmax(360px, 1fr))` : `repeat(${cols}, minmax(0, 1fr))`;
  container.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  container.hidden = n === 0;
  // The last pane stretches across empty grid cells, so an odd number of panes leaves no hole.
  const lastRow = n - cols * (rows - 1);
  current.open.forEach((id, index) => {
    const pane = panes.get(id);
    if (!pane) return;
    const shown = visible.includes(id);
    pane.el.hidden = !shown;
    pane.el.style.order = String(index);
    const last = shown && visible.indexOf(id) === n - 1;
    pane.el.style.gridColumn = current.layout === 'grid' && last && lastRow < cols ? `span ${cols - lastRow + 1}` : '';
    pane.el.classList.toggle('active', id === current.active);
  });
  // Pinned panes keep the dock's order (set in renderDock) and ignore the page's grid.
  for (const id of store.pinnedChatIds(state)) {
    const pane = panes.get(id);
    if (!pane) continue;
    pane.el.hidden = false;
    pane.el.style.gridColumn = '';
    pane.el.classList.remove('active');
  }
}

// The dock holds pinned chats and widgets, in the order they were pinned.
let usageWidget = null;
function renderDock() {
  const dock = $('#dock');
  const shown = state.pinned.length > 0;
  dock.hidden = !shown;
  $('#dock-resizer').hidden = !shown;
  if (state.pinned.includes('usage')) {
    usageWidget ??= Object.assign(document.createElement('section'), { className: 'widget usage-widget' });
    if (usageWidget.parentElement !== dock) dock.append(usageWidget);
  } else if (usageWidget) {
    usageWidget.remove();
    usageWidget = null;
  }
  state.pinned.forEach((key, index) => {
    const el = key === 'usage' ? usageWidget : panes.get(key.slice(5))?.el;
    if (el) el.style.order = String(index);
  });
}

function activate(id) {
  panes.get(id)?.seen();
  const current = page();
  if (current.active === id || !current.open.includes(id)) return;
  current.active = id;
  save();
  renderSidebar();
  renderTabs();
  layoutPanes();
}

function focusChat(id) {
  if (!store.isPinned(state, id)) store.openChat(state, id);
  update();
  panes.get(id)?.seen();
  requestAnimationFrame(() => { const view = panes.get(id)?.view; if (view?.status === 'running') view.focus(); });
}

function goToPage(key) {
  store.goToPage(state, key);
  update();
  const active = panes.get(page().active);
  requestAnimationFrame(() => { if (active?.view.status === 'running') active.view.focus(); active?.seen(); });
}

// Usage: a panel from the header, or a widget pinned to the dock.
function usageHtml({ widget = false } = {}) {
  if (!backend.isDesktop) return `<p class="dim">${escape(backend.desktopOnly)}</p>`;
  if (!usage) return `<p class="dim">${usageError ? escape(usageError) : 'Reading usage…'}</p>`;
  const totals = usageTotals(usage);
  const sum = (key, field) => totals.reduce((n, t) => n + t[key][field], 0);
  const cost = sum('week', 'cost');
  const rows = totals.map(t => {
    const info = toolInfo[t.id];
    const limits = t.limits.map(l => {
      const reset = l.resetsAt && l.resetsAt < Date.now();
      const used = Math.round(l.usedPercent);
      return `<div class="limit" title="${escape(l.label)} limit">
        <span class="limit-label">${escape(l.label)}</span><span class="meter" role="meter" aria-label="${escape(info.name)} ${escape(l.label)} allowance used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, used))}"><span style="width:${Math.max(0, Math.min(100, used))}%" class="${used >= 80 ? 'high' : ''}"></span></span>
        <span class="limit-value">${used}% used</span>
        ${l.resetsAt ? `<span class="limit-reset dim">${reset ? 'Window ended · awaiting refresh' : `Resets in ${escape(formatLimitCountdown(l.resetsAt))} · ${escape(formatLimitReset(l.resetsAt))}`}</span>` : ''}</div>`;
    }).join('');
    const quiet = !t.week.replies && !t.limits.length;
    const detail = quiet ? `<p class="dim">${escape(t.problem ?? 'Not used in the last 7 days.')}</p>`
      : `<div class="usage-numbers"><span><b>${formatTokens(t.today.input + t.today.output)}</b> today</span><span><b>${formatTokens(t.week.input + t.week.output)}</b> this week</span>
        <span class="dim">${t.id === 'opencode' ? plural(t.week.replies, 'session') : plural(t.week.replies, 'reply', 'replies')} · ${formatTokens(t.week.cached)} cached${t.week.cost ? ` · $${t.week.cost.toFixed(2)}` : ''}</span></div>`;
    return `<section class="usage-tool ${quiet ? 'quiet' : ''}" style="--tool:${info.color}">
      <h3>${info.name}${t.plan ? ` <span class="dim">${escape(t.plan)} plan</span>` : ''}</h3>${limits}
      ${t.limitsProblem ? `<p class="usage-problem">${escape(t.limitsProblem)}${t.limitsUpdatedAt && t.limits.length ? ` Showing last-known allowances from ${escape(new Date(t.limitsUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}.` : ''}</p>` : ''}
      ${detail}</section>`;
  }).join('');
  const updated = new Date(usage.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${usageError ? `<p class="usage-problem">${escape(usageError)} Showing the last available report.</p>` : ''}<div class="usage-summary">
      <div><b>${formatTokens(sum('today', 'input') + sum('today', 'output'))}</b><span>tokens today</span></div>
      <div><b>${formatTokens(sum('week', 'input') + sum('week', 'output'))}</b><span>this week</span></div>
      <div><b>${sum('week', 'replies')}</b><span>replies this week</span></div>
      ${cost ? `<div><b>$${cost.toFixed(2)}</b><span>cost this week</span></div>` : ''}
    </div>
    <div class="usage-tools">${rows}</div>
    <p class="usage-note dim">Allowances are read from your signed-in Claude and Codex accounts. Token totals cover this computer; cached context is separate. Updated ${escape(updated)}.${widget ? '' : ' Allowances refresh periodically; other tools show their local records.'}</p>`;
}

function renderUsage() {
  renderHeader();
  const panel = $('#usage-panel');
  if (!panel.hidden) {
    const pinned = state.pinned.includes('usage');
    panel.innerHTML = `<header><h2>AI usage</h2><div><button data-action="refresh-usage" ${usageRequest ? 'disabled' : ''}>${usageRequest ? 'reading…' : 'refresh'}</button><button data-action="pin-usage">${pinned ? 'unpin' : 'pin to side'}</button><button data-action="usage" aria-label="Close">×</button></div></header>${usageHtml()}`;
  }
  if (usageWidget) {
    usageWidget.innerHTML = `<header class="widget-header"><span class="widget-title">AI usage</span><span class="dim">all AIs</span><button class="small-button" data-action="refresh-usage" ${usageRequest ? 'disabled' : ''}>${usageRequest ? 'reading…' : 'refresh'}</button><button class="small-button" data-action="pin-usage" title="Unpin">unpin</button></header><div class="widget-body">${usageHtml({ widget: true })}</div>`;
  }
}

let usageTimer = null;
let usageInterval = 0;
let usageRequest = null;
function refreshUsage(refreshLimits = false) {
  if (!backend.isDesktop) return renderUsage();
  if (usageRequest) return usageRequest;
  usageRequest = backend.usageSummary(state.toolPaths, refreshLimits)
    .then(report => { usage = report; usageError = ''; trackResets(resets, report); })
    .catch(error => { usageError = `Couldn’t read usage: ${error}`; })
    .finally(() => { usageRequest = null; renderUsage(); });
  renderUsage();
  return usageRequest;
}
// Allowance resets are checked every half minute, so a notification arrives close to the time
// even though usage itself is read less often; the usage is then read again to show the new window.
const resets = new Map();
setInterval(() => {
  const due = takeDueResets(resets);
  if (!due.length) return;
  if (state.settings.notifyResets) {
    for (const reset of due) {
      const label = reset.label.charAt(0).toUpperCase() + reset.label.slice(1);
      backend.notify(`${toolInfo[reset.tool].name}: usage reset`, `${label} allowance is available again (it was ${Math.round(reset.usedPercent)}% used).`);
    }
  }
  refreshUsage(true);
}, 30_000);

// Keep allowances visible in the header; refresh local totals more often while expanded.
function watchUsage() {
  if (!backend.isDesktop) return;
  const wanted = !$('#usage-panel').hidden || state.pinned.includes('usage');
  const interval = wanted ? 60_000 : 300_000;
  if (interval === usageInterval) return;
  const first = !usageTimer;
  clearInterval(usageTimer);
  usageInterval = interval;
  usageTimer = setInterval(() => refreshUsage(), interval);
  if (first || wanted) refreshUsage();
}

function toggleUsagePanel(open = $('#usage-panel').hidden) {
  const panel = $('#usage-panel');
  panel.hidden = !open;
  $('#usage-button').setAttribute('aria-expanded', String(open));
  if (open) {
    const button = $('#usage-button').getBoundingClientRect();
    panel.style.top = `${button.bottom + 6}px`;
    panel.style.right = `${Math.max(8, innerWidth - button.right)}px`;
    renderUsage();
  }
  watchUsage();
}

// Dialogs are created per use and removed when closed.
function showDialog(html, { onSubmit, onClose, className = '' } = {}) {
  document.querySelectorAll('dialog.app-dialog[open]').forEach(d => d.close());
  const dialog = document.createElement('dialog');
  dialog.className = `app-dialog ${className}`;
  dialog.innerHTML = `<form>${html}</form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await onSubmit?.(new FormData(form), form, event.submitter) !== false) dialog.close();
  });
  dialog.addEventListener('click', event => { if (event.target.closest('[data-dismiss]')) dialog.close(); });
  dialog.addEventListener('close', () => { onClose?.(); dialog.remove(); });
  dialog.showModal();
  dialog.querySelector('[autofocus]')?.focus();
  return dialog;
}

function showFormError(form, message) {
  const error = form.querySelector('.form-error');
  error.textContent = message;
  error.hidden = false;
}

function settingsDialog({ focus = '' } = {}) {
  const s = state.settings;
  const toggle = (name, label, note) => `<label class="check"><input type="checkbox" name="${name}" ${s[name] ? 'checked' : ''}><span>${label}<small>${note}</small></span></label>`;
  const dialog = showDialog(`<h2>Settings</h2>
    <fieldset><legend>Appearance</legend>
      <label class="row">Theme<select name="theme">${THEME_GROUPS.map(group => `<optgroup label="${group}">${THEME_LIST.filter(t => t.group === group).map(t => `<option value="${t.id}" ${state.theme === t.id ? 'selected' : ''}>${escape(t.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <div class="theme-swatches" aria-hidden="true"></div>
      <label class="row">Font<select name="font">${FONT_LIST.map(f => `<option value="${f.id}" ${s.font === f.id ? 'selected' : ''}>${escape(f.name)}</option>`).join('')}</select></label>
      <label class="row">Terminal text size<input type="number" name="fontSize" min="9" max="24" value="${s.fontSize}"></label>
    </fieldset>
    <fieldset><legend>Alerts</legend>
      ${toggle('flash', 'Flash its chat', 'The chat’s dot, tab and border flash until you look at it.')}
      ${toggle('notifications', 'Desktop notifications', 'When an AI asks for approval or a choice, and when it finishes and is ready for your next prompt. Only for chats you can’t see at the moment.')}
      ${toggle('notifyResets', 'Notify when usage resets', 'When a Claude or Codex session or weekly allowance you’ve used starts over. Antigravity CLI and OpenCode don’t report allowances.')}
    </fieldset>
    <fieldset><legend>Starting up</legend>
      ${toggle('reopenChats', 'Reopen chats from last time', 'Each one resumes its conversation.')}
    </fieldset>
    <fieldset><legend>Updates</legend>
      <div class="update-status"></div>
      ${toggle('checkUpdates', 'Check for updates when the app starts', 'Looks for a newer release on GitHub. Nothing is installed until you choose to.')}
    </fieldset>
    <fieldset><legend>Safeguards</legend>
      ${toggle('confirmRemove', 'Ask before removing a chat', 'Shows “Are you sure?” when you remove a chat with × in the sidebar or “Delete chat…”.')}
    </fieldset>
    <fieldset><legend>AI tools</legend>
      <p class="dialog-note">Extra command-line options, added whenever that tool starts a chat. They apply to chats started from now on.</p>
      ${store.AI_TOOLS.map(t => `<label class="row">${toolInfo[t].name}<input name="args-${t}" value="${escape(s.toolArgs[t] ?? '')}" placeholder="${t === 'codex' ? 'e.g. --approve-for-me' : t === 'claude' ? 'e.g. --model sonnet' : ''}" autocomplete="off" spellcheck="false"></label>`).join('')}
      <button type="button" data-action="tools">sign in, install or choose where each tool is…</button>
    </fieldset>
    <fieldset><legend>Local models</legend>
      <label class="row">Model server<input name="localServer" value="${escape(s.localServer)}" placeholder="this computer" autocomplete="off" spellcheck="false"></label>
      <div class="local-status"></div>
      <p class="dialog-note">For “Local model” chats: LM Studio, Ollama, or another server with the same OpenAI-compatible API. Leave this empty to use one on this computer, or enter another computer’s address and port, such as 192.168.1.20:1234 for LM Studio or 192.168.1.20:11434 for Ollama; that server has to accept connections from the network. The chats run in OpenCode with the model you pick.</p>
    </fieldset>
    <div class="dialog-actions"><button type="submit" class="primary">done</button></div>`, { className: 'settings-dialog' });
  const form = dialog.querySelector('form');
  refreshUpdateStatus = () => renderUpdateStatus(dialog.querySelector('.update-status'));
  refreshUpdateStatus();
  const showLocal = () => renderLocalStatus(dialog.querySelector('.local-status'));
  localListeners.add(showLocal);
  checkLocalServer();
  showLocal();
  let localTimer = null;
  dialog.addEventListener('click', event => { if (event.target.closest('[data-local-check]')) checkLocalServer(); });
  dialog.addEventListener('close', () => { refreshUpdateStatus = null; localListeners.delete(showLocal); clearTimeout(localTimer); });
  if (focus) dialog.querySelector(`[name="${focus}"]`)?.focus();
  // A strip of the theme's terminal colors, so you can see it before closing the dialog.
  const showSwatches = () => {
    const t = (THEMES[state.theme] ?? THEMES[DEFAULT_THEME]).terminal;
    dialog.querySelector('.theme-swatches').innerHTML = ['background', 'foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'brightBlack']
      .map(key => `<span style="background:${t[key]}" title="${key}"></span>`).join('');
  };
  showSwatches();
  form.addEventListener('input', event => {
    const field = event.target;
    if (field.name === 'theme') {
      state.theme = field.value;
      panes.forEach(pane => pane.view.setTheme(state.theme));
      showSwatches();
    } else if (field.name === 'font') {
      s.font = field.value;
      applyFont();
    } else if (field.name === 'fontSize') {
      const size = Number(field.value);
      if (size >= 9 && size <= 24) {
        s.fontSize = size;
        panes.forEach(pane => pane.view.setFontSize(size));
      }
    } else if (field.name.startsWith('args-')) {
      const tool = field.name.slice(5);
      if (field.value.trim()) s.toolArgs[tool] = field.value; else delete s.toolArgs[tool];
    } else if (field.name === 'localServer') {
      // Ask the new address once typing pauses.
      s.localServer = field.value.trim();
      clearTimeout(localTimer);
      localTimer = setTimeout(checkLocalServer, 600);
    } else if (field.type === 'checkbox') {
      s[field.name] = field.checked;
    }
    update();
  });
}

// Updates: checked at startup (unless turned off) and from Settings. Installing replaces the app
// and restarts it. A copy that can't replace itself where it's installed gets a download link.
const updates = { status: 'idle', version: '', current: '', notes: '', progress: 0, error: '', offer: null, canInstall: false };
let refreshUpdateStatus = null;

function showUpdate() {
  const button = $('#update-button');
  const ready = updates.status === 'available' || updates.status === 'ready';
  button.hidden = !ready;
  button.textContent = updates.status === 'ready' ? 'restart to update' : `update ${updates.version}`;
  refreshUpdateStatus?.();
}

function renderUpdateStatus(box) {
  const u = updates;
  const version = u.current ? `Version ${escape(u.current)}` : 'AI Workbench';
  const line = {
    idle: version,
    checking: `${version} · checking…`,
    none: `${version} · up to date`,
    available: `${version} · <span class="accent">version ${escape(u.version)} is available</span>`,
    downloading: `${version} · downloading ${escape(u.version)}… ${u.progress ? `${Math.round(u.progress * 100)}%` : ''}`,
    ready: `${version} · <span class="accent">${escape(u.version)} is installed; restart to use it</span>`,
    error: `${version} · <span class="warn">${escape(u.error)}</span>`,
  }[u.status];
  const buttons = [];
  if (!backend.isDesktop) buttons.push('<span class="dim">Updates work in the desktop app.</span>');
  else if (u.status === 'available' && u.canInstall) buttons.push(`<button type="button" class="primary" data-update="install">download and install ${escape(u.version)}</button>`);
  else if (u.status === 'available') buttons.push(`<button type="button" class="primary" data-update="download">get ${escape(u.version)} from GitHub ↗</button>`);
  else if (u.status === 'ready') buttons.push('<button type="button" class="primary" data-update="restart">restart now</button>');
  if (backend.isDesktop && !['checking', 'downloading', 'ready'].includes(u.status)) buttons.push('<button type="button" data-update="check">check for updates</button>');
  const notes = u.notes && (u.status === 'available' || u.status === 'ready') ? `<p class="dialog-note update-notes">${escape(u.notes)}</p>` : '';
  const manual = u.status === 'available' && !u.canInstall
    ? '<p class="dialog-note">This copy can’t replace itself where it’s installed (for example, a folder you can’t write to): download the new version, or update it the way you installed it.</p>' : '';
  box.innerHTML = `<p class="update-line">${line}</p>${notes}${manual}<div class="update-actions">${buttons.join('')}</div>`;
}

async function checkUpdates({ quiet = false } = {}) {
  if (!backend.isDesktop || updates.status === 'checking' || updates.status === 'downloading' || updates.status === 'ready') return;
  updates.current ||= await backend.appVersion().catch(() => '');
  Object.assign(updates, { status: 'checking', error: '' });
  showUpdate();
  try {
    const { canInstall, target } = await backend.updateSupport();
    const offer = await backend.checkForUpdate(target);
    Object.assign(updates, offer ? { status: 'available', version: offer.version, notes: offer.body ?? '', offer, canInstall } : { status: 'none', offer: null });
    if (offer && quiet && state.settings.notifications) backend.notify('AI Workbench update available', `Version ${offer.version} is ready to install from Settings.`);
  } catch (error) {
    // Offline, or no release has been published yet: a startup check says nothing about it.
    Object.assign(updates, quiet ? { status: 'idle' } : { status: 'error', error: `Couldn’t check for updates (${String(error).slice(0, 120)})` });
  }
  showUpdate();
}

async function installUpdate() {
  const offer = updates.offer;
  if (!offer) return;
  Object.assign(updates, { status: 'downloading', progress: 0 });
  showUpdate();
  let total = 0, received = 0;
  try {
    await offer.downloadAndInstall(event => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      else if (event.event === 'Progress') { received += event.data.chunkLength; updates.progress = total ? received / total : 0; refreshUpdateStatus?.(); }
    });
    updates.status = 'ready';
  } catch (error) {
    Object.assign(updates, { status: 'error', error: `The update didn’t install (${String(error).slice(0, 120)})` });
  }
  showUpdate();
}

function restartForUpdate() {
  const running = store.runningChatIds(state).length;
  const restart = () => backend.relaunch();
  if (!running) return restart();
  confirmDialog({ title: 'Restart AI Workbench?',
    body: `${plural(running, 'running chat')} will stop. ${state.settings.reopenChats ? 'They reopen and resume their conversations when the app starts again.' : 'Their conversations are kept; open them again from the sidebar.'}`,
    confirm: 'restart now', onConfirm: restart });
}

document.addEventListener('click', event => {
  const action = event.target.closest('[data-update]')?.dataset.update;
  if (action === 'check') checkUpdates();
  else if (action === 'install') installUpdate();
  else if (action === 'restart') restartForUpdate();
  else if (action === 'download') backend.openLink(backend.releasesUrl);
});

function projectDialog(existing = null, preset = {}) {
  const dialog = showDialog(`<h2>${existing ? 'Edit project' : 'Add a project'}</h2>
    <label>Folder<span class="input-row"><input name="path" required value="${escape(existing?.path ?? preset.path ?? '')}" placeholder="/path/to/your/project" autocomplete="off" autofocus><button type="button" data-pick-folder>browse…</button></span>
      <small>The AI tools run inside this folder and can read and change its files.</small></label>
    <label>Name<input name="name" value="${escape(existing?.name ?? '')}" placeholder="the folder’s name" autocomplete="off"></label>
    <p class="form-error" hidden></p>
    <div class="dialog-actions"><button type="button" data-dismiss>cancel</button><button type="submit" class="primary">${existing ? 'save' : 'add project'}</button></div>`, {
    onSubmit: async (data, form) => {
      let path = String(data.get('path')).trim();
      if (path.length > 1 && !/^[A-Za-z]:\\$/.test(path)) path = path.replace(/[\\/]+$/, '');
      const info = await backend.pathInfo(path);
      if (info && !info.isDir) {
        showFormError(form, info.exists ? 'That’s a file. Choose a folder.' : 'That folder doesn’t exist.');
        return false;
      }
      const name = String(data.get('name')).trim() || info?.name || path.split(/[\\/]/).filter(Boolean).pop() || path;
      if (existing) {
        Object.assign(existing, { name, path });
        missingFolders.delete(existing.id);
      } else {
        const project = store.addProject(state, name, path);
        store.goToPage(state, project.id);
      }
      update();
    },
  });
  dialog.querySelector('[data-pick-folder]').onclick = async () => {
    const input = dialog.querySelector('[name=path]');
    const picked = await backend.pickFolder(input.value || homePath);
    if (picked) input.value = picked;
  };
}

function toolChoice(tool) {
  const status = tool === 'shell' ? { level: 'ready', text: 'your own shell' } : describeStatus(tools?.[tool]);
  const missing = status.level === 'missing';
  return `<button type="${missing ? 'button' : 'submit'}" name="tool" value="${tool}" class="tool-choice is-${status.level}" style="--tool:${toolInfo[tool].color}" ${missing ? 'data-action="tools"' : ''}>
    <strong>${toolInfo[tool].name}</strong><span>${missing ? 'not installed · set up' : escape(status.text)}</span></button>`;
}

// The model server in Settings → Local models (LM Studio, Ollama…) and the models it offers. It's
// checked whenever the new-chat dialog or the settings open, and when the address changes.
const localServer = { status: 'idle', server: '', name: '', models: [], error: '' };
const localListeners = new Set();
let localCheck = 0;

function checkLocalServer() {
  if (!backend.isDesktop) return;
  // Only the latest check counts: an earlier one may be about an address that has since changed.
  const check = ++localCheck;
  const latest = () => check === localCheck;
  Object.assign(localServer, { status: 'checking', error: '' });
  localListeners.forEach(listener => listener());
  backend.localModels(state.settings.localServer).then(
    found => latest() && Object.assign(localServer, { status: 'ready', server: found.server, name: found.name, models: found.models }),
    error => latest() && Object.assign(localServer, { status: 'error', server: '', name: '', models: [], error: String(error?.message ?? error) }),
  ).finally(() => latest() && localListeners.forEach(listener => listener()));
}

function renderLocalStatus(box) {
  const l = localServer;
  const line = !backend.isDesktop ? '<span class="dim">Local models work in the desktop app.</span>'
    : l.status === 'ready' ? `<span class="accent">${escape(l.name)}</span> at ${escape(l.server)} · ${l.models.length ? `${plural(l.models.length, 'model')}: ${escape(l.models.map(store.modelLabel).join(', '))}` : 'no models loaded'}`
    : l.status === 'error' ? `<span class="warn">${escape(l.error)}</span>`
    : 'looking for a model server…';
  const check = backend.isDesktop && l.status !== 'checking' ? '<div class="local-actions"><button type="button" data-local-check>check again</button></div>' : '';
  box.innerHTML = `<p class="local-line">${line}</p>${check}`;
}

function localChoice() {
  const l = localServer;
  const choice = (level, text, { submit = false, action = '' } = {}) => `<button type="${submit ? 'submit' : 'button'}" name="tool" value="local" class="tool-choice is-${level}" style="--tool:${toolInfo.local.color}" ${action ? `data-action="${action}"` : ''}>
    <strong>${toolInfo.local.name}</strong><span>${escape(text)}</span></button>`;
  if (!backend.isDesktop) return choice('unknown', 'desktop app only');
  if (describeStatus(tools?.opencode).level === 'missing') return choice('missing', 'needs OpenCode · set up', { action: 'tools' });
  if (l.status === 'ready' && l.models.length) return choice('ready', `${l.name} · ${plural(l.models.length, 'model')}`, { submit: true });
  if (l.status === 'ready') return choice('warn', `${l.name} has no models · set up`, { action: 'local-settings' });
  if (l.status === 'error') return choice('missing', 'no model server · set up', { action: 'local-settings' });
  return choice('unknown', 'looking for a model server…');
}

function newChatDialog(projectId, parentId = null, selectedTool = null) {
  const parent = chatById(parentId);
  const where = [`<option value="">No project (home folder)</option>`,
    ...state.projects.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)} — ${escape(shortPath(p.path))}</option>`)];
  const dialog = showDialog(`<h2>${parent ? `Open AI under ${escape(parent.title)}` : 'New chat'}</h2>
    <label>Where<select name="project" ${parent ? 'disabled' : ''}>${where.join('')}</select></label>
    <label>Title <span class="dim">(optional)</span><input name="title" maxlength="120" placeholder="e.g. Fix the login bug" autocomplete="off"></label>
    <div class="tool-picker" role="group" aria-label="AI">${(selectedTool ? [selectedTool] : parent ? store.DELEGATION_TOOLS : store.TOOLS).map(tool => tool === 'local' ? localChoice() : toolChoice(tool)).join('')}</div>
    <label class="local-model" hidden>Local model<select name="model"></select><small></small></label>
    <p class="dialog-note">${parent ? 'The parent can send tasks to this AI and read its terminal output. Use a unique name, then choose “Delegation instructions…” on the parent chat.' : 'Each chat keeps its own conversation. Close it any time; it picks up where it left off.'}</p>
    <div class="dialog-actions"><button type="button" data-dismiss>cancel</button></div>`, {
    className: 'new-chat',
    onSubmit: (data, form, submitter) => {
      const tool = submitter?.value;
      if (!store.TOOLS.includes(tool)) return false;
      const model = String(data.get('model') ?? '');
      if (tool === 'local' && !(localServer.status === 'ready' && localServer.models.includes(model))) return false;
      store.addChat(state, tool, parent ? parent.projectId : String(data.get('project')) || null, String(data.get('title')), tool === 'local' ? { server: localServer.server, model } : null, parentId);
      update();
    },
    onClose: () => localListeners.delete(showLocal),
  });
  // The model list fills in once the server answers; the last model used is picked again.
  function showLocal() {
    const localButton = dialog.querySelector('.tool-choice[value=local]');
    if (!localButton) return;
    localButton.outerHTML = localChoice();
    const row = dialog.querySelector('.local-model');
    row.hidden = !(localServer.status === 'ready' && localServer.models.length && describeStatus(tools?.opencode).level !== 'missing');
    if (row.hidden) return;
    const select = row.querySelector('select');
    const pick = select.value || state.chats.findLast(c => c.tool === 'local')?.model;
    select.innerHTML = localServer.models.map(m => `<option value="${escape(m)}" ${m === pick ? 'selected' : ''}>${escape(m)}</option>`).join('');
    const from = localServer.name === 'Model server' ? 'the model server' : localServer.name;
    row.querySelector('small').textContent = `From ${from} at ${localServer.server}. The chat runs in OpenCode.`;
  }
  localListeners.add(showLocal);
  showLocal();
  checkLocalServer();
  document.querySelector('.new-chat .tool-choice:not(.is-missing)')?.focus();
}

function renameDialog(id) {
  const chat = chatById(id);
  if (!chat) return;
  const dialog = showDialog(`<h2>Rename chat</h2><label>Title<input name="title" value="${escape(chat.title)}" maxlength="120" required autocomplete="off" autofocus></label>
    <div class="dialog-actions"><button type="button" data-dismiss>cancel</button><button type="submit" class="primary">save</button></div>`, {
    onSubmit: data => {
      chat.title = String(data.get('title')).trim() || chat.title;
      panes.get(id)?.update();
      update();
    },
  });
  dialog.querySelector('input').select();
}

function confirmDialog({ title, body, confirm, onConfirm }) {
  showDialog(`<h2>${title}</h2><p class="dialog-note">${body}</p>
    <div class="dialog-actions"><button type="button" data-dismiss autofocus>cancel</button><button type="submit" class="danger">${confirm}</button></div>`,
    { onSubmit: () => onConfirm() });
}

function deleteChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  if (!state.settings.confirmRemove) {
    store.removeChat(state, id);
    update();
    return;
  }
  const kept = chat.tool === 'shell' ? '' : ` Its conversation stays in ${toolInfo[store.engineOf(chat.tool)].name}’s own history.`;
  confirmDialog({ title: 'Are you sure?', body: `“${escape(chat.title)}” will be removed from AI Workbench.${kept}`,
    confirm: 'delete chat', onConfirm: () => { store.removeChat(state, id); update(); } });
}

function removeProject(id) {
  const project = projectById(id);
  if (!project) return;
  const count = state.chats.filter(c => c.projectId === id).length;
  confirmDialog({ title: 'Remove project?',
    body: `“${escape(project.name)}”${count ? ` and its ${plural(count, 'chat')}` : ''} will be removed from AI Workbench. The folder and its files are not touched.`,
    confirm: 'remove project', onConfirm: () => { store.removeProject(state, id); missingFolders.delete(id); update(); } });
}

function toolCard(tool) {
  const s = tools?.[tool];
  const status = backend.isDesktop ? describeStatus(s) : { level: 'unknown', text: 'desktop app only' };
  const custom = state.toolPaths[tool];
  const needsNode = s && !s.path && s.installNeedsNode && !s.nodeFound;
  const actions = [];
  if (s?.path) actions.push(`<button type="button" class="${s.signedIn === false ? 'primary' : ''}" data-login="${tool}">${s.signedIn === true ? 'sign in again' : 'sign in'}</button>`);
  else if (s) actions.push(`<button type="button" class="primary" data-install="${tool}" ${needsNode ? 'disabled' : ''}>install</button>`);
  if (s) actions.push(`<button type="button" data-locate="${tool}">${s.path ? 'use another copy…' : 'locate…'}</button>`);
  if (custom) actions.push(`<button type="button" data-default="${tool}">use default</button>`);
  if (s) actions.push(`<button type="button" class="link" data-docs="${escape(s.docsUrl)}">docs ↗</button>`);
  const detail = s?.path ? `<code title="${escape(s.path)}">${escape(shortPath(s.path))}</code>${custom ? ' <span class="dim">(chosen by you)</span>' : ''}`
    : s ? `<code>${escape(s.installCommand)}</code>${needsNode ? ' <span class="warn">needs Node.js from nodejs.org</span>' : ''}` : '';
  const problem = s?.problem && s.path ? `<p class="warn">${escape(s.problem)}</p>` : '';
  const hints = {
    agy: 'Antigravity CLI opens a Google sign-in in your browser the first time it starts.',
    opencode: 'Works with OpenCode’s free models. Sign in to use your own AI provider.',
  };
  const hint = s?.path && s.signedIn !== true && hints[tool] ? `<p class="dim">${hints[tool]}</p>` : '';
  return `<div class="tool-card is-${status.level}" style="--tool:${toolInfo[tool].color}">
    <div class="tool-card-head"><strong>${toolInfo[tool].name}</strong><span class="badge is-${status.level}">${escape(status.text)}</span></div>
    ${detail ? `<div class="tool-card-detail">${detail}</div>` : ''}${problem}${hint}
    <div class="tool-card-actions">${actions.join('')}</div></div>`;
}

function toolsDialog() {
  let helper = null;
  const dialog = showDialog(`<h2>AI tools</h2>
    <p class="dialog-note">AI Workbench runs the AI command-line tools installed on this computer. Each one keeps its own sign-in and conversation history, the same as in a terminal.</p>
    <div class="tool-cards"></div>
    <div class="helper" hidden><div class="helper-bar"><span class="helper-title"></span><button type="button" data-helper-stop>stop</button></div><div class="helper-terminal"></div></div>
    <div class="dialog-actions"><span class="dialog-status dim"></span><button type="button" data-recheck>check again</button><button type="button" class="primary" data-dismiss>done</button></div>`, {
    className: 'tools-dialog',
    onClose: () => { helper?.dispose(); helper = null; refreshToolsDialog = null; },
  });
  const cards = dialog.querySelector('.tool-cards');
  const status = dialog.querySelector('.dialog-status');
  refreshToolsDialog = checking => {
    cards.innerHTML = store.AI_TOOLS.map(toolCard).join('');
    status.textContent = checking ? 'checking…' : '';
  };
  refreshToolsDialog(backend.isDesktop);
  if (backend.isDesktop) checkTools(true);

  const runHelper = async (kind, tool) => {
    helper?.dispose();
    const box = dialog.querySelector('.helper');
    const name = toolInfo[tool].name;
    box.hidden = false;
    box.querySelector('.helper-title').textContent = kind === 'install' ? `Installing ${name}: ${tools?.[tool]?.installCommand ?? ''}`
      : tool === 'agy' ? 'Signing in to Antigravity CLI: finish signing in, then type /quit' : `Signing in to ${name}`;
    const host = box.querySelector('.helper-terminal');
    host.innerHTML = '';
    const view = new TerminalView(host, { theme: state.theme, fontSize: state.settings.fontSize, fontFamily: currentFont, onStatus: async current => {
      if (current !== helper || (current.status !== 'exited' && current.status !== 'failed')) return;
      const title = box.querySelector('.helper-title');
      title.textContent = current.status === 'failed' ? current.error
        : current.exitCode === null ? 'Stopped.'
        : current.exitCode ? `Finished with exit code ${current.exitCode}.` : kind === 'install' ? `Checking ${name}…` : 'Finished.';
      const checked = await checkTools(kind === 'install');
      if (current !== helper || kind !== 'install' || current.status === 'failed' || current.exitCode !== 0) return;
      const installed = checked?.[tool];
      title.textContent = installed?.path && !installed.problem ? `${name} installed${installed.version ? ` · ${installed.version}` : ''}.`
        : installed?.path ? `${name} was found, but couldn’t run. ${installed.problem}`
        : `Installation finished, but ${name} couldn’t be verified. ${installed?.problem ?? 'Try check again or locate the installed program.'}`;
    } });
    helper = view;
    await view.start({ kind, tool, toolPath: state.toolPaths[tool] ?? null, cwd: null });
    view.focus();
  };

  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { login, install, locate, docs } = button.dataset;
    if (login) runHelper('login', login);
    else if (install) runHelper('install', install);
    else if (docs) backend.openLink(docs);
    else if ('helperStop' in button.dataset) helper?.stop();
    else if ('recheck' in button.dataset) checkTools(true);
    else if (locate) {
      const picked = await backend.pickProgram();
      if (picked) { state.toolPaths[locate] = picked; save(); checkTools(); }
    } else if (button.dataset.default) {
      delete state.toolPaths[button.dataset.default];
      save();
      checkTools();
    }
  });
}

function checkTools(refresh = false) {
  if (!backend.isDesktop) return Promise.resolve();
  const check = ++toolsCheck;
  refreshToolsDialog?.(true);
  return backend.detectTools(state.toolPaths, refresh)
    .then(list => {
      const checked = Object.fromEntries(list.map(s => [s.id, s]));
      if (check === toolsCheck) tools = checked;
      return checked;
    })
    .catch(error => { if (check === toolsCheck) notice = `Couldn’t check the AI tools: ${error}`; })
    .finally(() => {
      if (check !== toolsCheck) return;
      renderHeader(); renderEmpty(); renderStatus(); refreshToolsDialog?.(false);
    });
}

async function checkFolders() {
  if (!backend.isDesktop) return;
  for (const p of state.projects) {
    const info = await backend.pathInfo(p.path);
    if (info && !info.isDir) missingFolders.add(p.id); else missingFolders.delete(p.id);
  }
  renderSidebar();
}

function showMenu(anchor, items) {
  const menu = $('#menu');
  menu.innerHTML = items.map(([label, , danger], i) => `<button type="button" role="menuitem" data-menu-item="${i}" class="${danger ? 'danger' : ''}">${label}</button>`).join('');
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  const close = () => {
    menu.hidden = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = event => { if (!menu.contains(event.target)) close(); };
  const onKey = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  menu.onclick = event => {
    const item = event.target.closest('[data-menu-item]');
    if (!item) return;
    close();
    items[item.dataset.menuItem][1]();
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey, true);
  menu.querySelector('button')?.focus();
}

function chatMenu(el) {
  const chat = chatById(el.dataset.id);
  if (!chat) return;
  const aiItems = chat.tool === 'shell' ? [] : [
    ['Open AI under this chat ›', () => showMenu(el, store.DELEGATION_TOOLS.map(tool => [escape(toolInfo[tool].name), () => newChatDialog(chat.projectId, chat.id, tool)]))],
    ['Move under another AI…', () => parentDialog(chat.id)],
    ['Delegation instructions…', () => delegationDialog(chat.id)],
    ['AI handoffs…', () => handoffDialog()],
  ];
  showMenu(el, [
    ['Rename…', () => renameDialog(chat.id)], ...aiItems,
    ['Insert file paths…', () => attachFiles(chat.id)],
    [chat.tool === 'shell' ? 'Restart terminal' : 'Start a new conversation', () => panes.get(chat.id)?.start({ fresh: chat.tool !== 'shell' })],
    ['Delete chat…', () => deleteChat(chat.id), true],
  ]);
}

function parentDialog(id) {
  const chat = chatById(id);
  const descendants = new Set(store.chatTree(state.chats, id).map(({ chat }) => chat.id));
  const candidates = state.chats.filter(c => c.id !== id && !descendants.has(c.id) && c.projectId === chat.projectId && store.DELEGATION_TOOLS.includes(c.tool));
  showDialog(`<h2>Move ${escape(chat.title)}</h2><label>Parent AI<select name="parent"><option value="">None (top level)</option>${candidates.map(c => `<option value="${escape(c.id)}" ${c.id === chat.parentId ? 'selected' : ''}>${escape(c.title)} · ${escape(toolInfo[c.tool].name)}</option>`).join('')}</select></label>
    <p class="dialog-note">The parent and its ancestors can delegate tasks to this chat. This chat can send replies to its parent.</p>
    <div class="dialog-actions"><button type="button" data-dismiss>cancel</button><button type="submit" class="primary">move</button></div>`, {
    onSubmit: data => { chat.parentId = String(data.get('parent')) || null; update(); },
  });
}

function delegationDialog(id) {
  const instructions = 'Use AI Workbench to delegate tasks when appropriate. First run the executable named by the AI_WORKBENCH_CLI environment variable with arguments "bridge help", then "bridge list". On macOS/Linux: "$AI_WORKBENCH_CLI" bridge help. On Windows PowerShell: & $env:AI_WORKBENCH_CLI bridge help. Address only the connected chat names or IDs I authorize. Send tasks with bridge send and inspect results with bridge read. Coordinate file ownership and review changes. Never answer another AI’s approval prompts. Do not print or share AI_WORKBENCH_TOKEN.';
  showDialog(`<h2>AI delegation</h2><p class="dialog-note">Right-click a chat → Open AI under this chat to connect a helper, or move an existing AI under this one. Give the parent these instructions once per conversation, then tell it which helpers to use.</p>
    <p class="form-error" hidden></p><label>Instructions<textarea rows="8" readonly>${escape(instructions)}</textarea></label>
    <p class="dialog-note">Insert these into the chat, then press Enter to send. After that you can say: “Delegate animation work only to the chat named Animations.”</p>
    <div class="dialog-actions"><button type="button" data-dismiss>close</button><button type="submit" class="primary">insert into chat</button></div>`, {
    onSubmit: (_, form) => {
      const pane = panes.get(id);
      const problem = pane ? pane.view.promptProblem() : 'Open this chat before inserting delegation instructions.';
      if (problem) { showFormError(form, problem); return false; }
      requestAnimationFrame(() => { focusChat(id); pane.view.paste(instructions); });
    },
  });
}

function handoffDialog() {
  showDialog(`<h2>AI handoffs</h2><p class="dialog-note">Prompts submitted during this app session.</p>${handoffs.length ? handoffs.slice().reverse().map(h => `<details><summary>${escape(h.from)} → ${escape(h.to)} · ${escape(new Date(h.at).toLocaleTimeString())}</summary><pre class="handoff-prompt">${escape(h.prompt)}</pre></details>`).join('') : '<p>No tasks have been sent yet.</p>'}<div class="dialog-actions"><button type="button" data-dismiss>close</button></div>`);
}

async function attachFiles(id) {
  const pane = panes.get(id);
  const paths = await backend.pickFiles(projectPath(chatById(id)) || homePath);
  pane?.insertPaths(paths);
}

const actions = {
  'tools': () => toolsDialog(),
  'settings': () => settingsDialog(),
  'local-settings': () => settingsDialog({ focus: 'localServer' }),
  'usage': () => toggleUsagePanel(),
  'refresh-usage': () => refreshUsage(true),
  'pin-usage': () => {
    if (state.pinned.includes('usage')) store.unpinWidget(state, 'usage'); else store.pinWidget(state, 'usage');
    toggleUsagePanel(false);
    update();
    watchUsage();
  },
  'add-project': () => projectDialog(),
  'edit-project': el => { const project = projectById(el.dataset.id); if (project) projectDialog(project); },
  'toggle-project': el => { store.toggleCollapsed(state, el.dataset.id); update(); },
  'go-page': el => goToPage(el.dataset.page),
  'project-menu': el => showMenu(el, [
    ['New chat here', () => newChatDialog(el.dataset.id)],
    ['Edit project…', () => projectDialog(projectById(el.dataset.id))],
    ['Remove from AI Workbench…', () => removeProject(el.dataset.id), true],
  ]),
  'new-chat': el => newChatDialog(el.dataset.project === undefined ? pageProjectId() : el.dataset.project || null),
  'open-chat': el => focusChat(el.dataset.id),
  'focus': el => focusChat(el.dataset.id),
  'close': el => { store.closeChat(state, el.dataset.id); update(); },
  'remove-chat': el => deleteChat(el.dataset.id),
  'pin': el => {
    const id = el.dataset.id;
    if (store.isPinned(state, id)) store.unpinChat(state, id); else store.pinChat(state, id);
    update();
    requestAnimationFrame(() => panes.get(id)?.visible && panes.get(id).view.focus());
  },
  'layout': el => { page().layout = el.dataset.layout; update(); },
  'attach': el => attachFiles(el.dataset.id),
  'jump': el => { const id = store.runningChatIds(state).find(id => chatState(id) === el.dataset.state); if (id) focusChat(id); },
  'resume': el => panes.get(el.dataset.id)?.start(),
  'new-conversation': el => panes.get(el.dataset.id)?.start({ fresh: true }),
  'pane-menu': el => chatMenu(el),
};

document.addEventListener('click', event => {
  const panel = $('#usage-panel');
  // Actions can replace the panel's contents; remember where this click began before rendering.
  const insideUsage = panel.contains(event.target) || event.target.closest('#usage-button');
  const target = event.target.closest('[data-action]');
  if (target && actions[target.dataset.action]) actions[target.dataset.action](target, event);
  if (!panel.hidden && !insideUsage) toggleUsagePanel(false);
});

document.addEventListener('contextmenu', event => {
  const target = event.target.closest('.chat-row, .pane-header, .open-tab');
  if (!target) return;
  const id = target.dataset.id ?? target.closest('[data-pane]')?.dataset.pane ?? target.querySelector('[data-id]')?.dataset.id;
  if (!id) return;
  event.preventDefault();
  chatMenu({ dataset: { id }, getBoundingClientRect: () => ({ bottom: event.clientY, right: event.clientX }) });
});

document.addEventListener('dblclick', event => {
  const target = event.target.closest('.chat-row, .open-tab [data-action=focus], .pane-title');
  const id = target?.dataset.id ?? target?.closest('[data-pane]')?.dataset.pane;
  if (id) renameDialog(id);
});

// Escape closes the usage panel even while a terminal has the keyboard, so it's caught before
// the terminal sees it.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('#usage-panel').hidden) return;
  event.preventDefault();
  event.stopPropagation();
  toggleUsagePanel(false);
}, true);

document.addEventListener('keydown', event => {
  const open = page().open;
  if (event.key !== 'Tab' || !event.ctrlKey || event.altKey || event.metaKey || open.length < 2) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  const index = open.indexOf(page().active);
  focusChat(open[(index + (event.shiftKey ? -1 : 1) + open.length) % open.length]);
});

function startPaneDrag(source, start) {
  let dragging = false;
  let target = null;
  const move = event => {
    if (!dragging) {
      if (Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) < 6) return;
      dragging = true;
      source.classList.add('dragging');
      document.body.classList.add('dragging-pane');
    }
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('#panes .pane');
    const next = over && over !== source ? over : null;
    if (next !== target) {
      target?.classList.remove('drop-target');
      target = next;
      target?.classList.add('drop-target');
    }
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    source.classList.remove('dragging');
    document.body.classList.remove('dragging-pane');
    target?.classList.remove('drop-target');
    if (dragging && target) {
      store.swapChats(state, source.dataset.pane, target.dataset.pane);
      save();
      renderTabs();
      layoutPanes();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

function startDockResize(start) {
  const width = state.settings.dockWidth;
  const move = event => {
    state.settings.dockWidth = Math.min(900, Math.max(260, Math.round(width + start.clientX - event.clientX)));
    document.documentElement.style.setProperty('--dock-width', `${state.settings.dockWidth}px`);
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    document.body.classList.remove('resizing-dock');
    save();
  };
  document.body.classList.add('resizing-dock');
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
}

function handleFileDrop(payload) {
  document.querySelectorAll('.file-target').forEach(el => el.classList.remove('file-target'));
  if (payload.type === 'leave' || !payload.position) return;
  const ratio = window.devicePixelRatio || 1;
  const under = document.elementFromPoint(payload.position.x / ratio, payload.position.y / ratio);
  const pane = under?.closest('.pane');
  const sidebar = under?.closest('.sidebar');
  if (payload.type !== 'drop') {
    (pane ?? sidebar)?.classList.add('file-target');
    return;
  }
  const paths = payload.paths ?? [];
  if (pane) panes.get(pane.dataset.pane)?.insertPaths(paths);
  else if (sidebar && paths.length === 1) backend.pathInfo(paths[0]).then(info => info?.isDir && projectDialog(null, { path: paths[0] }));
}

document.documentElement.style.setProperty('--mono', currentFont);
applyTheme();
if (state.settings.font !== 'system') applyFont();
renderSkeleton();
backend.appVersion().then(version => { updates.current = version; refreshUpdateStatus?.(); }).catch(() => {});
// Wait until the app has settled before looking online for a newer version.
if (state.settings.checkUpdates) setTimeout(() => checkUpdates({ quiet: true }), 8000);
window.addEventListener('focus', () => panes.get(page().active)?.seen());
for (const area of ['#panes', '#dock']) {
  $(area).addEventListener('pointerdown', event => {
    const pane = event.target.closest('.pane');
    if (!pane) return;
    activate(pane.dataset.pane);
    const header = event.target.closest('.pane-header');
    if (area !== '#panes' || !header || event.button !== 0 || event.target.closest('button') || page().layout === 'focus' || page().open.length < 2) return;
    event.preventDefault();
    startPaneDrag(pane, event);
  }, true);
}
$('#dock-resizer').addEventListener('pointerdown', event => { event.preventDefault(); startDockResize(event); });
backend.resetTerminals().then(() => backend.listenDelegation(request => handleDelegation(state, panes, request, handoff => {
  handoffs.push(handoff);
  if (handoffs.length > 100) handoffs.shift();
  notice = `AI handoff: ${handoff.from} → ${handoff.to}`;
  renderStatus();
}))).catch(error => { notice = `AI delegation unavailable: ${error}`; }).finally(() => {
  render();
  watchUsage();
  backend.homeDir().then(path => { homePath = path; render(); });
  checkTools();
  checkFolders();
  backend.onFileDrop(handleFileDrop);
});

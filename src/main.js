import './styles.css';
import * as store from './store.js';
import * as backend from './backend.js';
import { toolInfo, describeStatus } from './tools.js';
import { TerminalView, isMac, monoFonts } from './terminal.js';

const loaded = store.loadState(localStorage);
const state = loaded.state;
let notice = loaded.problem;
let tools = null;
let homePath = '';
const missingFolders = new Set();
const panes = new Map();
let refreshToolsDialog = null;

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chatById = id => state.chats.find(c => c.id === id);
const projectById = id => state.projects.find(p => p.id === id);
const projectPath = chat => chat?.projectId ? projectById(chat.projectId)?.path ?? '' : '';
const shortPath = path => homePath && path?.startsWith(homePath) ? '~' + path.slice(homePath.length) : path ?? '';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const stateLabels = { closed: 'closed', starting: 'starting…', working: 'working…', waiting: 'needs you', done: 'done', ready: 'ready', stopped: 'stopped', failed: 'couldn’t start' };
const chatState = id => panes.get(id)?.display ?? 'closed';

function save() {
  if (!store.saveState(localStorage, state)) notice = 'Unable to save: local storage is unavailable or full.';
}
function update() { save(); render(); }

function defaultProjectId() {
  const active = chatById(state.active);
  return active ? active.projectId : state.projects[0]?.id ?? null;
}

function renderSkeleton() {
  $('#app').innerHTML = `<div class="workbench">
    <header class="app-header"><strong><span class="accent">[≡]</span> AI WORKBENCH</strong><span class="header-path" id="header-path"></span>
      <button class="tools-button" id="tools-button" data-action="tools" title="Connect your AI tools"></button>
      <label class="theme-label">theme <select id="theme" aria-label="Theme"><option value="terminal">Terminal</option><option value="powershell">PowerShell</option><option value="amber">Amber</option></select></label></header>
    <div class="workspace"><aside class="sidebar" id="sidebar" aria-label="Projects and chats"></aside><main>
      <div class="workspace-toolbar" id="toolbar"></div>
      <nav class="open-tabs" id="tabs" aria-label="Open chats"></nav>
      <div class="panes" id="panes"></div>
      <div class="panes-empty" id="panes-empty" hidden></div>
    </main></div>
    <footer class="app-status" id="status"></footer>
  </div><div class="menu" id="menu" role="menu" hidden></div>`;
}

function render() {
  document.documentElement.dataset.theme = state.theme;
  renderHeader();
  renderSidebar();
  renderToolbar();
  renderTabs();
  syncPanes();
  renderEmpty();
  renderStatus();
}

function renderHeader() {
  const active = chatById(state.active);
  $('#header-path').textContent = active ? shortPath(projectPath(active) || homePath) || 'home folder' : '';
  const dots = store.AI_TOOLS.map(t => `<span class="dot is-${describeStatus(tools?.[t]).level}" style="--tool:${toolInfo[t].color}" title="${toolInfo[t].name}: ${describeStatus(tools?.[t]).text}"></span>`).join('');
  const label = !backend.isDesktop ? 'AI tools' : tools ? `AI tools · ${store.AI_TOOLS.filter(t => tools[t]?.path).length}/4` : 'AI tools · checking';
  $('#tools-button').innerHTML = `${dots}<span>${label}</span>`;
  $('#theme').value = state.theme;
}

function chatRow(c) {
  const shown = chatState(c.id);
  return `<button class="chat-row ${state.active === c.id ? 'selected' : ''}" data-action="open-chat" data-id="${escape(c.id)}" title="${escape(c.title)} · ${stateLabels[shown]} — double-click to rename">
    <span class="run-dot is-${shown}"></span>
    <span class="tool-tag" style="--tool:${toolInfo[c.tool].color}">${toolInfo[c.tool].tag}</span>
    <span class="chat-title">${escape(c.title)}</span></button>`;
}

function renderSidebar() {
  const sidebar = $('#sidebar');
  const scroll = sidebar.scrollTop;
  const projects = state.projects.map(p => {
    const collapsed = state.collapsed.includes(p.id);
    const chats = state.chats.filter(c => c.projectId === p.id);
    return `<section class="project">
      <div class="project-row">
        <button class="project-toggle" data-action="toggle-project" data-id="${escape(p.id)}" aria-expanded="${!collapsed}" title="${escape(p.path)}"><span class="caret"></span><span class="project-name">${escape(p.name)}</span>${collapsed && chats.length ? `<span class="count">${chats.length}</span>` : ''}</button>
        <button class="icon-button" data-action="new-chat" data-project="${escape(p.id)}" title="New chat in ${escape(p.name)}">+</button>
        <button class="icon-button" data-action="project-menu" data-id="${escape(p.id)}" title="Project options">···</button>
      </div>
      ${collapsed ? '' : `<div class="project-path" title="${escape(p.path)}">${escape(shortPath(p.path))}${missingFolders.has(p.id) ? ' <span class="warn">· folder not found</span>' : ''}</div>
      ${chats.map(chatRow).join('') || `<button class="add-chat" data-action="new-chat" data-project="${escape(p.id)}">+ new chat</button>`}`}
    </section>`;
  }).join('');
  const standalone = state.chats.filter(c => c.projectId === null);
  sidebar.innerHTML = `<div class="section-heading"><span>PROJECTS</span><button class="icon-button" data-action="add-project" title="Add a project folder">+</button></div>
    ${projects || '<p class="sidebar-hint">Add a project folder, or drop one here.</p>'}
    <div class="section-heading standalone-heading"><span>INDIVIDUAL CHATS</span><button class="icon-button" data-action="new-chat" data-project="" title="New chat without a project">+</button></div>
    ${standalone.map(chatRow).join('') || '<p class="sidebar-hint">Chats without a project run in your home folder.</p>'}`;
  sidebar.scrollTop = scroll;
}

function renderToolbar() {
  $('#toolbar').innerHTML = `<div class="layout-controls" role="group" aria-label="Layout">${store.LAYOUTS.map(l => `<button data-action="layout" data-layout="${l}" class="${state.layout === l ? 'selected' : ''}" aria-pressed="${state.layout === l}">${l}</button>`).join('')}</div>
    <span class="dim toolbar-count">${state.open.length} open</span>
    <button class="primary" data-action="new-chat" data-project="${escape(defaultProjectId() ?? '')}">+ new chat</button>`;
}

function renderTabs() {
  $('#tabs').innerHTML = state.open.map(id => {
    const c = chatById(id);
    const shown = chatState(id);
    return `<div class="open-tab ${state.active === id ? 'selected' : ''} is-${shown}" style="--tool:${toolInfo[c.tool].color}">
      <button data-action="focus" data-id="${escape(id)}" title="${escape(toolInfo[c.tool].name)} · ${escape(c.title)} · ${stateLabels[shown]}"><span class="run-dot is-${shown}"></span><span class="tab-tool">${toolInfo[c.tool].tag}</span> ${escape(c.title)}</button>
      <button class="tab-close" data-action="close" data-id="${escape(id)}" aria-label="Close ${escape(c.title)}" title="Close (the conversation is kept)">×</button></div>`;
  }).join('');
}

function renderStatus() {
  const shown = state.open.map(chatState);
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
  const key = `${chat.id}:${waiting}`;
  if (Date.now() - (notified.get(key) ?? 0) < 5000) return;
  notified.set(key, Date.now());
  const where = chat.projectId ? projectById(chat.projectId)?.name ?? '' : 'no project';
  backend.notify(`${toolInfo[chat.tool].name} ${waiting ? 'needs you' : 'finished'}`, `${chat.title} · ${where}`);
  if (!document.hasFocus()) backend.requestAttention();
}

function renderEmpty() {
  const empty = $('#panes-empty');
  empty.hidden = state.open.length > 0;
  if (!empty.hidden && !state.projects.length && !state.chats.length) {
    const ready = tools ? store.AI_TOOLS.filter(t => tools[t]?.path).length : null;
    empty.innerHTML = `<div class="welcome"><h1>Welcome to AI Workbench</h1>
      <p>Run Claude Code, Codex, Gemini CLI and OpenCode side by side, each working in your project folder.</p>
      <ol class="steps">
        <li class="${ready ? 'done' : ''}"><span class="step">1</span><div><strong>Connect your AI tools</strong><p>${ready === null ? (backend.isDesktop ? 'Checking which tools are installed…' : backend.desktopOnly) : `${ready} of 4 installed on this computer.`}</p></div><button data-action="tools">${ready ? 'review' : 'connect'}</button></li>
        <li><span class="step">2</span><div><strong>Add a project folder</strong><p>The AI works inside this folder.</p></div><button data-action="add-project">add project</button></li>
        <li><span class="step">3</span><div><strong>Start a chat</strong><p>Pick an AI. Its conversation is saved and picks up where it left off.</p></div><button data-action="new-chat" data-project="">new chat</button></li>
      </ol></div>`;
  } else if (!empty.hidden) {
    empty.innerHTML = `<div class="welcome compact"><strong>No chats open.</strong><p>Open one from the sidebar, or start a new one.</p><button class="primary" data-action="new-chat" data-project="${escape(defaultProjectId() ?? '')}">+ new chat</button></div>`;
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
        <span class="tool-tag"></span><span class="pane-title"></span><span class="agent-state"></span><span class="pane-cwd"></span>
        <button class="small-button" data-action="attach" data-id="${escape(chat.id)}" title="Insert file paths into the prompt">+ file</button>
        <button class="small-button" data-action="pane-menu" data-id="${escape(chat.id)}" title="More">···</button>
        <button class="small-button" data-action="close" data-id="${escape(chat.id)}" title="Close (the conversation is kept)">×</button>
      </header>
      <div class="pane-body"><div class="terminal-host"></div><div class="pane-overlay" hidden></div></div>`;
    this.unseen = false;
    this.view = new TerminalView(this.el.querySelector('.terminal-host'), {
      theme: state.theme,
      tool: chat.tool === 'shell' ? null : chat.tool,
      onFocus: () => activate(this.chatId),
      onStatus: () => { this.renderOverlay(); this.renderState(); renderSidebar(); renderTabs(); renderStatus(); },
      onEvent: event => this.handleEvent(event),
      onAgentState: (next, previous) => this.agentChanged(next, previous),
    });
    this.update();
    this.renderState();
  }

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
    label.textContent = stateLabels[shown];
    label.className = `agent-state is-${shown}`;
    this.el.dataset.state = shown;
  }

  agentChanged(next, previous) {
    const watched = document.hasFocus() && !this.el.hidden;
    if (next === 'idle' && previous === 'working') this.unseen = !(watched && state.active === this.chatId);
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

  get chat() { return chatById(this.chatId); }

  update() {
    const chat = this.chat;
    if (!chat) return;
    const info = toolInfo[chat.tool];
    this.el.style.setProperty('--tool', info.color);
    this.el.querySelector('.tool-tag').textContent = info.tag;
    this.el.querySelector('.pane-title').textContent = chat.title;
    const cwd = projectPath(chat) || homePath;
    this.el.querySelector('.pane-cwd').textContent = shortPath(cwd);
    this.el.querySelector('.pane-cwd').title = cwd;
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
    const shell = chat.tool === 'shell';
    return this.view.start({ kind: shell ? 'shell' : 'chat', tool: shell ? null : chat.tool, sessionId: chat.sessionId,
      knownSessions: state.chats.filter(c => c.id !== chat.id && c.sessionId).map(c => c.sessionId),
      cwd: projectPath(chat) || null, toolPath: state.toolPaths[chat.tool] ?? null })
      .then(() => this.view.status === 'running' && this.chatId === state.active && this.view.focus());
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

function syncPanes() {
  const container = $('#panes');
  for (const [id, pane] of panes) {
    if (!state.open.includes(id) || !chatById(id)) { pane.dispose(); panes.delete(id); }
  }
  const created = [];
  for (const id of state.open) {
    let pane = panes.get(id);
    if (!pane) {
      pane = new Pane(chatById(id));
      panes.set(id, pane);
      container.append(pane.el);
      created.push(pane);
    }
    pane.update();
  }
  layoutPanes();
  // Start once the layout is in place so each terminal opens at its real size; restored panes start a moment apart.
  created.forEach((pane, i) => setTimeout(() => panes.get(pane.chatId) === pane && pane.start(), i * 250));
}

function layoutPanes() {
  const container = $('#panes');
  const visible = state.layout === 'focus' ? state.open.filter(id => id === state.active) : state.open;
  const n = visible.length;
  let cols = 1, rows = 1;
  if (state.layout === 'grid') { cols = n <= 1 ? 1 : n <= 4 ? 2 : 3; rows = Math.max(1, Math.ceil(n / cols)); }
  if (state.layout === 'columns') cols = Math.max(1, n);
  container.style.gridTemplateColumns = state.layout === 'columns' ? `repeat(${cols}, minmax(360px, 1fr))` : `repeat(${cols}, minmax(0, 1fr))`;
  container.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  container.hidden = n === 0;
  // The last pane stretches across empty grid cells, so an odd number of panes leaves no hole.
  const lastRow = n - cols * (rows - 1);
  state.open.forEach((id, index) => {
    const pane = panes.get(id);
    if (!pane) return;
    const shown = visible.includes(id);
    pane.el.hidden = !shown;
    pane.el.style.order = String(index);
    const last = shown && visible.indexOf(id) === n - 1;
    pane.el.style.gridColumn = state.layout === 'grid' && last && lastRow < cols ? `span ${cols - lastRow + 1}` : '';
    pane.el.classList.toggle('active', id === state.active);
  });
}

function activate(id) {
  panes.get(id)?.seen();
  if (state.active === id || !state.open.includes(id)) return;
  state.active = id;
  save();
  renderHeader();
  renderSidebar();
  renderTabs();
  renderToolbar();
  layoutPanes();
}

function focusChat(id) {
  store.openChat(state, id);
  update();
  panes.get(id)?.seen();
  requestAnimationFrame(() => { const view = panes.get(id)?.view; if (view?.status === 'running') view.focus(); });
}

function closeChat(id) {
  store.closeChat(state, id);
  update();
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
        state.collapsed = state.collapsed.filter(id => id !== project.id);
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

function newChatDialog(projectId) {
  const where = [`<option value="">No project (home folder)</option>`,
    ...state.projects.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)} — ${escape(shortPath(p.path))}</option>`)];
  showDialog(`<h2>New chat</h2>
    <label>Where<select name="project">${where.join('')}</select></label>
    <label>Title <span class="dim">(optional)</span><input name="title" maxlength="120" placeholder="e.g. Fix the login bug" autocomplete="off"></label>
    <div class="tool-picker" role="group" aria-label="AI">${store.TOOLS.map(toolChoice).join('')}</div>
    <p class="dialog-note">Each chat keeps its own conversation. Close it any time; it picks up where it left off.</p>
    <div class="dialog-actions"><button type="button" data-dismiss>cancel</button></div>`, {
    className: 'new-chat',
    onSubmit: (data, form, submitter) => {
      const tool = submitter?.value;
      if (!store.TOOLS.includes(tool)) return false;
      store.addChat(state, tool, String(data.get('project')) || null, String(data.get('title')));
      update();
    },
  });
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
  const kept = chat.tool === 'shell' ? '' : ` Its conversation stays in ${toolInfo[chat.tool].name}’s own history.`;
  confirmDialog({ title: 'Delete chat?', body: `“${escape(chat.title)}” will be removed from AI Workbench.${kept}`,
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
    gemini: 'Gemini CLI asks how to sign in the first time it starts. If Google sign-in is refused, choose “Use Gemini API Key”.',
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
  if (backend.isDesktop) checkTools();

  const runHelper = async (kind, tool) => {
    helper?.dispose();
    const box = dialog.querySelector('.helper');
    const name = toolInfo[tool].name;
    box.hidden = false;
    box.querySelector('.helper-title').textContent = kind === 'install' ? `Installing ${name}: ${tools?.[tool]?.installCommand ?? ''}`
      : tool === 'gemini' ? 'Signing in to Gemini CLI: choose a sign-in method, then type /quit' : `Signing in to ${name}`;
    const host = box.querySelector('.helper-terminal');
    host.innerHTML = '';
    const view = new TerminalView(host, { theme: state.theme, onStatus: current => {
      if (current !== helper || (current.status !== 'exited' && current.status !== 'failed')) return;
      box.querySelector('.helper-title').textContent = current.status === 'failed' ? current.error
        : current.exitCode ? `Finished with exit code ${current.exitCode}.` : 'Finished.';
      checkTools(kind === 'install');
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
  refreshToolsDialog?.(true);
  return backend.detectTools(state.toolPaths, refresh)
    .then(list => { tools = Object.fromEntries(list.map(s => [s.id, s])); })
    .catch(error => { notice = `Couldn’t check the AI tools: ${error}`; })
    .finally(() => { renderHeader(); renderEmpty(); renderStatus(); refreshToolsDialog?.(false); });
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

async function attachFiles(id) {
  const pane = panes.get(id);
  const paths = await backend.pickFiles(projectPath(chatById(id)) || homePath);
  pane?.insertPaths(paths);
}

const actions = {
  'tools': () => toolsDialog(),
  'add-project': () => projectDialog(),
  'edit-project': el => { const project = projectById(el.dataset.id); if (project) projectDialog(project); },
  'toggle-project': el => { store.toggleCollapsed(state, el.dataset.id); update(); },
  'project-menu': el => showMenu(el, [
    ['New chat here', () => newChatDialog(el.dataset.id)],
    ['Edit project…', () => projectDialog(projectById(el.dataset.id))],
    ['Remove from AI Workbench…', () => removeProject(el.dataset.id), true],
  ]),
  'new-chat': el => newChatDialog(el.dataset.project === undefined ? defaultProjectId() : el.dataset.project || null),
  'open-chat': el => focusChat(el.dataset.id),
  'focus': el => focusChat(el.dataset.id),
  'close': el => closeChat(el.dataset.id),
  'layout': el => { state.layout = el.dataset.layout; update(); },
  'attach': el => attachFiles(el.dataset.id),
  'jump': el => { const id = state.open.find(id => chatState(id) === el.dataset.state); if (id) focusChat(id); },
  'resume': el => panes.get(el.dataset.id)?.start(),
  'new-conversation': el => panes.get(el.dataset.id)?.start({ fresh: true }),
  'pane-menu': el => {
    const chat = chatById(el.dataset.id);
    if (!chat) return;
    showMenu(el, [
      ['Rename…', () => renameDialog(chat.id)],
      [chat.tool === 'shell' ? 'Restart terminal' : 'Start a new conversation', () => panes.get(chat.id)?.start({ fresh: chat.tool !== 'shell' })],
      ['Delete chat…', () => deleteChat(chat.id), true],
    ]);
  },
};

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (target && actions[target.dataset.action]) actions[target.dataset.action](target, event);
});

document.addEventListener('dblclick', event => {
  const target = event.target.closest('.chat-row, .open-tab [data-action=focus], .pane-title');
  const id = target?.dataset.id ?? target?.closest('[data-pane]')?.dataset.pane;
  if (id) renameDialog(id);
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !event.ctrlKey || event.altKey || event.metaKey || state.open.length < 2) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  const index = state.open.indexOf(state.active);
  focusChat(state.open[(index + (event.shiftKey ? -1 : 1) + state.open.length) % state.open.length]);
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
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest('.pane');
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

document.documentElement.style.setProperty('--mono', monoFonts);
renderSkeleton();
$('#theme').onchange = event => {
  state.theme = event.target.value;
  update();
  panes.forEach(pane => pane.view.setTheme(state.theme));
};
window.addEventListener('focus', () => panes.get(state.active)?.seen());
$('#panes').addEventListener('pointerdown', event => {
  const pane = event.target.closest('.pane');
  if (!pane) return;
  activate(pane.dataset.pane);
  const header = event.target.closest('.pane-header');
  if (!header || event.button !== 0 || event.target.closest('button') || state.layout === 'focus' || state.open.length < 2) return;
  event.preventDefault();
  startPaneDrag(pane, event);
}, true);
backend.resetTerminals().finally(() => {
  render();
  backend.homeDir().then(path => { homePath = path; render(); });
  checkTools();
  checkFolders();
  backend.onFileDrop(handleFileDrop);
});

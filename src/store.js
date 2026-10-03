import { THEME_LIST, FONTS, DEFAULT_FONT } from './themes.js';

export const AI_TOOLS = ['claude', 'codex', 'agy', 'opencode'];
// A local-model chat talks to LM Studio, Ollama or the like, and runs in OpenCode.
export const TOOLS = [...AI_TOOLS, 'local', 'shell'];
export const engineOf = tool => tool === 'local' ? 'opencode' : tool;
// `qwen/qwen3-coder-30b` reads as `qwen3-coder-30b`.
export const modelLabel = model => String(model ?? '').split('/').pop();
export const LAYOUTS = ['grid', 'columns', 'focus'];
export const THEMES = THEME_LIST.map(t => t.id);
export const WIDGETS = ['usage'];
// Each project is a page; chats without a project share this one.
export const INDIVIDUAL = 'individual';
export const storageKey = 'ai-workbench.workspace.v4';
const v3Key = 'ai-workbench.workspace.v3';
const legacyKey = 'ai-workbench.sessions.v2';

// Claude Code starts a conversation under an ID we choose; Codex, Antigravity CLI and OpenCode report theirs.
const chosenSessionTools = ['claude'];
// Gemini CLI was replaced by Antigravity CLI (agy). Its chats carry over, but their Gemini
// conversations can't be opened there, so they start a new one.
const renamedTools = { gemini: 'agy' };

export function defaultSettings() {
  // localServer: where new local-model chats look for models; empty means this computer.
  return { fontSize: 13, font: DEFAULT_FONT, notifications: true, notifyResets: true, checkUpdates: true, flash: true, reopenChats: true, confirmRemove: true, dockWidth: 460, toolArgs: {}, localServer: '' };
}

export function emptyState() {
  return { projects: [], chats: [], page: INDIVIDUAL, pages: {}, pinned: [], theme: 'terminal', collapsed: [], toolPaths: {}, settings: defaultSettings() };
}

const emptyPage = (layout = 'grid') => ({ open: [], active: null, layout });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string';
const list = v => Array.isArray(v) ? v : [];
const clamp = (n, low, high, fallback) => Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;

export const pageKeyOf = chat => chat.projectId ?? INDIVIDUAL;
export const pinnedChat = id => `chat:${id}`;
export const isPinned = (state, id) => state.pinned.includes(pinnedChat(id));
export const pinnedChatIds = state => state.pinned.filter(key => key.startsWith('chat:')).map(key => key.slice(5));

function normalizeSettings(value) {
  const settings = defaultSettings();
  if (!isObject(value)) return settings;
  settings.fontSize = clamp(value.fontSize, 9, 24, settings.fontSize);
  settings.dockWidth = clamp(value.dockWidth, 260, 900, settings.dockWidth);
  if (isText(value.font) && FONTS[value.font]) settings.font = value.font;
  for (const key of ['notifications', 'notifyResets', 'checkUpdates', 'flash', 'reopenChats', 'confirmRemove']) if (typeof value[key] === 'boolean') settings[key] = value[key];
  if (isObject(value.toolArgs)) {
    for (const tool of AI_TOOLS) if (isText(value.toolArgs[tool]) && value.toolArgs[tool].trim()) settings.toolArgs[tool] = value.toolArgs[tool];
  }
  if (isText(value.localServer)) settings.localServer = value.localServer.trim().slice(0, 200);
  return settings;
}

// Keeps every entry that is still usable instead of discarding the whole workspace over one bad one.
// Also reads the version 3 layout, where all open chats shared one list.
export function normalize(value) {
  const state = emptyState();
  if (!isObject(value)) return state;
  const projectIds = new Set();
  for (const p of list(value.projects)) {
    if (!isObject(p) || !isText(p.id) || !isText(p.name) || !isText(p.path) || projectIds.has(p.id) || p.id === INDIVIDUAL) continue;
    projectIds.add(p.id);
    state.projects.push({ id: p.id, name: p.name, path: p.path });
  }
  const chats = new Map();
  for (const c of list(value.chats)) {
    if (!isObject(c) || !isText(c.id) || chats.has(c.id)) continue;
    const tool = renamedTools[c.tool] ?? c.tool;
    if (!TOOLS.includes(tool)) continue;
    const chat = { id: c.id, tool, title: isText(c.title) && c.title.trim() ? c.title : 'New chat',
      projectId: projectIds.has(c.projectId) ? c.projectId : null,
      sessionId: tool === c.tool && isText(c.sessionId) && c.sessionId ? c.sessionId : null };
    if (tool === 'local') Object.assign(chat, { server: isText(c.server) ? c.server : '', model: isText(c.model) ? c.model : '' });
    chats.set(chat.id, chat);
    state.chats.push(chat);
  }
  state.pinned = [...new Set(list(value.pinned))].filter(key => WIDGETS.includes(key) || (isText(key) && chats.has(key.slice(5)) && key.startsWith('chat:')));
  const pinned = new Set(pinnedChatIds(state));
  const pageFor = (key, layout) => state.pages[key] ??= emptyPage(LAYOUTS.includes(layout) ? layout : 'grid');

  if (isObject(value.pages)) {
    for (const [key, saved] of Object.entries(value.pages)) {
      if ((key !== INDIVIDUAL && !projectIds.has(key)) || !isObject(saved)) continue;
      const page = pageFor(key, saved.layout);
      page.open = [...new Set(list(saved.open))].filter(id => chats.has(id) && pageKeyOf(chats.get(id)) === key && !pinned.has(id));
      page.active = page.open.includes(saved.active) ? saved.active : page.open[0] ?? null;
    }
  } else {
    // Version 3: one list of open chats and one layout for everything.
    for (const id of new Set(list(value.open))) {
      const chat = chats.get(id);
      if (chat && !pinned.has(id)) pageFor(pageKeyOf(chat), value.layout).open.push(id);
    }
    for (const page of Object.values(state.pages)) page.active = page.open[0] ?? null;
    const active = chats.get(value.active);
    if (active && state.pages[pageKeyOf(active)]?.open.includes(active.id)) state.pages[pageKeyOf(active)].active = active.id;
    if (active) state.page = pageKeyOf(active);
    if (LAYOUTS.includes(value.layout)) for (const key of [INDIVIDUAL, ...projectIds]) pageFor(key, value.layout);
  }
  const validPage = key => key === INDIVIDUAL || projectIds.has(key);
  if (validPage(value.page)) state.page = value.page;
  else if (!validPage(state.page) || (state.page === INDIVIDUAL && !value.active && state.projects.length)) state.page = state.projects[0]?.id ?? INDIVIDUAL;
  pageFor(state.page);
  if (THEMES.includes(value.theme)) state.theme = value.theme;
  state.collapsed = list(value.collapsed).filter(id => projectIds.has(id));
  if (isObject(value.toolPaths)) {
    for (const tool of AI_TOOLS) if (isText(value.toolPaths[tool]) && value.toolPaths[tool].trim()) state.toolPaths[tool] = value.toolPaths[tool];
  }
  state.settings = normalizeSettings(value.settings);
  return state;
}

const v2Tools = { Codex: 'codex', Claude: 'claude', Gemini: 'agy', OpenCode: 'opencode' };

// Version 2 had no live sessions: untitled chats without notes were placeholders, so only named ones carry over.
// The old data stays in storage under its own key.
export function migrateV2(value) {
  const chats = list(value.sessions)
    .filter(s => isObject(s) && v2Tools[s.provider] && ((isText(s.title) && s.title !== 'New chat') || list(s.messages).length))
    .map(s => ({ id: s.id, tool: v2Tools[s.provider], title: s.title, projectId: s.projectId }));
  return normalize({ projects: value.projects, chats, layout: value.layout, theme: value.theme });
}

export function loadState(storage) {
  let raw;
  try { raw = storage.getItem(storageKey) ?? storage.getItem(v3Key); }
  catch { return { state: emptyState(), problem: 'Local storage is unavailable, so changes won’t be saved.' }; }
  if (raw === null) {
    let legacy = null;
    try { legacy = JSON.parse(storage.getItem(legacyKey)); } catch {}
    return { state: isObject(legacy) ? migrateV2(legacy) : emptyState(), problem: '' };
  }
  try {
    const value = JSON.parse(raw);
    if (!isObject(value)) throw new Error('not a workspace');
    return { state: normalize(value), problem: '' };
  } catch {
    // Keep the unreadable copy rather than overwriting it with an empty workspace on the next save.
    try { storage.setItem(`${storageKey}.unreadable-${Date.now()}`, raw); } catch {}
    return { state: emptyState(), problem: 'The saved workspace couldn’t be read, so a copy was kept and a new one started.' };
  }
}

export function saveState(storage, state) {
  try { storage.setItem(storageKey, JSON.stringify(state)); return true; }
  catch { return false; }
}

// With "reopen chats" turned off, the app starts with every chat closed; pinned widgets stay.
export function closeAllChats(state) {
  for (const page of Object.values(state.pages)) Object.assign(page, { open: [], active: null });
  state.pinned = state.pinned.filter(key => WIDGETS.includes(key));
}

export function currentPage(state) {
  return state.pages[state.page] ??= emptyPage();
}

export function goToPage(state, key) {
  if (key !== INDIVIDUAL && !state.projects.some(p => p.id === key)) return;
  state.page = key;
  currentPage(state);
}

export function addProject(state, name, path) {
  const project = { id: crypto.randomUUID(), name, path };
  state.projects.push(project);
  state.pages[project.id] = emptyPage(currentPage(state).layout);
  return project;
}

export function removeProject(state, id) {
  for (const chat of state.chats.filter(c => c.projectId === id)) removeChat(state, chat.id);
  state.projects = state.projects.filter(p => p.id !== id);
  delete state.pages[id];
  state.collapsed = state.collapsed.filter(key => key !== id);
  if (state.page === id) goToPage(state, state.projects[0]?.id ?? INDIVIDUAL);
}

// A local-model chat also takes the server and model it uses (`local`), and is named after the
// model unless given a title.
export function addChat(state, tool, projectId, title = '', local = null) {
  if (!TOOLS.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  if (projectId !== null && !state.projects.some(p => p.id === projectId)) throw new Error('Unknown project');
  if (tool === 'local' && !(local?.server && local?.model)) throw new Error('A local-model chat needs a server and a model');
  const chat = { id: crypto.randomUUID(), tool, projectId, title: title.trim() || (tool === 'local' ? modelLabel(local.model) : '') || 'New chat', sessionId: null };
  if (tool === 'local') Object.assign(chat, { server: local.server, model: local.model });
  ensureSessionId(chat);
  state.chats.push(chat);
  openChat(state, chat.id);
  return chat;
}

export function ensureSessionId(chat) {
  if (chosenSessionTools.includes(chat.tool) && !chat.sessionId) chat.sessionId = crypto.randomUUID();
}

// The next start begins a new conversation; the old one stays in the CLI's own history.
export function startNewConversation(chat) {
  chat.sessionId = null;
  ensureSessionId(chat);
}

// Opening a chat goes to its project's page, unless it's pinned, which shows it on every page.
export function openChat(state, id) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat || isPinned(state, id)) return;
  goToPage(state, pageKeyOf(chat));
  const page = currentPage(state);
  if (!page.open.includes(id)) page.open.push(id);
  page.active = id;
}

function leavePage(state, id) {
  const chat = state.chats.find(c => c.id === id);
  const page = chat && state.pages[pageKeyOf(chat)];
  const index = page ? page.open.indexOf(id) : -1;
  if (index === -1) return;
  page.open.splice(index, 1);
  if (page.active === id) page.active = page.open[Math.min(index, page.open.length - 1)] ?? null;
}

export function closeChat(state, id) {
  leavePage(state, id);
  state.pinned = state.pinned.filter(key => key !== pinnedChat(id));
}

export function removeChat(state, id) {
  closeChat(state, id);
  state.chats = state.chats.filter(c => c.id !== id);
}

export function pinChat(state, id) {
  if (!state.chats.some(c => c.id === id) || isPinned(state, id)) return;
  leavePage(state, id);
  state.pinned.push(pinnedChat(id));
}

// An unpinned chat goes back to its project's page.
export function unpinChat(state, id) {
  const chat = state.chats.find(c => c.id === id);
  if (!chat || !isPinned(state, id)) return;
  state.pinned = state.pinned.filter(key => key !== pinnedChat(id));
  const page = state.pages[pageKeyOf(chat)] ??= emptyPage();
  if (!page.open.includes(id)) page.open.push(id);
  page.active = id;
}

export function pinWidget(state, widget) {
  if (WIDGETS.includes(widget) && !state.pinned.includes(widget)) state.pinned.push(widget);
}

export function unpinWidget(state, widget) {
  state.pinned = state.pinned.filter(key => key !== widget);
}

// Every chat with a live terminal: open on some page, or pinned.
export function runningChatIds(state) {
  return [...Object.values(state.pages).flatMap(page => page.open), ...pinnedChatIds(state)];
}

export function swapChats(state, a, b) {
  const open = currentPage(state).open;
  const i = open.indexOf(a), j = open.indexOf(b);
  if (i === -1 || j === -1 || i === j) return;
  [open[i], open[j]] = [open[j], open[i]];
}

export function toggleCollapsed(state, projectId) {
  state.collapsed = state.collapsed.includes(projectId)
    ? state.collapsed.filter(id => id !== projectId) : [...state.collapsed, projectId];
}

// Command-line options as typed in the settings, split like a shell would: spaces separate,
// quotes group.
export function splitArgs(text) {
  const args = [];
  let current = '', quote = null, started = false;
  for (const ch of String(text ?? '')) {
    if (quote) {
      if (ch === quote) quote = null; else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

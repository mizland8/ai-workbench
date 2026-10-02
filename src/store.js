export const AI_TOOLS = ['claude', 'codex', 'gemini', 'opencode'];
export const TOOLS = [...AI_TOOLS, 'shell'];
export const LAYOUTS = ['grid', 'columns', 'focus'];
export const THEMES = ['terminal', 'powershell', 'amber'];
export const storageKey = 'ai-workbench.workspace.v3';
const legacyKey = 'ai-workbench.sessions.v2';

// Claude Code and Gemini CLI start a conversation under an ID we choose; Codex and OpenCode report theirs.
const chosenSessionTools = ['claude', 'gemini'];

export function emptyState() {
  return { projects: [], chats: [], open: [], active: null, layout: 'grid', theme: 'terminal', collapsed: [], toolPaths: {} };
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string';
const list = v => Array.isArray(v) ? v : [];

// Keeps every entry that is still usable instead of discarding the whole workspace over one bad one.
export function normalize(value) {
  const state = emptyState();
  if (!isObject(value)) return state;
  const projectIds = new Set();
  for (const p of list(value.projects)) {
    if (!isObject(p) || !isText(p.id) || !isText(p.name) || !isText(p.path) || projectIds.has(p.id)) continue;
    projectIds.add(p.id);
    state.projects.push({ id: p.id, name: p.name, path: p.path });
  }
  const chatIds = new Set();
  for (const c of list(value.chats)) {
    if (!isObject(c) || !isText(c.id) || !TOOLS.includes(c.tool) || chatIds.has(c.id)) continue;
    chatIds.add(c.id);
    state.chats.push({ id: c.id, tool: c.tool, title: isText(c.title) && c.title.trim() ? c.title : 'New chat',
      projectId: projectIds.has(c.projectId) ? c.projectId : null,
      sessionId: isText(c.sessionId) && c.sessionId ? c.sessionId : null });
  }
  state.open = [...new Set(list(value.open))].filter(id => chatIds.has(id));
  state.active = state.open.includes(value.active) ? value.active : state.open[0] ?? null;
  if (LAYOUTS.includes(value.layout)) state.layout = value.layout;
  if (THEMES.includes(value.theme)) state.theme = value.theme;
  state.collapsed = list(value.collapsed).filter(id => projectIds.has(id));
  if (isObject(value.toolPaths)) {
    for (const tool of AI_TOOLS) if (isText(value.toolPaths[tool]) && value.toolPaths[tool].trim()) state.toolPaths[tool] = value.toolPaths[tool];
  }
  return state;
}

const v2Tools = { Codex: 'codex', Claude: 'claude', Gemini: 'gemini', OpenCode: 'opencode' };

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
  try { raw = storage.getItem(storageKey); }
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

export function addProject(state, name, path) {
  const project = { id: crypto.randomUUID(), name, path };
  state.projects.push(project);
  return project;
}

export function removeProject(state, id) {
  for (const chat of state.chats.filter(c => c.projectId === id)) removeChat(state, chat.id);
  state.projects = state.projects.filter(p => p.id !== id);
  state.collapsed = state.collapsed.filter(key => key !== id);
}

export function addChat(state, tool, projectId, title = '') {
  if (!TOOLS.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  if (projectId !== null && !state.projects.some(p => p.id === projectId)) throw new Error('Unknown project');
  const chat = { id: crypto.randomUUID(), tool, projectId, title: title.trim() || 'New chat', sessionId: null };
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

export function openChat(state, id) {
  if (!state.chats.some(c => c.id === id)) return;
  if (!state.open.includes(id)) state.open.push(id);
  state.active = id;
}

export function closeChat(state, id) {
  const index = state.open.indexOf(id);
  if (index === -1) return;
  state.open.splice(index, 1);
  if (state.active === id) state.active = state.open[Math.min(index, state.open.length - 1)] ?? null;
}

export function removeChat(state, id) {
  closeChat(state, id);
  state.chats = state.chats.filter(c => c.id !== id);
}

export function swapChats(state, a, b) {
  const i = state.open.indexOf(a), j = state.open.indexOf(b);
  if (i === -1 || j === -1 || i === j) return;
  [state.open[i], state.open[j]] = [state.open[j], state.open[i]];
}

export function toggleCollapsed(state, projectId) {
  state.collapsed = state.collapsed.includes(projectId)
    ? state.collapsed.filter(id => id !== projectId) : [...state.collapsed, projectId];
}

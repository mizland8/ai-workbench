import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';

const memory = (entries = {}) => {
  const data = new Map(Object.entries(entries));
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), data };
};

const workspace = () => ({
  projects: [{ id: 'p1', name: 'App', path: '/work/app' }, { id: 'p2', name: 'Site', path: '/work/site' }],
  chats: [
    { id: 'c1', tool: 'claude', projectId: 'p1', title: 'Fix login', sessionId: '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b' },
    { id: 'c2', tool: 'codex', projectId: 'p1', title: 'Tests', sessionId: null },
    { id: 'c3', tool: 'shell', projectId: null, title: 'Scratch', sessionId: null },
    { id: 'c4', tool: 'gemini', projectId: 'p2', title: 'Copy', sessionId: '1f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b' },
  ],
  page: 'p1',
  pages: {
    p1: { open: ['c1', 'c2'], active: 'c2', layout: 'columns' },
    p2: { open: [], active: null, layout: 'grid' },
    individual: { open: ['c3'], active: 'c3', layout: 'focus' },
  },
  pinned: ['chat:c4', 'usage'],
  theme: 'amber', collapsed: ['p2'], toolPaths: { codex: '/opt/codex' },
  settings: { fontSize: 15, notifications: false, flash: true, reopenChats: true, dockWidth: 380, toolArgs: { codex: '--approve-for-me' } },
});

test('a saved workspace loads unchanged', () => {
  const { state, problem } = store.loadState(memory({ [store.storageKey]: JSON.stringify(workspace()) }));
  assert.equal(problem, '');
  assert.deepEqual(state, workspace());
});

test('one bad entry is skipped instead of resetting everything', () => {
  const saved = workspace();
  saved.chats.push(null, { id: 'c9', tool: 'unknown-ai', title: 'x' }, { id: 'c1', tool: 'shell', title: 'duplicate id' });
  saved.projects.push(null, { id: 'p9' });
  saved.pages.p1.open.push('missing', 'c3');
  saved.pinned.push('chat:missing', 'weather');
  const { state } = store.loadState(memory({ [store.storageKey]: JSON.stringify(saved) }));
  assert.deepEqual(state.chats.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(state.pages.p1.open, ['c1', 'c2'], 'chats from other pages and unknown chats are dropped');
  assert.deepEqual(state.pinned, ['chat:c4', 'usage']);
});

test('chats whose project is gone become individual chats', () => {
  const saved = workspace();
  saved.projects = saved.projects.filter(p => p.id !== 'p2');
  const { state } = store.loadState(memory({ [store.storageKey]: JSON.stringify(saved) }));
  assert.equal(state.chats.find(c => c.id === 'c4').projectId, null);
  assert.equal(state.pages.p2, undefined);
  assert.deepEqual(state.collapsed, []);
});

test('an unreadable workspace is kept aside, not overwritten', () => {
  const storage = memory({ [store.storageKey]: '{not json' });
  const { state, problem } = store.loadState(storage);
  assert.match(problem, /couldn’t be read/);
  assert.deepEqual(state, store.emptyState());
  const backups = [...storage.data.keys()].filter(key => key.startsWith(`${store.storageKey}.unreadable-`));
  assert.equal(storage.data.get(backups[0]), '{not json');
});

test('version 3 workspaces become pages: open chats go to their project, each page keeps the layout', () => {
  const v3 = {
    projects: [{ id: 'p1', name: 'App', path: '/work/app' }, { id: 'p2', name: 'Site', path: '/work/site' }],
    chats: [
      { id: 'c1', tool: 'claude', projectId: 'p1', title: 'Fix login', sessionId: '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b' },
      { id: 'c2', tool: 'codex', projectId: 'p2', title: 'Tests', sessionId: null },
      { id: 'c3', tool: 'shell', projectId: null, title: 'Scratch', sessionId: null },
    ],
    open: ['c1', 'c2', 'c3'], active: 'c2', layout: 'columns', theme: 'amber', collapsed: [], toolPaths: {},
  };
  const storage = memory({ 'ai-workbench.workspace.v3': JSON.stringify(v3) });
  const { state } = store.loadState(storage);
  assert.equal(state.page, 'p2', 'the page of the chat that was active');
  assert.deepEqual(state.pages.p1, { open: ['c1'], active: 'c1', layout: 'columns' });
  assert.deepEqual(state.pages.p2, { open: ['c2'], active: 'c2', layout: 'columns' });
  assert.deepEqual(state.pages.individual, { open: ['c3'], active: 'c3', layout: 'columns' });
  assert.deepEqual(state.settings, store.defaultSettings());
  assert.ok(storage.data.has('ai-workbench.workspace.v3'), 'old data is left in place');
});

test('version 2 workspaces keep projects and named chats; untitled placeholders are dropped', () => {
  const v2 = {
    projects: [{ id: 'project-default', name: 'AI Interface', path: '/home/me/AI Interface' }],
    sessions: [
      { id: 'session-0', provider: 'Codex', projectId: 'project-default', title: 'New chat', messages: [] },
      { id: 'session-1', provider: 'Claude', projectId: 'project-default', title: 'Review layout', messages: [] },
      { id: 'session-2', provider: 'Gemini', projectId: null, title: 'New chat', messages: [{ role: 'user', text: 'note' }] },
    ],
    open: ['session-0', 'session-1'], active: 'session-1', layout: 'focus', theme: 'powershell',
  };
  const { state } = store.loadState(memory({ 'ai-workbench.sessions.v2': JSON.stringify(v2) }));
  assert.deepEqual(state.chats.map(c => [c.id, c.tool, c.title]), [['session-1', 'claude', 'Review layout'], ['session-2', 'gemini', 'New chat']]);
  assert.deepEqual(store.runningChatIds(state), [], 'nothing starts automatically after the upgrade');
  assert.equal(state.page, 'project-default');
  assert.equal(state.pages['project-default'].layout, 'focus');
  assert.equal(state.theme, 'powershell');
});

test('settings are checked and limited', () => {
  const saved = workspace();
  saved.settings = { fontSize: 99, dockWidth: 'wide', flash: 'yes', notifications: false, toolArgs: { codex: '-c x=1', shell: 'nope', claude: 3 } };
  const { state } = store.loadState(memory({ [store.storageKey]: JSON.stringify(saved) }));
  assert.deepEqual(state.settings, { fontSize: 24, notifications: false, flash: true, reopenChats: true, dockWidth: 460, toolArgs: { codex: '-c x=1' } });
});

test('a new chat opens on its project page; Claude and Gemini chats get a session ID', () => {
  const state = store.emptyState();
  const project = store.addProject(state, 'App', '/work/app');
  const claude = store.addChat(state, 'claude', project.id, '  Plan  ');
  assert.equal(state.page, project.id);
  assert.deepEqual(store.currentPage(state), { open: [claude.id], active: claude.id, layout: 'grid' });
  assert.match(claude.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(claude.title, 'Plan');
  const shell = store.addChat(state, 'shell', null);
  assert.equal(state.page, store.INDIVIDUAL);
  assert.equal(shell.sessionId, null);
  assert.deepEqual(store.runningChatIds(state).sort(), [claude.id, shell.id].sort());
  assert.throws(() => store.addChat(state, 'claude', 'nope'), /Unknown project/);
});

test('pages keep their own open chats and layout', () => {
  const state = store.normalize(workspace());
  store.goToPage(state, 'p2');
  assert.deepEqual(store.currentPage(state).open, []);
  store.goToPage(state, 'nowhere');
  assert.equal(state.page, 'p2');
  store.openChat(state, 'c2');
  assert.equal(state.page, 'p1', 'opening a chat goes to its page');
  assert.equal(store.currentPage(state).layout, 'columns');
});

test('closing the active chat selects its neighbour on the same page', () => {
  const state = store.normalize(workspace());
  store.openChat(state, 'c1');
  store.closeChat(state, 'c1');
  assert.deepEqual(store.currentPage(state), { open: ['c2'], active: 'c2', layout: 'columns' });
  store.closeChat(state, 'c2');
  assert.equal(store.currentPage(state).active, null);
});

test('pinning moves a chat to the dock on every page, and unpinning puts it back on its page', () => {
  const state = store.normalize(workspace());
  store.pinChat(state, 'c1');
  assert.ok(store.isPinned(state, 'c1'));
  assert.deepEqual(state.pages.p1.open, ['c2']);
  store.openChat(state, 'c1');
  assert.deepEqual(state.pages.p1.open, ['c2'], 'opening a pinned chat leaves it in the dock');
  assert.deepEqual(store.runningChatIds(state).sort(), ['c1', 'c2', 'c3', 'c4']);
  store.goToPage(state, store.INDIVIDUAL);
  store.unpinChat(state, 'c1');
  assert.ok(!store.isPinned(state, 'c1'));
  assert.deepEqual(state.pages.p1, { open: ['c2', 'c1'], active: 'c1', layout: 'columns' });
  assert.equal(state.page, store.INDIVIDUAL, 'unpinning doesn’t switch pages');
  store.closeChat(state, 'c4');
  assert.deepEqual(state.pinned, ['usage'], 'closing a pinned chat removes it from the dock');
});

test('only known widgets can be pinned', () => {
  const state = store.emptyState();
  store.pinWidget(state, 'usage');
  store.pinWidget(state, 'usage');
  store.pinWidget(state, 'weather');
  assert.deepEqual(state.pinned, ['usage']);
  store.unpinWidget(state, 'usage');
  assert.deepEqual(state.pinned, []);
});

test('starting without reopening chats closes them all but keeps widgets', () => {
  const state = store.normalize(workspace());
  store.closeAllChats(state);
  assert.deepEqual(store.runningChatIds(state), []);
  assert.deepEqual(state.pinned, ['usage']);
});

test('swapping panes exchanges their positions on the current page', () => {
  const state = store.normalize(workspace());
  store.swapChats(state, 'c1', 'c2');
  assert.deepEqual(state.pages.p1.open, ['c2', 'c1']);
  store.swapChats(state, 'c1', 'c3');
  assert.deepEqual(state.pages.p1.open, ['c2', 'c1'], 'chats on other pages are left alone');
});

test('removing a project removes its chats and page, and moves to another page', () => {
  const state = store.normalize(workspace());
  store.removeProject(state, 'p1');
  assert.deepEqual(state.chats.map(c => c.id), ['c3', 'c4']);
  assert.equal(state.pages.p1, undefined);
  assert.equal(state.page, 'p2');
});

test('extra command-line options split like a shell', () => {
  assert.deepEqual(store.splitArgs('--approve-for-me -c model_reasoning_effort=max'), ['--approve-for-me', '-c', 'model_reasoning_effort=max']);
  assert.deepEqual(store.splitArgs(`  --name "My Project"  -x '' `), ['--name', 'My Project', '-x', '']);
  assert.deepEqual(store.splitArgs(''), []);
});

test('starting a new conversation replaces the session ID', () => {
  const chat = { tool: 'claude', sessionId: 'old' };
  store.startNewConversation(chat);
  assert.notEqual(chat.sessionId, 'old');
  const codex = { tool: 'codex', sessionId: 'old' };
  store.startNewConversation(codex);
  assert.equal(codex.sessionId, null);
});

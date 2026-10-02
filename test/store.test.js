import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';

const memory = (entries = {}) => {
  const data = new Map(Object.entries(entries));
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), data };
};

const workspace = () => ({
  projects: [{ id: 'p1', name: 'App', path: '/work/app' }],
  chats: [
    { id: 'c1', tool: 'claude', projectId: 'p1', title: 'Fix login', sessionId: '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b' },
    { id: 'c2', tool: 'codex', projectId: null, title: 'Scratch', sessionId: null },
  ],
  open: ['c1', 'c2'], active: 'c2', layout: 'columns', theme: 'amber', collapsed: ['p1'], toolPaths: { codex: '/opt/codex' },
});

test('a saved workspace loads unchanged', () => {
  const storage = memory({ [store.storageKey]: JSON.stringify(workspace()) });
  const { state, problem } = store.loadState(storage);
  assert.equal(problem, '');
  assert.deepEqual(state, workspace());
});

test('one bad entry is skipped instead of resetting everything', () => {
  const saved = workspace();
  saved.chats.push(null, { id: 'c3', tool: 'unknown-ai', title: 'x' }, { id: 'c1', tool: 'shell', title: 'duplicate id' });
  saved.projects.push(null, { id: 'p2' });
  saved.open.push('missing');
  const { state } = store.loadState(memory({ [store.storageKey]: JSON.stringify(saved) }));
  assert.deepEqual(state.chats.map(c => c.id), ['c1', 'c2']);
  assert.deepEqual(state.projects.map(p => p.id), ['p1']);
  assert.deepEqual(state.open, ['c1', 'c2']);
});

test('chats whose project is gone become individual chats', () => {
  const saved = workspace();
  saved.projects = [];
  const { state } = store.loadState(memory({ [store.storageKey]: JSON.stringify(saved) }));
  assert.equal(state.chats.find(c => c.id === 'c1').projectId, null);
  assert.deepEqual(state.collapsed, []);
});

test('an unreadable workspace is kept aside, not overwritten', () => {
  const storage = memory({ [store.storageKey]: '{not json' });
  const { state, problem } = store.loadState(storage);
  assert.match(problem, /couldn’t be read/);
  assert.deepEqual(state, store.emptyState());
  const backups = [...storage.data.keys()].filter(key => key.startsWith(`${store.storageKey}.unreadable-`));
  assert.equal(backups.length, 1);
  assert.equal(storage.data.get(backups[0]), '{not json');
});

test('version 2 workspaces keep projects and named chats; untitled placeholders are dropped', () => {
  const v2 = {
    projects: [{ id: 'project-default', name: 'AI Interface', path: '/home/me/AI Interface' }],
    sessions: [
      { id: 'session-0', provider: 'Codex', projectId: 'project-default', title: 'New chat', files: [], messages: [], draft: '' },
      { id: 'session-1', provider: 'Claude', projectId: 'project-default', title: 'Review layout', files: ['a.js'], messages: [], draft: '' },
      { id: 'session-2', provider: 'Gemini', projectId: null, title: 'New chat', messages: [{ role: 'user', text: 'note' }] },
    ],
    open: ['session-0', 'session-1'], active: 'session-1', layout: 'focus', theme: 'powershell',
  };
  const storage = memory({ 'ai-workbench.sessions.v2': JSON.stringify(v2) });
  const { state } = store.loadState(storage);
  assert.deepEqual(state.projects, v2.projects);
  assert.deepEqual(state.chats.map(c => [c.id, c.tool, c.title]), [['session-1', 'claude', 'Review layout'], ['session-2', 'gemini', 'New chat']]);
  assert.deepEqual(state.open, [], 'nothing starts automatically after the upgrade');
  assert.equal(state.layout, 'focus');
  assert.equal(state.theme, 'powershell');
  assert.ok(storage.data.has('ai-workbench.sessions.v2'), 'old data is left in place');
});

test('new Claude and Gemini chats get a session ID; Codex, OpenCode and shells wait for theirs', () => {
  const state = store.emptyState();
  const project = store.addProject(state, 'App', '/work/app');
  const claude = store.addChat(state, 'claude', project.id, '  Plan  ');
  const gemini = store.addChat(state, 'gemini', null);
  const codex = store.addChat(state, 'codex', project.id);
  const shell = store.addChat(state, 'shell', null);
  assert.match(claude.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(gemini.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(codex.sessionId, null);
  assert.equal(shell.sessionId, null);
  assert.equal(claude.title, 'Plan');
  assert.equal(gemini.title, 'New chat');
  assert.deepEqual(state.open, [claude.id, gemini.id, codex.id, shell.id]);
  assert.equal(state.active, shell.id);
  assert.throws(() => store.addChat(state, 'claude', 'nope'), /Unknown project/);
});

test('starting a new conversation replaces the session ID', () => {
  const chat = { tool: 'claude', sessionId: 'old' };
  store.startNewConversation(chat);
  assert.notEqual(chat.sessionId, 'old');
  const codex = { tool: 'codex', sessionId: 'old' };
  store.startNewConversation(codex);
  assert.equal(codex.sessionId, null);
});

test('closing the active chat selects its neighbour', () => {
  const state = store.normalize({ ...workspace(), chats: [...workspace().chats, { id: 'c3', tool: 'shell', title: 't' }], open: ['c1', 'c2', 'c3'], active: 'c2' });
  store.closeChat(state, 'c2');
  assert.deepEqual(state.open, ['c1', 'c3']);
  assert.equal(state.active, 'c3');
  store.closeChat(state, 'c3');
  assert.equal(state.active, 'c1');
  store.closeChat(state, 'c1');
  assert.equal(state.active, null);
});

test('swapping panes exchanges their positions', () => {
  const state = store.normalize(workspace());
  store.swapChats(state, 'c1', 'c2');
  assert.deepEqual(state.open, ['c2', 'c1']);
  store.swapChats(state, 'c1', 'missing');
  assert.deepEqual(state.open, ['c2', 'c1']);
});

test('removing a project removes its chats and keeps the others', () => {
  const state = store.normalize(workspace());
  store.removeProject(state, 'p1');
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.chats.map(c => c.id), ['c2']);
  assert.deepEqual(state.open, ['c2']);
  assert.deepEqual(state.collapsed, []);
});

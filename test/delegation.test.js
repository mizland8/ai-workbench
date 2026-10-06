import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';
import { handleDelegation, resolveTarget, briefing } from '../src/delegation.js';
import { ProjectBoard } from '../src/board.js';

function setup() {
  const state = store.emptyState();
  const project = store.addProject(state, 'Wrestling', '/games/wrestling');
  const parent = store.addChat(state, 'codex', project.id, 'Lead');
  const child = store.addChat(state, 'agy', project.id, 'Animations', null, parent.id);
  const grandchild = store.addChat(state, 'claude', project.id, 'Review', null, child.id);
  const other = store.addChat(state, 'agy', project.id, 'Unconnected');
  const panes = new Map(state.chats.map((c, i) => [c.id, { chatId: c.id, display: 'ready', view: { id: i + 1, status: 'running', lastOutputAt: 123, transcript: () => `Result from ${c.title}`, submitPrompt: async prompt => { c.received = prompt; } } }]));
  const request = (method, target = child.title, prompt = 'Implement the grapple animation') => ({ source: { chatId: parent.id, terminalId: 1 }, method, target, prompt });
  return { state, parent, child, grandchild, other, panes, request };
}
test('hierarchy persists and children keep their own live sessions', () => {
  const { state, parent, child, grandchild } = setup();
  const loaded = store.normalize(JSON.parse(JSON.stringify(state)));
  assert.equal(loaded.chats.find(c => c.id === child.id).parentId, parent.id);
  assert.deepEqual(store.chatTree(loaded.chats).map(({ chat, depth }) => [chat.title, depth]), [['Lead', 0], ['Animations', 1], ['Review', 2], ['Unconnected', 0]]);
  store.removeChat(loaded, child.id);
  assert.equal(loaded.chats.find(c => c.id === grandchild.id).parentId, parent.id);
});
test('invalid parents and cycles cannot hide chats or connect projects', () => {
  const { state, parent, child, other } = setup();
  parent.parentId = child.id;
  other.parentId = 'gone';
  const loaded = store.normalize(state);
  assert.equal(store.chatTree(loaded.chats).length, 4);
  const p2 = store.addProject(state, 'Other project', '/other');
  assert.throws(() => store.addChat(state, 'agy', p2.id, 'Wrong', null, child.id));
  assert.throws(() => store.addChat(state, 'shell', child.projectId, 'Shell', null, child.id));
});
test('every AI chat in a project reaches every other one; other projects stay out', async () => {
  const { state, parent, child, grandchild, other, panes, request } = setup();
  assert.deepEqual(store.delegationTargets(state, parent.id).map(c => c.id), [child.id, grandchild.id, other.id]);
  assert.deepEqual(store.delegationTargets(state, other.id).map(c => c.id), [parent.id, child.id, grandchild.id]);
  const listed = await handleDelegation(state, panes, request('list'));
  assert.equal(listed.you.name, 'Lead');
  assert.equal(listed.project.name, 'Wrestling');
  assert.deepEqual(listed.chats.map(c => [c.name, c.relation]), [['Animations', 'reports to you'], ['Review', 'under you'], ['Unconnected', 'teammate']]);
  assert.equal(listed.chats[1].parentName, 'Animations');
  await handleDelegation(state, panes, request('send', other.id, 'Review the grapple'));
  assert.equal(other.received, 'Review the grapple');
  const away = store.addChat(state, 'claude', store.addProject(state, 'Elsewhere', '/elsewhere').id, 'Outsider');
  panes.set(away.id, { display: 'ready', view: { id: 99, status: 'running' } });
  await assert.rejects(handleDelegation(state, panes, request('read', away.title)), /No AI chat in this project/);
  const loose = store.addChat(state, 'codex', null, 'Loose');
  assert.deepEqual(store.delegationTargets(state, loose.id), []);
});
test('a unique renamed chat resolves; ambiguous names require IDs', () => {
  const { state, parent, child, grandchild } = setup();
  child.title = 'Grapples';
  assert.equal(resolveTarget(state, parent.id, 'Grapples').id, child.id);
  assert.throws(() => resolveTarget(state, parent.id, 'Animations'), /No AI chat/);
  grandchild.title = child.title;
  assert.throws(() => resolveTarget(state, parent.id, 'Grapples'), /Several/);
  assert.equal(resolveTarget(state, parent.id, child.id).id, child.id);
});
test('send targets the existing terminal and read reports its output', async () => {
  const { state, child, panes, request } = setup();
  const log = [];
  const result = await handleDelegation(state, panes, request('send'), h => log.push(h));
  assert.equal(result.accepted, true);
  assert.equal(child.received, 'Implement the grapple animation');
  assert.equal(log[0].to, 'Animations');
  assert.equal((await handleDelegation(state, panes, request('read'))).text, 'Result from Animations');
});
test('stale callers, closed helpers, expired requests and control characters are rejected', async () => {
  const { state, child, panes, request } = setup();
  await assert.rejects(handleDelegation(state, panes, { ...request('send'), source: { chatId: request('send').source.chatId, terminalId: 999 } }), /ended/);
  await assert.rejects(handleDelegation(state, panes, { ...request('send'), expiresAt: 1 }), /expired/);
  await assert.rejects(handleDelegation(state, panes, request('send', child.id, '\x1b[2J')), /control/);
  panes.get(child.id).view.status = 'exited';
  await assert.rejects(handleDelegation(state, panes, request('send')), /closed or stopped/);
  assert.equal(child.received, undefined);
});
test('a busy or approval-blocked terminal refuses the task without logging a handoff', async () => {
  const { state, child, panes, request } = setup();
  panes.get(child.id).view.submitPrompt = async () => { throw new Error('Target is busy or needs user input'); };
  let logged = false;
  await assert.rejects(handleDelegation(state, panes, request('send'), () => { logged = true; }), /busy/);
  assert.equal(logged, false);
  assert.equal(child.received, undefined);
});

test('Windows multiline prompts keep line breaks without inserting terminal controls', async () => {
  const { state, child, panes, request } = setup();
  await handleDelegation(state, panes, request('send', child.id, 'Implement grapples\r\nReview animations'));
  assert.equal(child.received, 'Implement grapples\nReview animations');
});

test('local-model helpers retain their server, model, session and parent through reload', () => {
  const { state, parent } = setup();
  const helper = store.addChat(state, 'local', parent.projectId, 'Local review', { server: 'http://localhost:1234', model: 'qwen/qwen3-coder' }, parent.id);
  helper.sessionId = 'ses-local-helper';
  const restored = store.normalize(JSON.parse(JSON.stringify(state)));
  const saved = restored.chats.find(c => c.id === helper.id);
  assert.equal(saved.parentId, parent.id);
  assert.equal(saved.server, 'http://localhost:1234');
  assert.equal(saved.model, 'qwen/qwen3-coder');
  assert.equal(saved.sessionId, 'ses-local-helper');
  assert.equal(resolveTarget(restored, parent.id, 'Local review').id, helper.id);
});

import { TaskLedger } from '../src/task-ledger.js';
function taskStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}
test('tracked handoffs survive restart and workers report while their parent is busy', async () => {
  const { state, parent, child, panes, request } = setup();
  const storage = taskStorage();
  const ledger = new TaskLedger(storage);
  const sent = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  assert.ok(child.received.includes(sent.taskId));
  const restored = new TaskLedger(storage);
  const report = { source: { chatId: child.id, terminalId: 2 }, method: 'complete', target: sent.taskId, prompt: 'Changed animations.gd; checks passed.' };
  panes.get(parent.id).view.submitPrompt = () => { throw new Error('Parent must not receive terminal input'); };
  await handleDelegation(state, panes, report, () => {}, restored);
  let inbox = await handleDelegation(state, panes, request('inbox'), () => {}, restored);
  assert.equal(inbox.reports[0].result, report.prompt);
  await handleDelegation(state, panes, request('ack', sent.taskId), () => {}, restored);
  await handleDelegation(state, panes, report, () => {}, restored);
  inbox = await handleDelegation(state, panes, request('inbox'), () => {}, new TaskLedger(storage));
  assert.equal(inbox.reports.length, 0);
  await assert.rejects(handleDelegation(state, panes, { ...report, prompt: 'Different result' }, () => {}, restored), /final report/);
});
test('task reports are scoped to assigned participants and the current project', async () => {
  const { state, parent, child, grandchild, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const { taskId } = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  await assert.rejects(handleDelegation(state, panes, request('complete', taskId, 'done'), () => {}, ledger), /assigned worker/);
  await assert.rejects(handleDelegation(state, panes, { source: { chatId: grandchild.id, terminalId: 3 }, method: 'task', target: taskId }, () => {}, ledger), /accessible/);
  child.parentId = null;
  assert.equal((await handleDelegation(state, panes, request('tasks'), () => {}, ledger)).tasks.length, 1);
  child.projectId = store.addProject(state, 'Elsewhere', '/elsewhere').id;
  assert.equal((await handleDelegation(state, panes, request('tasks'), () => {}, ledger)).tasks.length, 0);
});
test('storage failure prevents dispatch and uncertain delivery is never replayed', async () => {
  const { state, child, panes, request } = setup();
  const storage = taskStorage();
  const ledger = new TaskLedger(storage);
  storage.setItem = () => { throw new Error('Storage full'); };
  await assert.rejects(handleDelegation(state, panes, request('send'), () => {}, ledger), /Storage full/);
  assert.equal(child.received, undefined);
  const secondStorage = taskStorage();
  const second = new TaskLedger(secondStorage);
  panes.get(child.id).view.submitPrompt = async () => { throw new Error('Connection lost'); };
  await assert.rejects(handleDelegation(state, panes, request('send'), () => {}, second), /Delivery was not confirmed/);
  assert.equal(new TaskLedger(secondStorage).tasks[0].status, 'delivery_unknown');
});
test('readiness checks prevent creating tasks for blocked terminals', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  panes.get(child.id).view.promptProblem = () => 'Approval required';
  await assert.rejects(handleDelegation(state, panes, request('send'), () => {}, ledger), /Approval/);
  assert.equal(ledger.tasks.length, 0);
});

test('a descendant worker can report to its original ancestor requester', async () => {
  const { state, grandchild, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const { taskId } = await handleDelegation(state, panes, request('send', grandchild.id), () => {}, ledger);
  const result = await handleDelegation(state, panes, { source: { chatId: grandchild.id, terminalId: 3 }, method: 'fail', target: taskId, prompt: 'Missing dependency' }, () => {}, ledger);
  assert.equal(result.task.status, 'failed');
});
test('history capacity protects unread reports and discards only acknowledged final tasks', () => {
  const { state, parent, child } = setup();
  const ledger = new TaskLedger(taskStorage());
  for (let i = 0; i < 200; i++) ledger.create(parent.id, child.id, `Task ${i}`);
  assert.throws(() => ledger.create(parent.id, child.id, 'Extra task'), /full/);
  const first = ledger.tasks[0].id;
  ledger.handle(state, child.id, { method: 'complete', target: first, prompt: 'Done' });
  assert.throws(() => ledger.create(parent.id, child.id, 'Extra task'), /full/);
  ledger.handle(state, parent.id, { method: 'ack', target: first });
  ledger.create(parent.id, child.id, 'Extra task');
  assert.equal(ledger.tasks.length, 200);
  assert.ok(!ledger.tasks.some(t => t.id === first));
});
test('tracked prompt size reserves space for reporting instructions', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  await assert.rejects(handleDelegation(state, panes, request('send', child.id, 'x'.repeat(31501)), () => {}, ledger), /31500/);
  assert.equal(ledger.tasks.length, 0);
  await handleDelegation(state, panes, request('send', child.id, 'x'.repeat(31500)), () => {}, ledger);
  assert.ok(child.received.length <= 32000);
});

test('the project board shares notes within a project and survives restart', async () => {
  const { state, parent, child, panes, request } = setup();
  const storage = taskStorage();
  const board = new ProjectBoard(storage);
  const posted = await handleDelegation(state, panes, { ...request('post', ''), prompt: 'I own animations.gd; starting grapples.' }, () => {}, null, { board });
  assert.equal(posted.posted.fromName, 'Lead');
  const asChild = { source: { chatId: child.id, terminalId: 2 }, method: 'board' };
  const read = await handleDelegation(state, panes, asChild, () => {}, null, { board: new ProjectBoard(storage) });
  assert.deepEqual(read.notes.map(n => n.text), ['I own animations.gd; starting grapples.']);
  const listed = await handleDelegation(state, panes, { source: asChild.source, method: 'list' }, () => {}, null, { board });
  assert.equal(listed.chats.find(c => c.id === parent.id).lastNote.text, 'I own animations.gd; starting grapples.');
  await assert.rejects(handleDelegation(state, panes, { ...request('post', ''), prompt: '  ' }, () => {}, null, { board }), /note/);
  const other = store.addProject(state, 'Other', '/other');
  assert.equal(board.read(other.id).length, 0);
});

test('a worker report notifies its requester and shows in the team list', async () => {
  const { state, parent, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const reports = [];
  const sent = await handleDelegation(state, panes, request('send'), () => {}, ledger, { onReport: t => reports.push(t) });
  const listed = await handleDelegation(state, panes, request('list'), () => {}, ledger);
  assert.equal(listed.chats.find(c => c.id === child.id).openTasks[0].taskId, sent.taskId);
  const report = { source: { chatId: child.id, terminalId: 2 }, method: 'complete', target: sent.taskId, prompt: 'Done; tests pass.' };
  await handleDelegation(state, panes, report, () => {}, ledger, { onReport: t => reports.push(t) });
  assert.deepEqual(reports.map(t => [t.fromId, t.status]), [[parent.id, 'completed']]);
  assert.equal((await handleDelegation(state, panes, request('list'), () => {}, ledger)).chats.find(c => c.id === child.id).openTasks.length, 0);
});

test('each AI is briefed on its name, project, lead and team in one shell-safe line', () => {
  const { state, parent, child } = setup();
  child.title = 'Anim "fx" & <ui>';
  const text = briefing(state, child.id);
  assert.match(text, /named Anim fx ui \(Antigravity CLI\) in the project Wrestling, whose folder is \/games\/wrestling/);
  assert.match(text, /Your lead is Lead\./);
  assert.match(text, /Chats under you: Review\./);
  assert.match(text, /Unconnected \(Antigravity CLI\)/);
  assert.match(text, /Stay within this project/);
  assert.doesNotMatch(text, /["%&|<>^`\n]/);
  assert.equal(briefing(state, store.addChat(state, 'shell', parent.projectId, 'Shell').id), null);
});

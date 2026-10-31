import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';
import { handleDelegation, resolveTarget, briefing } from '../src/delegation.js';
import { ProjectBoard } from '../src/board.js';
import { readFileSync } from 'node:fs';
import { coordinationPolicy } from '../src/coordination.js';
import { reportInstructions } from '../src/task-ledger.js';
import { TaskLedger } from '../src/task-ledger.js';
function taskStorage() {
  let value = null;
  return { getItem: () => value, setItem: (_, next) => { value = next; } };
}

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
  const ledger = new TaskLedger(taskStorage());
  await handleDelegation(state, panes, request('send', other.id, 'Review the grapple'), () => {}, ledger);
  assert.deepEqual(ledger.queued(other.id).map(t => t.prompt), ['Review the grapple']);
  const away = store.addChat(state, 'claude', store.addProject(state, 'Elsewhere', '/elsewhere').id, 'Outsider');
  panes.set(away.id, { display: 'ready', view: { id: 99, status: 'running' } });
  await assert.rejects(handleDelegation(state, panes, request('read', away.title)), /No AI chat in this project/);
  await assert.rejects(handleDelegation(state, panes, request('send', away.id), () => {}, ledger), /No AI chat in this project/);
  assert.equal(ledger.queued(away.id).length, 0);
  const loose = store.addChat(state, 'codex', null, 'Loose');
  assert.deepEqual(store.delegationTargets(state, loose.id), []);
});
test('a unique renamed chat resolves; ambiguous names require IDs', () => {
  const { state, parent, child, grandchild } = setup();
  child.title = 'Grapples';
  assert.equal(resolveTarget(state, parent.id, 'Grapples').id, child.id);
  assert.equal(resolveTarget(state, parent.id, ' grapples ').id, child.id);
  assert.throws(() => resolveTarget(state, parent.id, 'Animations'), /No AI chat/);
  grandchild.title = child.title;
  assert.throws(() => resolveTarget(state, parent.id, 'Grapples'), /Several/);
  grandchild.title = 'GRAPPLES';
  assert.equal(resolveTarget(state, parent.id, 'Grapples').id, child.id);
  assert.throws(() => resolveTarget(state, parent.id, 'grapples'), /Several/);
  assert.equal(resolveTarget(state, parent.id, child.id).id, child.id);
});
test('send queues the task without typing into the target, and read reports its output', async () => {
  const { state, child, panes, request } = setup();
  const log = [];
  const ledger = new TaskLedger(taskStorage());
  const result = await handleDelegation(state, panes, request('send'), h => log.push(h), ledger);
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'queued');
  assert.equal(child.received, undefined);
  assert.equal(ledger.queued(child.id)[0].prompt, 'Implement the grapple animation');
  assert.equal(log[0].to, 'Animations');
  assert.equal((await handleDelegation(state, panes, request('read'))).text, 'Result from Animations');
});
test('stale callers, expired requests, control characters and missing storage are rejected', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  await assert.rejects(handleDelegation(state, panes, { ...request('send'), source: { chatId: request('send').source.chatId, terminalId: 999 } }, () => {}, ledger), /ended/);
  await assert.rejects(handleDelegation(state, panes, { ...request('send'), expiresAt: 1 }, () => {}, ledger), /expired/);
  await assert.rejects(handleDelegation(state, panes, request('send', child.id, '\x1b[2J'), () => {}, ledger), /control/);
  await assert.rejects(handleDelegation(state, panes, request('send')), /storage/);
  panes.get(child.id).view.status = 'exited';
  await assert.rejects(handleDelegation(state, panes, request('read')), /closed or stopped/);
  assert.equal(ledger.tasks.length, 0);
  assert.equal(child.received, undefined);
});
test('busy, approval-blocked and closed chats still receive queued tasks; nothing is typed into them', async () => {
  const { state, child, grandchild, other, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  for (const chat of [child, grandchild, other]) panes.get(chat.id).view.submitPrompt = async () => { throw new Error('Must not type into the target'); };
  panes.get(child.id).view.deliveryState = () => ({ state: 'approval_pending', canAccept: false, reason: 'A user must review the approval in this chat. No prompt was sent.' });
  panes.get(grandchild.id).view.deliveryState = () => ({ state: 'busy', canAccept: false, reason: 'The agent is working.' });
  panes.get(other.id).view.status = 'exited';
  const queued = [];
  for (const chat of [child, grandchild, other]) assert.equal((await handleDelegation(state, panes, request('send', chat.id), () => {}, ledger, { onQueued: t => queued.push(t.toId) })).status, 'queued');
  assert.deepEqual(queued, [child.id, grandchild.id, other.id]);
  const listed = await handleDelegation(state, panes, request('list'), () => {}, ledger);
  assert.deepEqual(listed.chats.map(c => [c.status, c.queued, c.canAccept]), [['approval_pending', 1, true], ['busy', 1, true], ['ready', 1, true]]);
});

test('Windows multiline prompts keep line breaks without inserting terminal controls', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  await handleDelegation(state, panes, request('send', child.id, 'Implement grapples\r\nReview animations'), () => {}, ledger);
  assert.equal(ledger.queued(child.id)[0].prompt, 'Implement grapples\nReview animations');
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

test('tracked handoffs survive restart and workers report while their parent is busy', async () => {
  const { state, parent, child, panes, request } = setup();
  const storage = taskStorage();
  const ledger = new TaskLedger(storage);
  const sent = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  const restored = new TaskLedger(storage);
  const claimed = await handleDelegation(state, panes, { source: { chatId: child.id, terminalId: 2 }, method: 'next' }, () => {}, restored);
  assert.equal(claimed.task.id, sent.taskId);
  assert.equal(claimed.task.prompt, 'Implement the grapple animation');
  assert.equal(claimed.task.from, 'Lead');
  assert.match(claimed.instructions, new RegExp(`bridge complete ${sent.taskId}`));
  assert.equal(child.received, undefined);
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
  assert.equal(ledger.tasks.length, 0);
});
test('next claims only the caller\'s oldest queued task; cancel withdraws only unclaimed tasks of the requester', async () => {
  const { state, parent, child, grandchild, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const as = (chat, method, target = '', prompt = '') => handleDelegation(state, panes, { source: { chatId: chat.id, terminalId: state.chats.indexOf(chat) + 1 }, method, target, prompt }, () => {}, ledger);
  const first = await handleDelegation(state, panes, request('send', child.id, 'First'), () => {}, ledger);
  const second = await handleDelegation(state, panes, request('send', child.id, 'Second'), () => {}, ledger);
  assert.equal(second.position, 2);
  assert.equal((await as(grandchild, 'next')).task, null);
  await assert.rejects(as(child, 'cancel', second.taskId), /requester/);
  const claimed = await as(child, 'next');
  assert.equal(claimed.task.id, first.taskId);
  assert.equal(claimed.remaining, 1);
  await assert.rejects(as(parent, 'cancel', first.taskId), /before the worker claims/);
  assert.equal((await as(parent, 'cancel', second.taskId)).task.status, 'cancelled');
  assert.equal((await as(child, 'next')).task, null);
  child.projectId = store.addProject(state, 'Elsewhere', '/elsewhere').id;
  await handleDelegation(state, panes, request('send', grandchild.id, 'Third'), () => {}, ledger);
  assert.equal((await as(child, 'next')).task, null, 'a chat moved to another project cannot claim its old project\'s tasks');
});
test('queues are bounded per chat', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  for (let i = 0; i < 20; i++) await handleDelegation(state, panes, request('send', child.id, `Task ${i}`), () => {}, ledger);
  await assert.rejects(handleDelegation(state, panes, request('send', child.id, 'One more'), () => {}, ledger), /20 queued/);
});

test('a descendant worker can report to its original ancestor requester', async () => {
  const { state, grandchild, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const { taskId } = await handleDelegation(state, panes, request('send', grandchild.id), () => {}, ledger);
  const result = await handleDelegation(state, panes, { source: { chatId: grandchild.id, terminalId: 3 }, method: 'fail', target: taskId, prompt: 'Missing dependency' }, () => {}, ledger);
  assert.equal(result.task.status, 'failed');
});
test('history capacity protects unread reports and preserves acknowledged audit history', () => {
  const { state, parent, child } = setup();
  const ledger = new TaskLedger(taskStorage());
  for (let i = 0; i < 200; i++) ledger.create(parent.id, child.id, `Task ${i}`);
  assert.throws(() => ledger.create(parent.id, child.id, 'Extra task'), /full/);
  const first = ledger.tasks[0].id;
  ledger.handle(state, child.id, { method: 'complete', target: first, prompt: 'Done' });
  assert.throws(() => ledger.create(parent.id, child.id, 'Extra task'), /full/);
  ledger.handle(state, parent.id, { method: 'ack', target: first });
  ledger.create(parent.id, child.id, 'Extra task');
  assert.equal(ledger.tasks.length, 201);
  assert.ok(ledger.tasks.some(t => t.id === first));
});
test('task prompts are limited to 32000 characters', async () => {
  const { state, child, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  await assert.rejects(handleDelegation(state, panes, request('send', child.id, 'x'.repeat(32001)), () => {}, ledger), /32000/);
  assert.equal(ledger.tasks.length, 0);
  await handleDelegation(state, panes, request('send', child.id, 'x'.repeat(32000)), () => {}, ledger);
  assert.equal(ledger.tasks.length, 1);
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

test('coordination entry points prescribe independent work and standby instead of polling', async () => {
  const { state, parent, panes, request } = setup();
  const ledger = new TaskLedger(taskStorage());
  const sent = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  for (const text of [briefing(state, parent.id), sent.note, reportInstructions(sent.taskId)]) {
    assert.ok(text.includes(coordinationPolicy));
    assert.doesNotMatch(text, /Use bridge task to follow|without checking bridge list/);
  }
  // CLI help is compiled separately; keep its guidance consistent with prompt delivery.
  assert.ok(readFileSync(new URL('../src-tauri/src/bridge.rs', import.meta.url), 'utf8').includes(coordinationPolicy));
  assert.match(coordinationPolicy, /check bridge inbox once/);
  assert.match(coordinationPolicy, /end your turn and remain on standby/);
});

import { PURGE_HELP } from '../src/quota.js';
const quotaError = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError', code: 22 });
test('a full storage quota tells the AI how the user can purge', async () => {
  const { state, child, panes, request } = setup();
  const storage = taskStorage();
  const ledger = new TaskLedger(storage);
  storage.setItem = () => { throw quotaError(); };
  await assert.rejects(handleDelegation(state, panes, request('send'), () => {}, ledger), error => error.message === PURGE_HELP && /Purge finished tasks/.test(error.message));
  assert.equal(child.received, undefined);
  const board = new ProjectBoard(storage);
  assert.throws(() => board.post('p', { id: 'c', title: 'Claude' }, 'note'), /Purge finished tasks/);
});
test('purge forgets finished tasks, keeps live ones, and frees the quota', async () => {
  const { state, child, panes, request } = setup();
  let value = null;
  let capacity = Infinity;
  const storage = { getItem: () => value, setItem: (_, next) => { if (next.length > capacity) throw quotaError(); value = next; } };
  const ledger = new TaskLedger(storage);
  const done = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  await handleDelegation(state, panes, { source: { chatId: child.id, terminalId: 2 }, method: 'complete', target: done.taskId, prompt: 'x'.repeat(400) }, () => {}, ledger);
  const live = await handleDelegation(state, panes, request('send'), () => {}, ledger);
  capacity = value.length;
  await assert.rejects(handleDelegation(state, panes, request('send', undefined, 'A different task'), () => {}, ledger), /Purge finished tasks/);
  assert.equal(ledger.purge(), 1);
  assert.deepEqual(new TaskLedger(storage).tasks.map(t => t.id), [live.taskId]);
  assert.equal(ledger.purge(), 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryState } from '../src/agent-status.js';
import { handleDelegation } from '../src/delegation.js';
import { TaskLedger } from '../src/task-ledger.js';
import * as store from '../src/store.js';
const rule = '─'.repeat(50);
const prompts = { codex: ['  ›', '', 'GPT-6.1-Sol · project'], claude: [rule, '  ❯', rule], agy: [rule, '  >', rule], opencode: ['  ┃', '  ┃ Build · Big Pickle', 'tab agents  ctrl+p commands'] };
const snapshot = (tool, more = {}) => deliveryState({ tool, lines: prompts[tool], lastOutputAt: 2000, now: 4000, ...more });
test('every supported agent uses the same ready decision with indented prompts and changing footers', () => {
  for (const tool of Object.keys(prompts)) assert.equal(snapshot(tool).canAccept, true, tool);
  assert.equal(snapshot('codex', { lines: ['• Earlier reply: sign in to your account.', ...prompts.codex] }).canAccept, true);
  assert.equal(snapshot('claude', { lines: ['Do you want to proceed?', ...prompts.claude] }).canAccept, true);
});
test('closed, starting, working, approvals and questions hold a message; drafts and unknown screens do not', () => {
  const cases = [
    [{ status: 'exited' }, 'closed'], [{ id: null }, 'closed'], [{ lastOutputAt: 0 }, 'starting'], [{ submitting: true }, 'busy'],
    [{ lines: ['• Working • esc to interrupt', ...prompts.codex] }, 'busy'],
    [{ lines: ['Would you like to run the following command?', '› 1. Yes, proceed'] }, 'approval_pending'],
    [{ lines: ['Overwrite? (y/n)'] }, 'user_input_required'],
  ];
  for (const [options, state] of cases) { const result = snapshot('codex', options); assert.equal(result.state, state); assert.equal(result.canAccept, false); assert.ok(result.reason); }
  for (const lines of [['› draft', '', '? for shortcuts'], ['Unknown screen']]) assert.equal(snapshot('codex', { lines }).canAccept, true, lines[0]);
});
function setup() {
  const state = store.emptyState(), project = store.addProject(state, 'Repair test', '/tmp/workbench-test');
  const a = store.addChat(state, 'codex', project.id, 'Requester'), b = store.addChat(state, 'claude', project.id, 'Worker');
  let value = null, sent = 0, blocked = false;
  const storage = { getItem: () => value, setItem: (_, v) => { value = v; } }, ledger = new TaskLedger(storage);
  const panes = new Map([a, b].map((chat, i) => [chat.id, { chatId: chat.id, display: 'ready', view: { id: i + 1, status: 'running',
    refreshPrompt: async () => {}, deliveryState: () => ({ state: blocked ? 'approval_pending' : 'ready', canAccept: !blocked, reason: blocked ? 'Approval pending' : null }),
    promptProblem: () => blocked ? 'Approval pending' : null, submitPrompt: async () => { if (blocked) throw Error('Approval pending'); sent++; }, transcript: () => 'test screen' } }]));
  const request = (method, target = b.id, prompt = 'Harmless test') => ({ source: { chatId: a.id, terminalId: 1 }, method, target, prompt });
  const worker = (method, target, prompt) => ({ source: { chatId: b.id, terminalId: 2 }, method, target, prompt });
  return { state, a, b, ledger, storage, panes, request, worker, sent: () => sent, block: () => { blocked = true; } };
}
test('discovery refreshes and reports a ready UI dot as approval_pending; send still queues without typing', async () => {
  const s = setup(); s.panes.get(s.b.id).view.refreshPrompt = async () => s.block();
  const result = await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger);
  assert.equal(result.chats[0].status, 'approval_pending'); assert.match(result.chats[0].screen, /approval/i); assert.match(result.chats[0].label, /Worker · Claude Code/);
  assert.equal((await handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger)).status, 'queued');
  assert.equal(s.ledger.tasks.length, 1); assert.equal(s.sent(), 0);
});
test('concurrent or retried identical sends reuse one queued task; different tasks queue behind it', async () => {
  const s = setup(); const results = await Promise.all([1, 2].map(() => handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger)));
  assert.equal(s.ledger.tasks.length, 1); assert.equal(results[0].taskId, results[1].taskId); assert.equal(results[1].duplicate, true);
  assert.equal((await handleDelegation(s.state, s.panes, s.request('send', s.b.id, 'Different task'), undefined, s.ledger)).position, 2);
  assert.equal(s.sent(), 0);
});
test('tasks left delivery_unknown by older versions can still be inspected and resolved without replay', async () => {
  const s = setup();
  const task = s.ledger.create(s.a.id, s.b.id, 'Harmless test'); s.ledger.update(task.id, { status: 'delivery_unknown' });
  assert.equal((await handleDelegation(s.state, s.panes, s.request('next'), undefined, s.ledger)).task, null);
  assert.throws(() => s.ledger.handle(s.state, s.b.id, { method: 'resolve', target: task.id, prompt: 'not-delivered inspected terminal' }), /requester/);
  s.ledger.handle(s.state, s.a.id, { method: 'resolve', target: task.id, prompt: 'not-delivered inspected terminal and confirmed no prompt' });
  assert.equal(new TaskLedger(s.storage).tasks[0].status, 'cancelled'); assert.equal(s.sent(), 0);
});
test('failed to successful revisions preserve reports, renew inbox and notify once; acknowledgments survive reload', async () => {
  const s = setup(), notifications = [];
  const call = req => handleDelegation(s.state, s.panes, req, undefined, s.ledger, { onReport: t => notifications.push(t.status) });
  const { taskId } = await call(s.request('send'));
  await call(s.worker('fail', taskId, 'Initial check failed'));
  await call(s.request('ack', taskId));
  await call(s.worker('revise-complete', taskId, 'Corrected: reran check successfully; initial result was stale'));
  await call(s.worker('revise-complete', taskId, 'Corrected: reran check successfully; initial result was stale'));
  const inbox = await call(s.request('inbox')); const report = inbox.reports[0];
  assert.equal(report.status, 'completed'); assert.equal(report.reports[0].status, 'failed'); assert.equal(report.reports[0].acknowledged, true);
  assert.equal(report.reports.length, 2); assert.deepEqual(notifications, ['failed', 'completed']);
  await call(s.request('ack', taskId));
  assert.equal(new TaskLedger(s.storage).handle(s.state, s.a.id, s.request('inbox')).reports.length, 0);
});
test('selected scoped permission settings persist without replacing sessions or granting unrestricted access', () => {
  const s = setup(); s.a.sessionId = 'saved-session';
  const loaded = store.normalize(JSON.parse(JSON.stringify(s.state)));
  assert.equal(loaded.chats[0].sessionId, 'saved-session');
  const flags = store.toolOptions(loaded.settings, 'codex').flatMap(o => o.args);
  assert.deepEqual(flags, ['--dangerously-bypass-approvals-and-sandbox']);
  loaded.settings.approvals.codex = 'never';
  assert.equal(store.toolOptions(loaded.settings, 'codex')[0].args[1], 'never');
  assert.match(store.addChat(loaded, 'codex', loaded.projects[0].id).title, /^Codex \d+$/);
});

test('OpenCode approval prompts hold a message; its drafts do not', () => {
  assert.equal(snapshot('opencode', { lines: ['┃ unfinished draft', '┃ Build · model', 'tab agents  ctrl+p commands'] }).canAccept, true);
  assert.equal(snapshot('opencode', { lines: ['Permission required', 'Allow once   Allow always   Reject'] }).state, 'approval_pending');
});
test('discovery shows queued and claimed tasks until reported', async () => {
  const s = setup();
  const { taskId } = await handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger);
  let listed = await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger);
  assert.equal(listed.chats[0].queued, 1); assert.equal(listed.chats[0].openTasks[0].status, 'queued');
  await handleDelegation(s.state, s.panes, s.worker('next'), undefined, s.ledger);
  listed = await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger);
  assert.equal(listed.chats[0].queued, 0); assert.equal(listed.chats[0].openTasks[0].status, 'claimed');
  await handleDelegation(s.state, s.panes, s.worker('complete', taskId, 'Done'), undefined, s.ledger);
  assert.equal((await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger)).chats[0].openTasks.length, 0);
});

test('approval choices above an empty composer still block delivery and Enter', () => {
  const lines = ['Would you like to run the following command?', '› 1. Yes, proceed', '2. No', '›', '', '? for shortcuts'];
  assert.equal(snapshot('codex', { lines }).state, 'approval_pending');
});

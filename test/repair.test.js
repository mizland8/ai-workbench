import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryState, preparedPromptMatches } from '../src/agent-status.js';
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
test('closed, stale, settling, working, approvals, questions and drafts have distinct actionable states', () => {
  const cases = [
    [{ status: 'exited' }, 'closed'], [{ id: null }, 'closed'], [{ lastOutputAt: 0 }, 'stale'],
    [{ now: 2500 }, 'settling'], [{ submitting: true }, 'busy'],
    [{ lines: ['• Working • esc to interrupt', ...prompts.codex] }, 'busy'],
    [{ lines: ['Would you like to run the following command?', '› 1. Yes, proceed'] }, 'approval_pending'],
    [{ lines: ['Overwrite? (y/n)'] }, 'user_input_required'],
    [{ lines: ['› draft', '', '? for shortcuts'] }, 'draft_present'],
    [{ lines: ['Unknown screen'] }, 'unsupported_prompt'],
    [{ hasDraft: true, lastInputAt: 2000 }, 'draft_present'],
  ];
  for (const [options, state] of cases) { const result = snapshot('codex', options); assert.equal(result.state, state); assert.equal(result.canAccept, false); assert.match(result.reason, /No prompt was sent/); }
  assert.equal(snapshot('codex', { hasDraft: true, lastInputAt: 1000 }).canAccept, true, 'screen refresh clears a deleted draft');
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
test('discovery refreshes and reports a ready UI dot as approval_pending; dispatch refuses before persisting', async () => {
  const s = setup(); s.panes.get(s.b.id).view.refreshPrompt = async () => s.block();
  const result = await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger);
  assert.equal(result.chats[0].status, 'approval_pending'); assert.equal(result.chats[0].canAccept, false); assert.match(result.chats[0].label, /Worker · Claude Code/);
  await assert.rejects(handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger), /Approval pending/);
  assert.equal(s.ledger.tasks.length, 0); assert.equal(s.sent(), 0);
});
test('concurrent or retried identical sends reuse a durable task without duplicate delivery', async () => {
  const s = setup(); const results = await Promise.all([1, 2].map(() => handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger)));
  assert.equal(s.sent(), 1); assert.equal(s.ledger.tasks.length, 1); assert.equal(results[0].taskId, results[1].taskId);
  await assert.rejects(handleDelegation(s.state, s.panes, s.request('send', s.b.id, 'Different task'), undefined, s.ledger), /unresolved task/);
});
test('uncertain delivery can be inspected and explicitly resolved without replay', async () => {
  const s = setup(); s.panes.get(s.b.id).view.submitPrompt = async () => { throw Error('Lost confirmation'); };
  await assert.rejects(handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger), /not confirmed/);
  const task = s.ledger.tasks[0]; const retry = await handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger);
  assert.equal(retry.duplicate, true); assert.equal(retry.status, 'delivery_unknown');
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
  assert.deepEqual(flags, ['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']);
  loaded.settings.approvals.codex = 'never';
  assert.equal(store.toolOptions(loaded.settings, 'codex')[0].args[1], 'never');
  assert.match(store.addChat(loaded, 'codex', loaded.projects[0].id).title, /^Codex \d+$/);
});

test('OpenCode drafts and approval prompts remain protected with a visible footer', () => {
  assert.equal(snapshot('opencode', { lines: ['┃ unfinished draft', '┃ Build · model', 'tab agents  ctrl+p commands'] }).state, 'draft_present');
  assert.equal(snapshot('opencode', { lines: ['Permission required', 'Allow once   Allow always   Reject'] }).state, 'approval_pending');
});
test('ready discovery marks unresolved tasks as task_pending until reported', async () => {
  const s = setup();
  await handleDelegation(s.state, s.panes, s.request('send'), undefined, s.ledger);
  const listed = await handleDelegation(s.state, s.panes, s.request('list'), undefined, s.ledger);
  assert.equal(listed.chats[0].status, 'task_pending');
  assert.equal(listed.chats[0].canAccept, false);
});

test('Enter is withheld if the prepared composer changed to an approval, question or another draft', () => {
  for (const tool of ['codex', 'claude', 'agy', 'opencode']) {
    const marker = { codex: '›', claude: '❯', agy: '>', opencode: '┃' }[tool];
    const lines = tool === 'codex' ? [`${marker} harmless test`, '', '? for shortcuts'] : tool === 'opencode' ? [`${marker} harmless test`, '┃ Build · model', '╹▀▀▀', 'tab agents  ctrl+p commands'] : [rule, `${marker} harmless test`, rule];
    assert.equal(preparedPromptMatches(tool, lines, lines, 'harmless test'), true, tool);
    assert.equal(preparedPromptMatches(tool, lines, lines, 'different draft'), false, tool);
  }
  assert.equal(preparedPromptMatches('codex', ['Would you like to run the following command?', '› 1. Yes, proceed'], ['› 1. Yes, proceed'], 'harmless test'), false);
  assert.equal(preparedPromptMatches('agy', ['Overwrite? (y/n)', '> harmless test'], ['> harmless test'], 'harmless test'), false);
});

test('approval choices above an empty composer still block delivery and Enter', () => {
  const lines = ['Would you like to run the following command?', '› 1. Yes, proceed', '2. No', '›', '', '? for shortcuts'];
  assert.equal(snapshot('codex', { lines }).state, 'approval_pending');
  assert.equal(preparedPromptMatches('codex', lines, lines, 'harmless test'), false);
});

test('same-millisecond input and output cannot leave an erased draft permanently blocked', () => {
  const input = { hasDraft: true, lastInputAt: 2000, lastOutputAt: 2000, outputEpoch: 8, lastInputEpoch: 7 };
  assert.equal(snapshot('codex', input).canAccept, true);
  assert.equal(snapshot('codex', { ...input, outputEpoch: 7 }).state, 'draft_present', 'unparsed/unacknowledged keystrokes remain protected');
});

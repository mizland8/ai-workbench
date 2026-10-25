import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionQueue } from '../src/companion.js';
import { defaultSettings, toolOptions, unattendedArgs, splitArgs } from '../src/store.js';
const storage = () => { let value = null; return { getItem: () => value, setItem: (_, next) => { value = next; } }; };
const state = { chats: [{ id: 'chat1', tool: 'codex' }, { id: 'shell', tool: 'shell' }] };
const request = { id: 'message-1234', chatId: 'chat1', text: 'Run the tests\nand report back.' };
test('remote messages persist and retrying the same request never creates another delivery', () => {
  const saved = storage(), queue = new CompanionQueue(saved);
  assert.equal(queue.accept(state, request).status, 'queued');
  queue.update(request.id, 'delivered');
  const restored = new CompanionQueue(saved);
  assert.equal(restored.accept(state, request).status, 'delivered');
  assert.equal(restored.messages.length, 1);
  assert.throws(() => restored.accept(state, { ...request, text: 'Different work' }), /different message/);
});
test('remote work rejects shells and terminal controls, and failed persistence never accepts work', () => {
  const queue = new CompanionQueue(storage());
  assert.throws(() => queue.accept(state, { ...request, chatId: 'shell' }), /no longer exists/);
  assert.throws(() => queue.accept(state, { ...request, text: '\x1b[2J' }), /control characters/);
  queue.storage.setItem = () => { throw new Error('disk full'); };
  assert.throws(() => queue.accept(state, request), /disk full/);
  assert.equal(queue.messages.length, 0);
});
test('uncertain submissions survive restart without becoming queued again', () => {
  const saved = storage(), queue = new CompanionQueue(saved); queue.accept(state, request); queue.update(request.id, 'delivery_unknown');
  assert.equal(new CompanionQueue(saved).accept(state, request).status, 'delivery_unknown');
});
test('full-access and CLI-managed Codex modes never receive a Windows sandbox override', () => {
  const settings = defaultSettings();
  for (const mode of ['all', 'custom']) { settings.approvals.codex = mode; assert.ok(toolOptions(settings, 'codex', { windows: true }).every(o => !o.args.includes('windows.sandbox=unelevated'))); }
  settings.approvals.opencode = 'all';
  assert.equal(toolOptions(settings, 'opencode')[0].permission, 'allow');
});

test('all-agent preset removes conflicting permission arguments while preserving model options', () => {
  assert.deepEqual(splitArgs(unattendedArgs('codex', '--approve-for-me --sandbox workspace-write -c windows.sandbox=unelevated -m model -c model_reasoning_effort=high')), ['-m', 'model', '-c', 'model_reasoning_effort=high']);
  assert.deepEqual(splitArgs(unattendedArgs('claude', '--permission-mode acceptEdits --model sonnet')), ['--model','sonnet']);
  assert.deepEqual(splitArgs(unattendedArgs('agy', '--mode accept-edits --model test')), ['--model','test']);
});

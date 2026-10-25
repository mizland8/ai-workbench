import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompanionQueue, ReplyPrompts } from '../src/companion.js';
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

test('user replies require a current prompt and keep their identity distinct from queued work', () => {
  const queue = new CompanionQueue(storage());
  assert.throws(() => queue.accept(state, {...request,kind:'reply'}), /current prompt/);
  assert.throws(() => queue.accept(state, {...request,text:'1\n2',kind:'reply',promptId:'prompt-1234'}), /one line/);
  const message = queue.accept(state, {...request,text:'1',kind:'reply',promptId:'prompt-1234'});
  assert.equal(message.kind,'reply');
  assert.throws(() => queue.accept(state,{...request,text:'1'}), /different message/);
  assert.throws(() => queue.accept(state,{...request,text:'1',kind:'reply',promptId:'prompt-5678'}), /different message/);
  assert.equal(queue.cancelQueued('another-chat'),0);
  assert.equal(queue.cancelQueued('chat1'),1);
  assert.equal(queue.messages[0].status,'cancelled');
});
test('reply IDs expire on changed question, local input, terminal restart, or leaving the prompt', () => {
  const prompts=new ReplyPrompts(); let lines=['Trust this folder?','1. Trust and continue','2. Quit'], mode='approval_pending';
  const view={id:12,generation:1,lastInputAt:100,status:'running',submitting:false,screenLines:()=>lines,deliveryState:()=>({state:mode,reason:'Waiting for trust'})};
  const first=prompts.current('chat1',view);assert.ok(first.id);
  assert.equal(prompts.current('chat1',view).id,first.id);
  view.lastInputAt++;assert.equal(prompts.matches('chat1',view,first.id),false);
  const second=prompts.current('chat1',view);lines=['Approve a different operation?'];assert.equal(prompts.matches('chat1',view,second.id),false);
  const third=prompts.current('chat1',view);view.generation++;assert.equal(prompts.matches('chat1',view,third.id),false);
  mode='ready';assert.equal(prompts.current('chat1',view),null);
  mode='approval_pending';assert.notEqual(prompts.current('chat1',view).id,first.id);
});

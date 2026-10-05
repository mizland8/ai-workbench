import { delegationTargets } from './store.js';

export function resolveTarget(state, sourceId, target) {
  const allowed = delegationTargets(state, sourceId);
  const byId = allowed.find(chat => chat.id === target);
  if (byId) return byId;
  const named = allowed.filter(chat => chat.title === target);
  if (named.length > 1) throw new Error('Several connected chats have that name. Use the chat ID from bridge list.');
  if (!named.length) throw new Error('No connected AI chat has that name or ID. Open it under this chat first.');
  return named[0];
}

export async function handleDelegation(state, panes, request, onSend = () => {}, ledger = null) {
  if (request.expiresAt && Date.now() >= request.expiresAt) throw new Error('Handoff request expired. No prompt was sent.');
  const source = panes.get(request.source.chatId);
  if (!source || source.view.id !== request.source.terminalId || source.view.status !== 'running') throw new Error('The requesting terminal has ended.');
  const describe = chat => ({ id: chat.id, name: chat.title, tool: chat.tool, parentId: chat.parentId ?? null, status: panes.get(chat.id)?.display ?? 'closed' });
  if (request.method === 'list') return { chats: delegationTargets(state, source.chatId).map(describe) };
  if (['tasks', 'task', 'complete', 'fail', 'inbox', 'ack'].includes(request.method)) {
    if (!ledger) throw new Error('Task tracking is unavailable.');
    return ledger.handle(state, source.chatId, request);
  }
  const chat = resolveTarget(state, source.chatId, request.target);
  const target = panes.get(chat.id);
  if (!target || target.view.status !== 'running') throw new Error('The target chat is closed or stopped. Open it in Workbench first.');
  if (request.method === 'read') return { ...describe(chat), text: target.view.transcript(), observedAt: new Date().toISOString(), lastOutputAt: target.view.lastOutputAt, note: 'Terminal output may include prompts and earlier replies. Verify task completion yourself.' };
  if (request.method !== 'send') throw new Error('Unknown delegation command.');
  if (typeof request.prompt === 'string') request.prompt = request.prompt.replace(/\r\n/g, '\n');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 32000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(request.prompt)) throw new Error('Provide a prompt of 1–32000 characters without terminal control characters.');
  if (ledger && request.prompt.length > 31500) throw new Error('Tracked task prompts must be at most 31500 characters to leave room for reporting instructions.');
  let task;
  if (ledger) {
    const problem = target.view.promptProblem?.();
    if (problem) throw new Error(problem);
    task = ledger.create(source.chatId, chat.id, request.prompt);
  }
  const prompt = task ? `${request.prompt}\n\n[AI Workbench task ${task.id}] Using the executable in AI_WORKBENCH_CLI, report with bridge complete ${task.id} <summary>, or bridge fail ${task.id} <reason>. Include changed files and checks in your summary. This report is saved for the requesting AI even while it is busy. Do not infer success from terminal status.` : request.prompt;
  try {
    await target.view.submitPrompt(prompt);
    if (task && ledger.tasks.find(t => t.id === task.id)?.status === 'dispatching') ledger.update(task.id, { status: 'submitted' });
  } catch (error) {
    if (task) ledger.update(task.id, { status: 'delivery_unknown', result: String(error?.message ?? error) });
    throw new Error(task ? `Task ${task.id}: ${error?.message ?? error}. Delivery was not confirmed; inspect the task and terminal before retrying.` : error?.message ?? error);
  }
  onSend({ from: state.chats.find(c => c.id === source.chatId)?.title, to: chat.title, prompt: request.prompt, at: new Date().toISOString() });
  return { accepted: true, ...(task ? { taskId: task.id } : {}), ...describe(chat), note: task ? 'Prompt submitted. Use bridge task for progress and bridge inbox for worker reports. Review changes before accepting success.' : 'Prompt submitted. Use bridge list/read to check progress and results.' };
}

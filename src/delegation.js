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

export async function handleDelegation(state, panes, request, onSend = () => {}) {
  if (request.expiresAt && Date.now() >= request.expiresAt) throw new Error('Handoff request expired. No prompt was sent.');
  const source = panes.get(request.source.chatId);
  if (!source || source.view.id !== request.source.terminalId || source.view.status !== 'running') throw new Error('The requesting terminal has ended.');
  const describe = chat => ({ id: chat.id, name: chat.title, tool: chat.tool, parentId: chat.parentId ?? null, status: panes.get(chat.id)?.display ?? 'closed' });
  if (request.method === 'list') return { chats: delegationTargets(state, source.chatId).map(describe) };
  const chat = resolveTarget(state, source.chatId, request.target);
  const target = panes.get(chat.id);
  if (!target || target.view.status !== 'running') throw new Error('The target chat is closed or stopped. Open it in Workbench first.');
  if (request.method === 'read') return { ...describe(chat), text: target.view.transcript(), observedAt: new Date().toISOString(), lastOutputAt: target.view.lastOutputAt, note: 'Terminal output may include prompts and earlier replies. Verify task completion yourself.' };
  if (request.method !== 'send') throw new Error('Unknown delegation command.');
  if (typeof request.prompt === 'string') request.prompt = request.prompt.replace(/\r\n/g, '\n');
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 32000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(request.prompt)) throw new Error('Provide a prompt of 1–32000 characters without terminal control characters.');
  await target.view.submitPrompt(request.prompt);
  onSend({ from: state.chats.find(c => c.id === source.chatId)?.title, to: chat.title, prompt: request.prompt, at: new Date().toISOString() });
  return { accepted: true, ...describe(chat), note: 'Prompt submitted. Use bridge list/read to check progress and results.' };
}

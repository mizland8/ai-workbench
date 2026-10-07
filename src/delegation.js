import { delegationTargets, DELEGATION_TOOLS } from './store.js';

const DELEGATION_TOOLS_SET = new Set(DELEGATION_TOOLS);

export function resolveTarget(state, sourceId, target) {
  const allowed = delegationTargets(state, sourceId);
  const byId = allowed.find(chat => chat.id === target);
  if (byId) return byId;
  let named = allowed.filter(chat => chat.title === target);
  // People say "game art" for a chat titled "Game Art"; accept that when it names only one chat.
  if (!named.length) named = allowed.filter(chat => String(chat.title ?? '').trim().toLowerCase() === String(target ?? '').trim().toLowerCase());
  if (named.length > 1) throw new Error('Several connected chats have that name. Use the chat ID from bridge list.');
  if (!named.length) throw new Error('No AI chat in this project has that name or ID. Run bridge list for the team.');
  return named[0];
}

const toolNames = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity CLI', opencode: 'OpenCode', local: 'Local model' };
const openStatuses = ['dispatching', 'submitted', 'delivery_unknown'];

// How `chat` relates to `source`: the tree shows who leads whom; everyone in a project can talk.
function relation(state, sourceId, chat) {
  const source = state.chats.find(c => c.id === sourceId);
  if (chat.id === source?.parentId) return 'your lead';
  if (chat.parentId === sourceId) return 'reports to you';
  for (let up = state.chats.find(c => c.id === chat.parentId), seen = 0; up && seen < 100; up = state.chats.find(c => c.id === up.parentId), seen++) {
    if (up.id === sourceId) return 'under you';
  }
  return 'teammate';
}

export async function handleDelegation(state, panes, request, onSend = () => {}, ledger = null, { board = null, onReport = () => {} } = {}) {
  if (request.expiresAt && Date.now() >= request.expiresAt) throw new Error('Handoff request expired. No prompt was sent.');
  const source = panes.get(request.source.chatId);
  if (!source || source.view.id !== request.source.terminalId || source.view.status !== 'running') throw new Error('The requesting terminal has ended.');
  const me = state.chats.find(c => c.id === source.chatId);
  const project = state.projects.find(p => p.id === me?.projectId) ?? null;
  const describe = chat => {
    const parent = state.chats.find(c => c.id === chat.parentId);
    const working = ledger?.tasks.filter(t => t.toId === chat.id && openStatuses.includes(t.status)).map(t => ({ taskId: t.id, from: state.chats.find(c => c.id === t.fromId)?.title ?? t.fromId, prompt: t.prompt.slice(0, 160) })) ?? [];
    const note = project && board?.latest(project.id, chat.id);
    return { id: chat.id, name: chat.title, tool: chat.tool, toolName: toolNames[chat.tool] ?? chat.tool, parentId: chat.parentId ?? null, parentName: parent?.title ?? null, relation: chat.id === me.id ? 'you' : relation(state, me.id, chat), status: panes.get(chat.id)?.display ?? 'closed', openTasks: working, ...(note ? { lastNote: { text: note.text.slice(0, 300), at: note.at } } : {}) };
  };
  if (request.method === 'list') {
    return { you: describe(me), project: project ? { id: project.id, name: project.name, path: project.path } : null, chats: delegationTargets(state, me.id).map(describe),
      note: project ? 'Every AI chat in this project is listed. Stay in this project: work only in its folder. Closed chats must be opened in Workbench before they can receive tasks.' : 'This chat is not in a project, so only its parent and the chats under it are listed.' };
  }
  if (request.method === 'post' || request.method === 'board') {
    if (!board) throw new Error('The project board is unavailable.');
    if (!project) throw new Error('The board is shared by the chats of a project; this chat is not in one.');
    if (request.method === 'post') return { posted: board.post(project.id, me, request.prompt) };
    return { project: project.name, notes: board.read(project.id) };
  }
  if (['tasks', 'task', 'complete', 'fail', 'inbox', 'ack'].includes(request.method)) {
    if (!ledger) throw new Error('Task tracking is unavailable.');
    const result = ledger.handle(state, source.chatId, request);
    if (['complete', 'fail'].includes(request.method) && result.task && !result.task.acknowledged) onReport(result.task);
    return result;
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

// What every AI chat is told when it starts: who it is, which project it works in, and how to reach
// its team. One line without quotes or shell symbols, because Windows passes it through cmd.exe.
export function briefing(state, chatId) {
  const chat = state.chats.find(c => c.id === chatId);
  if (!chat || !DELEGATION_TOOLS_SET.has(chat.tool)) return null;
  const clean = text => String(text ?? '').replace(/[\x00-\x1f\x7f"%&|<>^`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const project = state.projects.find(p => p.id === chat.projectId);
  const parent = state.chats.find(c => c.id === chat.parentId);
  const team = delegationTargets(state, chat.id).map(c => `${clean(c.title)} (${toolNames[c.tool] ?? c.tool})`);
  const children = state.chats.filter(c => c.parentId === chat.id).map(c => clean(c.title));
  const path = project && clean(project.path) === project.path ? project.path : null;
  return [
    `You are running inside AI Workbench as the AI chat named ${clean(chat.title)} (${toolNames[chat.tool] ?? chat.tool})${project ? ` in the project ${clean(project.name)}${path ? `, whose folder is ${path}` : ''}` : ', outside any project'}.`,
    project ? 'Stay within this project: work only in its folder and do not read or change other projects unless the user explicitly asks.' : '',
    parent ? `Your lead is ${clean(parent.title)}.` : '',
    children.length ? `Chats under you: ${children.join(', ')}.` : '',
    team.length ? `Your team right now: ${team.join(', ')}.` : 'No other AI chats are in this project yet.',
    'You coordinate with them through the Workbench bridge: run the program whose path is in the AI_WORKBENCH_CLI environment variable with the arguments bridge help, then bridge list.',
    'bridge list shows the live team with each chat\'s role, status, open tasks and latest note. bridge board reads the project notes; bridge post followed by a note shares what you are doing, which files you own, and what you finished, so teammates know your updates. Post when you start and finish meaningful work.',
    'Use bridge send to give a teammate a task when the user asks you to involve other AIs or the work clearly needs it, and split file ownership so edits do not collide. When you receive a task tagged AI Workbench task, report with bridge complete or bridge fail. When a teammate reports back you get a short notice; read it with bridge inbox and acknowledge with bridge ack.',
    'The bridge is the only way to reach a teammate: never use computer use, screen control, window automation or simulated keystrokes to type into another chat or terminal.',
    'If a bridge command fails, quote its exact error. Never claim a teammate did not respond without checking bridge list, bridge tasks and bridge read. Never answer another AI\'s approval prompts and never print AI_WORKBENCH_TOKEN.',
  ].filter(Boolean).join(' ');
}

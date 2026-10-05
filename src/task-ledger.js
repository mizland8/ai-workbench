import { delegationTargets } from './store.js';

// Persist reports rather than typing into a busy parent's terminal. Completion is
// an explicit worker report, never an inference from an idle terminal screen.
const KEY = 'ai-workbench.tasks.v1';
const LIMIT = 200;
const statuses = ['dispatching', 'submitted', 'delivery_unknown', 'completed', 'failed'];

export class TaskLedger {
  constructor(storage) {
    this.storage = storage;
    const raw = storage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(saved) || saved.length > LIMIT || saved.some(t =>
      !t || !['id', 'fromId', 'toId', 'prompt', 'at', 'updatedAt'].every(k => typeof t[k] === 'string') ||
      !statuses.includes(t.status) || (t.result != null && typeof t.result !== 'string')) ||
      new Set(saved.map(t => t.id)).size !== saved.length) throw new Error('Saved task history is invalid. It has been preserved.');
    this.tasks = saved;
  }

  commit(tasks) {
    // A failed save must not acknowledge a report or dispatch a new prompt.
    this.storage.setItem(KEY, JSON.stringify(tasks));
    this.tasks = tasks;
  }

  create(fromId, toId, prompt) {
    const tasks = this.tasks.slice();
    if (tasks.length >= LIMIT) {
      const index = tasks.findIndex(t => t.acknowledged && ['completed', 'failed'].includes(t.status));
      if (index < 0) throw new Error('Task history is full. Acknowledge completed reports with bridge ack before sending more tasks.');
      tasks.splice(index, 1);
    }
    const at = new Date().toISOString();
    const task = { id: crypto.randomUUID(), fromId, toId, prompt, at, updatedAt: at, status: 'dispatching' };
    this.commit([...tasks, task]);
    return task;
  }

  update(id, changes) {
    this.commit(this.tasks.map(t => t.id === id ? { ...t, ...changes, updatedAt: new Date().toISOString() } : t));
  }

  handle(state, sourceId, request) {
    // Re-check current hierarchy: moving or removing a chat revokes access.
    const visible = t => (t.fromId === sourceId || t.toId === sourceId) && delegationTargets(state, t.fromId).some(c => c.id === t.toId);
    const summary = ({ prompt, result, ...task }) => task;
    if (request.method === 'tasks') return { tasks: this.tasks.filter(visible).map(summary) };
    if (request.method === 'inbox') {
      const reports = this.tasks.filter(t => visible(t) && t.fromId === sourceId && ['completed', 'failed'].includes(t.status) && !t.acknowledged);
      return { reports: reports.slice(0, 5).map(({ prompt, ...task }) => task), remaining: Math.max(0, reports.length - 5) };
    }
    const task = this.tasks.find(t => t.id === request.target && visible(t));
    if (!task) throw new Error('No accessible task has that ID. Use bridge tasks.');
    if (request.method === 'task') return { task };
    if (request.method === 'ack') {
      if (task.fromId !== sourceId || !['completed', 'failed'].includes(task.status)) throw new Error('Only the requester can acknowledge a completed report.');
      this.update(task.id, { acknowledged: true });
    } else {
      if (task.toId !== sourceId) throw new Error('Only the assigned worker can report the outcome.');
      const result = request.prompt?.replace(/\r\n/g, '\n');
      if (!result?.trim() || result.length > 32000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(result)) throw new Error('Provide a result of 1–32000 characters without control characters.');
      const status = request.method === 'complete' ? 'completed' : 'failed';
      if (['completed', 'failed'].includes(task.status)) {
        if (task.status !== status || task.result !== result) throw new Error('This task already has a final report.');
        return { task }; // Identical retries do not duplicate or unread a report.
      }
      this.update(task.id, { status, result, acknowledged: false });
    }
    return { task: this.tasks.find(t => t.id === task.id) };
  }
}

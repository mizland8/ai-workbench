// Short notes the AI chats of a project share: what each is doing, which files it owns, what it
// finished. Saved on this computer; only AI chats in the same project can read or post.
const KEY = 'ai-workbench.board.v1';
const PER_PROJECT = 100;
const TEXT_LIMIT = 4000;

export class ProjectBoard {
  constructor(storage) {
    this.storage = storage;
    const raw = storage.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(saved) || saved.some(n => !n || !['id', 'projectId', 'fromId', 'fromName', 'text', 'at'].every(k => typeof n[k] === 'string'))) {
      throw new Error('Saved project board is invalid. It has been preserved.');
    }
    this.notes = saved;
  }

  post(projectId, from, text) {
    text = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!text || text.length > TEXT_LIMIT || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error(`Provide a note of 1–${TEXT_LIMIT} characters without control characters.`);
    const note = { id: crypto.randomUUID(), projectId, fromId: from.id, fromName: from.title, text, at: new Date().toISOString() };
    const mine = this.notes.filter(n => n.projectId === projectId);
    const dropped = new Set(mine.slice(0, Math.max(0, mine.length + 1 - PER_PROJECT)).map(n => n.id));
    const notes = [...this.notes.filter(n => !dropped.has(n.id)), note];
    this.storage.setItem(KEY, JSON.stringify(notes));
    this.notes = notes;
    return note;
  }

  read(projectId, limit = 20) {
    return this.notes.filter(n => n.projectId === projectId).slice(-limit);
  }

  latest(projectId, fromId) {
    return this.notes.findLast(n => n.projectId === projectId && n.fromId === fromId) ?? null;
  }

  removeProject(projectId) {
    if (!this.notes.some(n => n.projectId === projectId)) return;
    this.notes = this.notes.filter(n => n.projectId !== projectId);
    this.storage.setItem(KEY, JSON.stringify(this.notes));
  }
}

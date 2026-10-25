import * as backend from './backend.js';

const KEY = 'ai-workbench.remote-messages.v1';
export class CompanionQueue {
  constructor(storage) {
    this.storage = storage;
    this.messages = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (!Array.isArray(this.messages) || this.messages.some(m => !m || !['id','chatId','text','status'].every(k => typeof m[k] === 'string'))) throw new Error('Remote message storage is invalid; it has been preserved.');
  }
  commit(messages) { this.storage.setItem(KEY, JSON.stringify(messages)); this.messages = messages; }
  accept(state, request) {
    const { id, chatId, text } = request ?? {};
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid message ID or text (maximum 16000 characters).');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('Messages cannot contain terminal control characters.');
    const chat = state.chats.find(c => c.id === chatId && c.tool !== 'shell');
    if (!chat) throw new Error('That AI chat no longer exists. Refresh this computer.');
    const previous = this.messages.find(m => m.id === id);
    if (previous) {
      if (previous.chatId !== chatId || previous.text !== text) throw new Error('This request ID belongs to a different message.');
      return previous;
    }
    if (this.messages.length >= 2000) throw new Error('Remote message history is full. Clear delivered receipts on the PC.');
    const message = { id, chatId, text, status: 'queued', at: new Date().toISOString() };
    this.commit([...this.messages, message]); return message;
  }
  update(id, status, error) {
    this.commit(this.messages.map(m => m.id === id ? { ...m, status, ...(error ? { error } : {}) } : m));
  }
  clearDelivered() { this.commit(this.messages.filter(m => m.status !== 'delivered')); }
}

export function startCompanion({ state, panes, getUsage, openChat, showDialog, escape }) {
  if (!backend.isDesktop) return { dialog: () => {} };
  let queue;
  try { queue = new CompanionQueue(localStorage); }
  catch (error) { console.error(error.message); }
  let enabled = false, publishing = false, delivering = new Set(), lastSnapshot = null;
  const lastSend = new Map();
  const publish = async () => {
    if (!enabled || publishing) return;
    publishing = true;
    try {
      for (const message of queue?.messages ?? []) {
        if (message.status !== 'queued' || delivering.has(message.chatId)) continue;
        const pane = panes.get(message.chatId), view = pane?.view;
        if (!view || view.submitting || Date.now() - (lastSend.get(message.chatId) ?? 0) < 8000 || Date.now() - (view.lastInputAt ?? 0) < 8000 || view.restartProblem?.() || view.status !== 'running' || view.agent.state !== 'idle' || !view.deliveryState().canAccept) continue;
        delivering.add(message.chatId);
        try {
          queue.update(message.id, 'dispatching');
          await view.submitPrompt(`[AI Workbench remote message ${message.id}]\n${message.text}`);
          queue.update(message.id, 'delivered');
          lastSend.set(message.chatId, Date.now());
        } catch (error) {
          // Never retry an uncertain terminal submission automatically.
          try { queue.update(message.id, 'delivery_unknown', String(error?.message ?? error)); } catch {}
        } finally { delivering.delete(message.chatId); }
      }
      const snapshot = {
        name: 'AI Workbench',
        projects: state.projects.map(({ id, name }) => ({ id, name })),
        chats: state.chats.filter(c => c.tool !== 'shell').map(c => ({ id: c.id, projectId: c.projectId, name: c.title, tool: c.tool,
          status: panes.get(c.id)?.view.agent?.state ?? 'closed',
          output: panes.get(c.id)?.view.transcript()?.slice(-8000) ?? '' })),
        usage: getUsage() ?? null,
        receipts: (queue?.messages ?? []).map(({ text, ...m }) => m),
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastSnapshot) { await backend.companionPublish({ ...snapshot, updatedAt: new Date().toISOString() }); lastSnapshot = serialized; }
    } finally { publishing = false; }
  };
  backend.companionStatus().then(status => { enabled = status.enabled; }).catch(() => {});
  backend.listenCompanion(async request => {
    if (!queue) throw new Error('Remote message storage is unavailable; no prompt was sent.');
    const message = queue.accept(state, request.message);
    if (message.status === 'queued') openChat(message.chatId);
    setTimeout(() => publish().catch(() => {}), 0);
    return { id: message.id, status: message.status };
  }).catch(error => console.error(error));
  setInterval(() => publish().catch(() => {}), 2000);

  async function dialog() {
    let status;
    try { status = await backend.companionStatus(); enabled = status.enabled; }
    catch (e) { return showDialog(`<h2>Computers</h2><p>${escape(e.message)}</p>`); }
    const box = showDialog(`<h2>Computers & phone</h2>
      <fieldset><legend>This PC</legend><p>${enabled ? `Linking enabled on port ${status.port}. Keep Workbench open.` : 'Linking is off. Enable it to allow explicitly paired phones and computers to view this PC and send work.'}</p>
      <label>Port<input name="companion-port" type="number" value="${status.port ?? 47931}" min="1" max="65535"></label>
      <button type="button" data-enable>${enabled ? 'Disable linking' : 'Enable linking'}</button>
      <p class="dialog-note">Use the same Wi-Fi or a private network such as Tailscale. Windows/macOS may ask you to allow incoming connections. Pairing grants access to projects, usage, AI chat output, and sending messages.</p>
      ${enabled ? '<label>This PC’s IP address or hostname<input name="companion-host" placeholder="192.168.1.20" autocomplete="off"></label><button type="button" data-pairing>Create pairing code</button><textarea data-code rows="4" readonly hidden aria-label="Pairing code"></textarea><p class="dialog-note">Paste the complete code into the phone or another Workbench. It expires after five minutes and can be used once.</p>' : ''}
      ${status.clients.map(c => `<p>${escape(c.name)} <button type="button" data-revoke="${escape(c.id)}">Revoke access</button></p>`).join('')}
      <button type="button" data-clear>Clear delivered message receipts</button></fieldset>
      <fieldset><legend>Other computers</legend><label>Pairing code<textarea name="remote-code" rows="3" placeholder="Paste a code from the other PC"></textarea></label><label>Computer name<input name="remote-name" placeholder="Office PC"></label><button type="button" data-connect>Pair computer</button><div data-remotes></div></fieldset>
      <p data-error class="form-error" role="status"></p><div class="dialog-actions"><button type="button" data-dismiss>close</button></div>`);
    const error = e => { box.querySelector('[data-error]').textContent = e?.message ?? String(e); };
    box.querySelector('[data-enable]').onclick = async () => {
      try {
        if (enabled) await backend.companionDisable();
        else await backend.companionEnable(Number(box.querySelector('[name="companion-port"]').value));
        enabled = !enabled; box.close(); dialog();
      } catch (e) { error(e); }
    };
    box.querySelector('[data-pairing]')?.addEventListener('click', async () => {
      try { const code = await backend.companionPairing(box.querySelector('[name="companion-host"]').value); const field = box.querySelector('[data-code]'); field.hidden = false; field.value = JSON.stringify(code); field.select(); }
      catch (e) { error(e); }
    });
    box.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { try { await backend.companionRevoke(b.dataset.revoke); b.closest('p').remove(); } catch (e) { error(e); } });
    box.querySelector('[data-clear]').onclick = () => { try { queue?.clearDelivered(); } catch (e) { error(e); } };
    box.querySelector('[data-connect]').onclick = async () => {
      try { await backend.companionRemote('pair', null, { ...JSON.parse(box.querySelector('[name="remote-code"]').value), name: box.querySelector('[name="remote-name"]').value || 'Remote PC' }); await list(); }
      catch (e) { error(e); }
    };
    async function list() {
      const remotes = await backend.companionRemote('list');
      box.querySelector('[data-remotes]').innerHTML = remotes.map(r => `<p>${escape(r.name)} · ${escape(r.host)} <button type="button" data-open="${escape(r.id)}">Open</button> <button type="button" data-forget="${escape(r.id)}">Forget</button></p>`).join('') || '<p class="dialog-note">No paired computers yet.</p>';
      box.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { const remote = remotes.find(r => r.id === b.dataset.open); box.close(); remoteDialog(remote); });
      box.querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => { try { await backend.companionRemote('forget', b.dataset.forget); await list(); } catch (e) { error(e); } });
    }
    list().catch(error);
  }
  async function remoteDialog(remote) {
    const box = showDialog(`<h2>${escape(remote.name)}</h2><p data-state>Connecting…</p><div data-chats></div><div data-usage></div><div data-receipts></div><label>Chat<select name="remote-chat"></select></label><pre data-output class="handoff-prompt"></pre><label>Message<textarea name="remote-message" rows="4"></textarea></label><button type="button" data-send>Send work</button><p data-receipt role="status"></p><div class="dialog-actions"><button type="button" data-dismiss>close</button></div>`);
    let revision, snapshot, request = null;
    box.querySelector('[data-send]').onclick = async () => {
      const button = box.querySelector('[data-send]'); button.disabled = true;
      try {
        const chatId = box.querySelector('[name="remote-chat"]').value, text = box.querySelector('[name="remote-message"]').value;
        if (!request || request.chatId !== chatId || request.text !== text) request = { id: crypto.randomUUID(), chatId, text };
        const result = await backend.companionRemote('message', remote.id, request);
        box.querySelector('[data-receipt]').textContent = `Message ${result.id}: ${result.status}`;
        box.querySelector('[name="remote-message"]').value = ''; request = null;
      } catch (e) { box.querySelector('[data-receipt]').textContent = e.message; }
      finally { button.disabled = false; }
    };
    box.querySelector('[name="remote-chat"]').onchange = () => output();
    function output() { const id = box.querySelector('[name="remote-chat"]').value; box.querySelector('[data-output]').textContent = snapshot?.chats?.find(c => c.id === id)?.output || 'No terminal output available.'; }
    while (box.open) {
      try {
        const result = await backend.companionRemote('snapshot', remote.id, revision === undefined ? {} : { since: revision });
        if (!box.open) break;
        revision = result.revision; snapshot = result.snapshot;
        box.querySelector('[data-state]').textContent = `Connected · ${snapshot.updatedAt ?? 'waiting for snapshot'}`;
        const select = box.querySelector('[name="remote-chat"]'), selected = select.value;
        select.innerHTML = (snapshot.chats ?? []).map(c => `<option value="${escape(c.id)}">${escape(c.name)} · ${escape(c.tool)} · ${escape(c.status)}</option>`).join('');
        if ([...select.options].some(o => o.value === selected)) select.value = selected;
        box.querySelector('[data-chats]').textContent = `${snapshot.projects?.length ?? 0} projects · ${snapshot.chats?.length ?? 0} AI chats`;
        box.querySelector('[data-usage]').innerHTML = (snapshot.usage?.tools ?? []).map(t => `<p>${escape(t.id)}: ${(t.limits ?? []).map(l => `${escape(l.label)} ${Math.round(l.usedPercent)}% used`).join(' · ') || 'No allowance reported'}</p>`).join('');
        box.querySelector('[data-receipts]').textContent = (snapshot.receipts ?? []).slice(-5).map(r => `${r.id}: ${r.status}`).join(' · ');
        output();
      } catch (e) { if (!box.open) break; box.querySelector('[data-state]').textContent = `Offline · ${e.message}`; await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  return { dialog };
}

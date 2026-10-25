import * as backend from './backend.js';

const KEY = 'ai-workbench.remote-messages.v1';
// A reply is bound to one displayed question, terminal generation and local input state.
export class ReplyPrompts {
  constructor() { this.prompts = new Map(); }
  current(chatId, view) {
    const delivery = view?.deliveryState();
    if (!view || view.status !== 'running' || view.submitting || !['approval_pending', 'user_input_required'].includes(delivery.state)) { this.prompts.delete(chatId); return null; }
    const signature = JSON.stringify([view.id, view.generation, view.lastInputAt, view.screenLines()]);
    let prompt = this.prompts.get(chatId);
    if (prompt?.signature !== signature) { prompt = { signature, id: crypto.randomUUID() }; this.prompts.set(chatId, prompt); }
    return { id: prompt.id, reason: delivery.reason };
  }
  matches(chatId, view, id) { return !!id && this.current(chatId, view)?.id === id; }
}

export class CompanionQueue {
  constructor(storage) {
    this.storage = storage;
    this.messages = JSON.parse(storage.getItem(KEY) ?? '[]');
    if (!Array.isArray(this.messages) || this.messages.some(m => !m || !['id','chatId','text','status'].every(k => typeof m[k] === 'string'))) throw new Error('Remote message storage is invalid; it has been preserved.');
  }
  commit(messages) { this.storage.setItem(KEY, JSON.stringify(messages)); this.messages = messages; }
  accept(state, request) {
    const { id, chatId, text, promptId } = request ?? {};
    const kind = request?.kind ?? 'work';
    if (!['work','reply'].includes(kind)) throw new Error('Unknown message kind.');
    if (kind === 'reply' && (typeof promptId !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(promptId) || text?.length > 1000 || /[\r\n\t]/.test(text))) throw new Error('A reply needs the current prompt ID and one line of text (maximum 1000 characters).');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid message ID or text (maximum 16000 characters).');
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('Messages cannot contain terminal control characters.');
    const chat = state.chats.find(c => c.id === chatId && c.tool !== 'shell');
    if (!chat) throw new Error('That AI chat no longer exists. Refresh this computer.');
    const previous = this.messages.find(m => m.id === id);
    if (previous) {
      if (previous.chatId !== chatId || previous.text !== text || (previous.kind ?? 'work') !== kind || previous.promptId !== promptId) throw new Error('This request ID belongs to a different message.');
      return previous;
    }
    if (this.messages.length >= 2000) throw new Error('Remote message history is full. Clear delivered receipts on the PC.');
    const message = { id, chatId, text, kind, ...(kind === 'reply' ? { promptId } : {}), status: 'queued', at: new Date().toISOString() };
    this.commit([...this.messages, message]); return message;
  }
  update(id, status, error) {
    this.commit(this.messages.map(m => m.id === id ? { ...m, status, ...(error ? { error } : {}) } : m));
  }
  cancelQueued(chatId) {
    let count = 0;
    this.commit(this.messages.map(m => m.chatId === chatId && m.status === 'queued' ? (count++, { ...m, status: 'cancelled' }) : m));
    return count;
  }
  clearDelivered() { this.commit(this.messages.filter(m => m.status !== 'delivered')); }
}

export function startCompanion({ state, panes, getUsage, openChat, showDialog, escape }) {
  if (!backend.isDesktop) return { dialog: () => {} };
  let queue;
  try { queue = new CompanionQueue(localStorage); }
  catch (error) { console.error(error.message); }
  let enabled = false, publishing = false, delivering = new Set(), lastSnapshot = null;
  const lastSend = new Map(), replyPrompts = new ReplyPrompts();
  let lastStatusAt = 0, device = {};
  const publish = async () => {
    if (publishing) return;
    publishing = true;
    try {
      if (Date.now() - lastStatusAt > 5000) { const status = await backend.companionStatus(); enabled = status.enabled; device = { name: status.deviceName, platform: status.platform }; lastStatusAt = Date.now(); }
      if (!enabled) return;
      for (const message of queue?.messages ?? []) {
        if (message.kind === 'reply' || message.status !== 'queued' || delivering.has(message.chatId)) continue;
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
        name: 'AI Workbench', device,
        projects: state.projects.map(({ id, name, path }) => ({ id, name, path })),
        chats: state.chats.filter(c => c.tool !== 'shell').map(c => ({ id: c.id, projectId: c.projectId, name: c.title, tool: c.tool,
          status: panes.get(c.id)?.view.status === 'running' ? panes.get(c.id).view.agent.state : (panes.get(c.id)?.view.status ?? 'closed'),
          output: panes.get(c.id)?.view.transcript()?.slice(-8000) ?? '', replyPrompt: replyPrompts.current(c.id, panes.get(c.id)?.view) })),
        usage: getUsage() ?? null,
        receipts: (queue?.messages ?? []).map(({ text, ...m }) => ({ ...m, ...(m.status === 'queued' ? {reason: panes.get(m.chatId)?.view.restartProblem?.() ?? panes.get(m.chatId)?.view.deliveryState().reason ?? 'Waiting for this chat to be ready.'} : {}) })),
      };
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastSnapshot) { await backend.companionPublish({ ...snapshot, updatedAt: new Date().toISOString() }); lastSnapshot = serialized; }
    } finally { publishing = false; }
  };
  backend.companionStatus().then(status => { enabled = status.enabled; }).catch(() => {});
  backend.listenCompanion(async request => {
    if (!queue) throw new Error('Remote message storage is unavailable; no prompt was sent.');
    if (request.message?.kind === 'cancel') {
      const cancelled = queue.cancelQueued(request.message.chatId);
      setTimeout(() => publish().catch(() => {}), 0);
      return { status: 'cancelled', count: cancelled };
    }
    const message = queue.accept(state, request.message);
    if (message.kind === 'reply') {
      if (message.status !== 'queued') return { id: message.id, status: message.status, error: message.error };
      const view = panes.get(message.chatId)?.view;
      if (!replyPrompts.matches(message.chatId, view, message.promptId)) {
        queue.update(message.id, 'rejected', 'The prompt changed. Refresh the chat and reply to the question currently shown.');
      } else {
        queue.update(message.id, 'dispatching');
        try {
          await view.replyToPrompt(message.text, () => replyPrompts.matches(message.chatId, view, message.promptId));
          queue.update(message.id, 'delivered');
          lastSend.set(message.chatId, Date.now());
        } catch (error) { queue.update(message.id, error.beforeSubmit ? 'rejected' : 'delivery_unknown', String(error?.message ?? error)); }
      }
      setTimeout(() => publish().catch(() => {}), 0);
      const receipt = queue.messages.find(m => m.id === message.id);
      return { id: receipt.id, status: receipt.status, ...(receipt.error ? {error: receipt.error} : {}) };
    }
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
      ${enabled ? '<label>This PC’s IP address or hostname<input name="companion-host" placeholder="Detect automatically" autocomplete="off"></label><button type="button" data-network-setup>Allow Wi-Fi connections</button><p data-network-status role="status" class="dialog-note">If the phone cannot connect, allow Workbench through this PC’s firewall. Your OS may ask for administrator approval once.</p><button type="button" data-pairing>Create pairing code</button><p data-pairing-status role="status"></p><textarea data-code rows="4" readonly hidden aria-label="Pairing code"></textarea><p class="dialog-note">Paste the complete code into the phone or another Workbench. It expires after five minutes and can be used once.</p>' : ''}
      ${status.clients.map(c => `<p>${escape(c.name)} <button type="button" data-revoke="${escape(c.id)}">Revoke access</button></p>`).join('')}
      <button type="button" data-clear>Clear delivered message receipts</button></fieldset>
      <fieldset><legend>Remote access from anywhere</legend>
      <p class="dialog-note">Built-in Tailscale connects only Workbench traffic. Sign each PC and the phone into the same personal account. Separate Workbench pairing is still required. Remote access reconnects when Workbench restarts.</p>
      <label>Device name<input name="mesh-name" value="${escape(localStorage.getItem('ai-workbench.mesh-name') ?? `workbench-pc-${crypto.randomUUID().slice(0,8)}`)}" maxlength="63"></label>
      <p data-mesh-state role="status">Checking remote connection…</p>
      <button type="button" data-mesh-enable>Enable built-in remote access</button>
      <button type="button" data-mesh-login hidden>Sign in to Tailscale</button>
      <button type="button" data-mesh-logout hidden>Sign out</button>
      <button type="button" data-mesh-pair hidden>Create remote pairing code</button>
      <textarea data-mesh-code rows="4" readonly hidden aria-label="Remote pairing code"></textarea>
      <p data-mesh-peers class="dialog-note"></p>
      </fieldset>
      <fieldset><legend>Other computers</legend><label>Pairing code<textarea name="remote-code" rows="3" placeholder="Paste a code from the other PC"></textarea></label><label>Computer name<input name="remote-name" placeholder="Office PC"></label><button type="button" data-connect>Pair computer</button><div data-remotes></div></fieldset>
      <p data-error class="form-error" role="status"></p><div class="dialog-actions"><button type="button" data-dismiss>close</button></div>`);
    const error = e => { const field = box.querySelector('[data-error]'); field.textContent = e?.message ?? String(e); field.scrollIntoView({ block: 'nearest' }); };
    const hostField = box.querySelector('[name="companion-host"]');
    if (hostField) hostField.value = status.addresses?.[0] ?? '';
    let mesh = { enabled: false }, checkingMesh = false;
    const updateMesh = async () => {
      if (!box.open || checkingMesh) return; checkingMesh = true;
      try {
        mesh = await backend.meshStatus(); if (!box.open) return;
        box.querySelector('[data-mesh-state]').textContent = mesh.enabled ? `${mesh.state ?? 'Starting'}${mesh.host ? ` · ${mesh.host}` : ''}` : 'Built-in remote access is off.';
        box.querySelector('[data-mesh-enable]').textContent = mesh.enabled ? 'Disable built-in remote access' : 'Enable built-in remote access';
        box.querySelector('[name="mesh-name"]').disabled = !!mesh.enabled;
        box.querySelector('[data-mesh-login]').hidden = !mesh.enabled || mesh.state === 'Running';
        box.querySelector('[data-mesh-logout]').hidden = !mesh.enabled || mesh.state !== 'Running';
        box.querySelector('[data-mesh-pair]').hidden = !mesh.enabled || mesh.state !== 'Running' || !enabled;
        box.querySelector('[data-mesh-peers]').textContent = (mesh.peers ?? []).map(p => `${p.name}: ${p.online ? 'online' : 'offline'}`).join(' · ');
      } catch (e) { if (box.open) box.querySelector('[data-mesh-state]').textContent = e.message; }
      finally { checkingMesh = false; }
    };
    updateMesh();
    const meshTimer = setInterval(updateMesh, 2000); box.addEventListener('close', () => clearInterval(meshTimer));
    box.querySelector('[data-mesh-enable]').onclick = async () => {
      const button = box.querySelector('[data-mesh-enable]'); button.disabled = true;
      try {
        if (mesh.enabled) await backend.meshAction('disable');
        else {
          if (!enabled) { await backend.companionEnable(Number(box.querySelector('[name="companion-port"]').value)); enabled = true; }
          const status = await backend.companionStatus();
          const name = box.querySelector('[name="mesh-name"]').value.trim();
          await backend.meshEnable(name, status.port ?? 0); localStorage.setItem('ai-workbench.mesh-name', name);
        }
        box.close(); dialog();
      } catch (e) { error(e); } finally { button.disabled = false; }
    };
    box.querySelector('[data-mesh-login]').onclick = async () => {
      const button = box.querySelector('[data-mesh-login]'); button.disabled = true;
      try {
        if (!mesh.authUrl) {
          await backend.meshAction('login');
          for (let attempt = 0; attempt < 20 && box.open; attempt++) {
            mesh = await backend.meshStatus();
            if (mesh.authUrl) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        if (!box.open) return;
        if (!mesh.authUrl) throw new Error('Sign-in link is not ready. Check your internet connection and try again.');
        const url = new URL(mesh.authUrl);
        if (url.protocol !== 'https:' || url.hostname !== 'login.tailscale.com') throw new Error('Unexpected remote sign-in URL.');
        await backend.openLink(url.href);
      } catch (e) { error(e); }
      finally { button.disabled = false; }
    };
    box.querySelector('[data-mesh-logout]').onclick = async () => { try { await backend.meshAction('logout'); await updateMesh(); } catch (e) { error(e); } };
    box.querySelector('[data-mesh-pair]').onclick = async () => { try { const field = box.querySelector('[data-mesh-code]'); field.value = JSON.stringify(await backend.meshPairing()); field.hidden = false; field.select(); } catch (e) { error(e); } };

    box.querySelector('[data-enable]').onclick = async () => {
      try {
        if (enabled) await backend.companionDisable();
        else await backend.companionEnable(Number(box.querySelector('[name="companion-port"]').value));
        enabled = !enabled; box.close(); dialog();
      } catch (e) { error(e); }
    };
    box.querySelector('[data-network-setup]')?.addEventListener('click', async () => {
      const button = box.querySelector('[data-network-setup]'), note = box.querySelector('[data-network-status]');
      button.disabled = true; note.textContent = 'Complete the system network permission prompt. Workbench will not retry automatically.';
      try { const result = await backend.companionNetworkSetup(); note.textContent = result.message; }
      catch (e) { note.textContent = e?.message ?? String(e); }
      finally { button.disabled = false; }
    });
    box.querySelector('[data-pairing]')?.addEventListener('click', async () => {
      const button = box.querySelector('[data-pairing]'), note = box.querySelector('[data-pairing-status]'), field = box.querySelector('[data-code]');
      button.disabled = true; note.className = ''; note.textContent = 'Creating pairing code…'; field.hidden = true;
      try {
        const code = await backend.companionPairing(hostField.value.trim());
        hostField.value = code.host; field.value = JSON.stringify(code); field.hidden = false; field.select();
        note.textContent = 'Code ready. Connect your phone to the same Wi-Fi and paste this code into Link computer. It expires in five minutes.';
      } catch (e) { note.className = 'form-error'; note.textContent = e?.message ?? String(e); }
      finally { button.disabled = false; note.scrollIntoView({ block: 'nearest' }); }
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
    const box = showDialog(`<h2>${escape(remote.name)}</h2><p data-state>Connecting…</p><div data-chats></div><div data-usage></div><div data-receipts></div><label>Chat<select name="remote-chat"></select></label><pre data-output class="handoff-prompt"></pre><label>Message<textarea name="remote-message" rows="4"></textarea></label><button type="button" data-send>Send work</button><button type="button" data-cancel-queued hidden>Discard queued work for this chat</button><p data-receipt role="status"></p><div class="dialog-actions"><button type="button" data-dismiss>close</button></div>`);
    let revision, snapshot, request = null;
    box.querySelector('[data-send]').onclick = async () => {
      const button = box.querySelector('[data-send]'); button.disabled = true;
      try {
        const chatId = box.querySelector('[name="remote-chat"]').value, text = box.querySelector('[name="remote-message"]').value;
        if (!request || request.chatId !== chatId || request.text !== text) {
          const promptId = button.dataset.promptId;
          request = { id: crypto.randomUUID(), chatId, text, ...(promptId ? {kind:'reply', promptId} : {}) };
        }
        const result = await backend.companionRemote('message', remote.id, request);
        box.querySelector('[data-receipt]').textContent = `Message ${result.id}: ${result.status}`;
        box.querySelector('[name="remote-message"]').value = ''; request = null;
      } catch (e) { box.querySelector('[data-receipt]').textContent = e.message; }
      finally { button.disabled = false; }
    };
    box.querySelector('[data-cancel-queued]').onclick = async () => {
      try { const result = await backend.companionRemote('message', remote.id, {kind:'cancel', chatId:box.querySelector('[name="remote-chat"]').value}); box.querySelector('[data-receipt]').textContent = `Cancelled ${result.count} queued messages.`; }
      catch (e) { box.querySelector('[data-receipt]').textContent = e.message; }
    };
    box.querySelector('[name="remote-chat"]').onchange = () => output();
    function output() {
      const id = box.querySelector('[name="remote-chat"]').value, chat = snapshot?.chats?.find(c => c.id === id), button = box.querySelector('[data-send]');
      box.querySelector('[data-output]').textContent = chat?.output || 'No terminal output available.';
      button.textContent = chat?.replyPrompt ? 'Reply to current prompt' : 'Send work'; button.dataset.promptId = chat?.replyPrompt?.id ?? '';
      box.querySelector('[data-cancel-queued]').hidden = !snapshot?.receipts?.some(r => r.chatId === id && r.status === 'queued');
    }
    while (box.open) {
      try {
        const result = await backend.companionRemote('snapshot', remote.id, revision === undefined ? {} : { since: revision });
        if (!box.open) break;
        revision = result.revision; snapshot = result.snapshot;
        box.querySelector('[data-state]').textContent = `Connected · ${snapshot.updatedAt ?? 'waiting for snapshot'}`;
        const select = box.querySelector('[name="remote-chat"]'), selected = select.value;
        select.innerHTML = (snapshot.chats ?? []).map(c => `<option value="${escape(c.id)}">${escape(snapshot.projects?.find(p => p.id === c.projectId)?.name ?? "Individual chats")} / ${escape(c.name)} · ${escape(c.tool)} · ${escape(c.status)}</option>`).join('');
        if ([...select.options].some(o => o.value === selected)) select.value = selected;
        box.querySelector('[data-chats]').textContent = `${snapshot.projects?.length ?? 0} projects · ${snapshot.chats?.length ?? 0} AI chats`;
        box.querySelector('[data-usage]').innerHTML = (snapshot.usage?.tools ?? []).map(t => `<p>${escape(t.id)}: ${(t.limits ?? []).map(l => `${escape(l.label)} ${Math.round(l.usedPercent)}% used`).join(' · ') || 'No allowance reported'}</p>`).join('');
        box.querySelector('[data-receipts]').textContent = (snapshot.receipts ?? []).slice(-5).map(r => `${r.id}: ${r.status}${r.reason ? ' · '+r.reason : ''}`).join(' · ');
        output();
      } catch (e) { if (!box.open) break; box.querySelector('[data-state]').textContent = `Offline · ${e.message}`; await new Promise(r => setTimeout(r, 5000)); }
    }
  }
  return { dialog };
}

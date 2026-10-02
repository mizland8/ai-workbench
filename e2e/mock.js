// Fake Tauri bridge: terminals echo what is typed; tests can push output, exits and session IDs.
(() => {
  const T = window.__AIW_TEST__ = { log: [], terminals: {}, fail: {}, toolsMissing: ['opencode'], notifications: [], usageOverrides: {} };
  window.Notification = class { static permission = 'granted'; static requestPermission() { return Promise.resolve('granted'); } constructor(title, options = {}) { T.notifications.push({ title, body: options.body }); } };
  const callbacks = new Map();
  const indexes = new Map();
  let nextCallback = 1, nextTerminal = 1;
  const send = (channel, message) => {
    const index = indexes.get(channel.id) ?? 0;
    indexes.set(channel.id, index + 1);
    callbacks.get(channel.id)?.({ message, index });
  };
  const bytes = text => new TextEncoder().encode(text).buffer;
  const status = id => T.toolsMissing.includes(id)
    ? { id, name: id, path: null, version: null, signedIn: null, problem: `${id} isn't installed, or isn't on your PATH.`, installCommand: `npm install -g ${id}`, installNeedsNode: true, nodeFound: true, docsUrl: `https://example.com/${id}` }
    : { id, name: id, path: `/home/tester/.local/bin/${id}`, version: '1.2.3', signedIn: id === 'gemini' ? null : id !== 'codex', problem: null, installCommand: `npm install -g ${id}`, installNeedsNode: true, nodeFound: true, docsUrl: `https://example.com/${id}` };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback(cb) { const id = nextCallback++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    runCallback(id, data) { callbacks.get(id)?.(data); },
    convertFileSrc: path => path,
    async invoke(cmd, args = {}) {
      T.log.push([cmd, JSON.parse(JSON.stringify(args))]);
      switch (cmd) {
        case 'home_dir': return '/home/tester';
        case 'path_info': {
          const missing = args.path.includes('missing');
          return { exists: !missing, isDir: !missing && !args.path.endsWith('.txt'), name: args.path.split('/').filter(Boolean).pop() };
        }
        case 'detect_tools': return ['claude', 'codex', 'gemini', 'opencode'].map(status);
        case 'usage_summary': {
          if (T.usageFailure) throw T.usageFailure;
          const now = Date.now();
          const recent = (input, output, cached, replies) => [{ start: now - 60_000, tokens: input + output + cached, input, output, cached, replies, cost: 0 }];
          return { generatedAt: now, tools: [
            { id: 'claude', buckets: recent(200, 1000, 50_000, 3), plan: 'Pro', problem: null, limitsUpdatedAt: now, limitsProblem: null,
              limits: [{ label: '5-hour', usedPercent: 20, resetsAt: now + 7_200_000 }, { label: 'weekly', usedPercent: 40, resetsAt: now + 5 * 86_400_000 }] },
            { id: 'codex', buckets: recent(2000, 1000, 0, 2), plan: 'plus', problem: null, limitsUpdatedAt: now, limitsProblem: null,
              limits: [{ label: '5-hour', usedPercent: 33, resetsAt: now + 3_600_000 }, { label: 'weekly', usedPercent: 85, resetsAt: now + 3 * 86_400_000 }] },
            { id: 'gemini', buckets: [], limits: [], plan: null, problem: null },
            { id: 'opencode', buckets: [], limits: [], plan: null, problem: "OpenCode isn't installed." },
          ].map(tool => ({ ...tool, ...T.usageOverrides[tool.id] })) };
        }
        case 'terminal_stop_all': return null;
        case 'terminal_start': {
          const request = args.request;
          const failure = T.fail[request.tool ?? request.kind];
          if (failure) throw failure;
          const id = nextTerminal++;
          const t = T.terminals[id] = { id, request, input: [], alive: true, size: [request.cols, request.rows] };
          t.send = message => send(args.events, typeof message === 'string' ? bytes(message) : message);
          setTimeout(() => t.send(`\x1b[32m${request.tool ?? request.kind}\x1b[0m started (${request.kind}) in ${request.cwd ?? '~'} session=${request.sessionId ?? '-'}\r\n> `), 5);
          if (request.tool === 'codex' && !request.sessionId) setTimeout(() => t.send({ type: 'session', id: `codex-session-${id}` }), 30);
          return { id, sessionId: request.sessionId ?? null, resumed: false, command: 'mock' };
        }
        case 'terminal_write': {
          const t = T.terminals[args.id];
          t.input.push(args.data);
          t.send(args.data === '\r' ? '\r\n> ' : args.data === '\n' ? '\r\n  ' : args.data);
          return null;
        }
        case 'terminal_resize': { const t = T.terminals[args.id]; if (t) t.size = [args.cols, args.rows]; return null; }
        case 'terminal_stop': {
          const t = T.terminals[args.id];
          if (t?.alive) { t.alive = false; setTimeout(() => t.send({ type: 'exit', code: null }), 5); }
          return null;
        }
        case 'plugin:event|listen': return nextCallback++;
        default: return null;
      }
    },
  };
})();

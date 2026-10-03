import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';

export const wait = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const name of candidates) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch {}
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('Chrome or Chromium not found. Set CHROME_PATH to run the interface tests.');
}

export async function launch({ port = 9333, profile, width = 1440, height = 920, outDir }) {
  const flags = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars'];
  // CI runners often can't use Chrome's sandbox; these tests only load the local build.
  if (process.env.CI) flags.push('--no-sandbox');
  const browser = spawn(findChrome(), [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  // Chrome's first start on a CI runner can take more than ten seconds.
  let page;
  for (const deadline = Date.now() + 60_000; !page && browser.exitCode === null && Date.now() < deadline;) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!page) await wait(100);
  }
  if (!page) {
    browser.kill();
    throw new Error(`Chrome didn't open its debugging port (exit code ${browser.exitCode}).\n${stderr}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const api = {
    send, errors,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async goto(url) { await send('Page.navigate', { url }); await wait(600); },
    async shot(name) { const { data } = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${outDir}/${name}.png`, Buffer.from(data, 'base64')); },
    async key(key, { code = key, modifiers = 0, text, keyCode } = {}) {
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, modifiers, text, unmodifiedText: text, windowsVirtualKeyCode: keyCode ?? key.toUpperCase().charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode ?? key.toUpperCase().charCodeAt(0) });
    },
    async type(text) { await send('Input.insertText', { text }); },
    async mouse(type, x, y, buttons = 1) { await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }); },
    close() { ws.close(); browser.kill(); return new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve)); },
  };
  return api;
}

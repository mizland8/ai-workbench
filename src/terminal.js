import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { startTerminal, writeTerminal, resizeTerminal, stopTerminal, openLink } from './backend.js';
import { detectAgentState, AgentStatus } from './agent-status.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);

// Linux webviews substitute a sans-serif font for any family that isn't installed, which breaks
// the terminal grid, so there the user's configured `monospace` font comes first.
export const monoFonts = isMac ? "ui-monospace, Menlo, Monaco, monospace"
  : isWindows ? "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace" : 'monospace';

const palettes = {
  terminal: { background: '#121717', foreground: '#d3ddd7', cursor: '#90cba3', cursorAccent: '#121717', selectionBackground: '#2f4d3a',
    black: '#1c2321', red: '#e57f7f', green: '#90cba3', yellow: '#e2c77f', blue: '#86b4e0', magenta: '#c9a2e0', cyan: '#7fc8c2', white: '#d3ddd7',
    brightBlack: '#64716b', brightRed: '#f09a9a', brightGreen: '#aee0bd', brightYellow: '#f0d99a', brightBlue: '#a6c9ef', brightMagenta: '#dcbcef', brightCyan: '#9fdcd6', brightWhite: '#f2f6f3' },
  powershell: { background: '#012456', foreground: '#eeeeee', cursor: '#f5de84', cursorAccent: '#012456', selectionBackground: '#1d5a96',
    black: '#0c0c0c', red: '#ff6b78', green: '#3fd13a', yellow: '#f9f1a5', blue: '#6d9bff', magenta: '#e05ad2', cyan: '#61d6d6', white: '#cccccc',
    brightBlack: '#8a97a8', brightRed: '#ff8f99', brightGreen: '#6fe36a', brightYellow: '#fff5b8', brightBlue: '#9dbcff', brightMagenta: '#f08ae6', brightCyan: '#8ee8e8', brightWhite: '#f2f2f2' },
  amber: { background: '#18150e', foreground: '#dbc9a6', cursor: '#e1b56c', cursorAccent: '#18150e', selectionBackground: '#4a3b22',
    black: '#211c13', red: '#e08a6f', green: '#b8c27a', yellow: '#e1b56c', blue: '#9db0c8', magenta: '#d39fb4', cyan: '#a9c2b0', white: '#dbc9a6',
    brightBlack: '#776a52', brightRed: '#f0a58c', brightGreen: '#cfd896', brightYellow: '#f0cb8a', brightBlue: '#b9c8da', brightMagenta: '#e4b9ca', brightCyan: '#c2d6c8', brightWhite: '#f3e6cc' },
};

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

// One xterm.js terminal connected to a CLI running in a pseudo-terminal on the Rust side.
// Status: idle → starting → running → exited, or failed when the CLI couldn't start.
// For an AI tool, `agent` also tracks what the AI is doing: working, waiting for you, or idle.
export class TerminalView {
  constructor(host, { theme = 'terminal', tool = null, onStatus, onEvent, onFocus, onAgentState } = {}) {
    this.host = host;
    this.tool = tool;
    this.id = null;
    this.status = 'idle';
    this.error = '';
    this.exitCode = null;
    this.generation = 0;
    this.callbacks = { onStatus, onEvent, onFocus };
    this.agent = new AgentStatus((state, previous) => onAgentState?.(state, previous));
    this.term = new Terminal({
      allowProposedApi: true, cursorBlink: true, fontFamily: monoFonts, fontSize: 13, lineHeight: 1.1, scrollback: 10000,
      macOptionIsMeta: true, theme: palettes[theme] ?? palettes.terminal,
      linkHandler: { activate: (event, uri) => openLink(uri) },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((event, uri) => openLink(uri)));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.open(host);
    this.term.attachCustomKeyEventHandler(event => this.handleKey(event));
    this.term.onData(data => this.input(data));
    this.term.textarea?.addEventListener('focus', () => this.callbacks.onFocus?.());
    this.term.onWriteParsed(() => this.scheduleDetect(150));
    host.addEventListener('paste', event => this.handlePaste(event), true);
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(host);
  }

  setStatus(status) {
    this.status = status;
    this.callbacks.onStatus?.(this);
  }

  async start(request) {
    this.stop();
    const generation = ++this.generation;
    this.error = '';
    this.exitCode = null;
    this.agent.reset();
    this.setStatus('starting');
    this.fitNow();
    const { cols, rows } = this.term;
    const current = () => generation === this.generation;
    try {
      const started = await startTerminal({ ...request, cols, rows },
        bytes => current() && this.term.write(bytes),
        event => current() && this.handleEvent(event));
      if (!current()) { stopTerminal(started.id); return null; }
      this.id = started.id;
      // A CLI that fails at once can report its exit before this call returns.
      if (this.status === 'starting') this.setStatus('running');
      if (cols !== this.term.cols || rows !== this.term.rows) resizeTerminal(started.id, this.term.cols, this.term.rows);
      return started;
    } catch (error) {
      if (!current()) return null;
      this.error = String(error?.message ?? error);
      this.setStatus('failed');
      return null;
    }
  }

  handleEvent(event) {
    if (event.type === 'exit') {
      this.id = null;
      this.exitCode = event.code ?? null;
      this.setStatus('exited');
    } else if (event.type === 'notice') {
      this.term.write(`\x1b[2m${event.text}\x1b[0m\r\n`);
    }
    this.callbacks.onEvent?.(event);
  }

  input(data) {
    if (this.status === 'running' && this.id !== null) writeTerminal(this.id, data);
    else if (this.status === 'exited' && data === '\r') this.callbacks.onEvent?.({ type: 'restart' });
  }

  // Text pasted the way a terminal pastes it, so the CLI receives it as one paste.
  paste(text) {
    this.term.paste(text);
    this.term.focus();
  }

  handleKey(event) {
    const action = this.keyAction(event);
    if (!action) return true;
    if (event.type === 'keydown' && action !== 'native') {
      event.preventDefault();
      action();
    }
    return false;
  }

  keyAction(e) {
    const key = e.key.toLowerCase();
    const ctrlOnly = e.ctrlKey && !e.altKey && !e.metaKey;
    // Ctrl+J is a line break in the prompt for Claude Code, Codex, Gemini CLI and OpenCode alike.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return () => this.input('\n');
    if (e.key === 'Tab' && e.ctrlKey) return () => {};
    if (isMac) return null;
    if (ctrlOnly && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
      return () => { copyText(this.term.getSelection()); this.term.clearSelection(); };
    }
    // Let the webview paste, which reaches handlePaste and then xterm.
    if (ctrlOnly && key === 'v') return 'native';
    return null;
  }

  // An image on the clipboard has no text to paste; pass Ctrl+V on so the CLI can attach the image itself.
  handlePaste(event) {
    const data = event.clipboardData;
    if (!data || data.getData('text/plain')) return;
    if ([...data.types].some(type => type === 'Files' || type.startsWith('image/'))) {
      event.preventDefault();
      event.stopPropagation();
      this.input('\x16');
    }
  }

  // The rows on screen right now, whatever the scroll position.
  screenLines() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = buffer.baseY; y < buffer.baseY + this.term.rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return lines;
  }

  // Checks run shortly after output arrives, and again when a pending state is due to count.
  scheduleDetect(delay) {
    const due = Date.now() + delay;
    if (!this.tool || (this.detectTimer && this.detectDue <= due)) return;
    clearTimeout(this.detectTimer);
    this.detectDue = due;
    this.detectTimer = setTimeout(() => {
      this.detectTimer = null;
      if (this.status !== 'running') return;
      const wait = this.agent.observe(detectAgentState(this.tool, this.screenLines()));
      if (wait > 0) this.scheduleDetect(wait);
    }, delay);
  }

  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.fitNow());
  }

  fitNow() {
    if (!this.host.isConnected || !this.host.offsetWidth || !this.host.offsetHeight) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try { this.fit.fit(); } catch { return; }
    if (this.id !== null && `${this.term.cols}x${this.term.rows}` !== before) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.id !== null && resizeTerminal(this.id, this.term.cols, this.term.rows), 50);
    }
  }

  setTheme(theme) {
    this.term.options.theme = palettes[theme] ?? palettes.terminal;
  }

  focus() {
    this.term.focus();
  }

  reset() {
    this.term.reset();
  }

  stop() {
    this.generation++;
    if (this.id !== null) stopTerminal(this.id);
    this.id = null;
    if (this.status === 'starting' || this.status === 'running') this.status = 'idle';
  }

  dispose() {
    this.stop();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.fitFrame);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.detectTimer);
    this.term.dispose();
  }
}

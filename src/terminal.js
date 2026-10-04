import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import { startTerminal, writeTerminal, resizeTerminal, stopTerminal, openLink, submitTerminalPrompt } from './backend.js';
import { detectAgentState, delegationReady, AgentStatus } from './agent-status.js';
import { THEMES, DEFAULT_THEME } from './themes.js';

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const isWindows = /Windows/.test(navigator.userAgent);

// Linux webviews substitute a sans-serif font for any family that isn't installed, which breaks
// the terminal grid, so there the user's configured `monospace` font comes first.
export const monoFonts = isMac ? "ui-monospace, Menlo, Monaco, monospace"
  : isWindows ? "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace" : 'monospace';

const palette = theme => (THEMES[theme] ?? THEMES[DEFAULT_THEME]).terminal;

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
  constructor(host, { theme = DEFAULT_THEME, fontSize = 13, fontFamily = monoFonts, tool = null, onStatus, onEvent, onFocus, onAgentState } = {}) {
    this.host = host;
    this.tool = tool;
    this.id = null;
    this.status = 'idle';
    this.error = '';
    this.lastInputAt = 0;
    this.lastOutputAt = 0;
    this.hasDraft = false;
    this.submitting = false;
    this.exitCode = null;
    this.generation = 0;
    this.callbacks = { onStatus, onEvent, onFocus };
    this.agent = new AgentStatus((state, previous) => onAgentState?.(state, previous));
    this.term = new Terminal({
      allowProposedApi: true, cursorBlink: true, fontFamily, fontSize, lineHeight: 1.1, scrollback: 10000,
      macOptionIsMeta: true, theme: palette(theme),
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
    this.lastInputAt = Date.now();
    this.lastOutputAt = 0;
    this.hasDraft = false;
    this.submitting = false;
    this.setStatus('starting');
    this.fitNow();
    const { cols, rows } = this.term;
    const current = () => generation === this.generation;
    try {
      const started = await startTerminal({ ...request, cols, rows },
        bytes => { if (current()) { this.lastOutputAt = Date.now(); this.term.write(bytes); } },
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
    if (this.status === 'running' && this.id !== null) {
      this.lastInputAt = Date.now();
      this.hasDraft = data !== '\r' && data !== '\x03';
      writeTerminal(this.id, data);
    }
    else if (this.status === 'exited' && data === '\r') this.callbacks.onEvent?.({ type: 'restart' });
  }

  // Text pasted the way a terminal pastes it, so the CLI receives it as one paste.
  paste(text) {
    this.term.paste(text);
    this.term.focus();
  }

  transcript() {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = Math.max(0, buffer.length - 250); y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n').slice(-64000);
  }

  promptProblem() {
    const lines = this.screenLines();
    if (this.status !== 'running' || this.id === null || this.agent.state !== 'idle' || !delegationReady(this.tool, lines) || this.submitting || this.hasDraft || !this.lastOutputAt || Date.now() - Math.max(this.lastInputAt, this.lastOutputAt) < 1500) {
      return 'Target is busy, needs user input, has a draft, is not at a recognized prompt, or is still settling. No prompt was sent.';
    }
    return null;
  }

  async submitPrompt(prompt) {
    const problem = this.promptProblem();
    if (problem) throw new Error(problem);
    this.submitting = true;
    const generation = this.generation;
    this.lastInputAt = Date.now();
    try { await submitTerminalPrompt(this.id, prompt); }
    finally { if (generation === this.generation) this.submitting = false; }
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
    // Ctrl+J is a line break in the prompt for Claude Code, Codex, Antigravity CLI and OpenCode alike.
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
    this.term.options.theme = palette(theme);
  }

  setFont(fontFamily) {
    if (this.term.options.fontFamily === fontFamily) return;
    this.term.options.fontFamily = fontFamily;
    this.scheduleFit();
  }

  setFontSize(size) {
    this.term.options.fontSize = size;
    this.scheduleFit();
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

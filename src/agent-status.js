// What an AI CLI is doing, read from the bottom of its screen. While they work, the CLIs show a
// hint such as "esc to interrupt"; when they need an answer, they show a question with choices.
const waitingPatterns = {
  claude: [/Do you want to /, /Yes, I trust this folder/, /No, and tell Claude what to do differently/],
  codex: [/Would you like to (run|make) the following/, /Trust and continue/],
  agy: [/Do you want to proceed\?/, /Yes, accept this change/, /Yes, and always allow/, /Yes, I trust this folder/, /requires permission to read, edit, and execute files/],
  opencode: [/Permission required/, /Allow once/],
};
const yesNo = [/\(y\/n\)/i, /\[y\/N\]/, /\[Y\/n\]/];
// Lower-case on purpose: Claude Code's menus say "Esc to cancel" without anything running.
const workingHints = [/esc to interrupt/, /esc interrupt/, /esc to cancel/];
// A braille spinner at the end of a line, like the one in Codex's footer while it writes an answer.
const spinnerAtEnd = /(?:^|[\s·•])[\u2801-\u28ff]\s*$/;

export function detectAgentState(tool, lines) {
  // Claude Code and Antigravity CLI draw from the top down, so in a tall pane their status line can sit
  // far above the bottom row: read the last lines that have text, not the last rows of the screen.
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  const bottom = lines.slice(Math.max(0, end - 20), end);
  // Narrow panes wrap the CLI's questions, often inside a box: match against the text with the
  // line breaks and box borders taken out.
  const text = bottom.map(line => line.replace(/[│┃║╭╮╰╯─━]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ');
  if ([...(waitingPatterns[tool] ?? []), ...yesNo].some(pattern => pattern.test(text))) return 'waiting';
  if (workingHints.some(pattern => pattern.test(text)) || bottom.slice(-6).some(line => spinnerAtEnd.test(line))) return 'working';
  return 'idle';
}

// How long a new state must last before it counts. Working shows at once; a CLI that is still
// streaming can look idle between redraws, so idle has to hold for a moment.
const holdMs = { working: 0, waiting: 400, idle: 1200 };

export class AgentStatus {
  constructor(onChange) {
    this.state = 'starting';
    this.pending = null;
    this.since = 0;
    this.onChange = onChange;
  }

  // Returns how many milliseconds to wait before observing again, or 0.
  observe(next, now = Date.now()) {
    if (next === this.state) {
      this.pending = null;
      return 0;
    }
    if (next !== this.pending) {
      this.pending = next;
      this.since = now;
    }
    const wait = holdMs[next] - (now - this.since);
    if (wait > 0) return wait;
    const previous = this.state;
    this.state = next;
    this.pending = null;
    this.onChange?.(next, previous);
    return 0;
  }

  reset(state = 'starting') {
    this.state = state;
    this.pending = null;
  }
}

// Absence of a spinner alone is insufficient: sign-in screens and menus can also be idle.
export function delegationReady(tool, lines) {
  if (detectAgentState(tool, lines) !== 'idle') return false;
  const text = lines.join('\n');
  if (/enter to confirm|enter.*continue|select (model|provider)|sign in|log in/i.test(text)) return false;
  const trimmed = lines.map(line => line.trim());
  if (tool === 'agy') return trimmed.some(line => /^>\s*$/.test(line)) && /keyboard shortcuts/i.test(text);
  if (tool === 'claude') return trimmed.includes('❯');
  if (tool === 'codex') return trimmed.some(line => /^›(?:\s+(?!\d+[.)])|$)/.test(line)) && /\? for shortcuts/.test(text);
  if (tool === 'opencode') return /tab agents.*ctrl\+p commands/.test(text) && lines.some(line => /┃/.test(line));
  return false;
}

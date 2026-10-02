// What an AI CLI is doing, read from the bottom of its screen. While they work, the CLIs show a
// hint such as "esc to interrupt"; when they need an answer, they show a question with choices.
const waitingPatterns = {
  claude: [/Do you want to /, /Yes, I trust this folder/, /No, and tell Claude what to do differently/],
  codex: [/Would you like to (run|make) the following/, /Trust and continue/],
  gemini: [/Allow execution of/, /Apply this change\?/, /Waiting for user confirmation/, /Do you trust the files in this folder\?/],
  opencode: [/Permission required/, /Allow once/],
};
const yesNo = [/\(y\/n\)/i, /\[y\/N\]/, /\[Y\/n\]/];
// Lower-case on purpose: Claude Code's menus say "Esc to cancel" without anything running.
const workingHints = [/esc to interrupt/, /esc interrupt/, /esc to cancel/];
// A braille spinner at the end of a line, like the one in Codex's footer while it writes an answer.
const spinnerAtEnd = /(?:^|[\s·•])[\u2801-\u28ff]\s*$/;

export function detectAgentState(tool, lines) {
  const bottom = lines.slice(-20);
  const text = bottom.join('\n');
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

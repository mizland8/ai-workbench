// What an AI CLI is doing, read from the bottom of its screen. While they work, the CLIs show a
// hint such as "esc to interrupt"; when they need an answer, they show a question with choices.
const waitingPatterns = {
  claude: [/Do you want to /, /Yes, I trust this folder/, /No, and tell Claude what to do differently/],
  codex: [/Would you like to (run|make|apply) (the following|these)/, /Trust and continue/, /Approval required/i],
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
  // A historical approval in the answer is not a live approval when an empty prompt follows.
  const mark = promptMarks[tool];
  const prompt = mark ? bottom.findLastIndex(line => line.trimStart().startsWith(mark)) : -1;
  const liveChoices = bottom.some(line => /^\s*[›❯>]\s*(?:\d+\.\s*)?(Yes|No|Trust|Allow)\b/i.test(line)) || /Allow once.*Allow always/.test(text);
  const waitingText = !liveChoices && promptDraft(tool, bottom) === false ? bottom.slice(prompt).join(' ') : text;
  if ([...(waitingPatterns[tool] ?? []), ...yesNo].some(pattern => pattern.test(waitingText))) return 'waiting';
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

const rule = /^\s*─{3,}\s*$/;
const oldAgyFooter = /Press \? to see keyboard shortcuts/i;
const promptMarks = { agy: '>', claude: '❯', codex: '›' };

// Whether the prompt holds text you typed: true, false, or null when no prompt is on screen.
// Pass the screen without its dim text: the CLIs draw placeholders like 'Try "fix lint errors"' dim.
export function promptDraft(tool, lines, textOnly = false) {
  if (tool === 'opencode') {
    const metadata = /^\s*(Build|Plan)\s*·/i;
    const first = lines.findLastIndex(line => line.includes('┃') && !metadata.test(line.split('┃').slice(1).join('┃')));
    if (first < 0) return null;
    let end = first + 1;
    while (end < lines.length && !/╹|tab agents.*ctrl\+p commands/.test(lines[end]) && !metadata.test(lines[end].replace(/^.*?┃/, ''))) end++;
    const content = [lines[first].split('┃').slice(1).join('┃'), ...lines.slice(first + 1, end).map(line => line.replace(/^.*?┃/, ''))].join('\n');
    return textOnly ? content : content.trim() !== '';
  }
  const mark = promptMarks[tool];
  if (!mark) return null;
  let first, end;
  if (tool === 'codex') {
    // Codex's prompt runs from its last › line down to the next blank line.
    first = lines.findLastIndex(line => line.trimStart().startsWith(mark));
    end = first + 1;
    while (end < lines.length && lines[end].trim()) end++;
  } else {
    // Claude Code and AGY draw the prompt between two rules; AGY before 1.2 drew it above a "Press ?" footer.
    end = lines.findLastIndex(line => rule.test(line) || (tool === 'agy' && oldAgyFooter.test(line)));
    first = end - 1;
    while (first >= 0 && !lines[first].trimStart().startsWith(mark) && !rule.test(lines[first])) first--;
  }
  if (first < 0 || !lines[first].trimStart().startsWith(mark)) return null;
  const content = [lines[first].trimStart().slice(mark.length), ...lines.slice(first + 1, end)].join('\n');
  return textOnly ? content : content.trim() !== '';
}

// Whether a chat can take a message from another AI now. Only two things hold one back: the AI is
// working, or it shows an approval or a question, where a pasted message and Enter would answer it
// for the user. Anything else, including text in its prompt, gets the message at once.
export function deliveryState({ tool, lines, status = 'running', id = 1, submitting = false, lastOutputAt = 0 }) {
  const blocked = (state, reason) => ({ state, canAccept: false, reason });
  if (status !== 'running' || id === null) return blocked('closed', 'This chat is closed; its tasks are delivered once it is open again.');
  if (submitting) return blocked('busy', 'A message is being delivered to this chat.');
  if (!lastOutputAt) return blocked('starting', 'This chat is still starting.');
  const observed = detectAgentState(tool, lines);
  if (observed === 'waiting') {
    const text = lines.slice(-20).join(' ');
    const approval = /permission|approval|following|proceed|trust|allow once|accept this change/i.test(text);
    return blocked(approval ? 'approval_pending' : 'user_input_required', approval
      ? 'This chat is waiting for the user to answer an approval; tasks are delivered after that.' : 'This chat is waiting for the user to answer a question; tasks are delivered after that.');
  }
  if (observed === 'working') return blocked('busy', 'This chat is working; tasks are delivered when it finishes.');
  // A menu the user opened (Claude Code's /model, say): Enter would pick its highlighted choice.
  if (lines.filter(line => line.trim()).slice(-4).some(line => /enter to (confirm|select)/i.test(line))) return blocked('user_input_required', 'This chat has a menu open; tasks are delivered once it is closed.');
  return { state: 'ready', canAccept: true, reason: null };
}

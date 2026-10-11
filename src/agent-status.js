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

// Absence of a spinner alone is insufficient: sign-in screens and menus can also be idle.
// `typed` is the screen without its dim text, as promptDraft wants it.
export function delegationReady(tool, lines, typed = lines) {
  if (detectAgentState(tool, lines) !== 'idle') return false;
  // Earlier replies may discuss sign-in or approvals; only inspect the active prompt/footer.
  const mark = promptMarks[tool];
  const first = mark ? lines.findLastIndex(line => line.trimStart().startsWith(mark)) : -1;
  const text = lines.slice(Math.max(0, first)).join('\n');
  if (first >= 0 && lines.slice(0, first).some(line => /^\s*(sign in to|log in to)/i.test(line))) return false;
  if (/enter to confirm|enter.*continue|select (model|provider)|sign in|log in/i.test(text)) return false;
  if (tool === 'agy' || tool === 'claude') return promptDraft(tool, typed) === false;
  // Codex hides "? for shortcuts" while its prompt holds text or a menu is open.
  if (tool === 'codex') return promptDraft(tool, typed) === false;
  if (tool === 'opencode') return promptDraft(tool, typed) === false && (/tab agents.*ctrl\+p commands/.test(text) || /╹▀/.test(text));
  return false;
}

// Shared by discovery and dispatch. Refresh from parsed screen rather than a delayed UI dot.
export function deliveryState({ tool, lines, typed = lines, status = 'running', id = 1,
  submitting = false, hasDraft = false, lastInputAt = 0, lastOutputAt = 0, outputEpoch = 0, lastInputEpoch = 0, now = Date.now() }) {
  const blocked = (state, reason) => ({ state, canAccept: false, reason: `${reason} No prompt was sent.` });
  if (status !== 'running' || id === null) return blocked('closed', 'Open or resume this terminal in Workbench.');
  if (submitting) return blocked('busy', 'Another delivery is in progress; inspect bridge tasks.');
  if (!lastOutputAt) return blocked('stale', 'No terminal screen has arrived yet; wait or resume the terminal.');
  const observed = detectAgentState(tool, lines);
  if (observed === 'waiting') {
    const text = lines.slice(-20).join(' ');
    const approval = /permission|approval|following|proceed|trust|allow once|accept this change/i.test(text);
    return blocked(approval ? 'approval_pending' : 'user_input_required', approval
      ? 'A user must review the approval in this chat.' : 'This chat is waiting for a user answer.');
  }
  if (observed === 'working') return blocked('busy', 'The agent is working; wait for its prompt.');
  if (now - Math.max(lastInputAt, lastOutputAt) < 1500) return blocked('settling', 'The terminal is changing; retry after it settles.');
  const draft = promptDraft(tool, typed);
  const refreshedAfterInput = outputEpoch > lastInputEpoch || lastOutputAt > lastInputAt;
  if (draft === true || (hasDraft && (draft === null || !refreshedAfterInput)))
    return blocked('draft_present', 'This chat contains a draft; ask its owner to send or clear it.');
  if (!delegationReady(tool, lines, typed)) return blocked('unsupported_prompt', 'The current screen is not a recognized empty prompt; inspect bridge read and the chat.');
  return { state: 'ready', canAccept: true, reason: null };
}

export function preparedPromptMatches(tool, lines, typed, prompt) {
  if (detectAgentState(tool, lines) !== 'idle') return false;
  const content = promptDraft(tool, typed, true);
  if (typeof content !== 'string' || !content.trim()) return false;
  // Tall composers may show only the tail. Compare a substantial suffix, ignoring TUI wrapping.
  const compact = text => text.replace(/\s+/g, '');
  return compact(content).endsWith(compact(prompt).slice(-160));
}

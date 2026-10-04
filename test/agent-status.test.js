import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAgentState, delegationReady, promptDraft, AgentStatus } from '../src/agent-status.js';

// Bottom lines of real screens, recorded from Claude Code 2.1.284, Codex 0.159.2 and OpenCode 1.18.34.
const screens = {
  claudeWorking: ['❯ In two short sentences, what is a terminal multiplexer?', '● A terminal multiplexer lets you run several terminal sessions',
    '✶ Whisking… (1s · ↓ 23 tokens)', '                                  ◐ medium · /effort', '────────', '❯', '────────',
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents'],
  claudeDone: ['● A terminal multiplexer lets you run several terminal sessions', '✻ Baked for 2s · done 9:08 PM',
    '                                  ◐ medium · /effort', '────────', '❯', '────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'],
  claudeTrust: [' Accessing workspace:', ' /tmp/project', ' Quick safety check: Is this a project you created or one you trust?',
    ' Security guide', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'],
  claudePermission: [' Bash command', '   touch probe.txt', ' Do you want to proceed?', ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for touch commands in /tmp/project", '   3. No, and tell Claude what to do differently (esc)'],
  claudeMenu: [' Select model', ' ❯ 1. Default (recommended)', '   2. Opus', ' Enter to confirm · Esc to cancel'],
  codexWorking: ['› In two short sentences, what is a terminal multiplexer?', '• Working (0s • esc to interrupt)', '› Ask Codex to do anything',
    '  GPT-6.1-Sol low · /tmp/project · ⠴', '  ? for shortcuts'],
  codexStreaming: ['› In two short sentences, what is a terminal multiplexer?', '• A terminal multiplexer lets you run', '› Ask Codex to do anything',
    '  GPT-6.1-Sol low · /tmp/project · ⠴', '  ? for shortcuts'],
  codexIdle: ['  >_ OpenAI Codex (v0.159.2)', '     /tmp/project', '  What are we poking with a metaphorical stick?', '› Ask Codex to do anything',
    '', '  GPT-6.1-Sol low · /tmp/project', '  ? for shortcuts'],
  codexTrust: ['  Folder access', '  /tmp/project', '  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue',
    '  2. Quit', '  enter continue · esc quit'],
  codexApproval: ['  Would you like to run the following command?', '  $ touch probe.txt', '› 1. Yes, proceed', '  2. No, and tell Codex what to do differently'],
  opencodeWorking: ['  ┃  In two short sentences, what is a terminal multiplexer?', '     ▣  Build · Big Pickle', '  ┃  Build · Big Pickle OpenCode Zen',
    '  ╹▀▀▀▀▀▀▀▀', '   ■■⬝⬝⬝⬝⬝⬝  esc interrupt                       tab agents  ctrl+p commands'],
  opencodeDone: ['     keep processes running in the background.', '     ▣  Build · Big Pickle · 13.9s', '  ┃', '  ┃  Build · Big Pickle OpenCode Zen', '  ╹▀▀▀▀▀▀▀▀'],
  opencodeStart: ['             ┃  Ask anything… "Fix a TODO in the codebase"', '             ┃  Build · Big Pickle OpenCode Zen',
    '                                 tab agents  ctrl+p commands', '  ● Tip Run /connect to add an AI provider and start coding', '  /tmp/project     1.18.34'],
  opencodePermission: ['  Permission required', '  Edit src/main.js', '  Allow once   Allow always   Reject'],
  agyWorking: [' ⠏ Thinking…', ' Press esc to interrupt generation.'],
  agyApproval: [' Run command: ls -la', ' Do you want to proceed?', ' ❯ Yes', "   Yes, and always allow 'ls' in this conversation", '   No'],
  agyTrust: [' Antigravity requires permission to read, edit, and execute files here.', ' ❯ Yes, I trust this folder', '   No, exit'],
  agyIdle: [' > ', ' Press ? to see keyboard shortcuts.'],
  // AGY 1.2.16 keeps an empty prompt open below the answer it is writing.
  agyGenerating: ['> Reply with only the word ok.', '⣽  Generating...', '─'.repeat(60), '>', '─'.repeat(60), 'esc to cancel          Gemini 3.8 Flash · high'],
  shellQuestion: ['Overwrite settings.json? (y/n)'],
};

// Prompts recorded from AGY 1.2.16, Claude Code 2.1.289 and Codex 0.160.0 after typing, deleting and
// Ctrl+J, with dim text blanked as screenLines(true) does: an empty prompt shows only its placeholder.
const rule = '─'.repeat(60);
const prompts = {
  agy: {
    empty: [rule, '>', rule, '? for shortcuts                         Gemini 3.8 Flash · high'],
    draft: [rule, '> hello', rule, '                                        Gemini 3.8 Flash · high'],
    multiline: [rule, '> one', '  two', rule, '                                        Gemini 3.8 Flash · high'],
  },
  claude: {
    empty: ['                          ◐ medium · /effort', rule, '❯', rule, '  ⏵⏵ auto mode on (shift+tab to cycle)'],
    draft: ['                          ◐ medium · /effort', rule, '❯ hello', rule, '  ⏵⏵ auto mode on (shift+tab to cycle)'],
    multiline: ['                       ctrl+g to edit in Vim', rule, '❯ one', '  two', rule, '  ⏵⏵ auto mode on (shift+tab to cycle)'],
  },
  codex: {
    empty: ['› In an earlier turn', '• Done.', '›', '', '  GPT-6.1-Sol low · /tmp/project', '  ← for agents · ? for shortcuts'],
    draft: ['› hello', '', '  GPT-6.1-Sol low · /tmp/project'],
    multiline: ['› one', '  two', '', '  GPT-6.1-Sol low · /tmp/project'],
  },
};

test('the prompt reads as empty only when nothing but its placeholder is in it', () => {
  for (const [tool, screen] of Object.entries(prompts)) {
    assert.equal(promptDraft(tool, screen.empty), false, `${tool} empty`);
    assert.equal(delegationReady(tool, screen.empty), true, `${tool} empty`);
    for (const kind of ['draft', 'multiline']) {
      assert.equal(promptDraft(tool, screen[kind]), true, `${tool} ${kind}`);
      assert.equal(delegationReady(tool, screen[kind]), false, `${tool} ${kind}`);
    }
  }
  // AGY before 1.2 drew its prompt above a footer instead of between rules.
  const footer = 'Press ? to see keyboard shortcuts.';
  assert.equal(promptDraft('agy', ['> ', '', footer]), false);
  for (const lines of [['> text', footer], ['>', 'continued draft', footer], ['>', footer, '> new draft', footer]]) assert.equal(promptDraft('agy', lines), true);
  // Menus and unknown screens are no prompt at all.
  assert.equal(promptDraft('agy', ['> Yes, I trust this folder', '  No, exit', '  ↑/↓ Navigate · enter Confirm']), null);
  assert.equal(promptDraft('claude', [' Select model', ' ❯ 1. Default (recommended)']), null);
  assert.equal(promptDraft('opencode', prompts.claude.empty), null);
});

const expected = {
  claudeWorking: ['claude', 'working'], claudeDone: ['claude', 'idle'], claudeTrust: ['claude', 'waiting'],
  claudePermission: ['claude', 'waiting'], claudeMenu: ['claude', 'idle'],
  codexWorking: ['codex', 'working'], codexStreaming: ['codex', 'working'], codexIdle: ['codex', 'idle'],
  codexTrust: ['codex', 'waiting'], codexApproval: ['codex', 'waiting'],
  opencodeWorking: ['opencode', 'working'], opencodeDone: ['opencode', 'idle'], opencodeStart: ['opencode', 'idle'],
  opencodePermission: ['opencode', 'waiting'],
  agyWorking: ['agy', 'working'], agyApproval: ['agy', 'waiting'], agyTrust: ['agy', 'waiting'], agyIdle: ['agy', 'idle'], agyGenerating: ['agy', 'working'],
  shellQuestion: ['codex', 'waiting'],
};

for (const [name, [tool, state]] of Object.entries(expected)) {
  test(`${name} reads as ${state}`, () => assert.equal(detectAgentState(tool, screens[name]), state));
}

test('in a tall pane, the status line near the top still counts', () => {
  const tall = [...screens.claudeWorking, ...Array(40).fill('')];
  assert.equal(detectAgentState('claude', tall), 'working');
});

test('questions wrapped in a narrow pane still count', () => {
  const agy = [' │ Run command: npm test                │', ' │ Do you want to                       │', ' │ proceed?                             │',
    ' │ ❯ Yes                                │', ' │   No                                 │', ' ╰──────────────────────────────────────╯'];
  assert.equal(detectAgentState('agy', agy), 'waiting');
  assert.equal(detectAgentState('claude', [' ❯ No, exit', '   Yes, I trust this', '   folder', ' Enter to confirm · Esc to cancel']), 'waiting');
});

test('only the bottom of the screen counts', () => {
  const old = ['  Do you want to proceed?', ...Array(25).fill(''), '❯', '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'];
  assert.equal(detectAgentState('claude', old), 'idle');
});

test('working shows at once; idle and waiting must hold before they count', () => {
  const changes = [];
  const status = new AgentStatus((next, previous) => changes.push(`${previous}→${next}`));
  assert.equal(status.observe('working', 0), 0);
  assert.equal(status.state, 'working');
  assert.equal(status.observe('idle', 100), 1200);
  assert.equal(status.observe('working', 600), 0, 'a redraw that looks working cancels the pending idle');
  assert.equal(status.observe('idle', 700), 1200);
  assert.equal(status.observe('idle', 1500), 400);
  assert.equal(status.state, 'working');
  assert.equal(status.observe('idle', 1900), 0);
  assert.equal(status.state, 'idle');
  assert.equal(status.observe('waiting', 2000), 400);
  assert.equal(status.observe('waiting', 2400), 0);
  assert.deepEqual(changes, ['starting→working', 'working→idle', 'idle→waiting']);
});

// Readiness must identify a prompt, not simply the absence of working hints.
test('delegation rejects menus, sign-in, approvals, and unknown screens', async () => {
  const { delegationReady } = await import('../src/agent-status.js');
  // Codex draws its placeholder dim, and readiness reads the screen with dim text blanked.
  const typed = { codexIdle: screens.codexIdle.map(line => line === '› Ask Codex to do anything' ? '›' : line) };
  for (const name of ['agyIdle', 'codexIdle', 'claudeDone', 'opencodeStart']) {
    assert.equal(delegationReady(expected[name][0], screens[name], typed[name]), true, name);
  }
  for (const name of ['agyApproval', 'agyTrust', 'agyWorking', 'agyGenerating', 'codexApproval', 'codexWorking', 'claudeMenu', 'claudeTrust', 'opencodePermission']) {
    assert.equal(delegationReady(expected[name][0], screens[name]), false, name);
  }
  assert.equal(delegationReady('agy', ['Sign in to Google', '> ', 'Press ? to see keyboard shortcuts.']), false);
  assert.equal(delegationReady('agy', ['Unknown startup screen']), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAgentState, AgentStatus } from '../src/agent-status.js';

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
    '  GPT-6.1-Sol low · /tmp/project', '  ? for shortcuts'],
  codexTrust: ['  Folder access', '  /tmp/project', '  Trust this folder? Codex can read, edit, and run files here.', '› 1. Trust and continue',
    '  2. Quit', '  enter continue · esc quit'],
  codexApproval: ['  Would you like to run the following command?', '  $ touch probe.txt', '› 1. Yes, proceed', '  2. No, and tell Codex what to do differently'],
  opencodeWorking: ['  ┃  In two short sentences, what is a terminal multiplexer?', '     ▣  Build · Big Pickle', '  ┃  Build · Big Pickle OpenCode Zen',
    '  ╹▀▀▀▀▀▀▀▀', '   ■■⬝⬝⬝⬝⬝⬝  esc interrupt                       tab agents  ctrl+p commands'],
  opencodeDone: ['     keep processes running in the background.', '     ▣  Build · Big Pickle · 13.9s', '  ┃', '  ┃  Build · Big Pickle OpenCode Zen', '  ╹▀▀▀▀▀▀▀▀'],
  opencodeStart: ['             ┃  Ask anything… "Fix a TODO in the codebase"', '             ┃  Build · Big Pickle OpenCode Zen',
    '                                 tab agents  ctrl+p commands', '  ● Tip Run /connect to add an AI provider and start coding', '  /tmp/project     1.18.34'],
  opencodePermission: ['  Permission required', '  Edit src/main.js', '  Allow once   Allow always   Reject'],
  geminiWorking: [' ⠏ Thinking about the question (esc to cancel, 3s)', ' > Type your message or @path/to/file'],
  geminiApproval: [' │ ? Shell ls -la │', " │ Allow execution of: 'ls'? │", ' │ ● 1. Allow once │', ' │   3. No, suggest changes (esc) │'],
  geminiTrust: [' │ Do you trust the files in this folder? │', ' │ ● 1. Trust folder (project) │', ' │   3. Don\'t trust │'],
  geminiIdle: [' > Type your message or @path/to/file', ' ~/project       no sandbox       gemini-3-pro'],
  shellQuestion: ['Overwrite settings.json? (y/n)'],
};

const expected = {
  claudeWorking: ['claude', 'working'], claudeDone: ['claude', 'idle'], claudeTrust: ['claude', 'waiting'],
  claudePermission: ['claude', 'waiting'], claudeMenu: ['claude', 'idle'],
  codexWorking: ['codex', 'working'], codexStreaming: ['codex', 'working'], codexIdle: ['codex', 'idle'],
  codexTrust: ['codex', 'waiting'], codexApproval: ['codex', 'waiting'],
  opencodeWorking: ['opencode', 'working'], opencodeDone: ['opencode', 'idle'], opencodeStart: ['opencode', 'idle'],
  opencodePermission: ['opencode', 'waiting'],
  geminiWorking: ['gemini', 'working'], geminiApproval: ['gemini', 'waiting'], geminiTrust: ['gemini', 'waiting'], geminiIdle: ['gemini', 'idle'],
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
  const gemini = [' │ Do you trust the files in this     │', ' │ folder?                            │', ' │                                    │',
    ' │ ● 1. Trust folder (ai-workbench-g… │', ' │   3. Don\'t trust                   │', ' ╰────────────────────────────────────╯', '   Press Ctrl+O to show more lines'];
  assert.equal(detectAgentState('gemini', gemini), 'waiting');
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

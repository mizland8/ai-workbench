export const toolInfo = {
  claude: { name: 'Claude Code', tag: 'claude', color: '#e5af89' },
  codex: { name: 'Codex', tag: 'codex', color: '#88d7b0' },
  agy: { name: 'Antigravity CLI', tag: 'agy', color: '#a5b8eb' },
  opencode: { name: 'OpenCode', tag: 'opencode', color: '#c9cbd1' },
  // A model from LM Studio, Ollama or another server with their API; the chat runs in OpenCode.
  local: { name: 'Local model', tag: 'local', color: '#e2c770' },
  shell: { name: 'Terminal', tag: 'terminal', color: '#c6a6e8' },
};

// What a tool's status means for the person using it, in a few words.
export function describeStatus(status) {
  if (!status) return { level: 'unknown', text: 'checking…' };
  if (!status.path) return { level: 'missing', text: 'not installed' };
  if (status.problem) return { level: 'warn', text: 'not responding' };
  const version = status.version ? ` · ${status.version}` : '';
  if (status.signedIn === false) return { level: 'warn', text: `sign-in needed${version}` };
  if (status.signedIn === true) return { level: 'ready', text: `ready${version}` };
  return { level: 'ready', text: `installed${version}` };
}

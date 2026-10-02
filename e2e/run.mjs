// Interface tests: the built app in headless Chrome, with a fake Tauri backend (mock.js) whose
// terminals echo input and can be told to show any screen. Run with `npm run test:ui`.
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, wait } from './cdp.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, '../dist');
const shots = join(here, 'screenshots');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/__mock.js') return res.writeHead(200, { 'content-type': types['.js'] }).end(await readFile(join(here, 'mock.js')));
    const file = path === '/' ? '/index.html' : normalize(decodeURIComponent(path));
    let body = await readFile(join(dist, file));
    if (file === '/index.html') body = String(body).replace('<script type="module"', '<script src="/__mock.js"></script><script type="module"');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'ai-workbench-ui-'));
await mkdir(shots, { recursive: true });
const page = await launch({ profile, outDir: shots });
const results = [];
const check = (name, ok, detail = '') => { results.push([ok, name, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`); };
const q = expr => page.eval(`return (${expr});`);
const click = selector => page.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ' + ${JSON.stringify(selector)}); el.click();`);
const calls = cmd => q(`__AIW_TEST__.log.filter(([c]) => c === ${JSON.stringify(cmd)}).map(([, a]) => a)`);
const paneText = index => q(`[...document.querySelectorAll('.pane')].find(p => p.style.order === '${index}')?.querySelector('.xterm-rows')?.innerText ?? ''`);
const saved = () => q(`JSON.parse(localStorage.getItem('ai-workbench.workspace.v3'))`);

try {
  await page.goto(`${origin}/`);
  await wait(300);
  // 1. First run
  check('welcome screen shows three steps', await q(`document.querySelectorAll('.steps li').length`) === 3);
  check('stale terminals are cleared at startup', (await calls('terminal_stop_all')).length === 1);
  check('header counts installed tools', /3\/4/.test(await q(`document.querySelector('#tools-button').textContent`)), await q(`document.querySelector('#tools-button').textContent`));
  check('step 1 reports installed tools', /3 of 4 installed/.test(await q(`document.querySelector('.steps').innerText`)));
  await page.shot('01-welcome');

  // 2. AI tools dialog
  await click('[data-action=tools]');
  await wait(200);
  check('tools dialog shows four cards', await q(`document.querySelectorAll('.tool-card').length`) === 4);
  const badges = await q(`[...document.querySelectorAll('.tool-card .badge')].map(b => b.textContent)`);
  check('badges describe each tool', JSON.stringify(badges) === JSON.stringify(['ready · 1.2.3', 'sign-in needed · 1.2.3', 'installed · 1.2.3', 'not installed']), badges);
  check('missing tool offers install', await q(`!!document.querySelector('[data-install=opencode]')`));
  const codexTitle = await q(`getComputedStyle(document.querySelectorAll('.tool-card strong')[1]).color`);
  check('card titles keep the normal text colour', codexTitle === await q(`getComputedStyle(document.querySelectorAll('.tool-card strong')[0]).color`), codexTitle);
  await click('[data-login=codex]');
  await wait(150);
  const login = (await calls('terminal_start')).at(-1)?.request;
  check('sign in runs the login flow in an embedded terminal', login?.kind === 'login' && login?.tool === 'codex', login);
  check('helper terminal shows output', /codex started \(login\)/.test(await q(`document.querySelector('.helper-terminal .xterm-rows')?.innerText ?? ''`)));
  await page.shot('02-tools-dialog');
  await page.eval(`document.querySelector('dialog [data-dismiss].primary').click();`);
  await wait(100);
  check('closing the dialog stops its terminal', (await calls('terminal_stop')).length === 1);

  // 3. Add a project
  await click('.steps [data-action=add-project]');
  await wait(100);
  await page.eval(`document.querySelector('dialog [name=path]').value = '/work/missing-folder'; document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('a folder that does not exist is refused', /doesn’t exist/.test(await q(`document.querySelector('dialog .form-error').textContent`)));
  await page.eval(`document.querySelector('dialog [name=path]').value = '/work/app/'; document.querySelector('dialog [type=submit]').click();`);
  await wait(150);
  const afterProject = await saved();
  check('project is added with the folder name', afterProject.projects[0]?.name === 'app' && afterProject.projects[0]?.path === '/work/app', afterProject.projects);
  check('empty workspace message replaces the welcome', await q(`!!document.querySelector('.welcome.compact')`));

  // 4. New chats
  await click('.welcome.compact [data-action=new-chat]');
  await wait(100);
  check('new chat dialog preselects the project', await q(`document.querySelector('dialog [name=project]').selectedOptions[0].textContent.startsWith('app')`));
  check('missing tool choice links to setup', await q(`document.querySelector('.tool-choice[value=opencode]').dataset.action === 'tools'`));
  await page.eval(`document.querySelector('dialog [name=title]').value = 'Fix login'; document.querySelector('.tool-choice[value=claude]').click();`);
  await wait(250);
  const claudeStart = (await calls('terminal_start')).at(-1)?.request;
  check('claude chat starts in the project folder with a session ID', claudeStart?.kind === 'chat' && claudeStart.tool === 'claude' && claudeStart.cwd === '/work/app' && /^[0-9a-f-]{36}$/.test(claudeStart.sessionId), claudeStart);
  check('terminal is sized to the pane', claudeStart?.cols > 80 && claudeStart?.rows > 20, [claudeStart?.cols, claudeStart?.rows]);
  check('claude output appears in the pane', /claude started \(chat\) in \/work\/app/.test(await paneText(0)));

  for (const [tool, project] of [['codex', true], ['shell', false]]) {
    await click('#toolbar [data-action=new-chat]');
    await wait(100);
    if (!project) await page.eval(`document.querySelector('dialog [name=project]').value = '';`);
    await click(`.tool-choice[value=${tool}]`);
    await wait(300);
  }
  const starts = (await calls('terminal_start')).filter(a => a.request.kind !== 'login');
  check('codex chat starts without a session ID', starts[1]?.request.tool === 'codex' && !starts[1]?.request.sessionId, starts[1]);
  check('terminal chat runs a shell in the home folder', starts[2]?.request.kind === 'shell' && starts[2]?.request.cwd === null, starts[2]);
  const codexChat = (await saved()).chats.find(c => c.tool === 'codex');
  check('session ID found for codex is saved', /^codex-session-/.test(codexChat?.sessionId ?? ''), codexChat);
  check('three panes in a 2-column grid; the third spans both columns', await q(`document.querySelector('#panes').style.gridTemplateColumns`) === 'repeat(2, minmax(0px, 1fr))' && await q(`[...document.querySelectorAll('.pane')].find(p => p.style.order === '2').style.gridColumn`) === 'span 2', await q(`[...document.querySelectorAll('.pane')].map(p => p.style.gridColumn)`));
  await page.shot('03-three-panes');

  // 5. Typing
  await page.eval(`[...document.querySelectorAll('.pane')].find(p => p.style.order === '0').querySelector('.xterm-helper-textarea').focus();`);
  await page.type('hello');
  await page.key('Enter', { modifiers: 8, text: '\r', keyCode: 13 });
  await page.type('world');
  await page.key('Enter', { text: '\r', keyCode: 13 });
  await wait(150);
  const claudeTerm = await q(`Object.values(__AIW_TEST__.terminals).find(t => t.request.tool === 'claude').input`);
  check('typing reaches the CLI; Shift+Enter sends a line break, Enter submits', JSON.stringify(claudeTerm) === JSON.stringify(['hello', '\n', 'world', '\r']), claudeTerm);
  check('focusing a pane makes it active', await q(`document.querySelector('.pane.active')?.style.order`) === '0');

  // 6. Panes survive re-renders
  await page.eval(`document.querySelectorAll('.pane').forEach(p => p.querySelector('.xterm').dataset.mark = p.dataset.pane);`);
  const startsBefore = (await calls('terminal_start')).length;
  await click('[data-action=layout][data-layout=columns]'); await wait(100);
  await click('[data-action=layout][data-layout=focus]'); await wait(100);
  check('focus layout shows only the active pane', await q(`[...document.querySelectorAll('.pane')].filter(p => !p.hidden).length`) === 1);
  await page.shot('04-focus');
  await click('[data-action=layout][data-layout=grid]'); await wait(100);
  await page.eval(`document.querySelectorAll('.open-tab [data-action=focus]')[1].click();`); await wait(100);
  await click('[data-action=toggle-project]'); await wait(100);
  check('collapsing a project hides its chats', await q(`document.querySelectorAll('.project .chat-row').length`) === 0);
  await page.eval(`document.querySelector('.sidebar .chat-row').click();`); await wait(100);
  check('project stays collapsed after other actions', await q(`document.querySelector('.project-toggle').getAttribute('aria-expanded')`) === 'false');
  await click('[data-action=toggle-project]'); await wait(100);
  check('no terminal restarted during layout/tab/sidebar changes', (await calls('terminal_start')).length === startsBefore);
  check('terminal elements are the same instances', await q(`[...document.querySelectorAll('.pane')].every(p => p.querySelector('.xterm').dataset.mark === p.dataset.pane)`));
  check('scrollback kept', /hello/.test(await paneText(0)));
  const strip = await q(`(() => { const host = document.querySelector('.pane .terminal-host'); const r = host.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.bottom - 2); return [el.className, getComputedStyle(el).backgroundColor]; })()`);
  check('no black strip below the last terminal row', strip[1] !== 'rgb(0, 0, 0)', strip);
  check('UI uses the monospace font list', await q(`getComputedStyle(document.body).fontFamily`) === 'monospace', await q(`getComputedStyle(document.body).fontFamily`));

  // 7. Drag a pane header onto another pane to swap them
  const openBefore = (await saved()).open;
  const box = await q(`(() => { const ps = [...document.querySelectorAll('.pane')].sort((a, b) => a.style.order - b.style.order); const h = ps[0].querySelector('.pane-title').getBoundingClientRect(); const t = ps[1].getBoundingClientRect(); return [h.x + 10, h.y + 5, t.x + t.width / 2, t.y + t.height / 2]; })()`);
  await page.mouse('mouseMoved', box[0], box[1], 0);
  await page.mouse('mousePressed', box[0], box[1]);
  await page.mouse('mouseMoved', box[0] + 30, box[1] + 10);
  await page.mouse('mouseMoved', box[2], box[3]);
  check('drop target is highlighted while dragging', await q(`document.querySelectorAll('.pane.drop-target').length`) === 1);
  await page.mouse('mouseReleased', box[2], box[3]);
  await wait(100);
  const openAfter = (await saved()).open;
  check('dragging swaps the two panes', openAfter[0] === openBefore[1] && openAfter[1] === openBefore[0] && openAfter[2] === openBefore[2], { openBefore, openAfter });
  check('swapping does not restart terminals', (await calls('terminal_start')).length === startsBefore);

  // 7b. What each agent is doing
  const term = tool => `Object.values(__AIW_TEST__.terminals).filter(t => t.request.tool === '${tool}').at(-1)`;
  const ids = await q(`(() => { const s = JSON.parse(localStorage.getItem('ai-workbench.workspace.v3')); return Object.fromEntries(s.chats.map(c => [c.tool, c.id])); })()`);
  const paneState = tool => q(`document.querySelector('.pane[data-pane="${ids[tool]}"]').dataset.state`);
  check('agents start out ready once their prompt shows', await paneState('claude') === 'ready' && await paneState('codex') === 'ready', [await paneState('claude'), await paneState('codex')]);
  check('a plain terminal is just ready', await paneState('shell') === 'ready');
  await page.eval(`document.querySelector('.pane[data-pane="${ids.claude}"] .xterm-helper-textarea').focus();`);
  await page.eval(`${term('claude')}.send('\\x1b[2J\\x1b[H✶ Whisking… (1s)\\r\\n  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt');`);
  await wait(400);
  check('"esc to interrupt" shows as working', await paneState('claude') === 'working' && await q(`document.querySelector('.pane[data-pane="${ids.claude}"] .agent-state').textContent`) === 'working…');
  check('the tab and sidebar dots say working too', await q(`!!document.querySelector('.open-tab .run-dot.is-working') && !!document.querySelector('.chat-row[data-id="${ids.claude}"] .run-dot.is-working')`));
  check('status bar counts working chats', /1 working/.test(await q(`document.querySelector('.status-summary').innerText`)));
  await page.shot('10-working');
  await page.eval(`${term('claude')}.send('\\x1b[2J\\x1b[H● Here is the answer.\\r\\n✻ Baked for 2s · done\\r\\n❯ ');`);
  await wait(1700);
  check('finishing while you watch it reads as ready, with no notification', await paneState('claude') === 'ready' && (await q('__AIW_TEST__.notifications.length')) === 0, [await paneState('claude'), await q('__AIW_TEST__.notifications')]);
  await page.eval(`${term('codex')}.send('\\x1b[2J\\x1b[H• Working (0s • esc to interrupt)\\r\\n  GPT · /work/app · ⠴');`);
  await wait(400);
  await page.eval(`${term('codex')}.send('\\x1b[2J\\x1b[H• All done.\\r\\n› Ask Codex to do anything');`);
  await wait(1700);
  check('a chat that finished while you were in another one is marked done', await paneState('codex') === 'done');
  check('the status bar offers a jump to it', /1 done/.test(await q(`document.querySelector('.status-summary').innerText`)));
  check('the window title mentions it', (await q('document.title')) === 'AI Workbench · 1 done', await q('document.title'));
  await page.shot('11-done');
  await click('[data-action=jump][data-state=done]');
  await wait(150);
  check('jumping to it makes it active and clears done', (await saved()).active === ids.codex && await paneState('codex') === 'ready');
  check('the title goes back to normal', (await q('document.title')) === 'AI Workbench');
  await click('[data-action=layout][data-layout=focus]');
  await wait(100);
  await page.eval(`${term('claude')}.send('\\x1b[2J\\x1b[H Bash command\\r\\n   touch probe.txt\\r\\n Do you want to proceed?\\r\\n ❯ 1. Yes\\r\\n   3. No, and tell Claude what to do differently (esc)');`);
  await wait(700);
  check('an approval question shows as needs you', await paneState('claude') === 'waiting');
  const notes = await q('__AIW_TEST__.notifications');
  check('a hidden chat that needs you sends a notification', notes.length === 1 && notes[0].title === 'Claude Code needs you' && notes[0].body === 'Fix login · app', notes);
  check('the window title says someone needs you', (await q('document.title')) === 'AI Workbench · 1 needs you');
  await page.shot('12-needs-you');
  await click('[data-action=jump][data-state=waiting]');
  await wait(150);
  check('jumping goes to the chat that needs you', (await saved()).active === ids.claude && await q(`!document.querySelector('.pane[data-pane="${ids.claude}"]').hidden`));
  await page.eval(`${term('claude')}.send('\\x1b[2J\\x1b[H● Done.\\r\\n❯ ');`);
  await wait(1700);
  await click('[data-action=layout][data-layout=grid]');
  await wait(100);

  // 8. Close and reopen resumes the same conversation
  const claudeId = (await saved()).chats.find(c => c.tool === 'claude').id;
  await page.eval(`document.querySelector('.pane[data-pane="${claudeId}"] [data-action=close]').click();`);
  await wait(100);
  check('closing a pane stops its CLI', (await calls('terminal_stop')).length >= 2);
  check('closed chat stays in the sidebar', await q(`!!document.querySelector('.chat-row[data-id="${claudeId}"]')`));
  await page.eval(`document.querySelector('.chat-row[data-id="${claudeId}"]').click();`);
  await wait(250);
  const reopen = (await calls('terminal_start')).at(-1).request;
  check('reopening uses the same session ID', reopen.tool === 'claude' && reopen.sessionId === claudeStart.sessionId, reopen);

  // 9. Exit, resume and new conversation
  await page.eval(`Object.values(__AIW_TEST__.terminals).filter(t => t.request.tool === 'claude').at(-1).send({ type: 'exit', code: 1 });`);
  await wait(100);
  check('exit shows a resume bar', /stopped \(exit code 1\)/.test(await q(`document.querySelector('.pane[data-pane="${claudeId}"] .pane-overlay').innerText`)));
  await page.shot('05-exited');
  await page.eval(`document.querySelector('.pane[data-pane="${claudeId}"] [data-action="new-conversation"]').click();`);
  await wait(150);
  const fresh = (await calls('terminal_start')).at(-1).request;
  check('new conversation gets a new session ID', fresh.tool === 'claude' && fresh.sessionId !== claudeStart.sessionId, fresh);

  // 10. Rename and delete through the pane menu
  await page.eval(`document.querySelector('.pane[data-pane="${claudeId}"] [data-action=pane-menu]').click();`);
  await wait(50);
  await page.eval(`document.querySelector('#menu [data-menu-item="0"]').click();`);
  await wait(50);
  await page.eval(`document.querySelector('dialog [name=title]').value = 'Renamed chat'; document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('rename updates tab, sidebar and pane', await q(`document.querySelector('.pane[data-pane="${claudeId}"] .pane-title').textContent === 'Renamed chat' && document.querySelector('.chat-row[data-id="${claudeId}"]').innerText.includes('Renamed chat') && document.querySelector('#tabs').innerText.includes('Renamed chat')`));
  await page.eval(`document.querySelector('.pane[data-pane="${claudeId}"] [data-action=pane-menu]').click();`);
  await page.eval(`document.querySelector('#menu [data-menu-item="2"]').click();`);
  await wait(50);
  check('delete asks for confirmation and explains history is kept', /stays in Claude Code’s own history/.test(await q(`document.querySelector('dialog').innerText`)));
  await page.shot('06-delete-confirm');
  await page.eval(`document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('deleted chat is gone', (await saved()).chats.every(c => c.id !== claudeId) && !(await q(`!!document.querySelector('[data-pane="${claudeId}"]')`)));

  // 11. Failure states
  await page.eval(`__AIW_TEST__.fail.gemini = "Gemini CLI isn't installed, or isn't on your PATH.";`);
  await click('#toolbar [data-action=new-chat]'); await wait(100);
  await click('.tool-choice[value=gemini]'); await wait(300);
  check('a CLI that cannot start explains why and links to setup', await q(`(() => { const o = [...document.querySelectorAll('.pane-overlay.failed')].at(-1); return !!o && o.innerText.includes("isn't installed") && !!o.querySelector('[data-action=tools]'); })()`));
  await page.shot('07-failed');

  // 12. Reload restores open chats, each resuming its own session
  const before = await saved();
  await page.eval(`__AIW_TEST__.fail = {}; location.reload();`);
  await wait(1500);
  const restarted = (await calls('terminal_start')).map(a => a.request);
  check('reload restores every open chat', restarted.length === before.open.length, { restarted: restarted.map(r => r.tool ?? r.kind), open: before.open.length });
  const codexRestart = restarted.find(r => r.tool === 'codex');
  check('codex resumes the session found earlier', codexRestart?.sessionId === codexChat.sessionId, codexRestart);
  check('theme and layout survive reload', (await saved()).layout === 'grid');

  // 13. Theme
  await page.eval(`const s = document.querySelector('#theme'); s.value = 'amber'; s.dispatchEvent(new Event('change'));`);
  await wait(150);
  const rowColor = await q(`getComputedStyle(document.querySelector('.pane .xterm-rows')).color`);
  check('theme applies to terminals', rowColor === 'rgb(219, 201, 166)', rowColor);
  await page.shot('08-amber');

  // 14. Remove project
  await click('[data-action=project-menu]'); await wait(50);
  await page.eval(`document.querySelector('#menu [data-menu-item="2"]').click();`); await wait(50);
  check('remove project says files are not touched', /files are not touched/.test(await q(`document.querySelector('dialog').innerText`)));
  await page.eval(`document.querySelector('dialog [type=submit]').click();`); await wait(150);
  const afterRemove = await saved();
  check('project and its chats are removed; individual chats stay', afterRemove.projects.length === 0 && afterRemove.chats.every(c => c.projectId === null) && afterRemove.chats.length > 0, afterRemove);

  // 15. Upgrade from version 2
  await page.eval(`localStorage.clear(); localStorage.setItem('ai-workbench.sessions.v2', JSON.stringify({ projects: [{ id: 'project-default', name: 'AI Interface', path: '/home/tester/AI Interface' }], sessions: [{ id: 'session-0', provider: 'Codex', projectId: 'project-default', title: 'New chat', files: [], messages: [], draft: '' }, { id: 'session-1', provider: 'Claude', projectId: 'project-default', title: 'Layout review', files: [], messages: [], draft: '' }], open: ['session-0', 'session-1'], active: 'session-0', layout: 'grid', theme: 'terminal' })); location.reload();`);
  await wait(1200);
  check('version 2 data migrates: project and named chat kept, nothing auto-started', await q(`document.querySelectorAll('.chat-row').length`) === 1 && /AI Interface/.test(await q(`document.querySelector('.sidebar').innerText`)) && (await calls('terminal_start')).length === 0);
  await page.shot('09-migrated');
} catch (error) {
  check('test run completed', false, String(error.stack ?? error));
} finally {
  check('no errors in the page', page.errors.length === 0, page.errors);
  await page.close();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  const failed = results.filter(r => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

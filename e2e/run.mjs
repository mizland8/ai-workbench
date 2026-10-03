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
const saved = () => q(`JSON.parse(localStorage.getItem('ai-workbench.workspace.v4'))`);
const idOf = title => q(`JSON.parse(localStorage.getItem('ai-workbench.workspace.v4')).chats.find(c => c.title === ${JSON.stringify(title)})?.id`);
const pane = id => `document.querySelector('.pane[data-pane="${id}"]')`;
const paneText = id => q(`${pane(id)}?.querySelector('.xterm-rows')?.innerText ?? ''`);
const paneState = id => q(`${pane(id)}?.dataset.state`);
const visible = id => q(`!!${pane(id)} && ${pane(id)}.offsetParent !== null`);
const lastTerm = tool => `Object.values(__AIW_TEST__.terminals).filter(t => t.request.tool === '${tool}').at(-1)`;
const show = (tool, text) => page.eval(`${lastTerm(tool)}.send(${JSON.stringify('\x1b[2J\x1b[H' + text.replace(/\n/g, '\r\n'))});`);
const newChat = async (tool, { title = '', project } = {}) => {
  await click('#toolbar [data-action=new-chat]');
  await wait(100);
  if (project !== undefined) await page.eval(`document.querySelector('dialog [name=project]').value = ${JSON.stringify(project)};`);
  if (title) await page.eval(`document.querySelector('dialog [name=title]').value = ${JSON.stringify(title)};`);
  await click(`.tool-choice[value=${tool}]`);
  await wait(300);
};
const addProject = async path => {
  await click('.section-heading [data-action=add-project]');
  await wait(100);
  await page.eval(`document.querySelector('dialog [name=path]').value = ${JSON.stringify(path)}; document.querySelector('dialog [type=submit]').click();`);
  await wait(150);
};
const starts = async () => (await calls('terminal_start')).filter(a => a.request.kind !== 'login').length;

try {
  await page.goto(`${origin}/`);
  await wait(300);
  // 1. First run
  check('welcome screen shows three steps', await q(`document.querySelectorAll('.steps li').length`) === 3);
  check('stale terminals are cleared at startup', (await calls('terminal_stop_all')).length === 1);
  check('header counts installed tools', /3\/4/.test(await q(`document.querySelector('#tools-button').textContent`)));
  check('header has usage and settings buttons', await q(`!!document.querySelector('[data-action=usage]') && !!document.querySelector('[data-action=settings]')`));
  check('subscription allowances appear before opening usage', /AI usage.*claude 40%.*codex 85%/.test(await q(`document.querySelector('#usage-button').textContent`)) && (await calls('usage_summary')).length === 1);
  await page.shot('01-welcome');

  // 2. AI tools dialog
  await click('[data-action=tools]');
  await wait(200);
  const badges = await q(`[...document.querySelectorAll('.tool-card .badge')].map(b => b.textContent)`);
  check('tools dialog describes each tool', JSON.stringify(badges) === JSON.stringify(['ready · 1.2.3', 'sign-in needed · 1.2.3', 'installed · 1.2.3', 'not installed']), badges);
  await click('[data-login=codex]');
  await wait(150);
  check('sign in runs in an embedded terminal', /codex started \(login\)/.test(await q(`document.querySelector('.helper-terminal .xterm-rows')?.innerText ?? ''`)));
  await page.eval(`document.querySelector('dialog [data-dismiss].primary').click();`);
  await wait(100);
  check('closing the dialog stops its terminal', (await calls('terminal_stop')).length === 1);

  // 3. A project is a page
  await click('.steps [data-action=add-project]');
  await wait(100);
  await page.eval(`document.querySelector('dialog [name=path]').value = '/work/missing-folder'; document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('a folder that does not exist is refused', /doesn’t exist/.test(await q(`document.querySelector('dialog .form-error').textContent`)));
  await page.eval(`document.querySelector('dialog [name=path]').value = '/work/app/'; document.querySelector('dialog [type=submit]').click();`);
  await wait(150);
  const app = (await saved()).projects[0];
  check('project is added and its page opens', app?.name === 'app' && (await saved()).page === app.id && /No chats open in app/.test(await q(`document.querySelector('.panes-empty').innerText`)));
  check('header names the page', /^app/.test(await q(`document.querySelector('#header-page').textContent`)));

  // 4. Chats on the app page
  await click('.welcome.compact [data-action=new-chat]');
  await wait(100);
  check('new chat dialog preselects the page’s project', await q(`document.querySelector('dialog [name=project]').value`) === app.id);
  await page.eval(`document.querySelector('dialog [name=title]').value = 'Fix login'; document.querySelector('.tool-choice[value=claude]').click();`);
  await wait(300);
  const claudeStart = (await calls('terminal_start')).at(-1).request;
  check('claude starts in the project folder with a session ID', claudeStart.tool === 'claude' && claudeStart.cwd === '/work/app' && /^[0-9a-f-]{36}$/.test(claudeStart.sessionId) && claudeStart.cols > 80, claudeStart);
  await newChat('codex', { title: 'Tests' });
  const claude = await idOf('Fix login'), codex = await idOf('Tests');
  check('codex starts without a session ID, then saves the one it reports', !(await calls('terminal_start')).at(-1).request.sessionId && /^codex-session-/.test((await saved()).chats.find(c => c.id === codex).sessionId ?? ''));
  check('both chats are on the app page', JSON.stringify((await saved()).pages[app.id].open) === JSON.stringify([claude, codex]));
  check('claude output appears', /claude started \(chat\) in \/work\/app/.test(await paneText(claude)));

  // 5. Typing
  await page.eval(`${pane(claude)}.querySelector('.xterm-helper-textarea').focus();`);
  await page.type('hello');
  await page.key('Enter', { modifiers: 8, text: '\r', keyCode: 13 });
  await page.type('world');
  await page.key('Enter', { text: '\r', keyCode: 13 });
  await wait(150);
  const typed = await q(`${lastTerm('claude')}.input`);
  check('typing reaches the CLI; Shift+Enter is a line break, Enter submits', JSON.stringify(typed) === JSON.stringify(['hello', '\n', 'world', '\r']), typed);

  // 6. Panes survive re-renders
  await page.eval(`document.querySelectorAll('.pane').forEach(p => p.querySelector('.xterm').dataset.mark = p.dataset.pane);`);
  const before = await starts();
  for (const layout of ['columns', 'focus', 'grid']) { await click(`[data-action=layout][data-layout=${layout}]`); await wait(80); }
  await click('.caret-button'); await wait(80);
  check('collapsing a project hides its chats', await q(`document.querySelectorAll('.project .chat-row').length`) === 0);
  await click('.caret-button'); await wait(80);
  check('no terminal restarted during layout and sidebar changes', await starts() === before);
  check('terminal elements are the same instances', await q(`[...document.querySelectorAll('.pane')].every(p => p.querySelector('.xterm').dataset.mark === p.dataset.pane)`));

  // 7. Drag a pane header onto another pane to swap them
  const box = await q(`(() => { const a = ${pane(claude)}.querySelector('.pane-title').getBoundingClientRect(); const b = ${pane(codex)}.getBoundingClientRect(); return [a.x + 10, a.y + 5, b.x + b.width / 2, b.y + b.height / 2]; })()`);
  await page.mouse('mouseMoved', box[0], box[1], 0);
  await page.mouse('mousePressed', box[0], box[1]);
  await page.mouse('mouseMoved', box[0] + 30, box[1] + 10);
  await page.mouse('mouseMoved', box[2], box[3]);
  await page.mouse('mouseReleased', box[2], box[3]);
  await wait(100);
  check('dragging swaps the two panes', JSON.stringify((await saved()).pages[app.id].open) === JSON.stringify([codex, claude]));
  check('swapping does not restart terminals', await starts() === before);

  // 8. Status: dots while working, flashing when done or waiting
  await page.eval(`${pane(claude)}.querySelector('.xterm-helper-textarea').focus();`);
  await show('claude', '✶ Whisking… (1s)\n  ⏵⏵ auto mode on · esc to interrupt');
  await wait(400);
  check('working shows moving dots on the pane, tab and sidebar', await paneState(claude) === 'working'
    && await q(`!!${pane(claude)}.querySelector('.agent-state .dots') && !!document.querySelector('.open-tab .run-dot.is-working .dots') && !!document.querySelector('.chat-row[data-id="${claude}"] .dots')`));
  await page.shot('08-working');
  await show('claude', '● Here is the answer.\n✻ Baked for 2s · done\n❯ ');
  await wait(1700);
  check('finishing while you watch reads as ready, no notification', await paneState(claude) === 'ready' && (await q('__AIW_TEST__.notifications.length')) === 0);
  await show('codex', '• Working (0s • esc to interrupt)\n  GPT · /work/app · ⠴');
  await wait(400);
  await show('codex', '• All done.\n› Ask Codex to do anything');
  await wait(1700);
  check('a chat that finished while you were in another one is marked done', await paneState(codex) === 'done');
  check('done flashes its tab and border', await q(`getComputedStyle(document.querySelector('.open-tab.is-done')).animationName`) === 'tab-flash-done'
    && await q(`getComputedStyle(${pane(codex)}).animationName`) === 'border-flash-done');
  check('the window title mentions it', (await q('document.title')) === 'AI Workbench · 1 done');
  await page.shot('09-done');
  await click('[data-action=jump][data-state=done]');
  await wait(150);
  check('jumping to it clears done', await paneState(codex) === 'ready' && (await q('document.title')) === 'AI Workbench');
  await click('[data-action=layout][data-layout=focus]');
  await wait(100);
  await show('claude', ' Bash command\n   touch probe.txt\n Do you want to proceed?\n ❯ 1. Yes\n   3. No, and tell Claude what to do differently (esc)');
  await wait(700);
  const notes = await q('__AIW_TEST__.notifications');
  check('a hidden chat that needs you flashes and notifies', await paneState(claude) === 'waiting' && notes.length === 1 && notes[0].title === 'Claude Code needs you' && notes[0].body === 'Fix login · app', notes);
  await click('[data-action=jump][data-state=waiting]');
  await wait(150);
  check('jumping goes to the chat that needs you', (await saved()).pages[app.id].active === claude && await visible(claude));
  await show('claude', '● Done.\n❯ ');
  await wait(1700);
  await click('[data-action=layout][data-layout=grid]');
  await wait(100);

  // 9. Pages keep their own chats and layout
  const beforePages = await starts();
  await addProject('/work/site');
  const site = (await saved()).projects.find(p => p.name === 'site');
  check('a new project opens its own empty page', (await saved()).page === site.id && /No chats open in site/.test(await q(`document.querySelector('.panes-empty').innerText`)));
  check('the other page’s chats keep running out of sight', !(await visible(claude)) && await q(`document.querySelectorAll('#parked .pane').length`) === 2 && (await calls('terminal_stop')).length === 1);
  await click('[data-action=layout][data-layout=columns]');
  await newChat('shell', { title: 'Site shell', project: site.id });
  check('a chat on this page runs in its folder', (await calls('terminal_start')).at(-1).request.cwd === '/work/site');
  await page.eval(`document.querySelector('.project-name[data-page="${app.id}"]').click();`);
  await wait(150);
  check('switching back shows the app page as it was', (await saved()).page === app.id && await visible(claude) && await visible(codex) && !(await visible(await idOf('Site shell'))));
  check('each page keeps its layout', (await saved()).pages[app.id].layout === 'grid' && (await saved()).pages[site.id].layout === 'columns');
  await click('.heading-link[data-page=individual]');
  await wait(100);
  await newChat('shell', { title: 'Scratch', project: '' });
  check('individual chats have their own page and run in the home folder', (await saved()).page === 'individual' && (await calls('terminal_start')).at(-1).request.cwd === null);
  check('moving between pages started only the new chats', await starts() === beforePages + 2);
  await page.shot('10-pages');

  // 10. Pinning
  await page.eval(`document.querySelector('.project-name[data-page="${app.id}"]').click();`);
  await wait(100);
  await page.eval(`${pane(claude)}.querySelector('[data-action=pin]').click();`);
  await wait(150);
  check('a pinned chat moves to the dock', await q(`${pane(claude)}.parentElement.id`) === 'dock' && JSON.stringify((await saved()).pages[app.id].open) === JSON.stringify([codex]));
  check('its label isn’t cut short', await q(`(() => { const t = ${pane(claude)}.querySelector('.pane-title'), p = ${pane(claude)}.querySelector('.pane-project'); return t.scrollWidth <= t.clientWidth && p.scrollWidth <= p.clientWidth; })()`));
  check('it is labelled with its AI, chat and project', await q(`${pane(claude)}.querySelector('.tool-tag').textContent + ' ' + ${pane(claude)}.querySelector('.pane-title').textContent + ' ' + ${pane(claude)}.querySelector('.pane-project').textContent`) === 'claude Fix login · app');
  check('the sidebar marks it pinned', /pinned/.test(await q(`document.querySelector('.chat-row[data-id="${claude}"]').innerText`)));
  await page.eval(`document.querySelector('.project-name[data-page="${site.id}"]').click();`);
  await wait(150);
  check('pinned chats stay visible on other pages', (await saved()).page === site.id && await visible(claude) && /1 pinned/.test(await q(`document.querySelector('.toolbar-count').textContent`)));
  await show('claude', '✶ Thinking… (2s)\n  esc to interrupt');
  await wait(400);
  check('pinned chats show their status too', await paneState(claude) === 'working');
  await page.shot('11-pinned');
  await show('claude', '● Ok.\n❯ ');
  await wait(1700);
  await page.eval(`${pane(claude)}.querySelector('[data-action=pin]').click();`);
  await wait(150);
  check('unpinning sends it back to its own page', !(await visible(claude)) && JSON.stringify((await saved()).pages[app.id].open) === JSON.stringify([codex, claude]));
  check('pinning and switching pages restarted nothing', await starts() === beforePages + 2);

  // 11. Usage
  await click('#usage-button');
  await wait(300);
  check('the usage panel reads each tool’s usage', (await calls('usage_summary')).length >= 1 && await q(`!document.querySelector('#usage-panel').hidden`));
  check('it sums today across AIs', /4\.2K\s*tokens today/.test(await q(`document.querySelector('.usage-summary').innerText`)), await q(`document.querySelector('.usage-summary').innerText`));
  check('each subscription shows its own plan and allowance meters', /Pro plan/.test(await q(`document.querySelector('#usage-panel').innerText`)) && /plus plan/.test(await q(`document.querySelector('#usage-panel').innerText`)) && await q(`document.querySelectorAll('#usage-panel .limit').length`) === 4 && await q(`!!document.querySelector('#usage-panel .meter .high')`));
  check('allowances show usage and reset countdowns', /85% used/.test(await q(`document.querySelector('#usage-panel').innerText`)) && /Resets in 1h/.test(await q(`document.querySelector('#usage-panel').innerText`)) && await q(`document.querySelectorAll('#usage-panel [role=meter]').length`) === 4);
  check('tools without use say why', /OpenCode isn't installed/.test(await q(`document.querySelector('#usage-panel').innerText`)) && /Not used in the last 7 days/.test(await q(`document.querySelector('#usage-panel').innerText`)));
  check('the header shows each subscription’s tightest allowance', /claude 40%.*codex 85%/.test(await q(`document.querySelector('#usage-button').textContent`)));
  await page.shot('12-usage');
  await page.eval(`__AIW_TEST__.usageOverrides.claude = { limitsProblem: 'Claude usage checks are rate limited.' };`);
  await click('#usage-panel [data-action=refresh-usage]'); await wait(150);
  check('refresh asks for current limits', (await calls('usage_summary')).at(-1).refreshLimits === true);
  check('failed checks label cached allowances and retain token totals', /Showing last-known allowances/.test(await q(`document.querySelector('#usage-panel').innerText`)) && /claude 40%\*/.test(await q(`document.querySelector('#usage-button').textContent`)) && /4\.2K/.test(await q(`document.querySelector('.usage-summary').innerText`)), await q(`document.querySelector('#usage-panel').innerText`));
  await page.eval(`__AIW_TEST__.usageOverrides.codex = { limits: [{ label: 'weekly', usedPercent: 85, resetsAt: Date.now() - 1 }] };`);
  await click('#usage-panel [data-action=refresh-usage]'); await wait(150);
  check('expired windows await new data and never claim zero usage', /Window ended · awaiting refresh/.test(await q(`document.querySelector('#usage-panel').innerText`)) && !/codex 85%/.test(await q(`document.querySelector('#usage-button').textContent`)));
  await page.eval(`__AIW_TEST__.usageOverrides = {}; __AIW_TEST__.usageFailure = 'test connection unavailable';`);
  await click('#usage-panel [data-action=refresh-usage]'); await wait(150);
  check('a whole-report failure stays visible alongside previous totals', /Couldn’t read usage: test connection unavailable/.test(await q(`document.querySelector('#usage-panel').innerText`)) && /4\.2K/.test(await q(`document.querySelector('.usage-summary').innerText`)));
  await page.eval(`__AIW_TEST__.usageFailure = null;`);
  await click('#usage-panel [data-action=refresh-usage]'); await wait(150);
  await click('#usage-panel [data-action=pin-usage]');
  await wait(200);
  check('usage can be pinned as a widget', await q(`document.querySelector('#usage-panel').hidden`) && await q(`!!document.querySelector('#dock .usage-widget .usage-summary')`));
  await page.shot('13-usage-widget');
  await click('#dock .usage-widget [data-action=pin-usage]');
  await wait(150);
  check('and unpinned', !(await q(`!!document.querySelector('.usage-widget')`)) && (await saved()).pinned.length === 0);
  await click('#usage-button'); await wait(100);
  await page.key('Escape', { keyCode: 27 }); await wait(100);
  check('Escape closes the usage panel', await q(`document.querySelector('#usage-panel').hidden`));

  // 12. Settings
  await page.eval(`document.querySelector('.project-name[data-page="${app.id}"]').click();`);
  await wait(100);
  await click('[data-action=settings]');
  await wait(100);
  const setField = (name, value) => page.eval(`const f = document.querySelector('dialog [name="${name}"]'); if (f.type === 'checkbox') f.checked = ${JSON.stringify(value)}; else f.value = ${JSON.stringify(value)}; f.dispatchEvent(new Event('input', { bubbles: true }));`);
  await setField('fontSize', '16');
  await wait(150);
  check('text size applies to the terminals', await q(`getComputedStyle(${pane(codex)}.querySelector('.xterm-rows')).fontSize`) === '16px');
  await setField('flash', false);
  check('flashing can be turned off', !(await q(`document.body.classList.contains('flash-on')`)) && (await saved()).settings.flash === false);
  await setField('flash', true);
  await setField('args-codex', '--approve-for-me -c model_reasoning_effort=max');
  await setField('theme', 'amber');
  await wait(150);
  check('theme applies to terminals', await q(`getComputedStyle(${pane(codex)}.querySelector('.xterm-rows')).color`) === 'rgb(219, 201, 166)');
  await setField('theme', 'github-light');
  await wait(150);
  check('a light theme recolors the app and its terminals', await q(`getComputedStyle(document.body).backgroundColor`) === 'rgb(255, 255, 255)'
    && await q(`getComputedStyle(${pane(codex)}.querySelector('.xterm-rows')).color`) === 'rgb(31, 35, 40)'
    && await q(`getComputedStyle(document.documentElement).colorScheme`) === 'light');
  check('the theme list is grouped', await q(`document.querySelectorAll('dialog [name=theme] optgroup').length`) === 4 && await q(`document.querySelectorAll('dialog [name=theme] option').length`) >= 60);
  await page.shot('14b-light-theme');
  await setField('font', 'jetbrains-mono');
  await wait(800);
  check('a bundled font loads and applies to terminals and the app', await q(`document.fonts.check("13px 'JetBrains Mono'")`)
    && /JetBrains Mono/.test(await q(`getComputedStyle(${pane(codex)}.querySelector('.xterm-rows')).fontFamily`))
    && /JetBrains Mono/.test(await q(`getComputedStyle(document.body).fontFamily`))
    && (await saved()).settings.font === 'jetbrains-mono');
  await setField('theme', 'dracula');
  await wait(150);
  await page.shot('14-settings');
  await page.eval(`document.querySelector('dialog [type=submit]').click();`);
  await wait(100);

  // 12b. Updates: a newer release is offered, installed, and the app restarts after asking
  await page.eval(`__AIW_TEST__.update = { rid: 1, currentVersion: '0.1.0', version: '0.2.0', date: null, body: 'More themes', rawJson: {} };`);
  await click('[data-action=settings]');
  await wait(100);
  check('settings show the version and a check button', /Version 0\.1\.0/.test(await q(`document.querySelector('.update-status').innerText`)) && await q(`!!document.querySelector('[data-update=check]')`));
  await click('[data-update=check]');
  await wait(150);
  check('a newer release is offered, in settings and the header', /0\.2\.0 is available/.test(await q(`document.querySelector('.update-status').innerText`))
    && /More themes/.test(await q(`document.querySelector('.update-status').innerText`)) && await q(`!document.querySelector('#update-button').hidden`));
  await click('[data-update=install]');
  await wait(150);
  check('installing reports progress, then offers a restart', await q(`!!document.querySelector('[data-update=restart]')`) && /restart to update/.test(await q(`document.querySelector('#update-button').textContent`)));
  await click('[data-update=restart]');
  await wait(100);
  check('restarting with running chats asks first', /Restart AI Workbench\?/.test(await q(`document.querySelector('dialog[open]:last-of-type')?.innerText ?? ''`)) || /Restart AI Workbench\?/.test(await q(`[...document.querySelectorAll('dialog[open]')].map(d => d.innerText).join(' ')`)));
  await page.eval(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('[type=submit]').click();`);
  await wait(100);
  check('confirming restarts the app', (await calls('plugin:process|restart')).length === 1);
  await page.eval(`document.querySelectorAll('dialog[open]').forEach(d => d.close());`);
  await wait(100);
  await page.eval(`${pane(codex)}.querySelector('[data-action=pane-menu]').click();`);
  await page.eval(`document.querySelector('#menu [data-menu-item="2"]').click();`);
  await wait(250);
  const restarted = (await calls('terminal_start')).at(-1).request;
  check('extra options from the settings are passed to the CLI', JSON.stringify(restarted.extraArgs) === JSON.stringify(['--approve-for-me', '-c', 'model_reasoning_effort=max']), restarted.extraArgs);

  // 13. Close and reopen resumes the same conversation
  const claudeSession = (await saved()).chats.find(c => c.id === claude).sessionId;
  await page.eval(`${pane(claude)}.querySelector('[data-action=close]').click();`);
  await wait(100);
  check('closing a pane keeps the chat in the sidebar', !(await q(`!!${pane(claude)}`)) && await q(`!!document.querySelector('.chat-row[data-id="${claude}"]')`));
  await page.eval(`document.querySelector('.chat-row[data-id="${claude}"]').click();`);
  await wait(250);
  check('reopening uses the same session ID', (await calls('terminal_start')).at(-1).request.sessionId === claudeSession);

  // 14. Exit, resume, new conversation
  await page.eval(`${lastTerm('claude')}.send({ type: 'exit', code: 1 });`);
  await wait(100);
  check('exit shows a resume bar', /stopped \(exit code 1\)/.test(await q(`${pane(claude)}.querySelector('.pane-overlay').innerText`)));
  await page.eval(`${pane(claude)}.querySelector('[data-action="new-conversation"]').click();`);
  await wait(150);
  check('new conversation gets a new session ID', (await calls('terminal_start')).at(-1).request.sessionId !== claudeSession);

  // 15. Rename and delete
  await page.eval(`${pane(claude)}.querySelector('[data-action=pane-menu]').click();`);
  await page.eval(`document.querySelector('#menu [data-menu-item="0"]').click();`);
  await wait(50);
  await page.eval(`document.querySelector('dialog [name=title]').value = 'Renamed chat'; document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('rename updates tab, sidebar and pane', await q(`${pane(claude)}.querySelector('.pane-title').textContent === 'Renamed chat' && document.querySelector('#tabs').innerText.includes('Renamed chat')`));
  await page.eval(`${pane(claude)}.querySelector('[data-action=pane-menu]').click();`);
  await page.eval(`document.querySelector('#menu [data-menu-item="3"]').click();`);
  await wait(50);
  check('delete explains the history is kept', /stays in Claude Code’s own history/.test(await q(`document.querySelector('dialog').innerText`)));
  await page.eval(`document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  check('deleted chat is gone', (await saved()).chats.every(c => c.id !== claude));

  // 16. Failure
  await page.eval(`__AIW_TEST__.fail.agy = "Antigravity CLI isn't installed, or isn't on your PATH.";`);
  await newChat('agy');
  check('a CLI that cannot start explains why', await q(`(() => { const o = [...document.querySelectorAll('.pane-overlay.failed')].at(-1); return !!o && o.innerText.includes("isn't installed") && !!o.querySelector('[data-action=tools]'); })()`));

  // 16b. The sidebar's × removes a chat, asking first unless the safeguard is turned off
  const lastAgy = async () => (await saved()).chats.filter(c => c.tool === 'agy').at(-1)?.id;
  const removable = await lastAgy();
  await click(`.row-remove[data-id="${removable}"]`);
  await wait(50);
  check('the sidebar × asks “Are you sure?”', /Are you sure\?/.test(await q(`document.querySelector('dialog[open]')?.innerText ?? ''`)));
  await page.eval(`document.querySelector('dialog[open] [data-dismiss]').click();`);
  await wait(100);
  check('cancelling keeps the chat', (await saved()).chats.some(c => c.id === removable));
  await click(`.row-remove[data-id="${removable}"]`);
  await wait(50);
  await page.eval(`document.querySelector('dialog[open] [type=submit]').click();`);
  await wait(100);
  check('confirming removes the chat from the sidebar', !(await saved()).chats.some(c => c.id === removable) && !(await q(`!!document.querySelector('.chat-row[data-id="${removable}"]')`)));
  await newChat('agy');
  const unguarded = await lastAgy();
  await click('[data-action=settings]');
  await wait(100);
  await setField('confirmRemove', false);
  await page.eval(`document.querySelector('dialog [type=submit]').click();`);
  await wait(100);
  await click(`.row-remove[data-id="${unguarded}"]`);
  await wait(100);
  check('with the safeguard off, × removes at once', !(await q(`!!document.querySelector('dialog[open]')`)) && !(await saved()).chats.some(c => c.id === unguarded));

  // 17. Reload restores every running chat, on every page, and pins
  await page.eval(`${pane(codex)}.querySelector('[data-action=pin]').click();`);
  await wait(100);
  const running = (await saved());
  const runningCount = Object.values(running.pages).reduce((n, p) => n + p.open.length, 0) + running.pinned.filter(k => k.startsWith('chat:')).length;
  await page.eval(`__AIW_TEST__.fail = {}; location.reload();`);
  await wait(2200);
  const afterReload = (await calls('terminal_start')).map(a => a.request);
  check('reload restarts every running chat once', afterReload.length === runningCount, { started: afterReload.length, runningCount });
  check('codex resumes its saved session and stays pinned', afterReload.find(r => r.tool === 'codex')?.sessionId === running.chats.find(c => c.id === codex).sessionId && await q(`${pane(codex)}.parentElement.id`) === 'dock');
  check('reload returns to the same page', (await saved()).page === running.page);

  // 18. Remove a project
  await page.eval(`document.querySelector('[data-action=project-menu][data-id="${site.id}"]').click();`);
  await page.eval(`document.querySelector('#menu [data-menu-item="2"]').click();`);
  await wait(50);
  await page.eval(`document.querySelector('dialog [type=submit]').click();`);
  await wait(150);
  check('removing a project removes its page and chats', !(await saved()).pages[site.id] && (await saved()).chats.every(c => c.projectId !== site.id));

  // 19. Upgrades
  await page.eval(`localStorage.clear(); localStorage.setItem('ai-workbench.workspace.v3', JSON.stringify({ projects: [{ id: 'p1', name: 'One', path: '/work/one' }, { id: 'p2', name: 'Two', path: '/work/two' }], chats: [{ id: 'a', tool: 'claude', projectId: 'p1', title: 'A', sessionId: '0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }, { id: 'b', tool: 'shell', projectId: 'p2', title: 'B', sessionId: null }], open: ['a', 'b'], active: 'b', layout: 'columns', theme: 'terminal' })); location.reload();`);
  await wait(1500);
  const v3 = await saved();
  check('version 3 workspaces become pages and keep running chats', v3.page === 'p2' && JSON.stringify(v3.pages.p1.open) === '["a"]' && v3.pages.p1.layout === 'columns' && (await calls('terminal_start')).length === 2, v3?.pages);
  await page.eval(`localStorage.clear(); localStorage.setItem('ai-workbench.sessions.v2', JSON.stringify({ projects: [{ id: 'project-default', name: 'AI Interface', path: '/home/tester/AI Interface' }], sessions: [{ id: 'session-0', provider: 'Codex', projectId: 'project-default', title: 'New chat', files: [], messages: [] }, { id: 'session-1', provider: 'Claude', projectId: 'project-default', title: 'Layout review', files: [], messages: [] }], open: ['session-0', 'session-1'], active: 'session-0', layout: 'grid', theme: 'terminal' })); location.reload();`);
  await wait(1200);
  check('version 2 data migrates without starting anything', await q(`document.querySelectorAll('.chat-row').length`) === 1 && (await calls('terminal_start')).length === 0);
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

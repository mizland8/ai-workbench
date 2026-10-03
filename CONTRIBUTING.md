# Contributing

Thanks for helping. AI Workbench aims to stay simple: one window, projects linked to folders, and the AI command-line tools people already use. Before adding a feature, ask whether it makes the app easier to use, not just more capable.

## Getting started

```bash
npm install
npm run tauri dev
```

`npm run tauri dev` reloads the interface when you save and rebuilds the Rust side when it changes. On Linux, `npm run install:linux` updates the copy in your app launcher once you're happy with a change.

Run the tests before opening a pull request:

```bash
npm test
npm run test:ui
cd src-tauri && cargo test && cargo clippy --all-targets
```

## How it's put together

The interface is plain JavaScript with no framework; the backend is a small Rust crate.

| File | What it does |
| --- | --- |
| `src/main.js` | The window: pages, sidebar, tabs, panes, the pinned dock, the usage panel, settings and other dialogs |
| `src/terminal.js` | One xterm.js terminal connected to a CLI, including keys and paste |
| `src/agent-status.js` | Reads what an AI is doing (working, waiting for you, idle) from its screen |
| `src/store.js` | The saved workspace: projects, chats, pages, pins and settings, and upgrades from older versions |
| `src/usage.js` | Adds usage up into today and this week, and formats it |
| `src/backend.js` | Calls into the Rust side; does nothing in a plain browser |
| `src-tauri/src/terminals.rs` | Starts each CLI in a pseudo-terminal and streams it to the window |
| `src-tauri/src/tools.rs` | The supported CLIs: finding them, versions, sign-in, install commands |
| `src-tauri/src/sessions.rs` | Where each CLI saves conversations, so chats resume the right one |
| `src-tauri/src/env.rs` | The environment CLIs run in, read from the user's login shell |
| `src-tauri/src/usage.rs` | Reads each CLI's usage records and combines them with subscription allowances |
| `src-tauri/src/subscriptions.rs` | Reads live Claude and Codex allowances, with login-aware caching, backoff and bounded requests |
| `e2e/` | Interface tests: the built app in headless Chrome with a fake backend (`mock.js`) |

## Adding a CLI

1. **`tools.rs`:** add it to `Tool`, with its name, login arguments, install command, docs link, and a sign-in check if the CLI has one.
2. **`terminals.rs`:** in `plan`, say how a chat starts and resumes. If the CLI accepts a session ID chosen up front, use that. Otherwise start it plainly and discover the session afterwards (`sessions.rs`).
3. **`sessions.rs`:** add a way to tell whether a saved conversation exists, or to find a new one in a folder.
4. **`src/store.js` and `src/tools.js`:** add it to `AI_TOOLS`, give it a name, tag, and colour, and add it to `chosenSessionTools` if it takes a session ID.
5. **`src/agent-status.js`:** add the text its screen shows when it asks for approval. Check that its "working" hint is covered.
6. **`usage.rs`:** read its usage records, if it keeps any, into the same quarter-hour buckets.
7. Add tests: a real screen of each state in `test/agent-status.test.js`, and session lookups in `sessions.rs`.

## Testing on Windows and macOS

The automatic tests can't open the app, so new releases need a quick check by hand on each system. Use a project folder whose path contains a space.

1. **AI tools:** every installed CLI shows up with its version. Install a missing one from the dialog, and sign in to one.
2. **Folders:** start each AI in the project. Its trust prompt or status line shows the project folder.
3. **Typing:** Shift+Enter adds a line, Ctrl+C copies a selection and interrupts otherwise, and Ctrl+V pastes text. On Windows, also check that Ctrl+V with an image on the clipboard reaches the CLI.
4. **Resume:** send a message, close the chat, and open it again. The conversation comes back for each CLI.
5. **Status:** the dot says working while the AI answers and "needs you" at an approval. A hidden chat that finishes is marked done and sends a notification.
6. **Files:** drop a file onto a chat, and use "+ file". The path is inserted.
7. **Panes:** drag a pane's header onto another pane, and the two swap.
8. **Terminal chat:** it opens PowerShell on Windows, or your login shell on macOS.
9. **Usage:** open AI usage, verify Claude and Codex session/weekly allowances and local reset dates against their CLI displays, then refresh and pin the panel. On macOS, check Claude credentials stored in Keychain. Sign out or switch accounts and confirm old allowances disappear. Antigravity CLI (agy) shows no local usage; its subscription quotas are not connected.
10. **Quit:** close the app, then check Task Manager or Activity Monitor. No `claude`, `codex`, `agy`, `opencode`, or `node` processes from it are left.

Windows is the likeliest to break, because npm installs CLIs there as `.cmd` launchers that run through `cmd.exe`, and installers run through PowerShell. When something fails, include the error shown in the pane in the issue.

## Releasing and updates

Installed copies check `https://github.com/mizland8/ai-workbench/releases/latest/download/latest.json` (Settings → Updates) and install a newer version after checking its signature against the public key in `src-tauri/tauri.conf.json`.

1. Raise the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (they must match, for example `0.2.0`).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The Release workflow builds every system, signs the update packages, and attaches them and `latest.json` to a **draft** release.
4. Publish the draft on GitHub. Installed copies see the update from then on.

The workflow signs with the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the contents of the private key file; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty). Keep a backup of that key: without it, installed copies can't accept updates and would need reinstalling by hand. Local builds don't need the key; only release builds (`--config src-tauri/tauri.release.conf.json`) make update packages.

On Linux only the AppImage replaces itself. A copy built with `scripts/install-linux.sh` or installed from a .deb or .rpm is told about the update and links to the release; rebuild or reinstall it the same way.

## Reporting problems

Say which system you're on, the AI Workbench version, and the versions shown in the AI tools dialog.

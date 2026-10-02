# AI Workbench

A simple desktop workspace for AI coding agents. Run Claude Code, Codex, Gemini CLI and OpenCode side by side, each working in your project folder.

## Download

Get the installer for your system from the [latest release](../../releases/latest).

- **macOS:** the `.dmg` for your Mac (Apple silicon or Intel). The builds aren't notarized yet, so macOS blocks the first launch: open **System Settings › Privacy & Security** and choose **Open Anyway**.
- **Windows:** the `.msi` or `-setup.exe`. SmartScreen may say the app is unrecognized: choose **More info › Run anyway**. The app uses the WebView2 runtime that comes with Windows 10 and 11.
- **Linux:** the `.deb` (Debian, Ubuntu), the `.rpm` (Fedora, openSUSE), or the `.AppImage` (make it executable with `chmod +x`, then run it).

## Connect your AI tools

AI Workbench runs the AI command-line tools already installed on the computer; it doesn't bundle them. Open **AI tools** in the header to see what it found. From there you can install a missing tool, sign in, or point the app at a copy in another location. Each tool keeps its own sign-in and conversation history, the same as in a terminal.

| Tool | Install (macOS, Linux) | Sign in |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Gemini CLI | `npm install -g @google/gemini-cli` | Asked on first start. Google sign-in is refused for personal accounts; choose a Gemini API key. |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | Optional: works with OpenCode's free models; `opencode providers login` adds your own provider. |

On Windows the dialog shows the PowerShell or npm equivalents. The app reads your login shell's environment (PATH, API keys, version managers), so tools are found even when the app starts from a desktop launcher instead of a terminal.

## Workspace

- **Projects.** Add a project folder, or drop one on the sidebar. Chats in a project run inside its folder; individual chats run in your home folder.
- **Chats.** Each chat is a live terminal running the AI you picked, or a plain Terminal. Close a chat at any time; opening it again resumes the same conversation. Use "Start a new conversation" from the chat's menu to begin again.
- **Status.** Each chat's dot, tab, and pane header show whether its AI is working, needs you (a question or approval), done, or ready. A chat that finished while you were looking elsewhere stays marked done until you open it. The status bar links to chats that need you or are done. When the window isn't in front or the chat is hidden, you also get a desktop notification. The state is read from each CLI's own screen, for example "esc to interrupt" while it works.
- **Layout.** Choose grid, columns, or focus. Drag a pane's header onto another pane to swap them.
- **Keys.** Shift+Enter adds a new line. Ctrl+C copies selected text and otherwise interrupts, Ctrl+Shift+C always copies, and Ctrl+V pastes text (an image on the clipboard is passed to the CLI). Ctrl+Tab moves between chats.
- **Files.** Drop files onto a chat, or use "+ file", to insert their paths into the prompt.
- **Themes.** Terminal, PowerShell, or Amber. Fonts are local system monospace fonts; no remote fonts are loaded.

## Where things are stored

- Projects, chats, layout, and theme are kept in the app's local webview storage. Browser previews and the desktop app have separate storage.
- Conversations are kept by each CLI in its own history (for example `~/.claude` or `~/.codex`). Claude Code and Gemini CLI start each chat under a session ID chosen by the app. For Codex and OpenCode, the app finds the conversation they created in the chat's folder once the first message is sent.
- Removing a chat or project never deletes files or a CLI's history.
- Upgrading from the previous version keeps projects and named chats. The old data stays in storage, under its own key.

## Build from source

You need [Node.js](https://nodejs.org) 20.19 or newer, [Rust](https://rustup.rs), and Tauri's [system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (WebKitGTK packages on Linux, the Xcode command line tools on macOS, the Microsoft C++ build tools on Windows).

```bash
npm install
npm run tauri dev      # run with live reload
npm run tauri build    # build installers into src-tauri/target/release/bundle/
```

A plain `cargo build --release` still loads the interface from the dev server; `tauri build` turns on the feature that embeds it.

## Tests

```bash
npm test               # workspace storage and status detection
npm run test:ui        # the interface in headless Chrome, with a fake backend
cd src-tauri && cargo test
```

`npm run test:ui` needs Chrome or Chromium; set `CHROME_PATH` if it isn't found. The backend also has tests that start the real CLIs installed on your computer (Linux and macOS): `cargo test -- --ignored --nocapture`. They send one short message each to Claude Code, Codex, and OpenCode, check that the conversation resumes, then delete the test conversations. Claude Code keeps a trust entry for each temporary folder.

Every pull request and push to `main` runs the tests on Linux, macOS, and Windows.

## Releasing

Set the new version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, then push a tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds installers for macOS, Windows, and Linux and attaches them to a draft release. Check it, then publish it.

## Current limits

- The tests run on macOS and Windows on every push, and releases include installers for them, but the app hasn't yet been tried by hand on those systems. [CONTRIBUTING.md](CONTRIBUTING.md) lists what to check.
- The status of each chat is read from the CLI's screen, so a CLI update that rewords its hints may need a pattern update in `src/agent-status.js`.
- Codex and OpenCode conversations are matched to chats by folder and start time. Two new chats with the same tool, started in the same folder before either sends a message, could swap conversations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

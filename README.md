# AI Workbench

A simple desktop workspace for AI coding agents. Run Claude Code, Codex, Antigravity CLI (agy) and OpenCode side by side, each working in your project folder.

## Download

Get the installer for your system from the [latest release](../../releases/latest).

- **macOS:** the `.dmg` for Apple silicon Macs (M1 and newer; Intel Macs are no longer built). The builds aren't notarized yet, so macOS blocks the first launch: open **System Settings › Privacy & Security** and choose **Open Anyway**.
- **Windows:** the `.msi` or `-setup.exe`. SmartScreen may say the app is unrecognized: choose **More info › Run anyway**. The app uses the WebView2 runtime that comes with Windows 10 and 11.
- **Linux:** the `.deb` (Debian, Ubuntu), the `.rpm` (Fedora, openSUSE), or the `.AppImage` (make it executable with `chmod +x`, then run it). On other distributions, such as Arch, you can also use the plain `ai-workbench_<version>_linux_x86_64` program, which uses the system's WebKitGTK (the `webkit2gtk-4.1` package): put it in a folder you own, such as `~/.local/bin`, and make it executable.

From then on the app updates itself: when a new release is out, it offers it under **Settings › Updates** and installs it when you choose to. Updates to a .deb or .rpm ask for your password, because the package manager installs them.

## Connect your AI tools

AI Workbench runs the AI command-line tools already installed on the computer; it doesn't bundle them. Open **AI tools** in the header to see what it found. From there you can install a missing tool, sign in, or point the app at a copy in another location. Each tool keeps its own sign-in and conversation history, the same as in a terminal.

| Tool | Install (macOS, Linux) | Sign in |
| --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| Codex | `npm install -g @openai/codex` | `codex login` |
| Antigravity CLI (`agy`) | `curl -fsSL --compressed https://antigravity.google/cli/install.sh \| bash` | Google sign-in in the browser on first start. Replaces Gemini CLI. |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | Optional: works with OpenCode's free models; `opencode providers login` adds your own provider. |

On Windows the dialog shows the PowerShell or npm equivalents. The app reads your login shell's environment (PATH, API keys, version managers), so tools are found even when the app starts from a desktop launcher instead of a terminal.

## Local models

A chat can also use a model you run yourself in LM Studio, Ollama, or another server with the same OpenAI-compatible API, on this computer or another one on your network. Start a chat with **Local model** and pick the model from the list the server offers. The chat runs in OpenCode (install it from **AI tools**). OpenCode gets the server and model for that chat only: your own OpenCode settings and sign-ins aren't changed, and the chat's prompts and replies go to your model server, not to a cloud AI service.

- **On this computer:** start LM Studio's server or Ollama. AI Workbench finds them on their usual ports (1234 and 11434).
- **On another computer:** enter its address and port under **Settings › Local models**, such as `192.168.1.20:1234` for LM Studio or `192.168.1.20:11434` for Ollama. That server has to accept connections from the network; for Ollama, start it with `OLLAMA_HOST=0.0.0.0`.
- Each local-model chat keeps the server and model it started with, and resumes its conversation like any other chat.
- Coding agents send long prompts that describe their tools. If the model doesn't use them, give it a longer context, 16k to 32k tokens, in LM Studio or Ollama.

## Workspace

- **Projects are pages.** Add a project folder, or drop one on the sidebar. Each project has its own page, with its own open chats and layout, and the sidebar switches between pages. Chats on other pages keep running. Chats without a project share the Individual chats page and run in your home folder.
- **Chats.** Each chat is a live terminal running the AI you picked, or a plain Terminal. Close a chat at any time; opening it again resumes the same conversation. Use "Start a new conversation" from the chat's menu to begin again. The × next to a chat in the sidebar removes it from the list (its conversation stays in the CLI's history); by default it asks "Are you sure?" first, which you can turn off under Settings → Safeguards.
- **Pinning.** Pin a chat to keep it in a column on the right on every page; its header names the AI, the chat and the project. Drag the column's edge to resize it. The usage summary can be pinned there too.
- **Status.** Each chat's dot, tab and header show what its AI is doing: moving dots while it works, a flash when it needs you (a question or approval), and a flash when it's done while you were elsewhere, until you look. The status bar links to those chats, and you get a desktop notification when the window isn't in front or the chat is hidden. The state is read from each CLI's own screen, for example "esc to interrupt" while it works.
- **Usage.** **AI usage** in the top right shows Claude and Codex subscription allowances at a glance. Open it for plan names, allowance meters, reset countdowns and times, plus each tool's tokens today and this week. Pin it to the side to keep it visible. Allowances come from the current account; token totals come from each tool's records on this computer, with cached context counted separately. Existing CLI sign-ins are reused, including Claude's macOS Keychain login. If a check fails, the panel explains why and labels any last-known allowances. When a Claude or Codex allowance you've used resets, you get a desktop notification (Settings → Alerts). Checks are cached, and refresh respects provider backoff.
- **Settings.** Theme (about 75, grouped like VS Code's picker: popular dark themes such as Dark Modern, One Dark Pro, Dracula, Tokyo Night, Catppuccin, Nord and Gruvbox; light themes such as Light Modern, GitHub Light and Solarized Light; high-contrast; and retro looks such as Green Phosphor and MS-DOS), font (the system's monospace font or one of 29 bundled coding fonts such as JetBrains Mono, Fira Code, Cascadia Code and Geist Mono), terminal text size, flashing, notifications (approvals, finished replies and usage resets), update checks (Settings → Updates installs new releases from GitHub), reopening chats at startup, the "Are you sure?" safeguard for removing chats, extra command-line options for each AI tool, and the model server for local models. The bundled fonts ship inside the app (open-source licenses, from Fontsource), so they look the same on every computer; no remote fonts are loaded.
- **Layout.** Choose grid, columns, or focus for each page. Drag a pane's header onto another pane to swap them.
- **Keys.** Shift+Enter adds a new line. Ctrl+C copies selected text and otherwise interrupts, Ctrl+Shift+C always copies, and Ctrl+V pastes text (an image on the clipboard is passed to the CLI). Ctrl+Tab moves between chats on the page.
- **Files.** Drop files onto a chat, or use "+ file" (or "Insert file paths…" in the chat's menu), to insert their paths into the prompt.

## Where things are stored

- Projects, chats, layout, and theme are kept in the app's local webview storage. Browser previews and the desktop app have separate storage.
- Conversations are kept by each CLI in its own history (for example `~/.claude` or `~/.codex`). Claude Code starts each chat under a session ID chosen by the app. For Codex, Antigravity CLI and OpenCode, the app finds the conversation they created in the chat's folder once the first message is sent. Chats made with Gemini CLI before the switch to Antigravity CLI stay in the list and start a new Antigravity conversation when opened.
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

On Linux you can install your own build for your user, without root:

```bash
npm run install:linux                      # build, then install or update
bash scripts/install-linux.sh --uninstall  # remove it again
```

This puts the app in `~/.local/bin` with a launcher entry and icons, so it opens from your app launcher like any other app. Run it again after making changes to update the installed copy. It also takes updates from the releases like a downloaded copy: installing one replaces your build with the release's plain Linux program.

## Tests

```bash
npm test               # workspace storage and status detection
npm run test:ui        # the interface in headless Chrome, with a fake backend
cd src-tauri && cargo test
```

`npm run test:ui` needs Chrome or Chromium; set `CHROME_PATH` if it isn't found. The backend also has tests that start the real CLIs installed on your computer (Linux and macOS): `cargo test -- --ignored --nocapture`. They send one short message each to Claude Code, Codex, and OpenCode, check that the conversation resumes, then delete the test conversations. Claude Code keeps a trust entry for each temporary folder.

Every pull request and push to `main` runs the tests on Linux, macOS, and Windows.

## Releasing

Set the new version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`, then push a tag whose message says what changed:

```bash
git tag -a v0.2.1 -m "What changed, in a line or two"
git push origin main v0.2.1
```

The release workflow builds installers for macOS, Windows, and Linux and attaches them to a draft release. Check it, then publish it. Installed copies offer the update from then on, showing the tag's message as its notes. [CONTRIBUTING.md](CONTRIBUTING.md#releasing-and-updates) has the details, including the signing key.

## Current limits

- The tests run on macOS and Windows on every push, and releases include installers for them, but the app hasn't yet been tried by hand on those systems. [CONTRIBUTING.md](CONTRIBUTING.md) lists what to check.
- The status of each chat is read from the CLI's screen, so a CLI update that rewords its hints may need a pattern update in `src/agent-status.js`.
- Codex and OpenCode conversations are matched to chats by folder and start time. Two new chats with the same tool, started in the same folder before either sends a message, could swap conversations.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

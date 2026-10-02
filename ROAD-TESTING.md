# AI Workbench road testing

This checkout is ready for Windows and macOS testing. Linux native operation and automated checks have passed; Windows and macOS native behavior still need verification.

## Build on your test machine

Install Git, Node.js (20.19 or newer) and stable Rust, plus the Tauri build prerequisites for your operating system:
https://v2.tauri.app/start/prerequisites/

On Windows, install Visual Studio C++ Build Tools and WebView2. On macOS, install Xcode command-line tools. From this project folder:

```sh
npm ci
npm test
npm run tauri dev
```

To create a native installer:

```sh
npm run tauri build
```

Install and sign in to your preferred AI command-line tools separately. Their accounts, histories and credentials are not included in this project archive. The Linux executable cannot run on Windows or macOS.

## Check the desktop app

Follow the Windows/macOS checklist in CONTRIBUTING.md. Include a project path with spaces, conversation resume, clipboard images on Windows, notifications, and cleanup of child processes when quitting.

Claude and Codex show live subscription allowances and session/weekly reset times when their account reports them. Gemini shows local CLI token totals; Antigravity (AGY) subscription quotas are not connected.

Unsigned test installers may require the operating system's allow/open-anyway flow. Test builds are not a verified production release.

## Carry or restore the source

The portable package contains a source ZIP and a Git bundle. Extract the ZIP to build, or preserve history with:

```sh
git clone ai-workbench.git.bundle ai-workbench
```

Report the operating system, CPU architecture, app commit, CLI versions, and exact failing step. Do not attach account tokens or private conversations.

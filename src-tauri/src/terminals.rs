//! Live terminals: each chat pane runs its CLI in a pseudo-terminal and streams it to xterm.js.

use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

type Live = Arc<Mutex<HashMap<u32, Arc<Terminal>>>>;

use crate::env;
use crate::sessions;
use crate::tools::{self, Tool};

#[derive(Default)]
pub struct Terminals {
    next_id: AtomicU32,
    live: Live,
    /// Session IDs found for Codex/OpenCode chats during this run, so two chats never claim the same one.
    claimed: Arc<Mutex<HashSet<String>>>,
}

struct Terminal {
    input: Sender<Vec<u8>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg_attr(not(unix), allow(dead_code))]
    pid: Option<u32>,
    exited: AtomicBool,
}

impl Terminals {
    fn get(&self, id: u32) -> Option<Arc<Terminal>> {
        self.live.lock().unwrap().get(&id).cloned()
    }

    pub fn stop_all(&self, escalate: bool) {
        let all: Vec<_> = self.live.lock().unwrap().drain().map(|(_, t)| t).collect();
        for terminal in all {
            terminal.stop(escalate);
        }
    }
}

impl Terminal {
    fn stop(self: &Arc<Self>, escalate: bool) {
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            // The CLI leads its own process group (portable-pty calls setsid), so the hangup also
            // reaches wrapper scripts and anything the CLI started.
            unsafe { libc::killpg(pid as i32, libc::SIGHUP) };
            if escalate {
                let this = Arc::clone(self);
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(3));
                    if !this.exited.load(Ordering::SeqCst) {
                        unsafe { libc::killpg(pid as i32, libc::SIGKILL) };
                    }
                });
            }
            return;
        }
        let _ = escalate;
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StartKind {
    /// A conversation with an AI CLI.
    Chat,
    /// The CLI's sign-in flow.
    Login,
    /// The vendor's installer.
    Install,
    /// The user's own shell.
    Shell,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    kind: StartKind,
    tool: Option<Tool>,
    session_id: Option<String>,
    /// Session IDs other chats already use.
    #[serde(default)]
    known_sessions: Vec<String>,
    cwd: Option<String>,
    tool_path: Option<String>,
    /// Extra command-line options for the CLI, from the settings.
    #[serde(default)]
    extra_args: Vec<String>,
    cols: u16,
    rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    id: u32,
    session_id: Option<String>,
    resumed: bool,
    command: String,
}

struct Plan {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    session_id: Option<String>,
    resumed: bool,
    /// Look for the conversation this CLI creates (Codex, Antigravity CLI and OpenCode pick their own IDs).
    discover: Option<Tool>,
    notice: Option<String>,
}

fn plan(request: &StartRequest) -> Result<Plan, String> {
    let cwd = request.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(PathBuf::from).unwrap_or_else(env::home_dir);
    if !cwd.is_dir() {
        return Err(format!("Folder not found: {}", cwd.display()));
    }
    let tool = || request.tool.ok_or_else(|| "No AI tool was chosen.".to_string());
    let mut plan = Plan { program: PathBuf::new(), args: Vec::new(), cwd, session_id: None, resumed: false, discover: None, notice: None };
    match request.kind {
        StartKind::Shell => (plan.program, plan.args) = env::user_shell(),
        StartKind::Install => (plan.program, plan.args) = env::shell_command(tool()?.install_command()),
        StartKind::Login => {
            let tool = tool()?;
            plan.program = tools::resolve(tool, request.tool_path.as_deref())?;
            plan.args = tool.login_args().iter().map(|a| a.to_string()).collect();
        }
        StartKind::Chat => {
            let tool = tool()?;
            plan.program = tools::resolve(tool, request.tool_path.as_deref())?;
            let known = request.session_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(String::from);
            match tool {
                Tool::Claude => {
                    let id = known.filter(|id| sessions::is_uuid(id)).ok_or("This chat has no session ID.")?;
                    let saved = sessions::claude_has_session(&id);
                    plan.args = vec![if saved { "--resume" } else { "--session-id" }.into(), id.clone()];
                    plan.session_id = Some(id);
                    plan.resumed = saved;
                }
                // Codex's shared background server can lag behind an updated CLI ("Cannot use the
                // background server"); each pane runs its own so closing it really stops Codex.
                Tool::Codex => match known {
                    Some(id) if sessions::codex_has_session(&id) => {
                        plan.args = vec!["resume".into(), "--no-daemon".into(), id.clone()];
                        plan.session_id = Some(id);
                        plan.resumed = true;
                    }
                    previous => {
                        if previous.is_some() {
                            plan.notice = Some("The previous Codex conversation wasn't found, so this is a new one.".into());
                        }
                        plan.args = vec!["--no-daemon".into()];
                        plan.discover = Some(Tool::Codex);
                    }
                },
                Tool::Agy => match known {
                    Some(id) if sessions::agy_has_session(&id) => {
                        plan.args = vec!["--conversation".into(), id.clone()];
                        plan.session_id = Some(id);
                        plan.resumed = true;
                    }
                    previous => {
                        if previous.is_some() {
                            plan.notice = Some("The previous Antigravity conversation wasn't found, so this is a new one.".into());
                        }
                        plan.discover = Some(Tool::Agy);
                    }
                },
                Tool::Opencode => match known {
                    Some(id) => {
                        plan.args = vec!["--session".into(), id.clone()];
                        plan.session_id = Some(id);
                        plan.resumed = true;
                    }
                    None => plan.discover = Some(Tool::Opencode),
                },
            }
            plan.args.extend(request.extra_args.iter().filter(|a| !a.is_empty()).cloned());
        }
    }
    Ok(plan)
}

fn command_for(program: &Path, args: &[String]) -> CommandBuilder {
    // npm installs CLIs on Windows as .cmd scripts, which only cmd.exe can run.
    #[cfg(windows)]
    if program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(["/d", "/c"]);
        cmd.arg(program);
        cmd.args(args);
        return cmd;
    }
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd
}

fn display_command(program: &Path, args: &[String]) -> String {
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    std::iter::once(name).chain(args.iter().cloned()).collect::<Vec<_>>().join(" ")
}

fn send_event(events: &Channel<InvokeResponseBody>, event: serde_json::Value) {
    let _ = events.send(InvokeResponseBody::Json(event.to_string()));
}

fn start(terminals: &Terminals, request: StartRequest, events: Channel<InvokeResponseBody>) -> Result<Started, String> {
    let plan = plan(&request)?;
    let pty = native_pty_system()
        .openpty(PtySize { rows: request.rows.max(2), cols: request.cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    let mut cmd = command_for(&plan.program, &plan.args);
    cmd.cwd(&plan.cwd);
    cmd.env_clear();
    for (key, value) in env::terminal_env() {
        cmd.env(key, value);
    }

    let started_at = SystemTime::now();
    let mut child = pty.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {}: {e}", plan.program.display()))?;
    // Our copy of the terminal's other end must close, or we never see the CLI's output end.
    drop(pty.slave);
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pty.master.take_writer().map_err(|e| e.to_string())?;

    let (input, typed) = mpsc::channel::<Vec<u8>>();
    let terminal = Arc::new(Terminal {
        input,
        master: Mutex::new(pty.master),
        killer: Mutex::new(child.clone_killer()),
        pid: child.process_id(),
        exited: AtomicBool::new(false),
    });
    let id = terminals.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    terminals.live.lock().unwrap().insert(id, Arc::clone(&terminal));

    if let Some(notice) = &plan.notice {
        send_event(&events, json!({ "type": "notice", "text": notice }));
    }

    // Typing goes through its own thread: a CLI that isn't reading must not block the UI.
    thread::spawn(move || {
        for chunk in typed {
            if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let output = events.clone();
    thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if output.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });

    {
        let live = Arc::clone(&terminals.live);
        let terminal = Arc::clone(&terminal);
        let events = events.clone();
        thread::spawn(move || {
            let status = child.wait();
            terminal.exited.store(true, Ordering::SeqCst);
            // Let the reader pass on the CLI's last output before reporting the exit.
            thread::sleep(Duration::from_millis(150));
            let code = status.ok().map(|s| s.exit_code());
            send_event(&events, json!({ "type": "exit", "code": code }));
            live.lock().unwrap().remove(&id);
        });
    }

    if let Some(tool) = plan.discover {
        let claimed_here = Arc::clone(&terminals.claimed);
        let terminal = Arc::clone(&terminal);
        let events = events.clone();
        let cwd = plan.cwd.clone();
        let program = plan.program.clone();
        let known: HashSet<String> = request.known_sessions.into_iter().collect();
        thread::spawn(move || {
            // The conversation is saved once the user sends something, which may be much later.
            let mut wait = Duration::from_secs(2);
            loop {
                let ended = terminal.exited.load(Ordering::SeqCst);
                let claimed: HashSet<String> = claimed_here.lock().unwrap().union(&known).cloned().collect();
                let found = match tool {
                    Tool::Codex => sessions::find_new_codex_session(&cwd, started_at, &claimed),
                    Tool::Agy => sessions::find_new_agy_session(&cwd, started_at, &claimed),
                    _ => sessions::find_new_opencode_session(&program, &cwd, started_at, &claimed),
                };
                if let Some(session) = found {
                    if claimed_here.lock().unwrap().insert(session.clone()) {
                        send_event(&events, json!({ "type": "session", "id": session }));
                        break;
                    }
                    continue;
                }
                if ended {
                    break;
                }
                thread::sleep(wait);
                // `opencode session list` starts a process each time, so check less often as time goes on.
                if tool == Tool::Opencode {
                    wait = (wait * 2).min(Duration::from_secs(30));
                }
            }
        });
    }

    Ok(Started { id, session_id: plan.session_id, resumed: plan.resumed, command: display_command(&plan.program, &plan.args) })
}

#[tauri::command]
pub async fn terminal_start(app: AppHandle, request: StartRequest, events: Channel<InvokeResponseBody>) -> Result<Started, String> {
    tauri::async_runtime::spawn_blocking(move || start(&app.state::<Terminals>(), request, events)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn terminal_write(terminals: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let terminal = terminals.get(id).ok_or("This session has ended.")?;
    terminal.input.send(data.into_bytes()).map_err(|_| "This session has ended.".to_string())
}

#[tauri::command]
pub fn terminal_resize(terminals: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    if let Some(terminal) = terminals.get(id) {
        let size = PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 };
        terminal.master.lock().unwrap().resize(size).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_stop(terminals: State<'_, Terminals>, id: u32) {
    if let Some(terminal) = terminals.get(id) {
        terminal.stop(true);
    }
}

#[tauri::command]
pub fn terminal_stop_all(terminals: State<'_, Terminals>) {
    terminals.stop_all(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: StartKind, tool: Option<Tool>, session_id: Option<&str>) -> StartRequest {
        StartRequest {
            kind,
            tool,
            session_id: session_id.map(String::from),
            known_sessions: Vec::new(),
            cwd: Some(std::env::temp_dir().display().to_string()),
            // Any existing file works as the CLI here; the plan never runs it.
            tool_path: Some(std::env::current_exe().unwrap().display().to_string()),
            extra_args: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn extra_options_from_settings_are_added() {
        let mut req = request(StartKind::Chat, Some(Tool::Codex), None);
        req.extra_args = vec!["--approve-for-me".into(), "-c".into(), "model_reasoning_effort=max".into()];
        assert_eq!(plan(&req).unwrap().args, ["--no-daemon", "--approve-for-me", "-c", "model_reasoning_effort=max"]);
    }

    #[test]
    fn new_claude_chats_choose_their_session_id() {
        let id = "0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
        let claude = plan(&request(StartKind::Chat, Some(Tool::Claude), Some(id))).unwrap();
        assert_eq!(claude.args, ["--session-id", id]);
        assert!(!claude.resumed);
        assert!(claude.discover.is_none());
        assert!(plan(&request(StartKind::Chat, Some(Tool::Claude), Some("not-a-uuid"))).is_err());
    }

    #[test]
    fn codex_and_opencode_look_for_their_new_session() {
        let codex = plan(&request(StartKind::Chat, Some(Tool::Codex), None)).unwrap();
        assert_eq!(codex.args, ["--no-daemon"]);
        assert_eq!(codex.discover, Some(Tool::Codex));
        let opencode = plan(&request(StartKind::Chat, Some(Tool::Opencode), Some("ses_123"))).unwrap();
        assert_eq!(opencode.args, ["--session", "ses_123"]);
        assert!(opencode.resumed);
    }

    #[test]
    fn new_agy_chats_look_for_their_conversation() {
        let agy = plan(&request(StartKind::Chat, Some(Tool::Agy), None)).unwrap();
        assert!(agy.args.is_empty());
        assert_eq!(agy.discover, Some(Tool::Agy));
        // A Gemini CLI session ID carried over from before isn't an Antigravity conversation.
        let carried = plan(&request(StartKind::Chat, Some(Tool::Agy), Some("not-an-agy-conversation"))).unwrap();
        assert_eq!(carried.discover, Some(Tool::Agy));
        assert!(carried.notice.is_some());
    }

    #[test]
    fn missing_folders_are_reported() {
        let mut req = request(StartKind::Shell, None, None);
        req.cwd = Some("/no/such/folder".into());
        assert_eq!(plan(&req).err().unwrap(), "Folder not found: /no/such/folder");
    }
}

/// Starts the real CLIs installed on this machine. Run with `cargo test -- --ignored --nocapture`.
#[cfg(all(test, unix))]
mod real_cli_tests {
    use super::*;
    use std::sync::mpsc::Receiver;
    use std::time::Instant;

    pub(crate) fn screen_text(bytes: &[u8]) -> String {
        // Drop escape sequences; good enough to see what a TUI drew.
        let text = String::from_utf8_lossy(bytes);
        let mut out = String::new();
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '\x1b' => match chars.next() {
                    Some('[') => {
                        for c in chars.by_ref() {
                            if c.is_ascii_alphabetic() || c == '~' {
                                break;
                            }
                        }
                    }
                    Some(']') => {
                        while let Some(c) = chars.next() {
                            if c == '\x07' {
                                break;
                            } else if c == '\x1b' {
                                chars.next();
                                break;
                            }
                        }
                    }
                    _ => {}
                },
                '\r' => {}
                c if c.is_control() && c != '\n' => {}
                c => out.push(c),
            }
        }
        out.split('\n').map(str::trim_end).filter(|l| !l.trim().is_empty()).collect::<Vec<_>>().join("\n")
    }

    pub(crate) fn collect(events: &Receiver<InvokeResponseBody>, output: &mut Vec<u8>, until: impl Fn(&str) -> bool, timeout: Duration) -> Option<serde_json::Value> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(200)) {
                Ok(InvokeResponseBody::Raw(bytes)) => output.extend(bytes),
                Ok(InvokeResponseBody::Json(json)) => {
                    let event: serde_json::Value = serde_json::from_str(&json).unwrap();
                    if event["type"] != "notice" {
                        return Some(event);
                    }
                }
                Err(_) => {}
            }
            if until(&screen_text(output)) {
                return None;
            }
        }
        None
    }

    pub(crate) fn uuid() -> String {
        std::fs::read_to_string("/proc/sys/kernel/random/uuid").unwrap().trim().to_string()
    }

    #[test]
    #[ignore = "runs the AI CLIs installed on this machine"]
    fn each_cli_starts_in_a_terminal() {
        let terminals = Terminals::default();
        let project = std::env::temp_dir().join(format!("ai-workbench-real-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();
        for tool in Tool::ALL {
            let (tx, rx) = mpsc::channel();
            let events = Channel::new(move |body| { let _ = tx.send(body); Ok(()) });
            let session_id = (tool == Tool::Claude).then(uuid);
            let request = StartRequest { kind: StartKind::Chat, tool: Some(tool), session_id, known_sessions: Vec::new(),
                cwd: Some(project.display().to_string()), tool_path: None, extra_args: Vec::new(), cols: 110, rows: 32 };
            let started = start(&terminals, request, events).unwrap_or_else(|e| panic!("{tool:?} didn't start: {e}"));
            let mut output = Vec::new();
            let early_exit = collect(&rx, &mut output, |screen| screen.lines().count() >= 6, Duration::from_secs(25));
            // Let the first screen settle before reading it.
            let _ = collect(&rx, &mut output, |_| false, Duration::from_secs(2));
            println!("\n===== {} (`{}`) =====\n{}\n", tool.name(), started.command, screen_text(&output));
            assert!(early_exit.is_none(), "{tool:?} exited right away: {early_exit:?}");
            assert!(!output.is_empty(), "{tool:?} printed nothing");
            terminals.get(started.id).expect("still running").stop(true);
            let exit = collect(&rx, &mut output, |_| false, Duration::from_secs(8));
            assert_eq!(exit.as_ref().map(|e| e["type"].clone()), Some("exit".into()), "{tool:?} didn't stop: {exit:?}");
        }
        let _ = std::fs::remove_dir_all(project);
    }

    /// Read until the CLI has drawn nothing new for a moment, so keys reach a screen that is ready.
    fn settle(rx: &Receiver<InvokeResponseBody>, out: &mut Vec<u8>) {
        let deadline = Instant::now() + Duration::from_secs(15);
        let (mut seen, mut changed) = (out.len(), Instant::now());
        while Instant::now() < deadline && changed.elapsed() < Duration::from_millis(1500) {
            if let Ok(InvokeResponseBody::Raw(bytes)) = rx.recv_timeout(Duration::from_millis(100)) {
                out.extend(bytes);
            }
            if out.len() != seen {
                (seen, changed) = (out.len(), Instant::now());
            }
        }
    }

    fn squash(text: &str) -> String {
        text.chars().filter(|c| !c.is_whitespace()).collect()
    }

    fn chat(tool: Tool, session_id: Option<String>, project: &Path) -> StartRequest {
        StartRequest { kind: StartKind::Chat, tool: Some(tool), session_id, known_sessions: Vec::new(),
            cwd: Some(project.display().to_string()), tool_path: None, extra_args: Vec::new(), cols: 110, rows: 32 }
    }

    fn open(terminals: &Terminals, request: StartRequest) -> (Started, Receiver<InvokeResponseBody>) {
        let (tx, rx) = mpsc::channel();
        let events = Channel::new(move |body| { let _ = tx.send(body); Ok(()) });
        (start(terminals, request, events).expect("starts"), rx)
    }

    fn type_text(terminals: &Terminals, id: u32, text: &str) {
        let terminal = terminals.get(id).expect("running");
        terminal.input.send(text.as_bytes().to_vec()).unwrap();
        thread::sleep(Duration::from_millis(600));
        terminal.input.send(b"\r".to_vec()).unwrap();
    }

    fn close(terminals: &Terminals, id: u32, rx: &Receiver<InvokeResponseBody>) {
        terminals.get(id).expect("running").stop(true);
        let exit = collect(rx, &mut Vec::new(), |_| false, Duration::from_secs(8));
        assert_eq!(exit.map(|e| e["type"].clone()), Some("exit".into()));
    }

    #[test]
    #[ignore = "sends one short message to Claude Code"]
    fn claude_conversation_resumes() {
        let terminals = Terminals::default();
        let project = std::env::temp_dir().join(format!("ai-workbench-claude-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();
        let id = uuid();

        let (first, rx) = open(&terminals, chat(Tool::Claude, Some(id.clone()), &project));
        assert!(!first.resumed && first.command.contains("--session-id"), "{}", first.command);
        let mut out = Vec::new();
        let early = collect(&rx, &mut out, |s| squash(s).contains("trustthisfolder"), Duration::from_secs(40));
        assert!(early.is_none(), "Claude Code stopped: {early:?}\n{}", screen_text(&out));
        if squash(&screen_text(&out)).contains("trustthisfolder") {
            // "No, exit" is selected first; once the prompt is ready, move to "Yes, I trust this folder".
            let _ = collect(&rx, &mut out, |_| false, Duration::from_secs(3));
            terminals.get(first.id).unwrap().input.send(b"\x1b[B".to_vec()).unwrap();
            thread::sleep(Duration::from_millis(1000));
            terminals.get(first.id).unwrap().input.send(b"\r".to_vec()).unwrap();
        }
        let prompt_ready = |s: &str| { let s = squash(s); s.contains("Try\"") || s.contains("forshortcuts") };
        collect(&rx, &mut out, prompt_ready, Duration::from_secs(40));
        let _ = collect(&rx, &mut out, |_| false, Duration::from_secs(3));
        assert!(!squash(&screen_text(&out)).contains("Transcriptsavingisoff"), "Claude Code isn't saving: {}", screen_text(&out));
        type_text(&terminals, first.id, "Reply with only the word pong");
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let answered = loop {
            let _ = collect(&rx, &mut out, |_| false, Duration::from_secs(1));
            let saved = sessions::claude_has_session(&id);
            let text = subdirs_with(&id).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
            if saved && text.contains("\"type\":\"assistant\"") { break true; }
            if std::time::Instant::now() > deadline { break false; }
        };
        println!("--- first run ---\n{}", screen_text(&out));
        assert!(answered, "Claude Code never saved an answer");
        close(&terminals, first.id, &rx);

        let (second, rx) = open(&terminals, chat(Tool::Claude, Some(id.clone()), &project));
        assert!(second.resumed && second.command.contains("--resume"), "{}", second.command);
        let mut out = Vec::new();
        collect(&rx, &mut out, |s| squash(s).contains("Replywithonlythewordpong"), Duration::from_secs(40));
        println!("--- resumed ---\n{}", screen_text(&out));
        assert!(squash(&screen_text(&out)).contains("Replywithonlythewordpong"), "history missing after resume");
        close(&terminals, second.id, &rx);

        if let Some(file) = subdirs_with(&id) {
            let _ = std::fs::remove_dir_all(file.parent().unwrap());
        }
        let _ = std::fs::remove_dir_all(project);
    }

    fn subdirs_with(id: &str) -> Option<PathBuf> {
        let projects = env::home_dir().join(".claude/projects");
        std::fs::read_dir(projects).ok()?.flatten().map(|e| e.path().join(format!("{id}.jsonl"))).find(|f| f.is_file())
    }

    #[test]
    #[ignore = "sends one short message to Codex and trusts a temporary folder"]
    fn codex_session_is_found_and_resumes() {
        let terminals = Terminals::default();
        let project = std::env::temp_dir().join(format!("ai-workbench-codex-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();

        let (first, rx) = open(&terminals, chat(Tool::Codex, None, &project));
        assert!(first.command.contains("--no-daemon"), "{}", first.command);
        let mut out = Vec::new();
        // Codex draws its prompt first and the folder-trust question over it; the question takes
        // letters as shortcuts, so answer it before typing anything.
        let early = collect(&rx, &mut out, |s| squash(s).contains("Trustandcontinue"), Duration::from_secs(60));
        assert!(early.is_none(), "Codex stopped: {early:?}\n{}", screen_text(&out));
        assert!(!squash(&screen_text(&out)).contains("Cannotusethebackgroundserver"));
        settle(&rx, &mut out);
        terminals.get(first.id).unwrap().input.send(b"\r".to_vec()).unwrap();
        settle(&rx, &mut out);
        type_text(&terminals, first.id, "Reply with only the word pong");
        let found = collect(&rx, &mut out, |_| false, Duration::from_secs(120)).expect("no session event");
        println!("--- first run ---\n{}\nevent: {found}", screen_text(&out));
        assert_eq!(found["type"], "session", "{found}");
        let session = found["id"].as_str().unwrap().to_string();
        let _ = collect(&rx, &mut out, |s| squash(s).matches("pong").count() >= 2, Duration::from_secs(60));
        close(&terminals, first.id, &rx);

        let (second, rx) = open(&terminals, chat(Tool::Codex, Some(session.clone()), &project));
        assert!(second.resumed && second.command == format!("codex resume --no-daemon {session}"), "{}", second.command);
        let mut out = Vec::new();
        collect(&rx, &mut out, |s| squash(s).contains("Replywithonlythewordpong"), Duration::from_secs(60));
        println!("--- resumed ---\n{}", screen_text(&out));
        assert!(squash(&screen_text(&out)).contains("Replywithonlythewordpong"), "history missing after resume");
        close(&terminals, second.id, &rx);

        let program = tools::resolve(Tool::Codex, None).unwrap();
        let _ = env::run_captured(env::probe_command(&program, &["delete", "--force", &session]), Duration::from_secs(30));
        // Take back the folder-trust entry Codex saved for the temporary folder.
        let config = env::home_dir().join(".codex/config.toml");
        if let Ok(text) = std::fs::read_to_string(&config) {
            let entry = format!("[projects.\"{}\"]\ntrust_level = \"trusted\"\n", project.display());
            if text.contains(&entry) {
                let _ = std::fs::write(&config, text.replace(&format!("\n{entry}"), "").replace(&entry, ""));
            }
        }
        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    #[ignore = "sends one short message to OpenCode's free model"]
    fn opencode_session_is_found_and_resumes() {
        let terminals = Terminals::default();
        let project = std::env::temp_dir().join(format!("ai-workbench-opencode-{}", std::process::id()));
        std::fs::create_dir_all(&project).unwrap();

        let (first, rx) = open(&terminals, chat(Tool::Opencode, None, &project));
        assert!(!first.resumed && first.session_id.is_none());
        let mut out = Vec::new();
        collect(&rx, &mut out, |s| squash(s).contains("Askanything"), Duration::from_secs(40));
        type_text(&terminals, first.id, "Reply with only the word pong");
        let found = collect(&rx, &mut out, |_| false, Duration::from_secs(90)).expect("no session event");
        println!("--- first run ---\n{}\nevent: {found}", screen_text(&out));
        assert_eq!(found["type"], "session", "{found}");
        let session = found["id"].as_str().unwrap().to_string();
        thread::sleep(Duration::from_secs(3));
        close(&terminals, first.id, &rx);

        let (second, rx) = open(&terminals, chat(Tool::Opencode, Some(session.clone()), &project));
        assert!(second.resumed && second.command.contains(&session), "{}", second.command);
        let mut out = Vec::new();
        collect(&rx, &mut out, |s| squash(s).contains("Replywithonlythewordpong"), Duration::from_secs(40));
        println!("--- resumed ---\n{}", screen_text(&out));
        assert!(squash(&screen_text(&out)).contains("Replywithonlythewordpong"), "history missing after resume");
        close(&terminals, second.id, &rx);

        let program = tools::resolve(Tool::Opencode, None).unwrap();
        let _ = env::run_captured(env::probe_command(&program, &["session", "delete", &session]), Duration::from_secs(30));
        let _ = std::fs::remove_dir_all(project);
    }
}

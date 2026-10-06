//! Authenticated loopback bridge. Each live AI terminal gets its own revocable credential.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};

const LIMIT: u64 = 64 * 1024;
const METHODS: [&str; 11] = [
    "list", "read", "send", "tasks", "task", "complete", "fail", "inbox", "ack", "post", "board",
];
/// Methods that take no target chat or task.
const UNTARGETED: [&str; 5] = ["list", "tasks", "inbox", "board", "post"];
const GUIDE: &str = "AI Workbench bridge: every AI chat in your project (Claude Code, Codex, Antigravity CLI, OpenCode) can reach every other one. Run the executable in AI_WORKBENCH_CLI with: bridge list; bridge read <chat>; bridge send <chat> <prompt>; bridge post <note>; bridge board; bridge tasks; bridge task <task-id>; bridge inbox; bridge ack <task-id>; bridge complete <task-id> <summary>; bridge fail <task-id> <reason>. In a POSIX shell use: \"$AI_WORKBENCH_CLI\" bridge list. In PowerShell use: & $env:AI_WORKBENCH_CLI bridge list. Use - in place of the text to read multiline text from stdin. <chat> is an exact unique chat name or ID from bridge list. list shows you, your project and folder, and every AI chat in the project with its tool, lead (parentName), relation to you, status, open tasks and latest board note. Stay in your project: work only in its folder. The tree shows who leads; anyone in the project may message anyone. board and post share short project notes (what you are doing, files you own, what you finished) that survive restarts; post when you start and finish meaningful work. send types a prompt into the existing chat and returns a persistent taskId; it rejects busy, approval, closed or unsettled terminals, and a send is never replayed automatically. Do not retry to answer approvals. A delivery_unknown or dispatching task needs inspection before retrying. read returns terminal text, not a structured answer. Workers report with bridge complete or bridge fail; reports are claims, not verification. A requester gets a short notice once its prompt is free, then reads reports with bridge inbox and acknowledges them with bridge ack. If a command fails, quote its exact error; do not conclude a teammate is unresponsive without checking list, tasks and read. Never answer another AI's approval prompts. Never print or share AI_WORKBENCH_TOKEN.\n";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    chat_id: String,
    terminal_id: u32,
}
#[derive(Deserialize)]
struct Request {
    token: String,
    method: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    prompt: String,
}
struct Inner {
    credentials: Mutex<HashMap<String, Source>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    events: Mutex<Option<Channel<Value>>>,
    active: AtomicUsize,
}
#[derive(Clone)]
pub struct Bridge {
    address: String,
    /// A private folder where sandboxed CLIs drop requests: Codex's sandbox blocks every socket,
    /// even to this computer, but lets commands write to the temporary folder.
    spool: Option<std::path::PathBuf>,
    inner: Arc<Inner>,
}
impl Bridge {
    pub fn new() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let address = listener.local_addr()?.to_string();
        let inner = Arc::new(Inner {
            credentials: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            events: Mutex::new(None),
            active: AtomicUsize::new(0),
        });
        let state = inner.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                if state.active.fetch_add(1, Ordering::SeqCst) >= 16 {
                    state.active.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let state = state.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &state);
                    state.active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        let spool = start_spool(&inner);
        Ok(Self {
            address,
            spool,
            inner,
        })
    }
    /// The bridge address, this terminal's credential, and the spool folder when there is one.
    pub fn register(&self, chat_id: String, terminal_id: u32) -> (String, String, Option<String>) {
        let token = uuid::Uuid::new_v4().to_string();
        self.inner.credentials.lock().unwrap().insert(
            token.clone(),
            Source {
                chat_id,
                terminal_id,
            },
        );
        (
            self.address.clone(),
            token,
            self.spool.as_ref().map(|p| p.to_string_lossy().into_owned()),
        )
    }
    pub fn revoke_all(&self) {
        self.inner.credentials.lock().unwrap().clear();
    }
    pub fn revoke(&self, terminal_id: u32) {
        self.inner
            .credentials
            .lock()
            .unwrap()
            .retain(|_, source| source.terminal_id != terminal_id);
    }
}
fn read_request(stream: impl Read) -> Result<Request, String> {
    let mut line = String::new();
    BufReader::new(stream.take(LIMIT + 1))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > LIMIT || !line.ends_with('\n') {
        return Err("Request is too large or incomplete".into());
    }
    let request: Request = serde_json::from_str(&line).map_err(|_| "Invalid request")?;
    if !METHODS.contains(&request.method.as_str()) {
        return Err("Unknown bridge method".into());
    }
    Ok(request)
}
fn serve(mut stream: TcpStream, inner: &Inner) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let response = answer(read_request(&mut stream), inner);
    writeln!(stream, "{}", response)
}
fn answer(request: Result<Request, String>, inner: &Inner) -> Value {
    let result = (|| -> Result<Value, String> {
        let request = request?;
        let source = inner
            .credentials
            .lock()
            .unwrap()
            .get(&request.token)
            .cloned()
            .ok_or("This AI terminal is no longer connected")?;
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        inner.pending.lock().unwrap().insert(id.clone(), tx);
        let event = json!({ "id": id, "source": source, "method": request.method, "target": request.target, "prompt": request.prompt, "expiresAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() + 14000 });
        let emitted = inner
            .events
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|events| events.send(event).is_ok());
        let response = if emitted {
            rx.recv_timeout(Duration::from_secs(15))
                .map_err(|_| "Workbench did not respond; no handoff was confirmed".to_string())
        } else {
            Err("Workbench is not ready".into())
        };
        inner.pending.lock().unwrap().remove(&id);
        response
    })();
    result.unwrap_or_else(|error| json!({ "error": error }))
}

fn spool_name_ok(stem: &str) -> bool {
    !stem.is_empty() && stem.len() <= 64 && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Watch the spool folder: each `<id>.req` holds one request line, answered in `<id>.resp`.
fn start_spool(inner: &Arc<Inner>) -> Option<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("ai-workbench-bridge-{}", uuid::Uuid::new_v4()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).ok()?;
    let state = inner.clone();
    let watched = dir.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(100));
        let Ok(entries) = std::fs::read_dir(&watched) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(stem) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".req")) else { continue };
            if !spool_name_ok(stem) || state.active.fetch_add(1, Ordering::SeqCst) >= 16 {
                if spool_name_ok(stem) {
                    state.active.fetch_sub(1, Ordering::SeqCst);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
                continue;
            }
            // Claim the request before answering, so the next scan doesn't answer it twice.
            let claimed = path.with_extension("work");
            if std::fs::rename(&path, &claimed).is_err() {
                state.active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let state = state.clone();
            let reply = watched.join(format!("{stem}.resp"));
            std::thread::spawn(move || {
                let request = std::fs::File::open(&claimed).map_err(|e| e.to_string()).and_then(read_request);
                let _ = std::fs::remove_file(&claimed);
                let response = answer(request, &state);
                let partial = reply.with_extension("answer");
                if std::fs::write(&partial, format!("{response}\n")).is_ok() {
                    let _ = std::fs::rename(&partial, &reply);
                }
                state.active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Some(dir)
}
#[tauri::command]
pub fn bridge_listen(bridge: State<'_, Bridge>, events: Channel<Value>) {
    *bridge.inner.events.lock().unwrap() = Some(events);
}
#[tauri::command]
pub fn bridge_respond(bridge: State<'_, Bridge>, id: String, response: Value) {
    if let Some(tx) = bridge.inner.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(response);
    }
}

/// Run before opening a GUI, so any AI's shell can use the same installed executable.
pub fn cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("bridge") {
        return None;
    }
    let result = (|| -> Result<Value, String> {
        if args.get(1).map(String::as_str) == Some("help") {
            return Ok(json!({ "instructions": GUIDE }));
        }
        let method = args.get(1).ok_or("Use bridge help for commands")?;
        if !METHODS.contains(&method.as_str()) {
            return Err("Unknown bridge method. Use bridge help for commands".into());
        }
        // post takes its note right after the method; the others take a target first.
        let (target, mut prompt) = if method == "post" {
            (String::new(), args.get(2..).unwrap_or_default().join(" "))
        } else {
            (args.get(2).cloned().unwrap_or_default(), args.get(3..).unwrap_or_default().join(" "))
        };
        if !UNTARGETED.contains(&method.as_str()) && target.is_empty() {
            return Err("A target chat name or ID is required".into());
        }
        if method == "post" && prompt.trim().is_empty() {
            return Err("Provide the note to post, or - to read it from stdin".into());
        }
        if prompt == "-" {
            prompt.clear();
            std::io::stdin()
                .take(LIMIT)
                .read_to_string(&mut prompt)
                .map_err(|e| e.to_string())?;
        }
        let address: std::net::SocketAddr = std::env::var("AI_WORKBENCH_BRIDGE")
            .map_err(|_| "Run this command inside an AI Workbench chat")?
            .parse()
            .map_err(|_| "Invalid bridge address")?;
        if !address.ip().is_loopback() {
            return Err("Bridge address must be local".into());
        }
        let token = std::env::var("AI_WORKBENCH_TOKEN").map_err(|_| "No bridge credential")?;
        let request =
            json!({ "token": token, "method": method, "target": target, "prompt": prompt })
                .to_string();
        if request.len() as u64 >= LIMIT {
            return Err("Prompt is too large".into());
        }
        let spool = std::env::var_os("AI_WORKBENCH_SPOOL").map(std::path::PathBuf::from);
        let mut stream = match TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
            Ok(stream) => stream,
            Err(error) => return match spool {
                Some(dir) => via_spool(&dir, &request).map_err(|spooled| format!(
                    "Couldn't reach AI Workbench. Direct connection: {error}. Mailbox folder {}: {spooled}. If this AI runs commands in a sandbox, it must allow writing to that folder or local network access.",
                    dir.display()
                )),
                None => Err(format!("Couldn't reach AI Workbench: {error}")),
            },
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        writeln!(stream, "{}", request).map_err(|e| e.to_string())?;
        let mut response = String::new();
        BufReader::new(stream.take(2 * 1024 * 1024))
            .read_line(&mut response)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&response).map_err(|_| "Invalid bridge response".into())
    })();
    print_result(result)
}

/// Leave the request in the spool folder and wait for Workbench's answer next to it.
fn via_spool(dir: &std::path::Path, request: &str) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let partial = dir.join(format!("{id}.part"));
    let ready = dir.join(format!("{id}.req"));
    let reply = dir.join(format!("{id}.resp"));
    std::fs::write(&partial, format!("{request}\n")).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, &ready).map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
        if let Ok(text) = std::fs::read_to_string(&reply) {
            let _ = std::fs::remove_file(&reply);
            return serde_json::from_str(&text).map_err(|_| "Invalid bridge response".into());
        }
    }
    // Withdraw a request Workbench never picked up; one it claimed may still have been delivered.
    if std::fs::remove_file(&ready).is_ok() {
        return Err("Workbench did not pick up the request; nothing was sent".into());
    }
    Err("Workbench did not respond; no handoff was confirmed".into())
}

fn print_result(result: Result<Value, String>) -> Option<i32> {
    match result {
        Ok(response) => {
            println!("{}", response);
            Some(if response.get("error").is_some() {
                1
            } else {
                0
            })
        }
        Err(error) => {
            eprintln!("{}", json!({ "error": error }));
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(address: &str, request: Value) -> Value {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        writeln!(stream, "{}", request).unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        serde_json::from_str(&response).unwrap()
    }
    #[test]
    fn authenticates_routes_and_revokes_live_terminal_credentials() {
        let bridge = Bridge::new().unwrap();
        let (address, token, _) = bridge.register("lead".into(), 42);
        let (tx, rx) = mpsc::channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                tx.send(serde_json::from_str::<Value>(&text).unwrap())
                    .unwrap();
            }
            Ok(())
        });
        *bridge.inner.events.lock().unwrap() = Some(events);
        let state = bridge.inner.clone();
        let responder = std::thread::spawn(move || {
            let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(event["source"]["chatId"], "lead");
            assert_eq!(event["source"]["terminalId"], 42);
            assert_eq!(event["target"], "Animations");
            assert_eq!(event["prompt"], "Fix the grapple\nReview the result");
            state
                .pending
                .lock()
                .unwrap()
                .remove(event["id"].as_str().unwrap())
                .unwrap()
                .send(json!({ "accepted": true }))
                .unwrap();
        });
        assert!(call(&address, json!({ "token": "wrong", "method": "list" }))["error"].is_string());
        let result = call(
            &address,
            json!({ "token": token, "method": "send", "target": "Animations", "prompt": "Fix the grapple\nReview the result" }),
        );
        assert_eq!(result["accepted"], true);
        responder.join().unwrap();
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
        bridge.revoke(42);
        assert!(call(&address, json!({ "token": token, "method": "list" }))["error"].is_string());
    }
    #[test]
    fn sandboxed_clis_reach_workbench_through_the_spool_folder() {
        let bridge = Bridge::new().unwrap();
        let (_, token, spool) = bridge.register("codex-chat".into(), 7);
        let spool = std::path::PathBuf::from(spool.unwrap());
        let (tx, rx) = mpsc::channel();
        *bridge.inner.events.lock().unwrap() = Some(Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                tx.send(serde_json::from_str::<Value>(&text).unwrap()).unwrap();
            }
            Ok(())
        }));
        let state = bridge.inner.clone();
        let responder = std::thread::spawn(move || {
            let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
            assert_eq!(event["source"]["chatId"], "codex-chat");
            assert_eq!(event["method"], "board");
            state.pending.lock().unwrap().remove(event["id"].as_str().unwrap()).unwrap().send(json!({ "notes": [] })).unwrap();
        });
        let request = json!({ "token": token, "method": "board" }).to_string();
        assert_eq!(via_spool(&spool, &request).unwrap(), json!({ "notes": [] }));
        responder.join().unwrap();
        let wrong = json!({ "token": "wrong", "method": "list" }).to_string();
        assert!(via_spool(&spool, &wrong).unwrap()["error"].is_string());
        assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
    }
    #[test]
    fn rejects_unknown_methods_oversized_requests_and_missing_ui() {
        let bridge = Bridge::new().unwrap();
        let (address, token, _) = bridge.register("lead".into(), 1);
        assert_eq!(
            call(&address, json!({ "token": token, "method": "execute" }))["error"],
            "Unknown bridge method"
        );
        let oversized = format!(
            "{}\n",
            json!({ "token": token, "method": "send", "prompt": "x".repeat(LIMIT as usize) })
        );
        assert_eq!(
            read_request(oversized.as_bytes()).err().unwrap(),
            "Request is too large or incomplete"
        );
        assert_eq!(
            call(&address, json!({ "token": token, "method": "list" }))["error"],
            "Workbench is not ready"
        );
        bridge.revoke_all();
        assert!(bridge.inner.credentials.lock().unwrap().is_empty());
        assert!(bridge.inner.pending.lock().unwrap().is_empty());
    }
}

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
const GUIDE: &str = "AI Workbench delegation is available in this terminal. Run the executable in AI_WORKBENCH_CLI with: bridge list; bridge read <chat-name-or-id>; bridge send <chat-name-or-id> <prompt>. In a POSIX shell use: \"$AI_WORKBENCH_CLI\" bridge list. In PowerShell use: & $env:AI_WORKBENCH_CLI bridge list. To send multiline text, use bridge send <target> - and provide stdin. Targets are your descendants and your immediate parent only; other chats are inaccessible. Exact unique names or IDs are required. list returns status and IDs. send submits a prompt to the existing chat, and rejects busy, approval, closed, or unsettled terminals; do not retry to answer approvals. read returns terminal text, not a structured answer or a guarantee the task succeeded. Poll list/read to inspect results. Assign clear file ownership and review changes. Never print or share AI_WORKBENCH_TOKEN.\n";

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
        Ok(Self { address, inner })
    }
    pub fn register(&self, chat_id: String, terminal_id: u32) -> (String, String) {
        let token = uuid::Uuid::new_v4().to_string();
        self.inner.credentials.lock().unwrap().insert(
            token.clone(),
            Source {
                chat_id,
                terminal_id,
            },
        );
        (self.address.clone(), token)
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
    if !["list", "read", "send"].contains(&request.method.as_str()) {
        return Err("Unknown bridge method".into());
    }
    Ok(request)
}
fn serve(mut stream: TcpStream, inner: &Inner) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let result = (|| -> Result<Value, String> {
        let request = read_request(&mut stream)?;
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
    let response = result.unwrap_or_else(|error| json!({ "error": error }));
    writeln!(stream, "{}", response)
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
        let method = args
            .get(1)
            .ok_or("Use bridge list, read <target>, or send <target> <prompt>")?;
        if !["list", "read", "send"].contains(&method.as_str()) {
            return Err("Unknown bridge method".into());
        }
        let target = args.get(2).cloned().unwrap_or_default();
        if method != "list" && target.is_empty() {
            return Err("A target chat name or ID is required".into());
        }
        let mut prompt = args.get(3..).unwrap_or_default().join(" ");
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
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        writeln!(stream, "{}", request).map_err(|e| e.to_string())?;
        let mut response = String::new();
        BufReader::new(stream.take(512 * 1024))
            .read_line(&mut response)
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&response).map_err(|_| "Invalid bridge response".into())
    })();
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
        let (address, token) = bridge.register("lead".into(), 42);
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
    fn rejects_unknown_methods_oversized_requests_and_missing_ui() {
        let bridge = Bridge::new().unwrap();
        let (address, token) = bridge.register("lead".into(), 1);
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

//! Explicitly enabled, TLS-pinned companion transport. AI bridge credentials never leave the PC.
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager, State};

const MAX_BODY: usize = 65536;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return Err("Invalid certificate".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "Invalid certificate".into()))
        .collect()
}
fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn hash(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}
#[derive(Clone, Serialize, Deserialize)]
struct Client {
    id: String,
    name: String,
    hash: String,
}
#[derive(Serialize, Deserialize)]
struct Identity {
    id: String,
    cert: Vec<u8>,
    key: Vec<u8>,
    clients: Vec<Client>,
}
#[derive(Default)]
struct Live {
    revision: u64,
    snapshot: Value,
    pairing: Option<(String, Instant)>,
    events: Option<Channel<Value>>,
    pending: HashMap<String, mpsc::Sender<Value>>,
}
struct Inner {
    identity: Mutex<Option<Identity>>,
    file: Mutex<Option<PathBuf>>,
    live: Mutex<Live>,
    changed: Condvar,
    enabled: AtomicBool,
    active: AtomicUsize,
}
struct Runtime {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
    port: u16,
}
pub struct Companion {
    inner: Arc<Inner>,
    runtime: Mutex<Option<Runtime>>,
}
impl Default for Companion {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                identity: Mutex::new(None),
                file: Mutex::new(None),
                live: Mutex::new(Live::default()),
                changed: Condvar::new(),
                enabled: AtomicBool::new(false),
                active: AtomicUsize::new(0),
            }),
            runtime: Mutex::new(None),
        }
    }
}
fn persist(inner: &Inner, identity: &Identity) -> Result<(), String> {
    let path = inner
        .file
        .lock()
        .unwrap()
        .clone()
        .ok_or("Companion storage unavailable")?;
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(identity).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    // Windows rename cannot replace an existing file. Keep the old file until the new one is complete.
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
impl Companion {
    fn init(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let mut identity = self.inner.identity.lock().unwrap();
        if identity.is_some() {
            return Ok(());
        }
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("companion-identity.json");
        *self.inner.file.lock().unwrap() = Some(file.clone());
        if file.exists() {
            *identity = Some(
                serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?).map_err(
                    |_| "Companion identity is damaged; restore it before enabling linking",
                )?,
            );
        } else {
            let key = rcgen::generate_simple_self_signed(vec!["localhost".into()])
                .map_err(|e| e.to_string())?;
            let id = Identity {
                id: uuid::Uuid::new_v4().to_string(),
                cert: key.cert.der().to_vec(),
                key: key.signing_key.serialize_der(),
                clients: vec![],
            };
            persist(&self.inner, &id)?;
            *identity = Some(id);
        }
        Ok(())
    }
    pub fn stop(&self) {
        self.inner.enabled.store(false, Ordering::SeqCst);
        self.inner.changed.notify_all();
        self.inner.live.lock().unwrap().pairing = None;
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.stop.store(true, Ordering::SeqCst);
            let _ = runtime.thread.join();
        }
    }
}
#[tauri::command]
pub fn companion_status(companion: State<'_, Companion>) -> Value {
    let clients = companion
        .inner
        .identity
        .lock()
        .unwrap()
        .as_ref()
        .map(|i| {
            i.clients
                .iter()
                .map(|c| json!({"id":c.id,"name":c.name}))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let port = companion.runtime.lock().unwrap().as_ref().map(|r| r.port);
    json!({"enabled":companion.inner.enabled.load(Ordering::SeqCst),"port":port,"clients":clients})
}
#[tauri::command]
pub fn companion_enable(
    app: tauri::AppHandle,
    companion: State<'_, Companion>,
    port: u16,
) -> Result<Value, String> {
    if port == 0 {
        return Err("Choose a port between 1 and 65535".into());
    }
    companion.init(&app)?;
    let mut runtime = companion.runtime.lock().unwrap();
    if runtime.is_some() {
        return Err("Linking is already enabled".into());
    }
    let id = companion.inner.identity.lock().unwrap();
    let id = id.as_ref().unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| e.to_string())?
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(id.cert.clone())],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(id.key.clone())),
    )
    .map_err(|e| e.to_string())?;
    let listener = TcpListener::bind(("0.0.0.0", port))
        .map_err(|e| format!("Cannot listen on port {port}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let inner = companion.inner.clone();
    let config = Arc::new(config);
    inner.enabled.store(true, Ordering::SeqCst);
    let thread = std::thread::spawn(move || {
        while !thread_stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((socket, _)) => {
                    if inner.active.fetch_add(1, Ordering::SeqCst) >= 24 {
                        inner.active.fetch_sub(1, Ordering::SeqCst);
                        continue;
                    }
                    let state = inner.clone();
                    let config = config.clone();
                    std::thread::spawn(move || {
                        let _ = serve(socket, config, &state);
                        state.active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(30))
                }
                Err(_) => break,
            }
        }
    });
    *runtime = Some(Runtime { stop, thread, port });
    Ok(json!({"enabled":true,"port":port}))
}
#[tauri::command]
pub fn companion_disable(companion: State<'_, Companion>) {
    companion.stop();
}
#[tauri::command]
pub fn companion_pairing(companion: State<'_, Companion>, host: String) -> Result<Value, String> {
    if !companion.inner.enabled.load(Ordering::SeqCst) {
        return Err("Enable linking first".into());
    }
    let host = host.trim();
    if host.is_empty()
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
    {
        return Err("Enter this PC's IPv4 address or hostname, without a URL or port".into());
    }
    let code = secret();
    companion.inner.live.lock().unwrap().pairing = Some((code.clone(), Instant::now()));
    let cert = hex(&companion
        .inner
        .identity
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Linking disabled")?
        .cert);
    let port = companion
        .runtime
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Linking disabled")?
        .port;
    Ok(json!({"host":host,"port":port,"cert":cert,"code":code,"expiresIn":300}))
}
#[tauri::command]
pub fn companion_revoke(companion: State<'_, Companion>, id: String) -> Result<(), String> {
    let mut identity = companion.inner.identity.lock().unwrap();
    let identity = identity.as_mut().ok_or("No companion identity")?;
    let old = identity.clients.clone();
    identity.clients.retain(|c| c.id != id);
    if let Err(e) = persist(&companion.inner, identity) {
        identity.clients = old;
        return Err(e);
    }
    companion.inner.changed.notify_all();
    Ok(())
}
#[tauri::command]
pub fn companion_publish(companion: State<'_, Companion>, snapshot: Value) {
    let mut live = companion.inner.live.lock().unwrap();
    if live.snapshot != snapshot {
        live.snapshot = snapshot;
        live.revision += 1;
        companion.inner.changed.notify_all();
    }
}
#[tauri::command]
pub fn companion_listen(companion: State<'_, Companion>, events: Channel<Value>) {
    companion.inner.live.lock().unwrap().events = Some(events);
}
#[tauri::command]
pub fn companion_respond(companion: State<'_, Companion>, id: String, response: Value) {
    if let Some(p) = companion.inner.live.lock().unwrap().pending.remove(&id) {
        let _ = p.send(response);
    }
}

struct Request {
    method: String,
    path: String,
    auth: String,
    body: Value,
}
fn parse(reader: &mut impl BufRead) -> Result<Request, String> {
    let mut line = String::new();
    reader
        .take(8193)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() > 8192 {
        return Err("Headers too large".into());
    }
    let parts: Vec<_> = line.trim_end().split(' ').collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" {
        return Err("Invalid request line".into());
    }
    let method = parts[0].to_string();
    let path = parts[1].to_string();
    let mut auth = String::new();
    let mut length = None;
    let mut total = line.len();
    loop {
        line.clear();
        reader
            .take(8193)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?;
        total += line.len();
        if total > 8192 || line.is_empty() {
            return Err("Invalid headers".into());
        }
        if line == "\r\n" {
            break;
        }
        let (k, v) = line.split_once(':').ok_or("Invalid header")?;
        let k = k.to_ascii_lowercase();
        let v = v.trim();
        match k.as_str() {
            "authorization" => auth = v.strip_prefix("Bearer ").unwrap_or("").into(),
            "content-length" => {
                if length.is_some() {
                    return Err("Duplicate length".into());
                }
                length = Some(v.parse::<usize>().map_err(|_| "Invalid length")?);
            }
            "transfer-encoding" | "origin" => return Err("Unsupported request".into()),
            _ => {}
        }
    }
    let length = length.unwrap_or(0);
    if length > MAX_BODY {
        return Err("Request too large".into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    Ok(Request {
        method,
        path,
        auth,
        body: if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).map_err(|_| "Invalid JSON")?
        },
    })
}
fn authorized(inner: &Inner, token: &str) -> bool {
    !token.is_empty()
        && inner
            .identity
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|i| i.clients.iter().any(|c| c.hash == hash(token)))
}
fn route(inner: &Inner, request: Request) -> (u16, Value) {
    if !inner.enabled.load(Ordering::SeqCst) {
        return (503, json!({"error":"Linking disabled"}));
    }
    if request.method == "POST" && request.path == "/pair" {
        let mut live = inner.live.lock().unwrap();
        let valid = live.pairing.as_ref().is_some_and(|(code, at)| {
            at.elapsed() < Duration::from_secs(300) && request.body["code"].as_str() == Some(code)
        });
        if !valid {
            return (401, json!({"error":"Pairing code invalid or expired"}));
        }
        let name = request.body["name"]
            .as_str()
            .unwrap_or("Companion")
            .chars()
            .take(80)
            .collect::<String>();
        let token = secret();
        let mut identity = inner.identity.lock().unwrap();
        let identity = identity.as_mut().unwrap();
        if identity.clients.len() >= 32 {
            return (409, json!({"error":"Remove a paired client first"}));
        }
        let client = Client {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            hash: hash(&token),
        };
        identity.clients.push(client.clone());
        if persist(inner, identity).is_err() {
            identity.clients.pop();
            return (500, json!({"error":"Could not save pairing"}));
        }
        live.pairing = None;
        return (
            200,
            json!({"token":token,"clientId":client.id,"computerId":identity.id}),
        );
    }
    if !authorized(inner, &request.auth) {
        return (401, json!({"error":"Pair this client again"}));
    }
    if request.method == "GET" && request.path.starts_with("/snapshot") {
        let since = request
            .path
            .strip_prefix("/snapshot?since=")
            .and_then(|v| v.parse::<u64>().ok());
        if request.path != "/snapshot" && since.is_none() {
            return (404, json!({"error":"Unknown endpoint"}));
        }
        let live = inner.live.lock().unwrap();
        let (live, _) = inner
            .changed
            .wait_timeout_while(live, Duration::from_secs(20), |l| {
                Some(l.revision) == since && inner.enabled.load(Ordering::SeqCst)
            })
            .unwrap();
        if !inner.enabled.load(Ordering::SeqCst) || !authorized(inner, &request.auth) {
            return (401, json!({"error":"Access revoked"}));
        }
        return (
            200,
            json!({"revision":live.revision,"snapshot":live.snapshot}),
        );
    }
    if request.method == "POST" && request.path == "/message" {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel();
        let events = {
            let mut live = inner.live.lock().unwrap();
            let Some(events) = live.events.clone() else {
                return (503, json!({"error":"Workbench is not ready"}));
            };
            live.pending.insert(id.clone(), tx);
            events
        };
        if events
            .send(json!({"id":id,"message":request.body}))
            .is_err()
        {
            inner.live.lock().unwrap().pending.remove(&id);
            return (503, json!({"error":"Workbench is not ready"}));
        }
        let response = rx.recv_timeout(Duration::from_secs(15));
        inner.live.lock().unwrap().pending.remove(&id);
        return match response {
            Ok(v) => (if v.get("error").is_some() { 400 } else { 200 }, v),
            Err(_) => (
                504,
                json!({"error":"No receipt yet. Retry with the same request ID."}),
            ),
        };
    }
    (404, json!({"error":"Unknown endpoint"}))
}
fn serve(
    socket: TcpStream,
    config: Arc<rustls::ServerConfig>,
    inner: &Inner,
) -> Result<(), String> {
    socket
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    socket
        .set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|e| e.to_string())?;
    let conn = rustls::ServerConnection::new(config).map_err(|e| e.to_string())?;
    let mut stream = rustls::StreamOwned::new(conn, socket);
    let result = {
        let mut reader = BufReader::new(&mut stream);
        parse(&mut reader)
    };
    let (status, body) = match result {
        Ok(r) => route(inner, r),
        Err(_) => (400, json!({"error":"Invalid request"})),
    };
    let bytes = serde_json::to_vec(&body).unwrap();
    write!(stream,"HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",bytes.len()).map_err(|e|e.to_string())?;
    stream.write_all(&bytes).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())
}

// Desktop-to-desktop client. Credentials remain in the native layer, not the remote page.
#[derive(Serialize, Deserialize, Clone)]
struct Remote {
    id: String,
    name: String,
    host: String,
    port: u16,
    cert: String,
    token: String,
}
fn remote_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("companion-remotes.json"))
}
fn remotes(app: &tauri::AppHandle) -> Result<Vec<Remote>, String> {
    let p = remote_file(app)?;
    if !p.exists() {
        return Ok(vec![]);
    }
    serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn save_remotes(app: &tauri::AppHandle, list: &[Remote]) -> Result<(), String> {
    let p = remote_file(app)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(p)
        .and_then(|mut f| f.write_all(&serde_json::to_vec(list).unwrap()))
        .map_err(|e| e.to_string())
}
fn client(cert: &str) -> Result<reqwest::blocking::Client, String> {
    let cert = reqwest::Certificate::from_der(&unhex(cert)?).map_err(|e| e.to_string())?;
    reqwest::blocking::Client::builder()
        .tls_certs_only([cert])
        .tls_danger_accept_invalid_hostnames(true)
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}
fn remote_request(remote: &Remote, method: &str, body: Value) -> Result<Value, String> {
    if remote.host.is_empty()
        || !remote
            .host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
    {
        return Err("Invalid computer address".into());
    }
    let c = client(&remote.cert)?;
    let url = format!("https://{}:{}/{}", remote.host, remote.port, method);
    let builder = if method.starts_with("snapshot") {
        c.get(url)
    } else {
        c.post(url).json(&body)
    };
    let response = builder
        .bearer_auth(&remote.token)
        .send()
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let value: Value = response.json().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Remote request failed")
            .into());
    }
    Ok(value)
}
#[tauri::command]
pub async fn companion_remote(
    app: tauri::AppHandle,
    method: String,
    id: Option<String>,
    body: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut list = remotes(&app)?;
        match method.as_str() {
            "list" => Ok(json!(list
                .iter()
                .map(|r| json!({"id":r.id,"name":r.name,"host":r.host}))
                .collect::<Vec<_>>())),
            "pair" => {
                let mut r = Remote {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: body["name"]
                        .as_str()
                        .unwrap_or("Remote PC")
                        .chars()
                        .take(80)
                        .collect(),
                    host: body["host"].as_str().ok_or("Missing host")?.into(),
                    port: body["port"]
                        .as_u64()
                        .filter(|p| *p > 0 && *p <= 65535)
                        .ok_or("Invalid port")? as u16,
                    cert: body["cert"].as_str().ok_or("Missing certificate")?.into(),
                    token: String::new(),
                };
                let result = remote_request(
                    &r,
                    "pair",
                    json!({"code":body["code"],"name":"Workbench desktop"}),
                )?;
                r.token = result["token"].as_str().ok_or("Missing token")?.into();
                let response = json!({"id":r.id,"name":r.name});
                list.push(r);
                save_remotes(&app, &list)?;
                Ok(response)
            }
            "forget" => {
                list.retain(|r| Some(&r.id) != id.as_ref());
                save_remotes(&app, &list)?;
                Ok(json!({"forgotten":true}))
            }
            "snapshot" | "message" => {
                let remote = list
                    .iter()
                    .find(|r| Some(&r.id) == id.as_ref())
                    .ok_or("Remote computer not found")?;
                let path = if method == "snapshot" {
                    body["since"]
                        .as_u64()
                        .map(|v| format!("snapshot?since={v}"))
                        .unwrap_or("snapshot".into())
                } else {
                    method
                };
                remote_request(remote, &path, body)
            }
            _ => Err("Unknown remote command".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parser_rejects_smuggling_and_oversize() {
        for req in [
            "POST /message HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            "POST /message HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n",
            "POST /message HTTP/1.1\r\nOrigin: https://evil.test\r\n\r\n",
            "POST /message HTTP/1.1\r\nContent-Length: 65537\r\n\r\n",
        ] {
            assert!(parse(&mut std::io::Cursor::new(req)).is_err());
        }
    }
    #[test]
    fn unpaired_and_disabled_clients_cannot_read_or_send() {
        let c = Companion::default();
        for path in ["/snapshot", "/message"] {
            let req = || Request {
                method: "GET".into(),
                path: path.into(),
                auth: "bad".into(),
                body: Value::Null,
            };
            assert_eq!(route(&c.inner, req()).0, 503);
            c.inner.enabled.store(true, Ordering::SeqCst);
            assert_eq!(route(&c.inner, req()).0, 401);
            c.inner.enabled.store(false, Ordering::SeqCst);
        }
    }
    #[test]
    fn tls_pairing_is_single_use_and_clients_can_be_revoked() {
        let c = Companion::default();
        let path = std::env::temp_dir().join(format!("aiw-companion-test-{}.json", secret()));
        *c.inner.file.lock().unwrap() = Some(path.clone());
        let key = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let cert = key.cert.der().to_vec();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.signing_key.serialize_der())),
        )
        .unwrap();
        *c.inner.identity.lock().unwrap() = Some(Identity {
            id: "test-pc".into(),
            cert: cert.clone(),
            key: key.signing_key.serialize_der(),
            clients: vec![],
        });
        c.inner.enabled.store(true, Ordering::SeqCst);
        c.inner.live.lock().unwrap().pairing = Some(("one-time-test-code".into(), Instant::now()));
        c.inner.live.lock().unwrap().snapshot =
            json!({"projects":[{"id":"p","name":"Test project"}]});
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let inner = c.inner.clone();
        let config = Arc::new(config);
        let worker = std::thread::spawn(move || {
            for socket in listener.incoming().take(6) {
                let _ = serve(socket.unwrap(), config.clone(), &inner);
            }
        });
        let mut remote = Remote {
            id: "client".into(),
            name: "test".into(),
            host: "127.0.0.1".into(),
            port,
            cert: hex(&cert),
            token: String::new(),
        };
        assert!(remote_request(&remote, "snapshot", Value::Null).is_err());
        let pairing = remote_request(
            &remote,
            "pair",
            json!({"code":"one-time-test-code","name":"test-client"}),
        )
        .unwrap();
        remote.token = pairing["token"].as_str().unwrap().into();
        assert!(remote_request(&remote, "pair", json!({"code":"one-time-test-code"})).is_err());
        assert_eq!(
            remote_request(&remote, "snapshot", Value::Null).unwrap()["snapshot"]["projects"][0]
                ["name"],
            "Test project"
        );
        c.inner
            .identity
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .clients
            .clear();
        assert!(remote_request(&remote, "snapshot", Value::Null).is_err());
        let other = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        remote.cert = hex(other.cert.der());
        assert!(remote_request(&remote, "snapshot", Value::Null).is_err());
        worker.join().unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "local Android transport fixture, explicitly launched for device testing"]
    fn android_transport_fixture() {
        let pairing_path =
            std::env::var("AIW_COMPANION_TEST_PAIRING").expect("pairing output path");
        let c = Companion::default();
        let identity_path = PathBuf::from(format!("{pairing_path}.identity"));
        *c.inner.file.lock().unwrap() = Some(identity_path.clone());
        let key = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let cert = key.cert.der().to_vec();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.signing_key.serialize_der())),
        )
        .unwrap();
        *c.inner.identity.lock().unwrap() = Some(Identity {
            id: "android-test-pc".into(),
            cert: cert.clone(),
            key: key.signing_key.serialize_der(),
            clients: vec![],
        });
        c.inner.enabled.store(true, Ordering::SeqCst);
        let code = secret();
        c.inner.live.lock().unwrap().pairing = Some((code.clone(), Instant::now()));
        c.inner.live.lock().unwrap().snapshot = json!({"projects":[{"id":"fixture-project","name":"Transport test"}],"chats":[{"id":"fixture-chat","name":"Fixture AI","tool":"codex","status":"idle","output":"Ready for a transport test."}],"usage":null,"receipts":[]});
        let inner = c.inner.clone();
        c.inner.live.lock().unwrap().events = Some(Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                let value: Value = serde_json::from_str(&text).unwrap();
                let id = value["id"].as_str().unwrap();
                let sender = inner.live.lock().unwrap().pending.remove(id);
                if let Some(sender) = sender {
                    let _ = sender.send(json!({"id":value["message"]["id"],"status":"queued"}));
                }
            }
            Ok(())
        }));
        let port = std::env::var("AIW_COMPANION_TEST_PORT")
            .unwrap_or("47932".into())
            .parse::<u16>()
            .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        listener.set_nonblocking(true).unwrap();
        std::fs::write(
            &pairing_path,
            json!({"host":"127.0.0.1","port":port,"cert":hex(&cert),"code":code}).to_string(),
        )
        .unwrap();
        let start = Instant::now();
        let config = Arc::new(config);
        while start.elapsed() < Duration::from_secs(240) {
            match listener.accept() {
                Ok((socket, _)) => {
                    let config = config.clone();
                    let inner = c.inner.clone();
                    std::thread::spawn(move || {
                        let _ = serve(socket, config, &inner);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(30)),
            }
        }
        let _ = std::fs::remove_file(identity_path);
        let _ = std::fs::remove_file(pairing_path);
    }

    #[test]
    fn certificate_hex_roundtrip() {
        assert_eq!(unhex(&hex(&[0, 5, 128, 255])).unwrap(), [0, 5, 128, 255]);
        assert!(unhex("€€").is_err());
    }
}

//! Owns the embedded network helper. Its private API secret never reaches the webview.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
    time::Duration,
};
use tauri::Manager;

const BINARY: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/workbench-network.bin"));
struct Runtime {
    child: Child,
    _stdin: ChildStdin,
    address: String,
    token: String,
}
#[derive(Default)]
pub struct Mesh {
    runtime: Mutex<Option<Runtime>>,
}
impl Mesh {
    pub fn stop(&self) {
        if let Some(mut runtime) = self.runtime.lock().unwrap().take() {
            let _ = runtime.child.kill();
            let _ = runtime.child.wait();
        }
    }
    pub fn request(&self, method: &str, body: Value) -> Result<Value, String> {
        let (address, token) = {
            let mut guard = self.runtime.lock().unwrap();
            let runtime = guard
                .as_mut()
                .ok_or("Enable built-in remote access and sign in first")?;
            if runtime
                .child
                .try_wait()
                .map_err(|e| e.to_string())?
                .is_some()
            {
                return Err("The remote connection stopped. Disable it and reconnect.".into());
            }
            (runtime.address.clone(), runtime.token.clone())
        };
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(35))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("http://{address}/{method}");
        let builder = if method == "status" {
            client.get(url)
        } else {
            client.post(url).json(&body)
        };
        let response = builder
            .bearer_auth(token)
            .send()
            .map_err(|_| "Remote connection helper is unavailable")?;
        let status = response.status();
        let value: Value = response
            .json()
            .map_err(|_| "Invalid connection helper response")?;
        if !status.is_success() {
            return Err(value["error"]
                .as_str()
                .unwrap_or("Remote connection failed")
                .into());
        }
        Ok(value)
    }
    pub fn forward(&self, port: u16) -> Result<(), String> {
        if self.runtime.lock().unwrap().is_some() {
            self.request("forward", json!({"port":port}))?;
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn mesh_status(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = app.state::<Mesh>();
        if mesh.runtime.lock().unwrap().is_none() {
            return Ok(json!({"enabled":false}));
        }
        match mesh.request("status", Value::Null) { Ok(value) => Ok(value), Err(error) => Ok(json!({"enabled":true,"state":"Disconnected","problem":error})) }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mesh_enable(app: tauri::AppHandle, name: String, port: u16) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = start_helper(&app, name.clone(), port)?;
        save_preference(&app, json!({"enabled":true,"name":name,"port":port}))?;
        Ok(value)
    })
    .await
    .map_err(|e| e.to_string())?
}
fn start_helper(app: &tauri::AppHandle, name: String, port: u16) -> Result<Value, String> {
    let mesh = app.state::<Mesh>();
    let mut guard = mesh.runtime.lock().unwrap();
    if guard.is_some() {
        return Err("Built-in remote access is already enabled".into());
    }
    if !name.starts_with("workbench-")
        || name.len() > 63
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Choose a device name beginning with workbench- using letters, digits and hyphens (up to 63 characters).".into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("network-runtime");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(BINARY));
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let file = cache.join(format!("workbench-network-{}{extension}", &hash[..16]));
    if !file.exists() {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o700);
        }
        options
            .open(&file)
            .and_then(|mut f| f.write_all(BINARY))
            .map_err(|e| e.to_string())?;
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("remote-network");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(file);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Enrollment always belongs to the user in the app, not inherited machine-wide CI credentials.
    for key in ["TS_AUTHKEY", "TS_ID_TOKEN", "TS_CONTROL_URL"] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let result = (|| {
        let mut stdin = child
            .stdin
            .take()
            .ok_or("Remote helper stdin unavailable")?;
        writeln!(
            stdin,
            "{}",
            json!({"dir":dir,"name":name,"token":token,"port":port,"controlUrl":""})
        )
        .map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Remote helper stdout unavailable")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let line = rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "Remote connection startup timed out")?
            .map_err(|e| e.to_string())?;
        let ready: Value =
            serde_json::from_str(&line).map_err(|_| "Remote connection helper could not start")?;
        let address = ready["address"]
            .as_str()
            .ok_or("Remote helper address missing")?
            .to_string();
        if !address.starts_with("127.0.0.1:") {
            return Err("Invalid private helper address".into());
        }
        Ok((stdin, address))
    })();
    match result {
        Ok((stdin, address)) => {
            *guard = Some(Runtime {
                child,
                _stdin: stdin,
                address,
                token,
            });
            Ok(json!({"enabled":true}))
        }
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn mesh_action(app: tauri::AppHandle, action: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = app.state::<Mesh>();
        match action.as_str() {
            "disable" => {
                mesh.stop();
                save_preference(&app, json!({"enabled":false}))?;
                Ok(json!({"enabled":false}))
            }
            "login" | "logout" => mesh.request(&action, Value::Null),
            _ => Err("Unknown remote connection action".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn mesh_pairing(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = app.state::<Mesh>().request("status", Value::Null)?;
        if status["state"] != "Running" {
            return Err("Finish signing into remote access first".into());
        }
        let host = status["host"]
            .as_str()
            .filter(|h| !h.is_empty())
            .ok_or("Remote device address is not ready")?;
        let mut pairing =
            crate::companion::pairing(&app.state::<crate::companion::Companion>(), host)?;
        pairing["transport"] = json!("mesh");
        Ok(pairing)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn preference_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("remote-network-preferences.json"))
}
fn save_preference(app: &tauri::AppHandle, value: Value) -> Result<(), String> {
    let file = preference_file(app)?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(file, serde_json::to_vec(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub fn set_host_port(app: &tauri::AppHandle, port: u16) {
    if let Ok(file) = preference_file(app) {
        if let Ok(bytes) = std::fs::read(file) {
            if let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) {
                value["port"] = json!(port);
                let _ = save_preference(app, value);
            }
        }
    }
}
pub fn restore(app: tauri::AppHandle) {
    let run = || -> Result<(), String> {
        let file = preference_file(&app)?;
        if !file.exists() {
            return Ok(());
        }
        let value: Value = serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if value["enabled"] != true {
            return Ok(());
        }
        let name = value["name"]
            .as_str()
            .ok_or("Missing remote device name")?
            .to_string();
        let port = value["port"].as_u64().filter(|p| *p <= 65535).unwrap_or(0) as u16;
        if port > 0 {
            crate::companion::companion_enable(
                app.clone(),
                app.state::<crate::companion::Companion>(),
                port,
                app.state::<Mesh>(),
            )?;
        }
        start_helper(&app, name, port)?;
        Ok(())
    };
    if let Err(error) = run() {
        eprintln!("Remote access did not restart: {error}");
    }
}

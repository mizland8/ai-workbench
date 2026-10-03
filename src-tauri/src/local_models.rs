//! Models served by LM Studio, Ollama or another server with the same OpenAI-compatible API, on
//! this computer or another one on the network. A chat with one runs in OpenCode, which gets the
//! server and model for that chat only (`OPENCODE_CONFIG_CONTENT`); the user's own OpenCode
//! settings and sign-ins are left alone.

use std::time::Duration;

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};

/// Where LM Studio and Ollama listen by default, tried in this order when no address is set.
const ON_THIS_COMPUTER: [&str; 2] = ["http://127.0.0.1:1234", "http://127.0.0.1:11434"];

/// The name local-model chats give the server in OpenCode (`workbench/<model>`).
pub const PROVIDER: &str = "workbench";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServer {
    /// The address chats use: scheme, host and port, without `/v1`.
    server: String,
    /// "LM Studio", "Ollama" or "Model server".
    name: &'static str,
    models: Vec<String>,
}

/// `192.168.1.20:1234`, `http://desktop:1234/v1/` and the like, written as `http://192.168.1.20:1234`.
pub fn normalize_address(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() || address.contains(char::is_whitespace) {
        return None;
    }
    let address = if address.contains("://") { address.to_string() } else { format!("http://{address}") };
    let url = reqwest::Url::parse(&address).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    let address = url.as_str().trim_end_matches('/');
    Some(address.strip_suffix("/v1").unwrap_or(address).trim_end_matches('/').to_string())
}

/// OpenCode settings for one chat: the server as a provider that offers the chat's model, used for
/// everything in that chat, including the short requests that name the conversation.
pub fn opencode_config(server: &str, model: &str) -> String {
    let host = server.split_once("://").map_or(server, |(_, rest)| rest);
    let model_ref = format!("{PROVIDER}/{model}");
    json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": { PROVIDER: {
            "npm": "@ai-sdk/openai-compatible",
            "name": format!("Local model server ({host})"),
            "options": { "baseURL": format!("{server}/v1") },
            "models": { model: { "name": model } },
        } },
        "model": model_ref,
        "small_model": model_ref,
    })
    .to_string()
}

/// The chat models in a `/v1/models` answer; embedding models are left out because they can't chat.
fn chat_models(body: &Value) -> Vec<String> {
    body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str())
        .filter(|id| !id.to_ascii_lowercase().contains("embed"))
        .map(String::from)
        .collect()
}

/// Ollama answers `/api/version`; LM Studio's server listens on port 1234 unless told otherwise.
fn server_name(client: &Client, server: &str) -> &'static str {
    let ollama = client
        .get(format!("{server}/api/version"))
        .send()
        .ok()
        .filter(|response| response.status().is_success())
        .and_then(|response| response.json::<Value>().ok())
        .is_some_and(|body| body["version"].is_string());
    if ollama {
        "Ollama"
    } else if server.ends_with(":1234") {
        "LM Studio"
    } else {
        "Model server"
    }
}

fn ask(client: &Client, server: &str) -> Result<LocalServer, String> {
    let unreachable = || format!("Nothing answered at {server}. Check that the model server is running and accepts connections from this computer.");
    let response = client.get(format!("{server}/v1/models")).send().map_err(|_| unreachable())?;
    if !response.status().is_success() {
        return Err(format!("{server} answered, but not with a list of models ({}). Is it LM Studio, Ollama or another OpenAI-compatible server?", response.status()));
    }
    let body: Value = response.json().map_err(|_| format!("{server} answered, but not like LM Studio or Ollama would."))?;
    Ok(LocalServer { server: server.to_string(), name: server_name(client, server), models: chat_models(&body) })
}

fn find(address: &str) -> Result<LocalServer, String> {
    // A model server is on this computer or the local network: no proxy, and no long waits.
    let client = Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_millis(1500))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    if address.trim().is_empty() {
        return ON_THIS_COMPUTER.iter().find_map(|server| ask(&client, server).ok()).ok_or_else(|| {
            "No LM Studio or Ollama server is running on this computer. Start one, or enter the address of the computer that runs it.".to_string()
        });
    }
    let server = normalize_address(address).ok_or_else(|| format!("“{}” isn't an address. Use one like 192.168.1.20:1234.", address.trim()))?;
    ask(&client, &server)
}

/// The server at `address` (or, with none, LM Studio or Ollama on this computer) and its models.
#[tauri::command]
pub async fn local_models(address: Option<String>) -> Result<LocalServer, String> {
    tauri::async_runtime::spawn_blocking(move || find(address.as_deref().unwrap_or_default())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_written_one_way() {
        assert_eq!(normalize_address("192.168.1.20:1234").as_deref(), Some("http://192.168.1.20:1234"));
        assert_eq!(normalize_address(" http://desktop.local:11434/v1/ ").as_deref(), Some("http://desktop.local:11434"));
        assert_eq!(normalize_address("https://models.example.com/lmstudio").as_deref(), Some("https://models.example.com/lmstudio"));
        assert_eq!(normalize_address("localhost:1234").as_deref(), Some("http://localhost:1234"));
        for bad in ["", "   ", "ftp://desktop:1234", "http://", "two words"] {
            assert_eq!(normalize_address(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn embedding_models_are_left_out() {
        let body = json!({ "object": "list", "data": [
            { "id": "qwen/qwen3-coder-30b", "object": "model" },
            { "id": "text-embedding-nomic-embed-text-v1.5", "object": "model" },
            { "id": "qwen2.5-coder:7b", "object": "model" },
            { "id": "mxbai-embed-large:latest", "object": "model" },
        ] });
        assert_eq!(chat_models(&body), ["qwen/qwen3-coder-30b", "qwen2.5-coder:7b"]);
        assert!(chat_models(&json!({ "error": "no" })).is_empty());
    }

    #[test]
    fn opencode_gets_the_server_and_model_for_this_chat_only() {
        let config: Value = serde_json::from_str(&opencode_config("http://192.168.1.20:1234", "qwen/qwen3-coder-30b")).unwrap();
        let provider = &config["provider"][PROVIDER];
        assert_eq!(provider["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(provider["options"]["baseURL"], "http://192.168.1.20:1234/v1");
        assert_eq!(provider["name"], "Local model server (192.168.1.20:1234)");
        assert!(provider["models"]["qwen/qwen3-coder-30b"].is_object());
        assert_eq!(config["model"], "workbench/qwen/qwen3-coder-30b");
        assert_eq!(config["small_model"], "workbench/qwen/qwen3-coder-30b");
    }

    #[test]
    fn a_server_that_isnt_running_is_reported() {
        // Port 9 (discard) has nothing listening on a normal machine.
        let problem = find("127.0.0.1:9").err().unwrap();
        assert!(problem.starts_with("Nothing answered at http://127.0.0.1:9."), "{problem}");
        assert!(find("not an address").err().unwrap().contains("isn't an address"));
    }
}

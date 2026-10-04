//! The AI CLIs this app connects to: finding them, checking sign-in, and how to install them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::env;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Claude,
    Codex,
    Agy,
    Opencode,
}

impl Tool {
    pub const ALL: [Tool; 4] = [Tool::Claude, Tool::Codex, Tool::Agy, Tool::Opencode];

    pub fn id(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
            Tool::Agy => "agy",
            Tool::Opencode => "opencode",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex",
            Tool::Agy => "Antigravity CLI",
            Tool::Opencode => "OpenCode",
        }
    }

    /// Arguments that start the CLI's own sign-in flow. Antigravity CLI has no login command; it
    /// opens a Google sign-in the first time it starts.
    pub fn login_args(self) -> &'static [&'static str] {
        match self {
            Tool::Claude => &["auth", "login"],
            Tool::Codex => &["login"],
            Tool::Agy => &[],
            Tool::Opencode => &["providers", "login"],
        }
    }

    /// The vendor's recommended install command for this platform.
    pub fn install_command(self) -> &'static str {
        let windows = cfg!(windows);
        match self {
            Tool::Claude if windows => "irm https://claude.ai/install.ps1 | iex",
            Tool::Claude => "curl -fsSL https://claude.ai/install.sh | bash",
            Tool::Codex if windows => "npm.cmd install -g @openai/codex",
            Tool::Codex => "npm install -g @openai/codex",
            Tool::Agy if windows => "irm https://antigravity.google/cli/install.ps1 | iex",
            // The script is served gzip-compressed, so curl has to unpack it before bash reads it.
            Tool::Agy => "curl -fsSL --compressed https://antigravity.google/cli/install.sh | bash",
            Tool::Opencode if windows => "npm.cmd install -g opencode-ai",
            Tool::Opencode => "curl -fsSL https://opencode.ai/install | bash",
        }
    }

    pub fn install_needs_node(self) -> bool {
        self.install_command().starts_with("npm ") || self.install_command().starts_with("npm.cmd ")
    }

    pub fn docs_url(self) -> &'static str {
        match self {
            Tool::Claude => "https://code.claude.com/docs/en/setup",
            Tool::Codex => "https://github.com/openai/codex",
            Tool::Agy => "https://antigravity.google",
            Tool::Opencode => "https://opencode.ai/docs",
        }
    }
}

/// Find the CLI: the user's chosen file if they picked one, otherwise the first match on PATH.
pub fn resolve(tool: Tool, custom: Option<&str>) -> Result<PathBuf, String> {
    if let Some(custom) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let path = PathBuf::from(custom);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("{} isn't at {}. Choose it again in AI tools.", tool.name(), path.display()))
        };
    }
    which::which_in(tool.id(), Some(env::search_path()), env::home_dir())
        .map_err(|_| format!("{} isn't installed, or isn't on your PATH.", tool.name()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    id: Tool,
    name: &'static str,
    path: Option<String>,
    version: Option<String>,
    /// None when the CLI gives no reliable way to tell.
    signed_in: Option<bool>,
    problem: Option<String>,
    install_command: &'static str,
    install_needs_node: bool,
    node_found: bool,
    docs_url: &'static str,
}

pub fn detect(tool: Tool, custom: Option<&str>, node_found: bool) -> ToolStatus {
    let mut status = ToolStatus {
        id: tool,
        name: tool.name(),
        path: None,
        version: None,
        signed_in: None,
        problem: None,
        install_command: tool.install_command(),
        install_needs_node: tool.install_needs_node(),
        node_found,
        docs_url: tool.docs_url(),
    };
    let path = match resolve(tool, custom) {
        Ok(path) => path,
        Err(problem) => {
            status.problem = Some(problem);
            return status;
        }
    };
    status.path = Some(path.display().to_string());

    let probe = |args: &[&str]| env::run_captured(env::probe_command(&path, args), Duration::from_secs(20));
    match probe(&["--version"]) {
        Some(out) => {
            status.version = parse_version(&String::from_utf8_lossy(&out.stdout))
                .or_else(|| parse_version(&String::from_utf8_lossy(&out.stderr)));
            if !out.success {
                status.problem = Some(format!("{} found, but `{} --version` failed.", tool.name(), tool.id()));
                return status;
            }
        }
        None => {
            status.problem = Some(format!("{} found, but it didn't respond.", tool.name()));
            return status;
        }
    }
    status.signed_in = match tool {
        Tool::Claude => probe(&["auth", "status", "--json"])
            .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
            .and_then(|status| status.get("loggedIn")?.as_bool()),
        Tool::Codex => probe(&["login", "status"]).and_then(|out| {
            let text = out.text().to_lowercase();
            if text.contains("not logged in") {
                Some(false)
            } else if text.contains("logged in") {
                Some(true)
            } else {
                None
            }
        }),
        Tool::Agy => agy_signed_in(),
        Tool::Opencode => opencode_signed_in(),
    };
    status
}

/// Check every tool at once; each check runs the CLI, so they go in parallel.
pub fn detect_all(custom_paths: &HashMap<String, String>) -> Vec<ToolStatus> {
    let node_found = ["node", "npm"].into_iter()
        .all(|program| which::which_in(program, Some(env::search_path()), env::home_dir()).is_ok());
    let handles: Vec<_> = Tool::ALL
        .into_iter()
        .map(|tool| {
            let custom = custom_paths.get(tool.id()).cloned();
            thread::spawn(move || detect(tool, custom.as_deref(), node_found))
        })
        .collect();
    handles.into_iter().zip(Tool::ALL).map(|(handle, tool)| handle.join().unwrap_or_else(|_| detect(tool, None, node_found))).collect()
}

fn parse_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|token| token.trim_start_matches('v').trim_end_matches(|c: char| !c.is_ascii_alphanumeric()))
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('.'))
        .map(str::to_string)
}

/// Antigravity CLI keeps its Google sign-in in the system keyring, which we can't read without a
/// prompt. Its conversations folder only appears after a signed-in first start, so it counts as
/// signed in; otherwise it's unknown.
fn agy_signed_in() -> Option<bool> {
    crate::sessions::agy_dir().join("conversations").is_dir().then_some(true)
}

/// OpenCode works without signing in (it ships free models), so only saved providers are reported.
fn opencode_signed_in() -> Option<bool> {
    let data = env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| env::home_dir().join(".local/share"));
    std::fs::read_to_string(data.join("opencode/auth.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .is_some_and(|auth| auth.as_object().is_some_and(|providers| !providers.is_empty()))
        .then_some(true)
}

#[tauri::command]
pub async fn detect_tools(tool_paths: HashMap<String, String>, refresh: bool) -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if refresh {
            env::refresh();
        }
        detect_all(&tool_paths)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_versions_from_each_cli() {
        assert_eq!(parse_version("2.1.284 (Claude Code)").as_deref(), Some("2.1.284"));
        assert_eq!(parse_version("codex-cli 0.159.2").as_deref(), Some("0.159.2"));
        assert_eq!(parse_version("0.62.0\n").as_deref(), Some("0.62.0"));
        assert_eq!(parse_version("v1.18.34").as_deref(), Some("1.18.34"));
        assert_eq!(parse_version("command not found"), None);
    }

    #[test]
    fn missing_custom_path_is_reported() {
        let err = resolve(Tool::Codex, Some("/nonexistent/codex")).unwrap_err();
        assert!(err.contains("/nonexistent/codex"));
    }

    #[cfg(windows)]
    #[test]
    fn npm_installers_use_the_cmd_launcher_and_require_node() {
        for tool in [Tool::Codex, Tool::Opencode] {
            assert!(tool.install_command().starts_with("npm.cmd "));
            assert!(tool.install_needs_node());
        }
        assert!(!Tool::Agy.install_needs_node());
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "checks installed CLIs on the current Windows PC"]
    fn installed_windows_clis_are_detected_and_run() {
        env::refresh();
        for tool in [Tool::Claude, Tool::Codex, Tool::Agy] {
            let status = detect(tool, None, true);
            assert!(status.path.is_some(), "{}: {:?}", tool.name(), status.problem);
            assert!(status.problem.is_none(), "{}: {:?}", tool.name(), status.problem);
            assert!(status.version.is_some(), "{} version was not detected", tool.name());
            println!("{}: {} ({})", tool.name(), status.version.unwrap(), status.path.unwrap());
        }
    }
}

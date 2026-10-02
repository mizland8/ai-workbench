//! Account allowances, independent of local token history. Credentials stay in this process.
//! Codex owns its authentication through app-server; Claude uses its existing CLI login.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::env;
use crate::tools::{self, Tool};
use crate::usage::{now_ms, parse_iso_ms, Limit};

#[derive(Clone, Default)]
pub struct Snapshot {
    pub limits: Vec<Limit>,
    pub plan: Option<String>,
    pub updated_at: Option<i64>,
    pub problem: Option<String>,
}

struct Cached {
    key: String,
    attempted: Instant,
    next_probe: Instant,
    retry_after: Instant,
    snapshot: Snapshot,
}

struct Failure {
    message: String,
    retry: Duration,
    keep_previous: bool,
}

impl Failure {
    fn unavailable(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: Duration::from_secs(60),
            keep_previous: true,
        }
    }

    fn auth(message: &str) -> Self {
        Self {
            keep_previous: false,
            ..Self::unavailable(message)
        }
    }
}

static CLAUDE: Mutex<Option<Cached>> = Mutex::new(None);
static CODEX: Mutex<Option<Cached>> = Mutex::new(None);

/// Serialize probes per provider. A manual refresh respects server backoff and a one-minute
/// minimum; reopening the panel never starts a burst of requests. A changed login drops the cache.
fn cached(
    cache: &Mutex<Option<Cached>>,
    key: String,
    force: bool,
    ttl: Duration,
    fetch: impl FnOnce() -> Result<Snapshot, Failure>,
) -> Snapshot {
    let mut entry = cache.lock().unwrap();
    let now = Instant::now();
    if let Some(old) = entry.as_ref().filter(|old| old.key == key) {
        let manual = force && now.duration_since(old.attempted) >= Duration::from_secs(60);
        if now < old.retry_after || (now < old.next_probe && !manual) {
            return old.snapshot.clone();
        }
    }
    let result = fetch();
    let finished = Instant::now();
    let (snapshot, wait, retry) = match result {
        Ok(snapshot) => (snapshot, ttl, Duration::ZERO),
        Err(error) => {
            let previous = entry
                .as_ref()
                .filter(|old| old.key == key && error.keep_previous)
                .map(|old| old.snapshot.clone())
                .filter(|snapshot| {
                    snapshot
                        .updated_at
                        .is_some_and(|at| now_ms() - at <= 3_600_000)
                });
            let mut snapshot = previous.unwrap_or_default();
            snapshot.problem = Some(error.message);
            (snapshot, error.retry, error.retry)
        }
    };
    *entry = Some(Cached {
        key,
        attempted: finished,
        next_probe: finished + wait,
        retry_after: finished + retry,
        snapshot: snapshot.clone(),
    });
    snapshot
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn plan_label(login: &Value) -> Option<String> {
    let tier = login["rateLimitTier"].as_str().unwrap_or("");
    if let Some(multiplier) = tier
        .split("max_")
        .nth(1)
        .and_then(|s| s.split('_').next())
        .filter(|s| s.ends_with('x'))
    {
        return Some(format!("Max {multiplier}"));
    }
    login["subscriptionType"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut chars = s.chars();
            format!("{}{}", chars.next().unwrap().to_uppercase(), chars.as_str())
        })
}

fn claude_credentials(root: &Path) -> Option<Value> {
    let secure_directory = env::user_env()
        .into_iter()
        .find(|(name, _)| {
            if cfg!(windows) {
                name.to_string_lossy()
                    .eq_ignore_ascii_case("CLAUDE_SECURESTORAGE_CONFIG_DIR")
            } else {
                name == "CLAUDE_SECURESTORAGE_CONFIG_DIR"
            }
        })
        .map(|(_, value)| value);
    let credential_root = match &secure_directory {
        Some(value) if value.is_empty() => env::home_dir().join(".claude"),
        Some(value) => PathBuf::from(value),
        None => root.to_path_buf(),
    };
    #[cfg(target_os = "macos")]
    {
        // Keychain is authoritative on macOS; a fallback file can contain an older login.
        let custom = secure_directory
            .as_ref()
            .map(|value| !value.is_empty())
            .unwrap_or_else(|| env::var("CLAUDE_CONFIG_DIR").is_some());
        let service = claude_keychain_service(&credential_root, custom);
        let username = env::var("USER")
            .map(|name| name.to_string_lossy().into_owned())
            .or_else(|| {
                env::run_captured(
                    env::probe_command(Path::new("/usr/bin/id"), &["-un"]),
                    Duration::from_secs(2),
                )
                .filter(|output| output.success)
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            })
            .filter(|name| {
                !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            })
            .unwrap_or_else(|| "claude-code-user".into());
        if let Some(output) = env::run_captured(
            env::probe_command(
                Path::new("/usr/bin/security"),
                &[
                    "find-generic-password",
                    "-a",
                    &username,
                    "-s",
                    &service,
                    "-w",
                ],
            ),
            Duration::from_secs(5),
        ) {
            if output.success {
                if let Ok(login) = serde_json::from_slice(&output.stdout) {
                    return Some(login);
                }
            }
        }
    }
    fs::read(credential_root.join(".credentials.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

#[cfg(any(target_os = "macos", test))]
fn claude_keychain_service(root: &Path, custom: bool) -> String {
    if custom {
        format!(
            "Claude Code-credentials-{}",
            &fingerprint(root.to_string_lossy().as_bytes())[..8]
        )
    } else {
        "Claude Code-credentials".into()
    }
}

pub fn claude(root: &Path, force: bool) -> Snapshot {
    let credentials = claude_credentials(root).unwrap_or(Value::Null);
    let login = &credentials["claudeAiOauth"];
    let token = login["accessToken"].as_str().unwrap_or("");
    let key = format!("{}:{}", root.display(), fingerprint(token.as_bytes()));
    let mut snapshot = cached(&CLAUDE, key, force, Duration::from_secs(900), || {
        if token.is_empty() {
            return Err(Failure::auth(
                "Sign in to Claude Code from AI tools to see subscription limits.",
            ));
        }
        if login["expiresAt"].as_i64().is_some_and(|at| at <= now_ms()) {
            return Err(Failure::auth(
                "Claude sign-in expired. Open AI tools to sign in again.",
            ));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                Failure::unavailable(
                    "Couldn't connect to Claude usage. Local token totals are still available.",
                )
            })?;
        let response = client
            .get("https://api.anthropic.com/api/oauth/usage")
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("Accept", "application/json")
            .send()
            .map_err(|_| {
                Failure::unavailable(
                    "Couldn't reach Claude usage. Local token totals are still available.",
                )
            })?;
        match response.status().as_u16() {
            401 | 403 => return Err(Failure::auth("Claude sign-in needs attention. Open AI tools to sign in again.")),
            429 => {
                let seconds = response.headers().get("retry-after").and_then(|h| h.to_str().ok()).and_then(|s| s.parse::<u64>().ok()).unwrap_or(900).clamp(60, 86_400);
                return Err(Failure { message: "Claude usage checks are rate limited. Retrying later; local token totals are still available.".into(), retry: Duration::from_secs(seconds), keep_previous: true });
            }
            200 => {}
            _ => return Err(Failure::unavailable("Claude subscription limits are unavailable. Local token totals are still available.")),
        }
        let payload: Value = response
            .json()
            .map_err(|_| Failure::unavailable("Claude returned unreadable subscription limits."))?;
        let limits = claude_limits(&payload);
        if limits.is_empty() {
            return Err(Failure::unavailable(
                "Claude didn't return subscription limits. Local token totals are still available.",
            ));
        }
        Ok(Snapshot {
            limits,
            updated_at: Some(now_ms()),
            ..Snapshot::default()
        })
    });
    snapshot.plan = plan_label(login);
    snapshot
}

fn claude_limits(payload: &Value) -> Vec<Limit> {
    // The endpoint reports percentages, including values below 1%. Do not infer a fraction scale.
    let weekly = if payload["seven_day_oauth_apps"].is_object() {
        "seven_day_oauth_apps"
    } else {
        "seven_day"
    };
    [
        ("five_hour", "5-hour"),
        (weekly, "weekly"),
        ("seven_day_sonnet", "Sonnet weekly"),
        ("seven_day_opus", "Opus weekly"),
    ]
    .into_iter()
    .filter_map(|(key, label)| {
        let window = &payload[key];
        let used = window["utilization"].as_f64()?;
        if !used.is_finite() || used < 0.0 {
            return None;
        }
        Some(Limit {
            label: label.into(),
            used_percent: used.clamp(0.0, 100.0),
            resets_at: window["resets_at"].as_str().and_then(parse_iso_ms),
        })
    })
    .collect()
}

/// The account-only app-server connection creates no thread and sends no prompts.
pub fn codex(custom: Option<&str>, force: bool) -> Snapshot {
    let root = env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::home_dir().join(".codex"));
    let program = tools::resolve(Tool::Codex, custom);
    let key = format!(
        "{}:{}:{}:{}",
        root.display(),
        program
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        fingerprint(&fs::read(root.join("auth.json")).unwrap_or_default()),
        fingerprint(
            env::var("OPENAI_API_KEY")
                .unwrap_or_default()
                .to_string_lossy()
                .as_bytes()
        )
    );
    cached(&CODEX, key, force, Duration::from_secs(300), || {
        let program = program.map_err(|_| {
            Failure::auth("Install Codex from AI tools to see subscription limits.")
        })?;
        let mut rpc = Rpc::spawn(env::probe_command(
            &program,
            &["-s", "read-only", "-a", "on-request", "app-server"],
        ))?;
        rpc.request(1, "initialize", json!({"clientInfo": {"name": "ai_workbench_usage", "title": "AI Workbench", "version": env!("CARGO_PKG_VERSION")}}))?;
        rpc.send(json!({"method": "initialized"}))?;
        let account = rpc.request(2, "account/read", json!({}))?;
        match account["account"]["type"].as_str() {
            None => {
                return Err(Failure::auth(
                    "Sign in to Codex from AI tools to see subscription limits.",
                ))
            }
            Some("apiKey") => {
                return Ok(Snapshot {
                    problem: Some(
                        "Codex uses an API key. Subscription allowances require a ChatGPT sign-in."
                            .into(),
                    ),
                    ..Snapshot::default()
                })
            }
            _ => {}
        }
        let response = rpc.request(3, "account/rateLimits/read", json!({}))?;
        let (limits, plan) = codex_limits(&response);
        if limits.is_empty() {
            return Err(Failure::unavailable(
                "Codex didn't return subscription limits. Local token totals are still available.",
            ));
        }
        Ok(Snapshot {
            limits,
            plan: plan.or_else(|| account["account"]["planType"].as_str().map(String::from)),
            updated_at: Some(now_ms()),
            problem: None,
        })
    })
}

fn codex_limits(response: &Value) -> (Vec<Limit>, Option<String>) {
    let single = &response["rateLimits"];
    let buckets: Vec<&Value> = match response["rateLimitsByLimitId"]
        .as_object()
        .filter(|m| !m.is_empty())
    {
        Some(map) => map.values().collect(),
        None => vec![single],
    };
    let plan = single["planType"]
        .as_str()
        .or_else(|| buckets.iter().find_map(|b| b["planType"].as_str()))
        .map(String::from);
    let mut limits = Vec::new();
    for bucket in &buckets {
        let name = if buckets.len() > 1 && bucket["limitId"].as_str() != Some("codex") {
            bucket["limitName"]
                .as_str()
                .or_else(|| bucket["limitId"].as_str())
                .unwrap_or("")
        } else {
            ""
        };
        for key in ["primary", "secondary"] {
            let window = &bucket[key];
            let Some(used) = window["usedPercent"]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
            else {
                continue;
            };
            let minutes = window["windowDurationMins"].as_u64().unwrap_or(0);
            let label = match minutes {
                300 => "5-hour".into(),
                10_080 => "weekly".into(),
                0 => "allowance".into(),
                m if m % 60 == 0 => format!("{}-hour", m / 60),
                m => format!("{m}-minute"),
            };
            limits.push(Limit {
                label: if name.is_empty() {
                    label
                } else {
                    format!("{name} · {label}")
                },
                used_percent: used.clamp(0.0, 100.0),
                resets_at: window["resetsAt"]
                    .as_i64()
                    .and_then(|s| s.checked_mul(1000)),
            });
        }
    }
    (limits, plan)
}

struct Rpc {
    child: Child,
    input: ChildStdin,
    output: mpsc::Receiver<Value>,
}

impl Rpc {
    fn spawn(mut command: Command) -> Result<Self, Failure> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().map_err(|_| {
            Failure::unavailable("Couldn't start Codex to check subscription limits.")
        })?;
        let input = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(message) = serde_json::from_str(&line) {
                    if tx.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            output,
        })
    }

    fn send(&mut self, value: Value) -> Result<(), Failure> {
        writeln!(self.input, "{value}")
            .and_then(|_| self.input.flush())
            .map_err(|_| Failure::unavailable("Codex stopped responding to usage checks."))
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, Failure> {
        self.send(json!({"id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let message = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    Failure::unavailable(
                        "Codex usage check timed out. Local token totals are still available.",
                    )
                })?;
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            if message["error"].is_object() {
                return Err(Failure::unavailable(
                    "Codex couldn't read subscription limits. Check its sign-in in AI tools.",
                ));
            }
            return message.get("result").cloned().ok_or_else(|| {
                Failure::unavailable("Codex returned unreadable subscription limits.")
            });
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            // npm's .cmd launcher can leave a child holding the stdout pipe open.
            let pid = self.child.id().to_string();
            let _ = env::run_captured(
                env::probe_command(Path::new("taskkill.exe"), &["/PID", &pid, "/T", "/F"]),
                Duration::from_secs(3),
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_keychain_services_separate_configuration_directories() {
        assert_eq!(
            claude_keychain_service(Path::new("/Users/tester/.claude"), false),
            "Claude Code-credentials"
        );
        let custom = claude_keychain_service(Path::new("/Users/tester/Work account"), true);
        assert!(custom.starts_with("Claude Code-credentials-"));
        assert_ne!(
            custom,
            claude_keychain_service(Path::new("/Users/tester/Personal account"), true)
        );
    }

    #[test]
    fn claude_percentages_include_fractional_and_model_limits() {
        let limits = claude_limits(
            &json!({"five_hour": {"utilization": 0.5, "resets_at": null},
            "seven_day": {"utilization": 22.0, "resets_at": "2026-10-09T16:00:00Z"},
            "seven_day_sonnet": {"utilization": 37.0}, "seven_day_opus": null}),
        );
        assert_eq!(limits.len(), 3);
        assert_eq!(
            limits[0].used_percent, 0.5,
            "half a percent is not fifty percent"
        );
        assert_eq!(limits[1].resets_at, parse_iso_ms("2026-10-09T16:00:00Z"));
        assert_eq!(limits[2].label, "Sonnet weekly");
        assert!(claude_limits(&json!({"five_hour": {"utilization": -1}})).is_empty());
    }

    #[test]
    fn claude_scoped_weekly_allowance_and_plan() {
        let limits = claude_limits(
            &json!({"seven_day": {"utilization": 90}, "seven_day_oauth_apps": {"utilization": 10}}),
        );
        assert_eq!(limits[0].used_percent, 10.0);
        assert_eq!(
            plan_label(
                &json!({"rateLimitTier": "default_claude_max_20x", "subscriptionType": "max"})
            ),
            Some("Max 20x".into())
        );
        assert_eq!(
            plan_label(&json!({"subscriptionType": "pro"})),
            Some("Pro".into())
        );
    }

    #[test]
    fn codex_live_payload_uses_milliseconds_and_keeps_separate_buckets() {
        let (limits, plan) = codex_limits(
            &json!({"rateLimits": {"planType": "plus", "primary": {"usedPercent": 12, "windowDurationMins": 300}},
            "rateLimitsByLimitId": {"codex": {"limitId": "codex", "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1790907855}, "secondary": {"usedPercent": 33, "windowDurationMins": 10080}},
                "other": {"limitId": "other", "limitName": "Other model", "primary": {"usedPercent": 42, "windowDurationMins": 60}}}}),
        );
        assert_eq!(plan.as_deref(), Some("plus"));
        assert_eq!(
            limits.len(),
            3,
            "the compatibility bucket isn't counted twice"
        );
        assert_eq!(limits[0].resets_at, Some(1790907855000));
        assert_eq!(limits[1].label, "weekly");
        assert_eq!(limits[2].label, "Other model · 1-hour");
        let (legacy, _) = codex_limits(
            &json!({"rateLimits": {"primary": {"usedPercent": 0, "windowDurationMins": 300}}}),
        );
        assert_eq!(legacy.len(), 1);
    }

    #[test]
    fn cache_respects_backoff_and_drops_another_accounts_limits() {
        let cache = Mutex::new(None);
        let successful = || {
            Ok(Snapshot {
                limits: vec![Limit {
                    label: "weekly".into(),
                    used_percent: 45.0,
                    resets_at: None,
                }],
                updated_at: Some(now_ms()),
                ..Snapshot::default()
            })
        };
        cached(
            &cache,
            "account-one".into(),
            false,
            Duration::from_secs(300),
            successful,
        );
        cached(
            &cache,
            "account-one".into(),
            true,
            Duration::from_secs(300),
            || panic!("rapid refresh must be cached"),
        );
        {
            let mut entry = cache.lock().unwrap();
            let old = entry.as_mut().unwrap();
            old.next_probe = Instant::now();
            old.attempted -= Duration::from_secs(61);
        }
        let failed = cached(
            &cache,
            "account-one".into(),
            false,
            Duration::from_secs(300),
            || Err(Failure::unavailable("offline")),
        );
        assert_eq!(failed.limits.len(), 1);
        assert_eq!(failed.problem.as_deref(), Some("offline"));
        cached(
            &cache,
            "account-one".into(),
            true,
            Duration::from_secs(300),
            || panic!("manual refresh must respect backoff"),
        );
        let other = cached(
            &cache,
            "account-two".into(),
            false,
            Duration::from_secs(300),
            || Err(Failure::auth("signed out")),
        );
        assert!(
            other.limits.is_empty(),
            "another login must not inherit quotas"
        );
    }

    #[test]
    fn app_server_fixture() {
        if std::env::var_os("AI_WORKBENCH_RPC_FIXTURE").is_none() {
            return;
        }
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let request: Value = serde_json::from_str(&line).unwrap();
            if request["method"] == "initialized" {
                continue;
            }
            println!("{}", json!({"method": "account/updated", "params": {}}));
            let result = match request["method"].as_str().unwrap() {
                "initialize" => json!({"userAgent": "fixture"}),
                "account/read" => json!({"account": {"type": "chatgpt", "planType": "plus"}}),
                _ => {
                    json!({"rateLimits": {"primary": {"usedPercent": 37, "windowDurationMins": 300}}})
                }
            };
            println!("{}", json!({"id": request["id"], "result": result}));
            std::io::stdout().flush().unwrap();
        }
    }

    #[test]
    fn rpc_reads_replies_despite_notifications_and_runner_output() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "subscriptions::tests::app_server_fixture",
                "--nocapture",
            ])
            .env("AI_WORKBENCH_RPC_FIXTURE", "1");
        let mut rpc = Rpc::spawn(command).unwrap_or_else(|_| panic!("fixture starts"));
        rpc.request(1, "initialize", json!({}))
            .unwrap_or_else(|_| panic!("initialize"));
        rpc.send(json!({"method": "initialized"}))
            .unwrap_or_else(|_| panic!("initialized"));
        let account = rpc
            .request(2, "account/read", json!({}))
            .unwrap_or_else(|_| panic!("account/read"));
        assert_eq!(account["account"]["planType"], "plus");
        let limits = rpc
            .request(3, "account/rateLimits/read", json!({}))
            .unwrap_or_else(|_| panic!("account/rateLimits/read"));
        assert_eq!(codex_limits(&limits).0[0].used_percent, 37.0);
    }
}

//! Where each CLI keeps its conversations, so a chat reopens the conversation it had.
//!
//! Claude Code and Gemini CLI let us choose the session ID when a conversation starts, so we
//! only check whether it was saved yet. Codex and OpenCode choose their own IDs, so after
//! starting one we look for the new conversation in that folder.

use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::env;

/// How far a conversation's start may precede the moment we launched the CLI (clock and filesystem slack).
const SLACK: Duration = Duration::from_secs(5);

pub fn is_uuid(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, len)| g.len() == len && g.chars().all(|c| c.is_ascii_hexdigit()))
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

fn files(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_file()).collect())
        .unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

pub fn same_dir(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.components().eq(b.components()),
    }
}

fn claude_dir() -> PathBuf {
    env::var("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| env::home_dir().join(".claude"))
}

/// Claude Code saves `<config>/projects/<encoded folder>/<session id>.jsonl` once a conversation has a message.
pub fn claude_has_session(id: &str) -> bool {
    claude_has_session_in(&claude_dir(), id)
}

fn claude_has_session_in(config: &Path, id: &str) -> bool {
    let file = format!("{id}.jsonl");
    subdirs(&config.join("projects")).iter().any(|project| project.join(&file).is_file())
}

fn gemini_dir() -> PathBuf {
    env::var("GEMINI_CLI_HOME").map(PathBuf::from).unwrap_or_else(env::home_dir).join(".gemini")
}

/// Gemini CLI saves `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`.
pub fn gemini_has_session(id: &str) -> bool {
    gemini_has_session_in(&gemini_dir(), id)
}

fn gemini_has_session_in(gemini: &Path, id: &str) -> bool {
    let Some(short) = id.get(..8) else { return false };
    let suffixes = [format!("-{short}.jsonl"), format!("-{short}.json")];
    subdirs(&gemini.join("tmp")).iter().any(|project| {
        files(&project.join("chats")).iter().any(|file| {
            let name = file_name(file);
            name.starts_with("session-")
                && suffixes.iter().any(|s| name.ends_with(s.as_str()))
                && file_starts_with_id(file, id)
        })
    })
}

fn file_starts_with_id(file: &Path, id: &str) -> bool {
    let mut head = Vec::new();
    fs::File::open(file).and_then(|f| f.take(64 * 1024).read_to_end(&mut head)).is_ok()
        && String::from_utf8_lossy(&head).contains(id)
}

fn codex_dir() -> PathBuf {
    env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| env::home_dir().join(".codex"))
}

/// Codex saves `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`; newest days first.
fn codex_day_dirs(codex: &Path) -> Vec<PathBuf> {
    let mut days = Vec::new();
    for year in subdirs(&codex.join("sessions")) {
        for month in subdirs(&year) {
            days.extend(subdirs(&month));
        }
    }
    days.sort();
    days.reverse();
    days
}

pub fn codex_has_session(id: &str) -> bool {
    codex_has_session_in(&codex_dir(), id)
}

fn codex_has_session_in(codex: &Path, id: &str) -> bool {
    let suffix = format!("-{id}.jsonl");
    codex_day_dirs(codex).iter().any(|day| files(day).iter().any(|f| file_name(f).ends_with(&suffix)))
}

/// The Codex conversation started in `cwd` since `since` that no other chat has claimed.
pub fn find_new_codex_session(cwd: &Path, since: SystemTime, claimed: &HashSet<String>) -> Option<String> {
    find_new_codex_session_in(&codex_dir(), cwd, since, claimed)
}

fn find_new_codex_session_in(codex: &Path, cwd: &Path, since: SystemTime, claimed: &HashSet<String>) -> Option<String> {
    let earliest = since - SLACK;
    let mut found: Vec<(bool, SystemTime, String)> = Vec::new();
    // A conversation that started in the last couple of days is in one of the newest day folders.
    for day in codex_day_dirs(codex).into_iter().take(3) {
        for file in files(&day) {
            if !file_name(&file).starts_with("rollout-") {
                continue;
            }
            let Ok(meta) = fs::metadata(&file) else { continue };
            let started = meta.created().or_else(|_| meta.modified()).unwrap_or(UNIX_EPOCH);
            if meta.modified().unwrap_or(UNIX_EPOCH) < earliest || started < earliest {
                continue;
            }
            let Some(first) = first_line(&file) else { continue };
            let Ok(record) = serde_json::from_str::<serde_json::Value>(&first) else { continue };
            let payload = &record["payload"];
            let (Some(id), Some(dir)) = (payload["id"].as_str(), payload["cwd"].as_str()) else { continue };
            // Codex also records helper threads (e.g. its guardian reviewer) next to the conversation.
            let helper = payload["source"].get("subagent").is_some() || payload["thread_source"].as_str().is_some_and(|t| t != "user");
            if record["type"] == "session_meta" && !helper && same_dir(Path::new(dir), cwd) && !claimed.contains(id) {
                // Prefer interactive sessions over `codex exec` runs in the same folder.
                let interactive = payload["originator"].as_str().is_some_and(|o| o.contains("tui"));
                found.push((!interactive, started, id.to_string()));
            }
        }
    }
    found.sort();
    found.into_iter().next().map(|(_, _, id)| id)
}

fn first_line(file: &Path) -> Option<String> {
    let mut line = String::new();
    BufReader::new(fs::File::open(file).ok()?).take(4 * 1024 * 1024).read_line(&mut line).ok()?;
    Some(line)
}

/// The OpenCode conversation started in `cwd` since `since`, from `opencode session list`.
pub fn find_new_opencode_session(program: &Path, cwd: &Path, since: SystemTime, claimed: &HashSet<String>) -> Option<String> {
    let mut cmd = env::probe_command(program, &["session", "list", "--format", "json", "-n", "20"]);
    cmd.current_dir(cwd);
    let out = env::run_captured(cmd, Duration::from_secs(30))?;
    pick_opencode_session(&out.stdout, cwd, since, claimed)
}

fn pick_opencode_session(json: &[u8], cwd: &Path, since: SystemTime, claimed: &HashSet<String>) -> Option<String> {
    let sessions: Vec<serde_json::Value> = serde_json::from_slice(json).ok()?;
    let earliest = (since - SLACK).duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    sessions
        .iter()
        .filter_map(|s| Some((s["created"].as_i64()?, s["id"].as_str()?, s["directory"].as_str()?)))
        .filter(|(created, id, dir)| *created >= earliest && !claimed.contains(*id) && same_dir(Path::new(dir), cwd))
        .min_by_key(|(created, _, _)| *created)
        .map(|(_, id, _)| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-workbench-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ID: &str = "0f8e2c1a-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn recognises_uuids() {
        assert!(is_uuid(ID));
        assert!(!is_uuid("0f8e2c1a5b6d4e7f8a9b0c1d2e3f4a5b"));
        assert!(!is_uuid("ses_3f2a1b"));
    }

    #[test]
    fn finds_saved_claude_and_gemini_sessions() {
        let root = scratch("claude-gemini");
        assert!(!claude_has_session_in(&root, ID));
        let project = root.join("projects/-home-me-app");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join(format!("{ID}.jsonl")), "{}").unwrap();
        assert!(claude_has_session_in(&root, ID));

        let chats = root.join("tmp/app/chats");
        fs::create_dir_all(&chats).unwrap();
        assert!(!gemini_has_session_in(&root, ID));
        fs::write(chats.join("session-2026-10-01T10-00-0f8e2c1a.jsonl"), format!("{{\"sessionId\":\"{ID}\"}}")).unwrap();
        assert!(gemini_has_session_in(&root, ID));
        assert!(!gemini_has_session_in(&root, "0f8e2c1a-0000-4000-8000-000000000000"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_the_new_codex_session_for_a_folder() {
        let root = scratch("codex");
        let work = root.join("work");
        let other = root.join("other");
        fs::create_dir_all(&work).unwrap();
        fs::create_dir_all(&other).unwrap();
        let day = root.join("sessions/2026/10/01");
        fs::create_dir_all(&day).unwrap();
        let rollout = |id: &str, cwd: &Path, originator: &str, source: serde_json::Value| {
            let mut file = fs::File::create(day.join(format!("rollout-2026-10-01T10-00-00-{id}.jsonl"))).unwrap();
            let meta = serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "originator": originator, "source": source}});
            writeln!(file, "{meta}").unwrap();
        };
        let since = SystemTime::now();
        rollout("aaaaaaaa-0000-4000-8000-000000000000", &work, "codex-tui", serde_json::json!({"subagent": {"other": "guardian"}}));
        rollout("aaaaaaaa-0000-4000-8000-000000000001", &other, "codex-tui", "cli".into());
        rollout("aaaaaaaa-0000-4000-8000-000000000002", &work, "codex_exec", "exec".into());
        rollout("aaaaaaaa-0000-4000-8000-000000000003", &work, "codex-tui", "cli".into());

        let none = HashSet::new();
        assert_eq!(find_new_codex_session_in(&root, &work, since, &none).as_deref(), Some("aaaaaaaa-0000-4000-8000-000000000003"));
        let claimed = HashSet::from(["aaaaaaaa-0000-4000-8000-000000000003".to_string()]);
        assert_eq!(find_new_codex_session_in(&root, &work, since, &claimed).as_deref(), Some("aaaaaaaa-0000-4000-8000-000000000002"));
        let later = SystemTime::now() + Duration::from_secs(60);
        assert_eq!(find_new_codex_session_in(&root, &work, later, &none), None);
        assert!(codex_has_session_in(&root, "aaaaaaaa-0000-4000-8000-000000000001"));
        assert!(!codex_has_session_in(&root, ID));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picks_the_new_opencode_session_for_a_folder() {
        let root = scratch("opencode");
        let since = SystemTime::now();
        let now = since.duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let list = serde_json::json!([
            {"id": "ses_old", "created": now - 600_000, "directory": root},
            {"id": "ses_elsewhere", "created": now + 1000, "directory": "/somewhere/else"},
            {"id": "ses_second", "created": now + 3000, "directory": root},
            {"id": "ses_first", "created": now + 2000, "directory": root},
        ]);
        let json = serde_json::to_vec(&list).unwrap();
        let none = HashSet::new();
        assert_eq!(pick_opencode_session(&json, &root, since, &none).as_deref(), Some("ses_first"));
        let claimed = HashSet::from(["ses_first".to_string()]);
        assert_eq!(pick_opencode_session(&json, &root, since, &claimed).as_deref(), Some("ses_second"));
        assert_eq!(pick_opencode_session(b"", &root, since, &none), None);
        fs::remove_dir_all(root).unwrap();
    }
}

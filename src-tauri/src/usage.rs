//! How much each AI CLI has been used lately, read from the records each one keeps on disk.
//!
//! Claude Code and Codex save token counts with every reply; OpenCode keeps totals per session in
//! its database. Antigravity CLI keeps none on disk. Live subscription limits come from `subscriptions`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::env;
use crate::subscriptions;
use crate::tools::{self, Tool};

/// Usage is grouped into quarter hours, which the window adds up into local days: every time zone
/// offset is a multiple of fifteen minutes.
const BUCKET_MS: i64 = 15 * 60 * 1000;
const LOOKBACK: Duration = Duration::from_secs(8 * 24 * 3600);

/// `input` and `output` are new tokens; `cached` is context the AI re-read from its cache, which
/// is usually far larger and counts for much less. `tokens` is all three together.
#[derive(Default, Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Amount {
    tokens: u64,
    input: u64,
    output: u64,
    cached: u64,
    replies: u64,
    cost: f64,
}

impl Amount {
    fn add(&mut self, other: &Amount) {
        self.tokens += other.tokens;
        self.input += other.input;
        self.output += other.output;
        self.cached += other.cached;
        self.replies += other.replies;
        self.cost += other.cost;
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    start: i64,
    #[serde(flatten)]
    amount: Amount,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    id: Tool,
    buckets: Vec<Bucket>,
    limits: Vec<Limit>,
    plan: Option<String>,
    problem: Option<String>,
    limits_updated_at: Option<i64>,
    limits_problem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    generated_at: i64,
    tools: Vec<ToolUsage>,
}

#[derive(Clone, Debug)]
struct Event {
    at: i64,
    /// Claude Code can save the same reply in more than one transcript.
    key: Option<String>,
    amount: Amount,
}

#[derive(Clone, Default)]
struct Parsed {
    events: Vec<Event>,
    /// The newest rate-limit snapshot in the file (Codex), with its time.
    limits: Option<(i64, Value)>,
    /// Bytes read so far. Transcripts only grow, so the next read continues from here.
    read_to: u64,
    /// Codex's running totals as of `read_to`.
    totals: [u64; 4],
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Days since 1970-01-01 for a calendar date (proleptic Gregorian).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Milliseconds since the epoch for an ISO 8601 time such as `2026-10-02T00:36:21.087Z`.
pub(crate) fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    let num = |range: std::ops::Range<usize>| -> Option<i64> { text.get(range)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let days = days_from_civil(num(0..4)?, num(5..7)?, num(8..10)?);
    let mut ms = ((days * 24 + num(11..13)?) * 60 + num(14..16)?) * 60_000 + num(17..19)? * 1000;
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction.chars().take_while(char::is_ascii_digit).collect();
        let padded = format!("{digits:0<3}");
        ms += padded[..3].parse::<i64>().ok()?;
        rest = &fraction[digits.len()..];
    }
    match rest {
        "" | "Z" | "z" => Some(ms),
        offset if offset.len() == 6 && (offset.starts_with('+') || offset.starts_with('-')) => {
            let minutes = offset[1..3].parse::<i64>().ok()? * 60 + offset[4..6].parse::<i64>().ok()?;
            let sign = if offset.starts_with('+') { 1 } else { -1 };
            Some(ms - sign * minutes * 60_000)
        }
        _ => None,
    }
}

/// Files under `root` (a few folders deep) changed since `since`, with their size and time.
fn recent_files(root: &Path, depth: usize, since: SystemTime, wanted: &dyn Fn(&str) -> bool) -> Vec<(PathBuf, SystemTime, u64)> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return found };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                found.extend(recent_files(&path, depth - 1, since, wanted));
            }
        } else if let Ok(modified) = meta.modified() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if modified >= since && wanted(&name) {
                found.push((path, modified, meta.len()));
            }
        }
    }
    found
}

type Parser = fn(&Path, &mut Parsed);
type Cache = HashMap<PathBuf, (SystemTime, u64, Parsed)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Parse a file, reusing the last result while it's unchanged and reading only what was added
/// since when it has grown.
fn parse_cached(path: &Path, modified: SystemTime, len: u64, parse: Parser) -> Parsed {
    let previous = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(path).cloned();
    let mut parsed = match previous {
        Some((m, l, parsed)) if m == modified && l == len => return parsed,
        Some((_, l, parsed)) if len >= l => parsed,
        _ => Parsed::default(),
    };
    parse(path, &mut parsed);
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), (modified, len, parsed.clone()));
    parsed
}

/// Complete lines added since `parsed.read_to`; a line still being written waits for the next read.
fn new_lines(path: &Path, parsed: &mut Parsed) -> Vec<String> {
    let mut bytes = Vec::new();
    let read = fs::File::open(path).and_then(|mut file| {
        file.seek(SeekFrom::Start(parsed.read_to))?;
        file.read_to_end(&mut bytes)
    });
    if read.is_err() {
        return Vec::new();
    }
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    parsed.read_to += complete as u64;
    String::from_utf8_lossy(&bytes[..complete]).lines().map(String::from).collect()
}

/// Claude Code transcripts: every assistant reply carries `message.usage`.
fn claude_file(path: &Path, parsed: &mut Parsed) {
    for line in new_lines(path, parsed) {
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        let usage = &record["message"]["usage"];
        if record["type"] != "assistant" || !usage.is_object() {
            continue;
        }
        let Some(at) = record["timestamp"].as_str().and_then(parse_iso_ms) else { continue };
        let n = |key: &str| usage[key].as_u64().unwrap_or(0);
        let (input, output) = (n("input_tokens"), n("output_tokens"));
        let cached = n("cache_read_input_tokens") + n("cache_creation_input_tokens");
        let key = format!("{}:{}", record["message"]["id"].as_str().unwrap_or(""), record["requestId"].as_str().unwrap_or(""));
        let amount = Amount { tokens: input + output + cached, input, output, cached, replies: 1, cost: 0.0 };
        parsed.events.push(Event { at, key: Some(key), amount });
    }
}

/// Codex sessions: `token_count` events carry running totals for the session and, with a
/// ChatGPT plan, the current rate limits. Codex counts cached tokens as part of the input.
fn codex_file(path: &Path, parsed: &mut Parsed) {
    for line in new_lines(path, parsed) {
        if !line.contains("\"token_count\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else { continue };
        let payload = &record["payload"];
        if payload["type"] != "token_count" {
            continue;
        }
        let Some(at) = record["timestamp"].as_str().and_then(parse_iso_ms) else { continue };
        if payload["rate_limits"].is_object() {
            parsed.limits = Some((at, payload["rate_limits"].clone()));
        }
        let total = &payload["info"]["total_token_usage"];
        if !total.is_object() {
            continue;
        }
        let n = |key: &str| total[key].as_u64().unwrap_or(0);
        let current = [n("total_tokens"), n("input_tokens"), n("output_tokens"), n("cached_input_tokens")];
        let previous = parsed.totals;
        if current[0] > previous[0] {
            let delta = |i: usize| current[i].saturating_sub(previous[i]);
            let amount = Amount { tokens: delta(0), input: delta(1).saturating_sub(delta(3)), output: delta(2), cached: delta(3), replies: 1, cost: 0.0 };
            parsed.events.push(Event { at, key: None, amount });
        }
        parsed.totals = current;
    }
}

fn codex_limits(snapshot: &Value) -> (Vec<Limit>, Option<String>) {
    let limits = ["primary", "secondary"]
        .iter()
        .filter_map(|window| {
            let w = &snapshot[*window];
            Some(Limit {
                label: window_label(w["window_minutes"].as_u64().unwrap_or(0)),
                used_percent: w["used_percent"].as_f64()?,
                resets_at: w["resets_at"].as_i64().map(|seconds| seconds * 1000),
            })
        })
        .collect();
    (limits, snapshot["plan_type"].as_str().map(String::from))
}

fn window_label(minutes: u64) -> String {
    match minutes {
        10_080 => "weekly".into(),
        m if m > 0 && m % 1440 == 0 => format!("{}-day", m / 1440),
        m if m > 0 && m % 60 == 0 => format!("{}-hour", m / 60),
        m => format!("{m}-minute"),
    }
}

type OpencodeCache = (SystemTime, Instant, Result<Vec<Event>, String>);
static OPENCODE_CACHE: Mutex<Option<OpencodeCache>> = Mutex::new(None);

/// When OpenCode's database last changed, or None if OpenCode has never saved anything.
fn opencode_changed() -> Option<SystemTime> {
    let data = env::var("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| env::home_dir().join(".local/share"));
    ["opencode.db", "opencode.db-wal"]
        .iter()
        .filter_map(|name| fs::metadata(data.join("opencode").join(name)).and_then(|m| m.modified()).ok())
        .max()
}

/// Starting OpenCode takes a moment, so it's only asked again once its database has changed.
fn opencode_events_cached(program: &Path, since_ms: i64) -> Result<Vec<Event>, String> {
    let Some(changed) = opencode_changed() else { return Ok(Vec::new()) };
    if let Some((when, asked, result)) = OPENCODE_CACHE.lock().unwrap().as_ref() {
        if *when == changed && asked.elapsed() < Duration::from_secs(600) {
            return result.clone();
        }
    }
    let result = opencode_events(program, since_ms);
    // Reading the database can touch its files, so note the time after asking, not before.
    let after = opencode_changed().unwrap_or(changed);
    *OPENCODE_CACHE.lock().unwrap() = Some((after, Instant::now(), result.clone()));
    result
}

/// OpenCode keeps totals per session in its database, which `opencode db` can query.
fn opencode_events(program: &Path, since_ms: i64) -> Result<Vec<Event>, String> {
    let sql = format!(
        "select (time_created / {BUCKET_MS}) * {BUCKET_MS} as start, count(*) as sessions, \
         coalesce(sum(tokens_input), 0) as input, coalesce(sum(tokens_output), 0) as output, \
         coalesce(sum(tokens_reasoning), 0) as reasoning, coalesce(sum(tokens_cache_read), 0) as cache_read, \
         coalesce(sum(tokens_cache_write), 0) as cache_write, coalesce(sum(cost), 0) as cost \
         from session where time_created >= {since_ms} group by start"
    );
    let out = env::run_captured(env::probe_command(program, &["db", &sql, "--format", "json"]), Duration::from_secs(30))
        .ok_or("OpenCode didn't respond.")?;
    if !out.success {
        return Err("This version of OpenCode can't report usage.".into());
    }
    Ok(opencode_events_from_json(&out.stdout))
}

fn opencode_events_from_json(json: &[u8]) -> Vec<Event> {
    let rows: Vec<Value> = serde_json::from_slice(json).unwrap_or_default();
    rows.iter()
        .filter_map(|row| {
            let n = |key: &str| row[key].as_u64().or_else(|| row[key].as_f64().map(|f| f as u64)).unwrap_or(0);
            let (input, output) = (n("input"), n("output") + n("reasoning"));
            let cached = n("cache_read") + n("cache_write");
            let amount = Amount { tokens: input + output + cached, input, output, cached, replies: n("sessions"), cost: row["cost"].as_f64().unwrap_or(0.0) };
            Some(Event { at: row["start"].as_i64()?, key: None, amount })
        })
        .collect()
}

fn into_buckets(events: impl IntoIterator<Item = Event>, since_ms: i64) -> Vec<Bucket> {
    let mut seen = HashSet::new();
    let mut grouped: BTreeMap<i64, Amount> = BTreeMap::new();
    for event in events {
        if event.at < since_ms || event.key.as_ref().is_some_and(|key| !seen.insert(key.clone())) {
            continue;
        }
        grouped.entry(event.at.div_euclid(BUCKET_MS) * BUCKET_MS).or_default().add(&event.amount);
    }
    grouped.into_iter().map(|(start, amount)| Bucket { start, amount }).collect()
}

fn usage_from_files(id: Tool, files: Vec<(PathBuf, SystemTime, u64)>, parse: Parser, since_ms: i64) -> ToolUsage {
    let parsed: Vec<Parsed> = files.iter().map(|(path, modified, len)| parse_cached(path, *modified, *len, parse)).collect();
    let newest_limits = parsed.iter().filter_map(|p| p.limits.as_ref()).max_by_key(|(at, _)| *at);
    let (limits, plan) = newest_limits.map(|(_, snapshot)| codex_limits(snapshot)).unwrap_or_default();
    let buckets = into_buckets(parsed.into_iter().flat_map(|p| p.events), since_ms);
    ToolUsage { id, buckets, limits, plan, problem: None, limits_updated_at: None, limits_problem: None }
}

fn home_dir_from(var: &str, fallback: &str) -> PathBuf {
    env::var(var).map(PathBuf::from).unwrap_or_else(|| env::home_dir().join(fallback))
}

pub fn report(tool_paths: &HashMap<String, String>, refresh_limits: bool) -> UsageReport {
    let since = SystemTime::now() - LOOKBACK;
    let since_ms = now_ms() - LOOKBACK.as_millis() as i64;
    let opencode_path = tool_paths.get("opencode").cloned();
    let codex_path = tool_paths.get("codex").cloned();

    let claude = thread::spawn(move || {
        let root = home_dir_from("CLAUDE_CONFIG_DIR", ".claude");
        let mut usage = usage_from_files(Tool::Claude, recent_files(&root.join("projects"), 4, since, &|n| n.ends_with(".jsonl")), claude_file, since_ms);
        apply_subscription(&mut usage, subscriptions::claude(&root, refresh_limits));
        usage
    });
    let codex = thread::spawn(move || {
        let sessions = home_dir_from("CODEX_HOME", ".codex").join("sessions");
        let rollout = |n: &str| n.starts_with("rollout-") && n.ends_with(".jsonl");
        let mut usage = usage_from_files(Tool::Codex, recent_files(&sessions, 3, since, &rollout), codex_file, since_ms);
        apply_subscription(&mut usage, subscriptions::codex(codex_path.as_deref(), refresh_limits));
        usage
    });
    // Antigravity CLI only shows its usage inside a chat (`/usage`), so there is nothing to read.
    let agy = thread::spawn(|| ToolUsage { id: Tool::Agy, buckets: Vec::new(), limits: Vec::new(), plan: None,
        problem: Some("Antigravity CLI doesn't save usage on this computer. Type /usage in a chat to see it.".into()),
        limits_updated_at: None, limits_problem: None });
    let opencode = thread::spawn(move || {
        let mut usage = ToolUsage { id: Tool::Opencode, buckets: Vec::new(), limits: Vec::new(), plan: None, problem: None, limits_updated_at: None, limits_problem: None };
        match tools::resolve(Tool::Opencode, opencode_path.as_deref()) {
            Ok(program) => match opencode_events_cached(&program, since_ms) {
                Ok(events) => usage.buckets = into_buckets(events, since_ms),
                Err(problem) => usage.problem = Some(problem),
            },
            Err(_) => usage.problem = Some("OpenCode isn't installed.".into()),
        }
        usage
    });

    let empty = |id| ToolUsage { id, buckets: Vec::new(), limits: Vec::new(), plan: None, problem: Some("Couldn't read the usage records.".into()), limits_updated_at: None, limits_problem: None };
    let tools = [(Tool::Claude, claude), (Tool::Codex, codex), (Tool::Agy, agy), (Tool::Opencode, opencode)]
        .into_iter()
        .map(|(id, handle)| handle.join().unwrap_or_else(|_| empty(id)))
        .collect();
    UsageReport { generated_at: now_ms(), tools }
}

#[tauri::command]
pub async fn usage_summary(tool_paths: HashMap<String, String>, refresh_limits: Option<bool>) -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(move || report(&tool_paths, refresh_limits.unwrap_or(false))).await.map_err(|e| e.to_string())
}

fn apply_subscription(usage: &mut ToolUsage, snapshot: subscriptions::Snapshot) {
    // A transcript can belong to a previous login; only the current account supplies quotas.
    usage.limits = snapshot.limits;
    usage.plan = snapshot.plan;
    usage.limits_updated_at = snapshot.updated_at;
    usage.limits_problem = snapshot.problem;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-workbench-usage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_lines(path: &Path, lines: &[Value]) {
        let mut file = fs::File::create(path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    #[test]
    fn reads_iso_times() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-10-02T00:36:21.087Z"), Some(1_790_901_381_087));
        assert_eq!(parse_iso_ms("2026-10-02T02:36:21.087+02:00"), Some(1_790_901_381_087));
        assert_eq!(parse_iso_ms("2026-10-02T00:36:21.5Z"), Some(1_790_901_381_500));
        assert_eq!(parse_iso_ms("yesterday"), None);
    }

    #[test]
    fn claude_replies_count_once_even_when_saved_twice() {
        let dir = scratch("claude");
        let reply = |id: &str, time: &str| serde_json::json!({
            "type": "assistant", "timestamp": time, "requestId": format!("req-{id}"),
            "message": {"id": id, "usage": {"input_tokens": 2, "output_tokens": 190, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000}}
        });
        let user = serde_json::json!({"type": "user", "timestamp": "2026-10-02T10:00:00Z", "message": {"content": "hi"}});
        write_lines(&dir.join("a.jsonl"), &[user, reply("m1", "2026-10-02T10:00:05Z"), reply("m2", "2026-10-02T10:20:00Z")]);
        write_lines(&dir.join("b.jsonl"), &[reply("m1", "2026-10-02T10:00:05Z")]);
        let parse = |file: &str| { let mut parsed = Parsed::default(); claude_file(&dir.join(file), &mut parsed); parsed.events };
        let events: Vec<Event> = ["a.jsonl", "b.jsonl"].iter().flat_map(|f| parse(f)).collect();
        assert_eq!(events.len(), 3);
        let buckets = into_buckets(events, 0);
        assert_eq!(buckets.len(), 2, "10:00 and 10:15 quarter hours");
        assert_eq!(buckets[0].amount, Amount { tokens: 1292, input: 2, output: 190, cached: 1100, replies: 1, cost: 0.0 });
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_running_totals_become_per_reply_usage_and_limits() {
        let dir = scratch("codex");
        let count = |time: &str, total: u64, output: u64, used: f64| serde_json::json!({
            "timestamp": time, "type": "event_msg",
            "payload": {"type": "token_count",
                "info": {"total_token_usage": {"input_tokens": total - output, "cached_input_tokens": (total - output) / 2, "output_tokens": output, "total_tokens": total}},
                "rate_limits": {"plan_type": "plus",
                    "primary": {"used_percent": used, "window_minutes": 300, "resets_at": 1_790_907_855},
                    "secondary": {"used_percent": 12.0, "window_minutes": 10080, "resets_at": 1_791_048_939}}}
        });
        let file = dir.join("rollout-x.jsonl");
        write_lines(&file, &[count("2026-10-02T10:00:00Z", 1000, 100, 5.0), count("2026-10-02T10:00:01Z", 1000, 100, 5.0)]);
        let mut parsed = Parsed::default();
        codex_file(&file, &mut parsed);
        // The session goes on: only the new line is read, continuing from the running totals.
        let mut more = fs::OpenOptions::new().append(true).open(&file).unwrap();
        writeln!(more, "{}", count("2026-10-02T10:30:00Z", 3000, 300, 7.0)).unwrap();
        write!(more, "{{\"timestamp\": \"2026-10-02T10:31:00Z\", \"type\": \"event_msg\", \"payl").unwrap();
        codex_file(&file, &mut parsed);
        let tokens: Vec<u64> = parsed.events.iter().map(|e| e.amount.tokens).collect();
        assert_eq!(tokens, [1000, 2000], "a repeated total adds nothing, and a half-written line waits");
        assert_eq!(parsed.events[0].amount, Amount { tokens: 1000, input: 450, output: 100, cached: 450, replies: 1, cost: 0.0 });
        let (limits, plan) = codex_limits(&parsed.limits.unwrap().1);
        assert_eq!(plan.as_deref(), Some("plus"));
        assert_eq!(limits, [
            Limit { label: "5-hour".into(), used_percent: 7.0, resets_at: Some(1_790_907_855_000) },
            Limit { label: "weekly".into(), used_percent: 12.0, resets_at: Some(1_791_048_939_000) },
        ]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opencode_rows_become_buckets_with_cost() {
        let json = br#"[{"start": 1790901000000, "sessions": 2, "input": 100, "output": 40, "reasoning": 10, "cache_read": 500, "cache_write": 0, "cost": 0.0123}]"#;
        let events = opencode_events_from_json(json);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].amount, Amount { tokens: 650, input: 100, output: 50, cached: 500, replies: 2, cost: 0.0123 });
        assert!(opencode_events_from_json(b"").is_empty());
    }

    #[test]
    #[ignore = "reads the usage records on this computer"]
    fn prints_usage_on_this_computer() {
        let started = std::time::Instant::now();
        let usage = report(&HashMap::new(), false);
        println!("read in {:?}", started.elapsed());
        for tool in &usage.tools {
            let mut total = Amount::default();
            tool.buckets.iter().for_each(|b| total.add(&b.amount));
            println!("{:?}: {} new tokens ({} in, {} out), {} cached, {} replies, cost {:.2}, limits {:?}",
                tool.id, total.input + total.output, total.input, total.output, total.cached, total.replies, total.cost, tool.limits);
        }
        for attempt in 0..2 {
            let again = std::time::Instant::now();
            report(&HashMap::new(), false);
            println!("read again ({attempt}) in {:?}", again.elapsed());
        }
    }

    #[test]
    fn window_names() {
        assert_eq!(window_label(300), "5-hour");
        assert_eq!(window_label(10_080), "weekly");
        assert_eq!(window_label(1440), "1-day");
    }
}

//! The environment the AI CLIs run in.
//!
//! A desktop app doesn't start from the user's shell, so it misses whatever their shell profile
//! adds (PATH entries, API keys, version managers). On Unix we ask the login shell for its
//! environment once and give that to every CLI, the same way the CLIs would see it in a terminal.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Env = Vec<(OsString, OsString)>;

static RESOLVED: Mutex<Option<Env>> = Mutex::new(None);

/// Variables that would make a CLI think it runs inside another terminal, multiplexer or agent.
const TERMINAL_VARS: &[&str] = &[
    "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "COLORTERM", "COLORFGBG",
    "VTE_VERSION", "WT_SESSION", "WT_PROFILE_ID", "TMUX", "TMUX_PANE", "STY", "TERMINAL_EMULATOR",
    "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "GEMINI_CLI", "OPENCODE", "SHLVL", "PWD", "OLDPWD", "_",
    // Claude Code marks the processes it starts; a CLI that inherits these thinks it is a child
    // session and, among other things, stops saving its conversation.
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID",
];
const TERMINAL_PREFIXES: &[&str] = &[
    "KITTY_", "WEZTERM_", "GHOSTTY_", "ITERM_", "KONSOLE_", "ALACRITTY_", "VSCODE_", "ZELLIJ",
];

fn is_terminal_var(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    TERMINAL_VARS.contains(&key.as_ref()) || TERMINAL_PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Environment variable names are case-insensitive on Windows.
fn same_key(key: &OsStr, name: &str) -> bool {
    if cfg!(windows) {
        key.to_string_lossy().eq_ignore_ascii_case(name)
    } else {
        key == name
    }
}

pub fn home_dir() -> PathBuf {
    std::env::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// The user's environment, minus anything specific to the terminal this app was started from.
pub fn user_env() -> Env {
    RESOLVED.lock().unwrap().get_or_insert_with(resolve).clone()
}

/// Re-read the shell environment, e.g. after an install changed PATH.
pub fn refresh() {
    let fresh = resolve();
    *RESOLVED.lock().unwrap() = Some(fresh);
}

/// Look up a non-empty variable in the user's environment.
pub fn var(name: &str) -> Option<OsString> {
    user_env().into_iter().find(|(k, _)| same_key(k, name)).map(|(_, v)| v).filter(|v| !v.is_empty())
}

pub fn search_path() -> OsString {
    var("PATH").unwrap_or_default()
}

fn resolve() -> Env {
    #[cfg(unix)]
    let base = login_shell_env().unwrap_or_else(|| std::env::vars_os().collect());
    #[cfg(not(unix))]
    let base: Env = std::env::vars_os().collect();
    #[cfg(target_os = "linux")]
    let base = match std::env::var_os("APPDIR").filter(|dir| !dir.is_empty() && std::env::var_os("APPIMAGE").is_some()) {
        Some(appdir) => without_appimage_vars(base, &appdir),
        None => base,
    };

    let shell_path = base.iter().find(|(k, _)| same_key(k, "PATH")).map(|(_, v)| v.clone());
    let mut env: Env =
        base.into_iter().filter(|(k, _)| !same_key(k, "PATH") && !is_terminal_var(k)).collect();
    env.push(("PATH".into(), merged_path(shell_path)));
    env
}

/// The AppImage's launcher points GTK at the libraries inside the AppImage (and sets its theme).
/// Programs a CLI starts, like the browser it opens for signing in, would load those too.
#[cfg(target_os = "linux")]
fn without_appimage_vars(env: Env, appdir: &OsStr) -> Env {
    use std::os::unix::ffi::OsStrExt;
    let inside = |value: &OsStr| value.as_bytes().starts_with(appdir.as_bytes());
    env.into_iter()
        .filter_map(|(key, value)| match key.to_str() {
            Some("APPIMAGE" | "APPDIR" | "ARGV0" | "OWD" | "GTK_THEME") => None,
            Some("XDG_DATA_DIRS") => {
                let dirs: Vec<PathBuf> = std::env::split_paths(&value).filter(|dir| !inside(dir.as_os_str())).collect();
                (!dirs.is_empty()).then(|| (key, std::env::join_paths(dirs).unwrap_or_default()))
            }
            _ if inside(&value) => None,
            _ => Some((key, value)),
        })
        .collect()
}

/// PATH from the shell, then this process, then the folders CLI installers use by default.
fn merged_path(shell_path: Option<OsString>) -> OsString {
    let home = home_dir();
    let mut dirs: Vec<PathBuf> = Vec::new();
    // Installers update the registry, not the environment of an already-running desktop app.
    #[cfg(windows)]
    for path in windows_registered_paths() {
        dirs.extend(std::env::split_paths(&path));
    }
    for path in [shell_path, std::env::var_os("PATH")].into_iter().flatten() {
        dirs.extend(std::env::split_paths(&path));
    }
    for dir in [".local/bin", ".claude/local", ".opencode/bin", ".bun/bin", ".npm-global/bin",
        ".volta/bin", ".local/share/mise/shims", ".asdf/shims", ".cargo/bin"]
    {
        dirs.push(home.join(dir));
    }
    #[cfg(unix)]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        dirs.push(local.join("agy/bin"));
        dirs.push(local.join("Programs/nodejs"));
    }
    let mut seen = HashSet::new();
    dirs.retain(|dir| {
        !dir.as_os_str().is_empty() && std::env::join_paths([dir]).is_ok() && seen.insert(dir.clone())
    });
    std::env::join_paths(dirs).unwrap_or_default()
}

#[cfg(windows)]
fn windows_registered_paths() -> Vec<OsString> {
    use winreg::{enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE}, RegKey};
    [
        (HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
        (HKEY_CURRENT_USER, "Environment"),
    ]
    .into_iter()
    .filter_map(|(root, key)| RegKey::predef(root).open_subkey(key).ok()?.get_value::<String, _>("Path").ok())
    .map(|path| expand_windows_path(&path).into())
    .collect()
}

/// Registry PATH values can contain references such as %USERPROFILE% or %APPDATA%.
#[cfg(windows)]
fn expand_windows_path(path: &str) -> String {
    let mut expanded = String::new();
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        rest = &rest[start..];
        let Some(end) = rest[1..].find('%').map(|end| end + 1) else { break };
        let name = &rest[1..end];
        match std::env::var_os(name) {
            Some(value) => expanded.push_str(&value.to_string_lossy()),
            None => expanded.push_str(&rest[..=end]),
        }
        rest = &rest[end + 1..];
    }
    expanded.push_str(rest);
    expanded
}

/// Run the user's interactive login shell once and read back its environment.
#[cfg(unix)]
fn login_shell_env() -> Option<Env> {
    use std::os::unix::ffi::OsStringExt;
    const MARK: &str = "__AI_WORKBENCH_ENV__";
    let shell = std::env::var_os("SHELL").filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut cmd = Command::new(shell);
    cmd.arg("-ilc").arg(format!("printf '%s' {MARK}; env -0 2>/dev/null || env; printf '%s' {MARK}"));
    let out = run_captured(cmd, Duration::from_secs(6))?.stdout;
    let start = find(&out, MARK.as_bytes())? + MARK.len();
    let end = start + find(&out[start..], MARK.as_bytes())?;
    let body = &out[start..end];

    let entries: Vec<Vec<u8>> = if body.contains(&0) {
        body.split(|b| *b == 0).map(<[u8]>::to_vec).collect()
    } else {
        // Plain `env` (macOS): a line that doesn't start with NAME= continues the previous value.
        let mut joined: Vec<Vec<u8>> = Vec::new();
        for line in body.split(|b| *b == b'\n') {
            let starts_var = line.iter().position(|b| *b == b'=').is_some_and(|eq| {
                eq > 0 && line[..eq].iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
            });
            match joined.last_mut() {
                Some(last) if !starts_var => {
                    last.push(b'\n');
                    last.extend_from_slice(line);
                }
                _ => joined.push(line.to_vec()),
            }
        }
        joined
    };
    let env: Env = entries
        .into_iter()
        .filter_map(|mut entry| {
            let eq = entry.iter().position(|b| *b == b'=').filter(|eq| *eq > 0)?;
            let value = entry.split_off(eq + 1);
            entry.pop();
            Some((OsString::from_vec(entry), OsString::from_vec(value)))
        })
        .collect();
    (!env.is_empty()).then_some(env)
}

#[cfg(unix)]
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The full environment for a CLI running in one of our terminals.
pub fn terminal_env() -> Env {
    let mut env = user_env();
    #[cfg(unix)]
    env.push(("TERM".into(), "xterm-256color".into()));
    env.push(("COLORTERM".into(), "truecolor".into()));
    let has_locale = env.iter().any(|(k, v)| ["LANG", "LC_ALL", "LC_CTYPE"].iter().any(|n| same_key(k, n)) && !v.is_empty());
    if !has_locale {
        env.push(("LANG".into(), "en_US.UTF-8".into()));
    }
    env
}

pub struct Captured {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Captured {
    pub fn text(&self) -> String {
        format!("{}\n{}", String::from_utf8_lossy(&self.stdout), String::from_utf8_lossy(&self.stderr))
    }
}

/// Run a short command without a terminal, giving up after `timeout`.
pub fn run_captured(mut cmd: Command, timeout: Duration) -> Option<Captured> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let (tx, rx) = mpsc::channel();
    let pipes: [Option<Box<dyn Read + Send>>; 2] = [
        child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
        child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>),
    ];
    for (index, pipe) in pipes.into_iter().enumerate() {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            let _ = tx.send((index, buf));
        });
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    }?;
    let mut captured = Captured { success: status.success(), stdout: Vec::new(), stderr: Vec::new() };
    // Pipes close when the command exits, unless it left a background process holding them open.
    let drain_until = Instant::now() + Duration::from_millis(500);
    while let Ok((index, buf)) = rx.recv_timeout(drain_until.saturating_duration_since(Instant::now())) {
        if index == 0 {
            captured.stdout = buf;
        } else {
            captured.stderr = buf;
        }
    }
    Some(captured)
}

/// A short check (version, sign-in) that sees the same environment as the terminals.
pub fn probe_command(program: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    let mut cmd = if program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/d", "/c"]).arg(program);
        cmd
    } else {
        Command::new(program)
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(home_dir()).env_clear().envs(user_env());
    cmd
}

/// The user's interactive shell, for plain terminal panes.
pub fn user_shell() -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        let program = which::which_in("pwsh.exe", Some(search_path()), home_dir())
            .unwrap_or_else(|_| PathBuf::from("powershell.exe"));
        (program, vec!["-NoLogo".into()])
    }
    #[cfg(unix)]
    {
        let shell = var("SHELL").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/bin/sh"));
        // macOS terminals start login shells; Linux terminals start interactive non-login shells.
        let args = if cfg!(target_os = "macos") { vec!["-l".to_string()] } else { Vec::new() };
        (shell, args)
    }
}

/// A one-off shell command run in a terminal, such as an installer.
pub fn shell_command(command: &str) -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        // PowerShell otherwise exits successfully even when a native installer returns an error.
        let command = format!("$ErrorActionPreference = 'Stop'; $global:LASTEXITCODE = 0; try {{ {command}; if ($LASTEXITCODE -ne 0) {{ exit $LASTEXITCODE }} }} catch {{ Write-Error $_ -ErrorAction Continue; exit 1 }}");
        let mut args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"].map(String::from).to_vec();
        args.push(command);
        (PathBuf::from("powershell.exe"), args)
    }
    #[cfg(unix)]
    {
        (PathBuf::from("/bin/sh"), vec!["-c".to_string(), command.to_string()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_path_includes_native_and_npm_install_locations() {
        let path = merged_path(Some(OsString::from(r"C:\old-path")));
        let dirs: Vec<_> = std::env::split_paths(&path).collect();
        let local = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap());
        let roaming = PathBuf::from(std::env::var_os("APPDATA").unwrap());
        assert!(dirs.contains(&local.join("agy/bin")));
        assert!(dirs.contains(&roaming.join("npm")));
        // An installer can update the registry while the process still holds its old PATH.
        for registered in windows_registered_paths() {
            for dir in std::env::split_paths(&registered).filter(|dir| !dir.as_os_str().is_empty()) {
                assert!(dirs.contains(&dir), "missing registered PATH entry: {}", dir.display());
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn expands_registry_path_variables_without_dropping_unknown_variables() {
        let profile = std::env::var("USERPROFILE").unwrap();
        assert_eq!(expand_windows_path(r"%USERPROFILE%\bin;%AIW_UNKNOWN_PATH_VARIABLE%\bin"),
            format!(r"{profile}\bin;%AIW_UNKNOWN_PATH_VARIABLE%\bin"));
        assert_eq!(expand_windows_path("unfinished%"), "unfinished%");
    }

    #[cfg(windows)]
    #[test]
    fn probes_cmd_launchers_in_paths_with_spaces() {
        let dir = std::env::temp_dir().join(format!("aiw npm launcher {}", unique_test_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let launcher = dir.join("mock.cmd");
        std::fs::write(&launcher, "@echo off\r\nif \"%~1\"==\"--version\" (echo 1.2.3 & exit /b 0)\r\necho failed 1>&2\r\nexit /b 7\r\n").unwrap();
        let version = run_captured(probe_command(&launcher, &["--version"]), Duration::from_secs(5)).unwrap();
        let failure = run_captured(probe_command(&launcher, &["fail"]), Duration::from_secs(5)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(version.success, "{}", version.text());
        assert!(version.text().contains("1.2.3"));
        assert!(!failure.success);
        assert!(failure.text().contains("failed"));
    }

    #[cfg(windows)]
    fn unique_test_id() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[cfg(windows)]
    #[test]
    fn installer_shell_reports_native_and_powershell_failures() {
        for (script, success) in [("cmd.exe /d /c exit 7", false), ("throw 'install failed'", false), ("Write-Output installed", true)] {
            let (program, args) = shell_command(script);
            let args: Vec<_> = args.iter().map(String::as_str).collect();
            let out = run_captured(probe_command(&program, &args), Duration::from_secs(10)).unwrap();
            assert_eq!(out.success, success, "{script}: {}", out.text());
        }
    }

    #[test]
    fn strips_variables_from_the_launching_terminal() {
        for key in ["TERM_PROGRAM", "KITTY_WINDOW_ID", "GHOSTTY_RESOURCES_DIR", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "TMUX"] {
            assert!(is_terminal_var(OsStr::new(key)), "{key} should be stripped");
        }
        for key in ["PATH", "HOME", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "OPENCODE_CONFIG"] {
            assert!(!is_terminal_var(OsStr::new(key)), "{key} should be kept");
        }
    }

    #[cfg(unix)]
    #[test]
    fn captures_output_and_gives_up_on_slow_commands() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf out; printf err >&2; exit 3"]);
        let done = run_captured(cmd, Duration::from_secs(5)).expect("command runs");
        assert!(!done.success);
        assert_eq!(done.stdout, b"out");
        assert_eq!(done.stderr, b"err");

        let mut slow = Command::new("sh");
        slow.args(["-c", "sleep 5"]);
        let started = Instant::now();
        assert!(run_captured(slow, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn leaves_out_what_an_appimage_launcher_sets() {
        let mount = "/tmp/.mount_AI.WorX1y2z3";
        let env: Env = [
            ("APPIMAGE", "/home/u/Apps/AI.Workbench.AppImage"),
            ("APPDIR", mount),
            ("GTK_PATH", "/tmp/.mount_AI.WorX1y2z3//usr/lib/gtk-3.0"),
            ("GIO_MODULE_DIR", "/tmp/.mount_AI.WorX1y2z3//usr/lib/gio/modules"),
            ("GTK_THEME", "Adwaita:dark"),
            ("XDG_DATA_DIRS", "/tmp/.mount_AI.WorX1y2z3/usr/share:/usr/share:/usr/local/share"),
            ("HOME", "/home/u"),
        ]
        .into_iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
        let kept: Vec<(String, String)> = without_appimage_vars(env, OsStr::new(mount))
            .into_iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
            .collect();
        assert_eq!(kept, [("XDG_DATA_DIRS".into(), "/usr/share:/usr/local/share".into()), ("HOME".into(), "/home/u".into())]);
    }

    #[test]
    fn terminal_env_has_one_path_and_no_outside_terminal() {
        let env = terminal_env();
        assert_eq!(env.iter().filter(|(k, _)| same_key(k, "PATH")).count(), 1);
        assert!(!env.iter().any(|(k, _)| k == "TERM_PROGRAM"));
        #[cfg(unix)]
        assert!(env.iter().any(|(k, v)| k == "TERM" && v == "xterm-256color"));
    }
}

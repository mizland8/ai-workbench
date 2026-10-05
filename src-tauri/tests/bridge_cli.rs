//! Exercise the installed executable's CLI branch without opening a desktop window.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::Duration;

#[test]
fn native_client_routes_named_tasks_and_multiline_stdin_without_opening_a_gui() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let server = std::thread::spawn(move || {
        for method in [
            "list", "read", "send", "tasks", "task", "complete", "fail", "inbox", "ack",
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["token"], "test-private-token");
            assert_eq!(request["method"], method);
            if !["list", "tasks", "inbox"].contains(&method) {
                assert_eq!(request["target"], "Grapple Animations");
            }
            if ["send", "complete", "fail"].contains(&method) {
                assert_eq!(request["prompt"], "Implement grapples\nReview the result");
            }
            writeln!(stream, "{}", json!({ "ok": true, "method": method })).unwrap();
        }
    });
    for method in [
        "list", "read", "send", "tasks", "task", "complete", "fail", "inbox", "ack",
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_ai-workbench"));
        command
            .args(["bridge", method])
            .env("AI_WORKBENCH_BRIDGE", &address)
            .env("AI_WORKBENCH_TOKEN", "test-private-token");
        if !["list", "tasks", "inbox"].contains(&method) {
            command.arg("Grapple Animations");
        }
        if ["send", "complete", "fail"].contains(&method) {
            command.arg("-");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        if ["send", "complete", "fail"].contains(&method) {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"Implement grapples\nReview the result")
                .unwrap();
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["ok"], true);
        assert_eq!(response["method"], method);
    }
    server.join().unwrap();
}

#[test]
fn help_needs_no_session_and_missing_credentials_fail_cleanly() {
    let program = env!("CARGO_BIN_EXE_ai-workbench");
    let help = Command::new(program)
        .args(["bridge", "help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(
        serde_json::from_slice::<Value>(&help.stdout).unwrap()["instructions"]
            .as_str()
            .unwrap()
            .contains("bridge send")
    );
    let missing = Command::new(program)
        .args(["bridge", "list"])
        .env_remove("AI_WORKBENCH_BRIDGE")
        .env_remove("AI_WORKBENCH_TOKEN")
        .output()
        .unwrap();
    assert!(!missing.status.success());
    assert!(serde_json::from_slice::<Value>(&missing.stderr).unwrap()["error"].is_string());
}

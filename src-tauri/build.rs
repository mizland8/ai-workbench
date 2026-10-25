fn main() {
    let root = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let source = root.join("../network");
    for path in ["go.mod", "go.sum", "netcore", "cmd"] {
        println!("cargo:rerun-if-changed={}", source.join(path).display());
    }
    println!("cargo:rerun-if-env-changed=GO");
    let os = match std::env::var("CARGO_CFG_TARGET_OS").unwrap().as_str() {
        "macos" => "darwin",
        "windows" => "windows",
        "linux" => "linux",
        other => panic!("Unsupported network platform {other}"),
    };
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").unwrap().as_str() {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => panic!("Unsupported network architecture {other}"),
    };
    let binary =
        std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("workbench-network.bin");
    let result = std::process::Command::new(std::env::var("GO").unwrap_or("go".into()))
        .current_dir(source)
        .env("GOOS", os)
        .env("GOARCH", arch)
        .env("CGO_ENABLED", "0")
        .args(["build", "-p=2", "-trimpath", "-ldflags=-s -w", "-o"])
        .arg(binary)
        .arg("./cmd/workbench-network")
        .status()
        .expect("Go 1.27.3 is required to build Workbench's embedded networking");
    assert!(result.success(), "Embedded networking build failed");
    tauri_build::build()
}

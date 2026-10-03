mod env;
mod local_models;
mod sessions;
mod terminals;
mod tools;
mod usage;
mod subscriptions;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathInfo {
    exists: bool,
    is_dir: bool,
    name: String,
}

#[tauri::command]
fn path_info(path: String) -> PathInfo {
    let path = std::path::Path::new(&path);
    PathInfo {
        exists: path.exists(),
        is_dir: path.is_dir(),
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[tauri::command]
fn home_dir() -> String {
    env::home_dir().display().to_string()
}

/// How this copy of the app takes updates from the GitHub releases (`plugins.updater` in
/// tauri.conf.json). Installers, the AppImage, .deb and .rpm are each replaced by their own kind.
/// A plain Linux binary, like the one `scripts/install-linux.sh` installs, is replaced by the
/// plain binary that each release also carries.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSupport {
    /// The `latest.json` entry to install from, when the updater can't tell by itself.
    target: Option<String>,
    /// Whether the app can install the update itself; otherwise it links to the release.
    can_install: bool,
}

#[tauri::command]
fn update_support() -> UpdateSupport {
    #[cfg(target_os = "linux")]
    {
        use tauri::utils::{config::BundleType, platform};
        // The AppImage and the plain binary are swapped for the new file where they are.
        let replaceable = |file: Option<std::path::PathBuf>| file.as_deref().and_then(std::path::Path::parent).is_some_and(writable);
        match (platform::bundle_type(), std::env::var_os("APPIMAGE")) {
            // The package manager installs these, after asking for the password.
            (Some(BundleType::Deb | BundleType::Rpm), _) => UpdateSupport { target: None, can_install: true },
            (Some(BundleType::AppImage), Some(file)) => UpdateSupport { target: None, can_install: replaceable(Some(file.into())) },
            (None, None) => UpdateSupport {
                target: Some(format!("linux-{}-binary", std::env::consts::ARCH)),
                can_install: replaceable(platform::current_exe().ok()),
            },
            _ => UpdateSupport { target: None, can_install: false },
        }
    }
    #[cfg(not(target_os = "linux"))]
    UpdateSupport { target: None, can_install: true }
}

/// Whether the user may create and remove files in `dir`.
#[cfg(target_os = "linux")]
fn writable(dir: &std::path::Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(dir.as_os_str().as_bytes()).is_ok_and(|dir| unsafe { libc::access(dir.as_ptr(), libc::W_OK) } == 0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(terminals::Terminals::default())
        .setup(|_| {
            // Reading the login shell's environment takes a moment; start before the first chat needs it.
            std::thread::spawn(env::user_env);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            path_info,
            home_dir,
            update_support,
            tools::detect_tools,
            local_models::local_models,
            usage::usage_summary,
            terminals::terminal_start,
            terminals::terminal_write,
            terminals::terminal_resize,
            terminals::terminal_stop,
            terminals::terminal_stop_all,
        ])
        .build(tauri::generate_context!())
        .expect("error while building AI Workbench")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<terminals::Terminals>().stop_all(false);
            }
        });
}

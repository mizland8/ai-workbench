mod env;
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

/// Whether this copy of the app can replace itself with an update. On Linux only the AppImage
/// can; a copy built from source or installed from a .deb or .rpm is updated the way it came.
#[tauri::command]
fn can_self_update() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
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
            can_self_update,
            tools::detect_tools,
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

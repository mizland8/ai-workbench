#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    // GUI launches must not allocate a console. Explicit bridge commands can use their caller's
    // console; redirected stdin/stdout/stderr supplied by the caller remain available.
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("bridge") {
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
    }
    if let Some(code) = ai_workbench_lib::bridge::cli() {
        std::process::exit(code);
    }
    ai_workbench_lib::run();
}

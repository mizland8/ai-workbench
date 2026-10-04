fn main() {
    if let Some(code) = ai_workbench_lib::bridge::cli() { std::process::exit(code); }
    ai_workbench_lib::run();
}

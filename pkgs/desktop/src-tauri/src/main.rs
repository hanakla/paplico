#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg_attr(desktop, tauri_runtime_cef::cef_entry_point)]
fn main() {
    paplico_desktop::run()
}

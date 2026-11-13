const COMMANDS: &[&str] = &["query_local_fonts", "read_font", "read_font_range"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

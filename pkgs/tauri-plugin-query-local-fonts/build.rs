const COMMANDS: &[&str] = &["query_local_fonts", "read_font", "read_font_range",
    "has_native_change_events",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}

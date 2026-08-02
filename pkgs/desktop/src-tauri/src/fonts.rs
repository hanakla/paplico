use std::fs;
use std::path::Path;

const ALLOWED_EXTENSIONS: &[&str] = &["ttf", "ttc", "otf", "otc", "woff", "woff2"];

#[tauri::command]
pub fn load_font_data(path: String) -> Result<Vec<u8>, String> {
    let canonical = fs::canonicalize(&path)
        .map_err(|e| format!("Failed to resolve font path {}: {}", path, e))?;

    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !ALLOWED_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "Invalid font file extension '{}': {}",
            ext, path
        ));
    }

    fs::read(&canonical).map_err(|e| format!("Failed to read font file {}: {}", path, e))
}

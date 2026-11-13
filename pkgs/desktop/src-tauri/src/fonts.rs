use crate::allowed_path::resolve_allowed_path;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const ALLOWED_EXTENSIONS: &[&str] = &["ttf", "ttc", "otf", "otc", "woff", "woff2"];

#[tauri::command]
pub fn load_font_data(path: String) -> Result<Vec<u8>, String> {
    let canonical = resolve_font_path(&path)?;
    fs::read(&canonical).map_err(|e| format!("Failed to read font file {}: {}", path, e))
}

/// Read `length` bytes starting at `offset` so callers can inspect font
/// headers without transferring the whole file over IPC.
#[tauri::command]
pub fn read_font_range(path: String, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    let canonical = resolve_font_path(&path)?;
    let mut file = fs::File::open(&canonical)
        .map_err(|e| format!("Failed to open font file {}: {}", path, e))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("Failed to seek font file {}: {}", path, e))?;
    let mut buf = Vec::with_capacity(length as usize);
    file.take(length)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Failed to read font file {}: {}", path, e))?;
    Ok(buf)
}

fn resolve_font_path(path: &str) -> Result<PathBuf, String> {
    resolve_allowed_path(path, ALLOWED_EXTENSIONS, "font")
}

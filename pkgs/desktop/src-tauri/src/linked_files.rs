use crate::allowed_path::resolve_allowed_path;
use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;

// The web app decides which images it links to, in
// pkgs/web/src/stores/linkedFilesStore.ts. Keep this list equal to that one.
const ALLOWED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "avif"];

/// What tells an edited linked image from an untouched one without reading it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedImageStat {
    /// Milliseconds since the Unix epoch.
    modified_at: f64,
    size: f64,
}

/// Reads an image a document links to. Documents name these files by path,
/// so the read is limited to image files instead of the filesystem scope the
/// user granted through a dialog or a drop.
#[tauri::command]
pub async fn read_linked_image(path: String) -> Result<Response, String> {
    let canonical = resolve_allowed_path(&path, ALLOWED_EXTENSIONS, "linked image")?;
    fs::read(&canonical)
        .map(Response::new)
        .map_err(|e| format!("Failed to read linked image {}: {}", path, e))
}

/// Stats the images a document links to, in the order of `paths`. An image
/// that cannot be read comes back as `None`.
#[tauri::command]
pub async fn stat_linked_images(paths: Vec<String>) -> Vec<Option<LinkedImageStat>> {
    paths.iter().map(|path| stat_linked_image(path)).collect()
}

fn stat_linked_image(path: &str) -> Option<LinkedImageStat> {
    let canonical = resolve_allowed_path(path, ALLOWED_EXTENSIONS, "linked image").ok()?;
    let metadata = fs::metadata(canonical).ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;

    Some(LinkedImageStat {
        modified_at: modified.as_secs_f64() * 1000.0,
        size: metadata.len() as f64,
    })
}

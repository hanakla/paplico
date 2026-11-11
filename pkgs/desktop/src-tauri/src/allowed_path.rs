use std::fs;
use std::path::PathBuf;

/// Resolves `path` to the file it really names and accepts it only when that
/// file carries one of the `allowed` extensions. `kind` names the file in the
/// error message.
pub fn resolve_allowed_path(path: &str, allowed: &[&str], kind: &str) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|e| format!("Failed to resolve {} path {}: {}", kind, path, e))?;

    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Invalid {} file extension '{}': {}", kind, ext, path));
    }

    Ok(canonical)
}

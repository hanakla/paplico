use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use uuid::Uuid;

#[derive(Default)]
pub struct AutomationFileSystemState {
    accesses: Mutex<HashMap<String, AutomationAccess>>,
}

#[derive(Clone)]
enum AutomationAccess {
    File(PathBuf),
    Directory(PathBuf),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationFileDescriptor {
    token: String,
    name: String,
}

#[tauri::command]
pub async fn automation_open_files(
    app: AppHandle,
    state: State<'_, AutomationFileSystemState>,
    extensions: Option<Vec<String>>,
) -> Result<Vec<AutomationFileDescriptor>, String> {
    let mut dialog = app.dialog().file();
    if let Some(extensions) = extensions {
        let extensions = extensions
            .into_iter()
            .map(|extension| extension.trim_start_matches('.').to_owned())
            .collect::<Vec<_>>();
        if !extensions.is_empty() {
            let extension_refs = extensions.iter().map(String::as_str).collect::<Vec<_>>();
            dialog = dialog.add_filter("Files", &extension_refs);
        }
    }

    let Some(paths) = dialog.blocking_pick_files() else {
        return Ok(Vec::new());
    };

    let files = paths
        .into_iter()
        .map(|path| {
            let path = path.into_path().map_err(|error| error.to_string())?;
            let path = path.canonicalize().map_err(|error| error.to_string())?;
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| "Selected file has no valid name".to_owned())?
                .to_owned();
            Ok((path, name))
        })
        .collect::<Result<Vec<_>, String>>()?;

    files
        .into_iter()
        .map(|(path, name)| {
            let token = insert_access(state.inner(), AutomationAccess::File(path))?;
            Ok(AutomationFileDescriptor { token, name })
        })
        .collect()
}

#[tauri::command]
pub async fn automation_save_file(
    app: AppHandle,
    state: State<'_, AutomationFileSystemState>,
    file_name: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<Option<AutomationFileDescriptor>, String> {
    let mut dialog = app.dialog().file();
    if let Some(file_name) = file_name.as_deref() {
        dialog = dialog.set_file_name(file_name);
    }
    if let Some(extensions) = extensions {
        let extensions = extensions
            .into_iter()
            .map(|extension| extension.trim_start_matches('.').to_owned())
            .collect::<Vec<_>>();
        if !extensions.is_empty() {
            let extension_refs = extensions.iter().map(String::as_str).collect::<Vec<_>>();
            dialog = dialog.add_filter("Files", &extension_refs);
        }
    }

    let Some(path) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|error| error.to_string())?;

    // The destination usually does not exist yet, so only its parent can be
    // canonicalized.
    let parent = path
        .parent()
        .ok_or_else(|| "Selected path has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Selected path has no valid name".to_owned())?
        .to_owned();

    let token = insert_access(state.inner(), AutomationAccess::File(parent.join(&name)))?;
    Ok(Some(AutomationFileDescriptor { token, name }))
}

#[tauri::command]
pub fn automation_register_document_directory(
    app: AppHandle,
    state: State<'_, AutomationFileSystemState>,
    document_path: String,
) -> Result<Option<String>, String> {
    let document_path = Path::new(&document_path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !app.fs_scope().is_allowed(&document_path) {
        return Err("Document path was not selected by the application".to_owned());
    }
    let Some(parent) = document_path.parent() else {
        return Ok(None);
    };
    let parent = parent.canonicalize().map_err(|error| error.to_string())?;
    insert_access(state.inner(), AutomationAccess::Directory(parent)).map(Some)
}

#[tauri::command]
pub fn automation_read_file(
    state: State<'_, AutomationFileSystemState>,
    token: String,
    relative_path: Option<String>,
) -> Result<Vec<u8>, String> {
    read_file(state.inner(), &token, relative_path.as_deref())
}

#[tauri::command]
pub fn automation_write_file(
    state: State<'_, AutomationFileSystemState>,
    token: String,
    relative_path: Option<String>,
    bytes: Vec<u8>,
) -> Result<(), String> {
    write_file(state.inner(), &token, relative_path.as_deref(), &bytes)
}

#[tauri::command]
pub fn automation_create_directory(
    state: State<'_, AutomationFileSystemState>,
    token: String,
    relative_path: String,
) -> Result<String, String> {
    create_directory(state.inner(), &token, &relative_path)
}

#[tauri::command]
pub fn automation_directory_file(
    state: State<'_, AutomationFileSystemState>,
    token: String,
    relative_path: String,
    create: Option<bool>,
) -> Result<Option<AutomationFileDescriptor>, String> {
    directory_file(state.inner(), &token, &relative_path, create.unwrap_or(false))
}

#[tauri::command]
pub fn automation_revoke_access(
    state: State<'_, AutomationFileSystemState>,
    token: String,
) -> Result<(), String> {
    revoke_access(state.inner(), &token)
}

fn read_file(
    state: &AutomationFileSystemState,
    token: &str,
    relative_path: Option<&str>,
) -> Result<Vec<u8>, String> {
    let access = get_access(state, token)?;
    fs::read(resolve_path(&access, relative_path, false)?).map_err(|error| error.to_string())
}

fn write_file(
    state: &AutomationFileSystemState,
    token: &str,
    relative_path: Option<&str>,
    bytes: &[u8],
) -> Result<(), String> {
    let access = get_access(state, token)?;
    let path = resolve_path(&access, relative_path, true)?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn create_directory(
    state: &AutomationFileSystemState,
    token: &str,
    relative_path: &str,
) -> Result<String, String> {
    let AutomationAccess::Directory(root) = get_access(state, token)? else {
        return Err("A selected file does not accept a relative path".to_owned());
    };
    let path = resolve_directory_path(&root, relative_path, true)?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;

    // The leaf did not exist while it was resolved, so confirm the created
    // directory is still inside the root.
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.starts_with(&root) {
        return Err("Relative path escapes the document directory".to_owned());
    }
    insert_access(state, AutomationAccess::Directory(path))
}

fn directory_file(
    state: &AutomationFileSystemState,
    token: &str,
    relative_path: &str,
    create: bool,
) -> Result<Option<AutomationFileDescriptor>, String> {
    let AutomationAccess::Directory(root) = get_access(state, token)? else {
        return Err("A selected file does not accept a relative path".to_owned());
    };
    let path = resolve_directory_path(&root, relative_path, create)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Relative path has no file name".to_owned())?
        .to_owned();

    if create {
        // Appending nothing creates the file and leaves an existing one alone.
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
    } else if !path.is_file() {
        return Ok(None);
    }

    let token = insert_access(state, AutomationAccess::File(path))?;
    Ok(Some(AutomationFileDescriptor { token, name }))
}

fn revoke_access(state: &AutomationFileSystemState, token: &str) -> Result<(), String> {
    state
        .accesses
        .lock()
        .map_err(|_| "Automation file access registry is unavailable".to_owned())?
        .remove(token);
    Ok(())
}

fn insert_access(
    state: &AutomationFileSystemState,
    access: AutomationAccess,
) -> Result<String, String> {
    let token = Uuid::new_v4().to_string();
    state
        .accesses
        .lock()
        .map_err(|_| "Automation file access registry is unavailable".to_owned())?
        .insert(token.clone(), access);
    Ok(token)
}

fn get_access(state: &AutomationFileSystemState, token: &str) -> Result<AutomationAccess, String> {
    state
        .accesses
        .lock()
        .map_err(|_| "Automation file access registry is unavailable".to_owned())?
        .get(token)
        .cloned()
        .ok_or_else(|| "Automation file access token is invalid".to_owned())
}

fn resolve_path(
    access: &AutomationAccess,
    relative_path: Option<&str>,
    create_parents: bool,
) -> Result<PathBuf, String> {
    match access {
        AutomationAccess::File(path) => {
            if relative_path.is_some() {
                return Err("A selected file does not accept a relative path".to_owned());
            }
            Ok(path.clone())
        }
        AutomationAccess::Directory(root) => {
            let relative_path =
                relative_path.ok_or_else(|| "A relative path is required".to_owned())?;
            resolve_directory_path(root, relative_path, create_parents)
        }
    }
}

/// Accepts both `/` and `\` as separators whichever platform we run on, so a
/// script written on one machine resolves the same way on another. Splitting
/// would swallow a leading separator, so roots are rejected before that.
fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let rooted = relative_path.starts_with(['/', '\\'])
        || matches!(relative_path.as_bytes(), [drive, b':', ..] if drive.is_ascii_alphabetic());
    if rooted {
        return Err("Relative path must stay inside the document directory".to_owned());
    }
    Ok(relative_path
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .collect())
}

fn resolve_directory_path(
    root: &Path,
    relative_path: &str,
    create_parents: bool,
) -> Result<PathBuf, String> {
    let relative_path = normalize_relative_path(relative_path)?;
    if relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Relative path must stay inside the document directory".to_owned());
    }
    let relative_path = relative_path.as_path();

    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let parent = relative_path
        .parent()
        .ok_or_else(|| "Relative path has no parent".to_owned())?;
    let mut checked_parent = root.clone();

    for component in parent.components() {
        let Component::Normal(component) = component else {
            return Err("Relative path must stay inside the document directory".to_owned());
        };
        checked_parent.push(component);
        if checked_parent.exists() {
            checked_parent = checked_parent
                .canonicalize()
                .map_err(|error| error.to_string())?;
        } else if create_parents {
            fs::create_dir(&checked_parent).map_err(|error| error.to_string())?;
            checked_parent = checked_parent
                .canonicalize()
                .map_err(|error| error.to_string())?;
        }
        if !checked_parent.starts_with(&root) {
            return Err("Relative path escapes the document directory".to_owned());
        }
    }

    let file_name = relative_path
        .file_name()
        .ok_or_else(|| "Relative path has no file name".to_owned())?;
    let path = checked_parent.join(file_name);
    if path.exists() {
        let canonical_path = path.canonicalize().map_err(|error| error.to_string())?;
        if !canonical_path.starts_with(&root) {
            return Err("Relative path escapes the document directory".to_owned());
        }
        return Ok(canonical_path);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::{
        create_directory, directory_file, insert_access, read_file, resolve_directory_path,
        revoke_access, write_file, AutomationAccess, AutomationFileSystemState,
    };
    use std::fs;

    #[test]
    fn creates_nested_directories_inside_the_document_directory() {
        let root = test_directory("create-dir");
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();

        create_directory(&state, &token, "exports/renders").unwrap();
        assert!(root.join("exports/renders").is_dir());

        // Creating an existing directory is not an error.
        create_directory(&state, &token, "exports/renders").unwrap();

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_directories_from_either_separator() {
        let root = test_directory("create-dir-separators");
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();

        create_directory(&state, &token, "a\\b").unwrap();
        create_directory(&state, &token, "c/d").unwrap();

        assert!(root.join("a").join("b").is_dir());
        assert!(root.join("c").join("d").is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_through_a_file_taken_from_a_created_directory() {
        let root = test_directory("directory-file");
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();

        let nested = create_directory(&state, &token, "exports").unwrap();
        let descriptor = directory_file(&state, &nested, "note.txt", true)
            .unwrap()
            .unwrap();
        write_file(&state, &descriptor.token, None, b"done").unwrap();

        assert_eq!(descriptor.name, "note.txt");
        assert_eq!(fs::read(root.join("exports/note.txt")).unwrap(), b"done");

        // A file handle does not take a relative path of its own.
        assert!(write_file(&state, &descriptor.token, Some("other.txt"), b"x").is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_creates_a_missing_file_when_asked_to() {
        let root = test_directory("directory-file-create");
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();

        assert!(directory_file(&state, &token, "missing.txt", false)
            .unwrap()
            .is_none());
        assert!(!root.join("missing.txt").exists());

        assert!(directory_file(&state, &token, "deep/made.txt", true)
            .unwrap()
            .is_some());
        assert!(root.join("deep/made.txt").is_file());

        // Creating over an existing file keeps its contents.
        fs::write(root.join("kept.txt"), b"keep").unwrap();
        assert!(directory_file(&state, &token, "kept.txt", true)
            .unwrap()
            .is_some());
        assert_eq!(fs::read(root.join("kept.txt")).unwrap(), b"keep");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_files_outside_the_document_directory() {
        let root = test_directory("directory-file-outside");
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();

        assert!(directory_file(&state, &token, "../secret.txt", true).is_err());
        assert!(directory_file(&state, &token, "..\\secret.txt", true).is_err());
        assert!(directory_file(&state, &token, "\\secret.txt", true).is_err());
        assert!(directory_file(&state, &token, "C:\\secret.txt", true).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_creating_directories_outside_the_document_directory() {
        let root = test_directory("create-dir-outside");
        let state = AutomationFileSystemState::default();
        let directory = insert_access(&state, AutomationAccess::Directory(root.clone())).unwrap();
        let file = insert_access(&state, AutomationAccess::File(root.join("a.txt"))).unwrap();

        assert!(create_directory(&state, &directory, "../escaped").is_err());
        assert!(create_directory(&state, &directory, "/tmp/escaped").is_err());
        assert!(create_directory(&state, &file, "exports").is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_writes_and_revokes_selected_file_access() {
        let root = test_directory("selected-file");
        let path = root.join("selected.bin");
        fs::write(&path, [1, 2, 3]).unwrap();
        let state = AutomationFileSystemState::default();
        let token = insert_access(&state, AutomationAccess::File(path.clone())).unwrap();

        assert_eq!(read_file(&state, &token, None).unwrap(), [1, 2, 3]);
        write_file(&state, &token, None, &[4, 5, 6]).unwrap();
        assert_eq!(fs::read(&path).unwrap(), [4, 5, 6]);

        revoke_access(&state, &token).unwrap();
        assert!(read_file(&state, &token, None).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resolves_nested_files_inside_the_document_directory() {
        let root = test_directory("nested");
        let path = resolve_directory_path(&root, "exports/result.txt", true).unwrap();

        assert_eq!(path, root.join("exports/result.txt"));
        assert!(root.join("exports").is_dir());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_paths_outside_the_document_directory() {
        let root = test_directory("outside");

        assert!(resolve_directory_path(&root, "../secret.txt", false).is_err());
        assert!(resolve_directory_path(&root, "/tmp/secret.txt", false).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_document_directory() {
        use std::os::unix::fs::symlink;

        let root = test_directory("symlink-root");
        let outside = test_directory("symlink-outside");
        symlink(&outside, root.join("outside")).unwrap();

        assert!(resolve_directory_path(&root, "outside/secret.txt", false).is_err());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    fn test_directory(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "paplico-automation-fs-{name}-{}",
            std::process::id()
        ));
        if path.exists() {
            fs::remove_dir_all(&path).unwrap();
        }
        fs::create_dir(&path).unwrap();
        path.canonicalize().unwrap()
    }
}

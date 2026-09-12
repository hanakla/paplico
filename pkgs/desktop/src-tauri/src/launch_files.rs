//! Documents the OS asks the app to open through its file association:
//! command-line arguments on Windows and Linux, `RunEvent::Opened` on macOS.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_fs::FsExt;

pub const OPEN_FILES_EVENT: &str = "paplico:open-files";
const DOCUMENT_EXTENSION: &str = "papf";

/// Paths received before the webview subscribed to the open event.
/// `None` once the webview has drained it; later paths go out as events.
pub struct LaunchFilesState {
    pending: Mutex<Option<Vec<String>>>,
}

impl Default for LaunchFilesState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(Some(Vec::new())),
        }
    }
}

/// Grants the webview read access to each document and hands the paths over.
pub fn open_files<R: Runtime>(app: &AppHandle<R>, paths: impl IntoIterator<Item = PathBuf>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|path| is_document(path))
        .map(|path| {
            let _ = app.fs_scope().allow_file(&path);
            path.to_string_lossy().into_owned()
        })
        .collect();
    if paths.is_empty() {
        return;
    }

    let state = app.state::<LaunchFilesState>();
    let mut pending = state.pending.lock().unwrap();
    match pending.as_mut() {
        Some(buffer) => buffer.extend(paths),
        None => {
            let _ = app.emit(OPEN_FILES_EVENT, paths);
        }
    }
}

/// Returns the documents opened before the webview was listening and switches
/// later opens to the event.
#[tauri::command]
pub fn take_launch_files(state: State<'_, LaunchFilesState>) -> Vec<String> {
    state.pending.lock().unwrap().take().unwrap_or_default()
}

pub fn command_line_documents() -> impl Iterator<Item = PathBuf> {
    std::env::args_os().skip(1).map(PathBuf::from)
}

fn is_document(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(DOCUMENT_EXTENSION))
        && path.is_file()
}

//! Lists the fonts installed on the device in the shape the browser's
//! `window.queryLocalFonts()` returns, and reads their files.
//!
//! Each platform asks the OS for every font it can use, so fonts a font
//! manager activates count too: CoreText on macOS, DirectWrite on Windows and
//! the fontconfig directories elsewhere.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};

#[cfg_attr(target_os = "macos", path = "macos.rs")]
#[cfg_attr(windows, path = "windows.rs")]
#[cfg_attr(not(any(target_os = "macos", windows)), path = "fontdb.rs")]
mod platform;

/// The fields of a browser `FontData`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRecord {
    pub family: String,
    pub full_name: String,
    pub postscript_name: String,
    pub style: String,
}

/// A font the OS reported, with the file its data is read from.
pub struct LocalFont {
    pub record: FontRecord,
    pub path: PathBuf,
}

/// The files of the fonts the last query found, by PostScript name. Reads
/// accept only these, so the page can never name a file of its own.
#[derive(Default)]
struct FontFiles(Mutex<BTreeMap<String, PathBuf>>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("paplico-query-local-fonts")
        .invoke_handler(tauri::generate_handler![
            query_local_fonts,
            read_font,
            read_font_range
        ])
        .setup(|app, _api| {
            app.manage(FontFiles::default());
            Ok(())
        })
        .build()
}

/// Lists the fonts sorted by PostScript name, one per name, keeping only the
/// given names when there are any.
#[tauri::command]
async fn query_local_fonts(
    files: State<'_, FontFiles>,
    postscript_names: Option<Vec<String>>,
) -> Result<Vec<FontRecord>, String> {
    let fonts = tauri::async_runtime::spawn_blocking(platform::enumerate)
        .await
        .map_err(|e| e.to_string())?;

    let mut by_name = BTreeMap::new();
    for font in fonts {
        by_name
            .entry(font.record.postscript_name.clone())
            .or_insert(font);
    }

    *files.0.lock().map_err(|e| e.to_string())? = by_name
        .iter()
        .map(|(name, font)| (name.clone(), font.path.clone()))
        .collect();

    Ok(by_name
        .into_values()
        .filter(|font| {
            postscript_names
                .as_ref()
                .is_none_or(|names| names.contains(&font.record.postscript_name))
        })
        .map(|font| font.record)
        .collect())
}

/// Reads the whole file of a font the last query found.
#[tauri::command]
async fn read_font(
    files: State<'_, FontFiles>,
    postscript_name: String,
) -> Result<Response, String> {
    read(&files, &postscript_name, 0, u64::MAX).await
}

/// Reads `length` bytes from `offset` in the file of a font the last query
/// found, so a caller reading a table does not move the whole file.
#[tauri::command]
async fn read_font_range(
    files: State<'_, FontFiles>,
    postscript_name: String,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    read(&files, &postscript_name, offset, length).await
}

async fn read(
    files: &FontFiles,
    postscript_name: &str,
    offset: u64,
    length: u64,
) -> Result<Response, String> {
    let path = path_of(files, postscript_name)?;
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.take(length).read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(Response::new)
    .map_err(|e| e.to_string())
}

fn path_of(files: &FontFiles, postscript_name: &str) -> Result<PathBuf, String> {
    files
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(postscript_name)
        .cloned()
        .ok_or_else(|| format!("No local font is named {postscript_name}"))
}

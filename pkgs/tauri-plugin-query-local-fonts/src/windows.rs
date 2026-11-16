use crate::{FontRecord, LocalFont};
use std::path::PathBuf;
use std::sync::Arc;
use windows::core::{w, Interface, Result, BOOL, PCWSTR};
use windows::Win32::Graphics::DirectWrite::*;
use windows::Win32::System::Registry::{
    RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_NOTIFY, REG_NOTIFY_CHANGE_LAST_SET,
};

/// Lists every font in DirectWrite's system collection, the source Chrome
/// reads too. Faces DirectWrite only simulates are left out: they have no file
/// of their own.
pub fn enumerate() -> Vec<LocalFont> {
    fonts().unwrap_or_default()
}

fn fonts() -> Result<Vec<LocalFont>> {
    let factory: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)? };
    let mut collection = None;
    unsafe { factory.GetSystemFontCollection(&mut collection, true)? };
    let Some(collection) = collection else {
        return Ok(Vec::new());
    };

    let mut fonts = Vec::new();
    for family in 0..unsafe { collection.GetFontFamilyCount() } {
        let family = unsafe { collection.GetFontFamily(family)? };
        for index in 0..unsafe { family.GetFontCount() } {
            let font = unsafe { family.GetFont(index)? };
            if unsafe { font.GetSimulations() } != DWRITE_FONT_SIMULATIONS_NONE {
                continue;
            }
            if let Some(font) = local_font(&font) {
                fonts.push(font);
            }
        }
    }
    Ok(fonts)
}

fn local_font(font: &IDWriteFont) -> Option<LocalFont> {
    Some(LocalFont {
        record: FontRecord {
            family: informational(font, DWRITE_INFORMATIONAL_STRING_WIN32_FAMILY_NAMES)?,
            full_name: informational(font, DWRITE_INFORMATIONAL_STRING_FULL_NAME)?,
            postscript_name: informational(font, DWRITE_INFORMATIONAL_STRING_POSTSCRIPT_NAME)?,
            style: informational(font, DWRITE_INFORMATIONAL_STRING_WIN32_SUBFAMILY_NAMES)?,
        },
        path: file_path(font).ok()??,
    })
}

/// The English US value of an informational string, or the first one.
fn informational(font: &IDWriteFont, id: DWRITE_INFORMATIONAL_STRING_ID) -> Option<String> {
    let mut strings = None;
    let mut exists = BOOL::default();
    unsafe { font.GetInformationalStrings(id, &mut strings, &mut exists) }.ok()?;
    let strings = strings?;

    let mut index = 0;
    let mut found = BOOL::default();
    unsafe { strings.FindLocaleName(w!("en-us"), &mut index, &mut found) }.ok()?;
    if !found.as_bool() {
        index = 0;
    }
    let length = unsafe { strings.GetStringLength(index) }.ok()?;
    let mut buffer = vec![0u16; length as usize + 1];
    unsafe { strings.GetString(index, &mut buffer) }.ok()?;
    Some(String::from_utf16_lossy(&buffer[..length as usize]))
}

/// The path of the font's file, when a local file loader reads it.
fn file_path(font: &IDWriteFont) -> Result<Option<PathBuf>> {
    let face = unsafe { font.CreateFontFace()? };
    let mut count = 1;
    let mut file = None;
    unsafe { face.GetFiles(&mut count, Some(&mut file))? };
    let Some(file) = file else { return Ok(None) };

    let mut key = std::ptr::null_mut();
    let mut key_size = 0;
    unsafe { file.GetReferenceKey(&mut key, &mut key_size)? };
    let Ok(loader) = unsafe { file.GetLoader()? }.cast::<IDWriteLocalFontFileLoader>() else {
        return Ok(None);
    };
    let length = unsafe { loader.GetFilePathLengthFromKey(key, key_size)? };
    let mut path = vec![0u16; length as usize + 1];
    unsafe { loader.GetFilePathFromKey(key, key_size, &mut path)? };
    Ok(Some(PathBuf::from(String::from_utf16_lossy(
        &path[..length as usize],
    ))))
}

/// Calls `on_change` when Windows adds or removes an installed font, which
/// shows as a write to the registry key that lists them. Per-user installs
/// write to the current user's key, the others to the machine's.
pub fn watch(on_change: impl Fn() + Send + Sync + 'static) -> bool {
    let on_change = Arc::new(on_change);
    // An HKEY cannot cross threads, so each thread takes its own.
    let roots: [fn() -> HKEY; 2] = [|| HKEY_LOCAL_MACHINE, || HKEY_CURRENT_USER];
    for root in roots {
        let on_change = Arc::clone(&on_change);
        std::thread::spawn(move || watch_fonts_key(root(), &*on_change));
    }
    true
}

fn watch_fonts_key(root: HKEY, on_change: &dyn Fn()) {
    const FONTS_KEY: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts");
    let mut key = HKEY::default();
    if unsafe { RegOpenKeyExW(root, FONTS_KEY, None, KEY_NOTIFY, &mut key) }.is_err() {
        return;
    }
    while unsafe { RegNotifyChangeKeyValue(key, true, REG_NOTIFY_CHANGE_LAST_SET, None, false) }
        .is_ok()
    {
        on_change();
    }
}

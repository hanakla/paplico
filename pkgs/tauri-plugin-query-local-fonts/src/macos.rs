use crate::{FontRecord, LocalFont};
use objc2_core_foundation::{CFArray, CFString, CFURL};
use objc2_core_text::{
    kCTFontDisplayNameAttribute, kCTFontFamilyNameAttribute, kCTFontNameAttribute,
    kCTFontStyleNameAttribute, kCTFontURLAttribute, CTFontCollection, CTFontDescriptor,
};

/// Lists every font CoreText can use, the source Safari and Chrome read too.
pub fn enumerate() -> Vec<LocalFont> {
    let collection = unsafe { CTFontCollection::from_available_fonts(None) };
    let Some(descriptors) = (unsafe { collection.matching_font_descriptors() }) else {
        return Vec::new();
    };
    let descriptors: &CFArray<CTFontDescriptor> = unsafe { descriptors.cast_unchecked() };
    descriptors.iter().filter_map(|d| local_font(&d)).collect()
}

fn local_font(descriptor: &CTFontDescriptor) -> Option<LocalFont> {
    let text = |key: &CFString| {
        unsafe { descriptor.attribute(key) }?
            .downcast::<CFString>()
            .ok()
            .map(|s| s.to_string())
    };
    // The full name comes in the user's language, as the browser gives it.
    let localized = |key: &CFString| {
        unsafe { descriptor.localized_attribute(key, std::ptr::null_mut()) }?
            .downcast::<CFString>()
            .ok()
            .map(|s| s.to_string())
    };
    let url = unsafe { descriptor.attribute(kCTFontURLAttribute) }?
        .downcast::<CFURL>()
        .ok()?;
    Some(LocalFont {
        record: FontRecord {
            family: text(unsafe { kCTFontFamilyNameAttribute })?,
            full_name: localized(unsafe { kCTFontDisplayNameAttribute })?,
            postscript_name: text(unsafe { kCTFontNameAttribute })?,
            style: text(unsafe { kCTFontStyleNameAttribute })?,
        },
        path: url.to_file_path()?,
    })
}

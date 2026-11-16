use crate::{FontRecord, LocalFont};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFNotificationCenter, CFNotificationSuspensionBehavior, CFString, CFURL,
};
use objc2_core_text::{
    kCTFontDisplayNameAttribute, kCTFontFamilyNameAttribute, kCTFontNameAttribute,
    kCTFontManagerRegisteredFontsChangedNotification, kCTFontStyleNameAttribute,
    kCTFontURLAttribute, CTFontCollection, CTFontDescriptor,
};
use std::ffi::c_void;
use std::ptr;

type OnChange = Box<dyn Fn() + Send + Sync>;

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

/// Calls `on_change` when CoreText registers or unregisters fonts. The
/// observer stays for the life of the process.
pub fn watch(on_change: impl Fn() + Send + Sync + 'static) -> bool {
    let Some(center) = CFNotificationCenter::local_center() else {
        return false;
    };
    let observer = Box::into_raw(Box::new(Box::new(on_change) as OnChange));
    unsafe {
        center.add_observer(
            observer.cast::<c_void>(),
            Some(notify),
            Some(kCTFontManagerRegisteredFontsChangedNotification),
            ptr::null(),
            CFNotificationSuspensionBehavior::DeliverImmediately,
        );
    }
    true
}

unsafe extern "C-unwind" fn notify(
    _center: *mut CFNotificationCenter,
    observer: *mut c_void,
    _name: *const CFString,
    _object: *const c_void,
    _user_info: *const CFDictionary,
) {
    let on_change = unsafe { &*observer.cast::<OnChange>() };
    on_change();
}

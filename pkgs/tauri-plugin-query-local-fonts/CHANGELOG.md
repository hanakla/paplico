# Changelog

## Unreleased

### Changed

- **Breaking API changes**
  - The plugin requires Tauri 3.0 alpha instead of Tauri 2. Rust 1.95 or newer is required.

## 0.2.0

### Changed

- **Breaking API changes**
  - The plugin is named `paplico-query-local-fonts` instead of `query-local-fonts`. Allow `paplico-query-local-fonts:default` in the capability.

### Added

- **Rust crate**
  - The Rust half is published as the `tauri-plugin-paplico-query-local-fonts` crate.

## 0.1.0

### Added

- **Local fonts**
  - `queryLocalFonts` lists the installed fonts like the browser's `window.queryLocalFonts()`: CoreText on macOS, DirectWrite on Windows and fontdb elsewhere.
  - `readFontRange` reads part of a font's file without reading the whole file.

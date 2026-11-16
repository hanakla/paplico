# Paplico desktop

The desktop app uses Tauri 3.0 alpha and Chromium Embedded Framework on macOS, Windows and Linux.
The iOS app uses Tauri's wry runtime with WKWebView.

## Prerequisites

- Rust 1.95 or newer.
- The [Tauri prerequisites](https://v3.tauri.app/start/prerequisites/) for the target platform.
- CMake and Ninja on macOS and Windows to compile CEF's C++ wrapper.
- On Linux, GTK 4 development libraries instead of WebKitGTK.
- Space for the CEF distribution and Cargo build artifacts. The first build downloads CEF.

## Development

Run `yarn dev:desktop` from the repository root.
Run `yarn build:desktop` to create an installer.
Tauri bundles the CEF framework, helper processes and signing entitlements.
On macOS, `tauri dev` also launches from an app bundle.

Run `yarn dev:ios` or `yarn build:ios` for the iOS app.
Those targets do not download or bundle CEF.

Two third-party plugins and the CEF downloader have local compatibility copies.
Their provenance and patches are recorded in [vendor/README.md](src-tauri/vendor/README.md).

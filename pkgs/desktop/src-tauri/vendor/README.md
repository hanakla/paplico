# Tauri compatibility sources

These sources keep OAuth callbacks and mobile safe-area insets available on Tauri 3.0 alpha.
Neither upstream crate publishes a Tauri 3 release.

| Directory | Upstream source | License |
| --- | --- | --- |
| `tauri-plugin-oauth` | [FabianLars/tauri-plugin-oauth](https://github.com/FabianLars/tauri-plugin-oauth), crates.io 2.1.0 | MIT OR Apache-2.0 |
| `tauri-plugin-safe-area-insets-css` | [saurL/tauri-plugin-safe-area-insets-css](https://github.com/saurL/tauri-plugin-safe-area-insets-css), crates.io 0.2.0 | MIT |
| `download-cef` | [tauri-apps/cef-rs](https://github.com/tauri-apps/cef-rs), crates.io 3.0.0 | Apache-2.0 OR MIT |

The Cargo manifests depend on Tauri 3 and its plugin build helper.
Generated command permissions come from Tauri's build output.
The sources retain their upstream plugin names and commands so their published JavaScript clients can call them.
The root Yarn resolution makes those clients share the app's Tauri 3 JavaScript API.
The safe-area plugin omits diagnostic logging that requires iOS 14 so its declared iOS 13 target builds.

The CEF downloader accepts distribution indexes up to 64 MiB.
Its upstream 10 MiB limit rejects the current official index.
The archive checksum verification remains in place.

Replace these copies with upstream dependencies when compatible releases are available.

# Changelog

## [Unreleased]

### Added

- `fontLoaders` option of `Paplico.create`. Text fonts resolve through the `FontLoader`s it lists, and the host app can add its own by extending the abstract `FontLoader` class. No loader is registered by default.
- `paplico.fonts`, the `FontManager` each Paplico instance owns.
- `LocalFontBackend` and `FontData` types in `/typography`, and `DomLocalFontBackend` in `/infra`, for building a `LocalFontsLoader` on any platform.

### Changed

- `FontSource` is `{ loaderId, fontId }`. Documents saved earlier are migrated when opened.

### Removed

- `getFontManager` and the `googleFontsApiKey` option of `Paplico.create`. Pass a `GoogleFontsLoader` in `fontLoaders` instead.
- `/infra/localfonts.tauri` and the `@tauri-apps/api` and `tauri-plugin-system-fonts-api` dependencies. A Tauri app implements `LocalFontBackend` itself.

## [0.1.0] - 2026-09-26

### Added

- First release of the Paplico drawing engine as a standalone package: document model, WebGPU renderer, drawing tools, filters, typography, papf I/O and collaboration transports.
- Entry points: `@paplico/core` (the `Paplico` facade, errors and shortcuts), `/schema`, `/document`, `/brush`, `/collaboration`, `/color`, `/io`, `/tools`, `/timelapse`, `/typography`, `/filters`, `/utils` and `/infra`.
- `/infra/localfonts.tauri` for the Tauri local font backend, kept out of `/infra` so browser bundles never load `@tauri-apps/*`.
- `/three-webgpu-compat`, the target for a bundler alias of `three` so three.js and `@pixiv/three-vrm` share one WebGPU build.
- `fallbackFontUrl` option of `Paplico.create` names where the built-in Noto Sans JP fallback font is served. The package fetches no app-specific URL on its own.
- `registerForHotReload(paplico)` marks the instance that development hot reloads re-attach to.
- `CollaborationConfig.relayHost` names the PartyKit host for the cloud and end-to-end encrypted transports. The package reads no environment variables, so the host application passes it in.
- `pngjs` is an optional peer dependency. It is loaded only for the PNG decode fallback when running on Node WebGPU.

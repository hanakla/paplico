# Changelog

## [Unreleased]

### Added

- `placementAnchorIds` option of `PaplicoCommands.pasteElements`. `placement` is resolved against these elements instead of the selection.

### Fixed

- Alt+drag duplicates with the select tool and the path edit tool land right in front of the frontmost source instead of on top of the layer. `duplicateElementsByIds` stacks its copies the same way.

## [0.2.0] - 2026-09-27

### Added

- `fontLoaders` option of `Paplico.create`. Text fonts resolve through the `FontLoader`s it lists, and the host app can add its own by extending the abstract `FontLoader` class. No loader is registered by default.
- `paplico.fonts`, the `FontManager` each Paplico instance owns.
- `LocalFontBackend` and `FontData` types in `/typography`, and `DomLocalFontBackend` in `/infra`, for building a `LocalFontsLoader` on any platform.
- `Paplico.connectCollaboration(factory, { document })` attaches a collaboration transport. `factory` receives the Y.Doc to sync. `document: "fromRemote"` discards the local document so the room's state is adopted as-is. `document: "keepForRemote"` keeps it, merges it with the room and removes layers listed twice once the transport reports sync.
- `CollaborationBase` in `/collaboration`, the base class a collaboration transport extends. A host app can implement its own transport with it.
- `@paplico/core/export` entry. It holds one exporter class per output format, `PNGExporter`, `JPEGExporter`, `AvifHdrExporter`, `PSDExporter`, `TIFFExporter` and `SVGExporter`, and the `IExporter`, `ExportContext`, `ExportRenderer` and `ExportResult` types. Each class takes its settings in the constructor.
- `Paplico.exportArtboard(exporter, artboardId)` exports an artboard through any `IExporter`, so a host app can add its own output format.
- `Paplico.renderElementsToPNG(elementIds, document, options)` renders elements to a PNG sized to their filter-expanded bounds.
- `Paplico.activateCanvasTarget(targetId)` makes a canvas target the active one, and the `activeCanvasTargetChange` event reports the switch. Removing the active target emits it with `null`, which means the primary target serves as the active one.

### Changed

- `FontSource` is `{ loaderId, fontId }`. Documents saved earlier are migrated when opened.
- `Paplico.importDocument` throws `PaplicoError` with the code `DOCUMENT_OPEN_WHILE_CONNECTED` while a collaboration transport is attached. The transport would otherwise keep syncing the discarded Y.Doc, and edits would stop reaching the room without any error.
- With several canvas targets, only the active target draws tool overlays such as handles, the brush cursor, snap lines and selection outlines. A press on another target activates it before reaching the tool. Hovering no longer switches the active target, and hover moves and tool wheel input on inactive targets are ignored. Plain wheel pan and zoom still work on every target.

### Removed

- `getFontManager` and the `googleFontsApiKey` option of `Paplico.create`. Pass a `GoogleFontsLoader` in `fontLoaders` instead.
- `/infra/localfonts.tauri` and the `@tauri-apps/api` and `tauri-plugin-system-fonts-api` dependencies. A Tauri app implements `LocalFontBackend` itself.
- `Paplico.setCollaboration` and the `collaboration` option of `Paplico.create`. Use `connectCollaboration` instead.
- The `exporter`, `psdExporter`, `tiffExporter` and `svgExporter` properties of `Paplico`. Pass an exporter from `/export` to `exportArtboard` instead.

### Fixed

- Resizing a group no longer moves a rotated compound path or blend inside it away from the rest of the group.
- A stroke that ends within 100ms of pen-down keeps its pressure when the pen lifts off. It used to commit at a flat width, unlike its preview.
- With several canvas targets, a paste or a keyboard shortcut runs once instead of once per target.
- `clipPathId` is stored as a plain string by every Yjs reader and writer. Deleting a middle anchor with the path edit tool in a document with a clip group no longer leaves the original path behind.
- Inside an editing scope, hit tests answer only on the layer that holds the scope element. The current layer no longer jumps to the topmost visible layer, and deleting a middle anchor with the path edit tool no longer makes the whole path disappear.

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

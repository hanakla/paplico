# @paplico/tauri-plugin-query-local-fonts

A Tauri v3 plugin that lists the fonts installed on the device in the shape of the browser's [`window.queryLocalFonts()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/queryLocalFonts).

The fonts come from the OS itself, so fonts a font manager activates are listed too.

| OS | Source |
| --- | --- |
| macOS | CoreText |
| Windows | DirectWrite |
| Linux and others | fontdb, reading the fontconfig directories |

## Setup

Install the JavaScript package.

```sh
npm install @paplico/tauri-plugin-query-local-fonts
```

Add the Rust crate to your Tauri app.

```sh
cargo add tauri-plugin-paplico-query-local-fonts
```

Register the plugin.

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_paplico_query_local_fonts::init())
```

Allow it in your capability.

```json
{ "permissions": ["paplico-query-local-fonts:default"] }
```

## Usage

```ts
import { queryLocalFonts, readFontRange } from "@paplico/tauri-plugin-query-local-fonts";

const fonts = await queryLocalFonts({ postscriptNames: ["HelveticaNeue-Bold"] });
const file = await fonts[0].blob();
const header = await readFontRange(fonts[0], 0, 12);
```

`readFontRange` is not part of the browser API. It reads part of a font's file without moving the whole file. Only fonts the last `queryLocalFonts` call returned can be read.

# @paplico/core

The Paplico drawing engine: document model, WebGPU renderer, drawing tools,
filters, typography, papf file I/O and real-time collaboration transports.
It knows nothing about React or any app framework; the host app renders the
UI and passes in what the engine cannot know by itself.

## Requirements

- A browser with WebGPU. There is no Canvas 2D or WebGL fallback.
- An ESM bundler (Vite, webpack, Turbopack, ...).

## Install

```bash
npm install @paplico/core
```

## Usage

```typescript
import { Paplico } from "@paplico/core";

const paplico = await Paplico.create(canvas, {
	// Bytes of the builtin ICC profiles; see "Files the host serves".
	getBuiltinProfileBytes: async (id) => {
		const file = { srgb: "sRGB-v4.icc", "display-p3": "DisplayP3Compat-v4.icc" }[id];
		const res = await fetch(`/assets/icc/${file}`);
		return new Uint8Array(await res.arrayBuffer());
	},
	fallbackFontUrl: "/assets/fonts/NotoSansJP-VariableFont_wght.ttf",
});

paplico.startRendering();
paplico.tools.setCurrentTool("pen");

// Save and load papf documents
const blob = await paplico.exportDocument();
await paplico.importDocument(blob);

// Release GPU resources and listeners
paplico.destroy();
```

`Paplico.create` throws when WebGPU cannot be initialized.

## Files the host serves

The engine fetches nothing app-specific on its own. The host app serves
these files and tells the engine where they are:

| File | Passed as |
| --- | --- |
| `sRGB-v4.icc`, `DisplayP3Compat-v4.icc` | bytes returned by `getBuiltinProfileBytes` |
| `NotoSansJP-VariableFont_wght.ttf` | `fallbackFontUrl`, used for text no loaded font covers |

The Paplico app ships them under `pkgs/web/public/assets/` in the
[repository](https://github.com/hanakla/paplico).

## Bundler setup

Alias the bare `three` import to the package's WebGPU compatibility module,
so three.js and `@pixiv/three-vrm` share one WebGPU build:

```typescript
// vite.config.ts
export default defineConfig({
	resolve: {
		alias: [{ find: /^three$/, replacement: "@paplico/core/three-webgpu-compat" }],
	},
});
```

```typescript
// next.config.ts
export default {
	turbopack: { resolveAlias: { three: "@paplico/core/three-webgpu-compat" } },
	webpack: (config) => {
		config.resolve.alias = {
			...config.resolve.alias,
			three$: "@paplico/core/three-webgpu-compat",
		};
		return config;
	},
};
```

`pngjs` is an optional peer dependency. Install it only when running the
engine on Node with a WebGPU implementation such as `webgpu` (Dawn); browsers
never load it.

## Entry points

| Import | Contents |
| --- | --- |
| `@paplico/core` | `Paplico` facade, errors, shortcuts, `registerForHotReload` |
| `@paplico/core/schema` | Document, layer, element, color and brush types |
| `@paplico/core/document` | Default value factories, length units, renderer state |
| `@paplico/core/brush` | Brush presets, properties and curves |
| `@paplico/core/collaboration` | Collaboration transports, invite URLs, room crypto |
| `@paplico/core/color` | ICC profile inspection |
| `@paplico/core/io` | papf read/write, migrations |
| `@paplico/core/tools` | Tool types and tool-specific helpers |
| `@paplico/core/timelapse` | Timelapse export and playback |
| `@paplico/core/typography` | Font manager and text layout |
| `@paplico/core/filters` | Filter types and the filter catalog |
| `@paplico/core/utils` | Geometry, color and easing helpers |
| `@paplico/core/infra` | Clipboard |
| `@paplico/core/infra/localfonts.tauri` | Local font backend for Tauri apps |
| `@paplico/core/three-webgpu-compat` | Target of the `three` bundler alias |

Collaboration transports take the PartyKit host from
`CollaborationConfig.relayHost`; the engine reads no environment variables.

## Development

```bash
# Run tests (unit; GPU suites run locally with Dawn)
yarn workspace @paplico/core test

# Type check
yarn workspace @paplico/core typecheck

# Build dist for publishing
yarn workspace @paplico/core build
```

## License

AGPL-3.0-or-later

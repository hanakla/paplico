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
import { DomLocalFontBackend } from "@paplico/core/infra";
import { GoogleFontsLoader, LocalFontsLoader } from "@paplico/core/typography";

const paplico = await Paplico.create(canvas, {
	// Where text fonts come from; see "Fonts".
	fontLoaders: [
		new GoogleFontsLoader(GOOGLE_FONTS_API_KEY),
		new LocalFontsLoader(new DomLocalFontBackend()),
	],
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

## Customizing

### Fonts

Text fonts are resolved by the `FontLoader`s passed as `fontLoaders`. The
engine registers none by default. A text style stores its font as a
`FontSource`, `{ loaderId, fontId }`, and the loader whose `id` equals
`loaderId` loads it. Text whose loader is not registered renders with the
fallback font.

| Loader | `id` | `fontId` |
| --- | --- | --- |
| `GoogleFontsLoader` | `google` | Family name; `Family:700` pins one weight file of a family without a variable font |
| `LocalFontsLoader` | `local` | PostScript name of an installed font |

`LocalFontsLoader` reads installed fonts through a `LocalFontBackend`.
Browsers use `DomLocalFontBackend` from `@paplico/core/infra`. Other
platforms implement `LocalFontBackend` in the host app; the Paplico desktop
app does so for Tauri in `pkgs/web/src/infra/localfonts.tauri.ts`.

#### Adding a custom font loader

Extend `FontLoader` and pass an instance alongside the others. A loader only
lists its fonts and fetches their files; parsing, caching, deduplicating
concurrent loads and registering the font for DOM text happen in the base
class.

```typescript
import { FontLoader, type FontFile, type FontMetadata } from "@paplico/core/typography";

class AppFontsLoader extends FontLoader {
	// Stored in documents as FontSource.loaderId; keep it stable across releases
	public readonly id = "app-fonts";
	// Name shown to users, e.g. as a font picker tab
	public readonly label = "App Fonts";

	public async queryFonts(): Promise<FontMetadata[]> {
		return [
			{
				family: "My Brand Sans",
				fullName: "My Brand Sans Regular",
				postScriptName: "MyBrandSans-Regular",
				style: "Regular",
				weight: 400,
				loaderId: this.id,
				fontId: "my-brand-sans",
			},
		];
	}

	protected async fetchFont(fontId: string): Promise<FontFile | null> {
		const res = await fetch(`/fonts/${fontId}.ttf`);
		if (!res.ok) return null;
		return {
			data: await res.arrayBuffer(),
			metadata: {
				family: "My Brand Sans",
				fullName: "My Brand Sans Regular",
				postScriptName: "MyBrandSans-Regular",
				style: "Regular",
				weight: 400,
			},
		};
	}
}

const paplico = await Paplico.create(canvas, {
	fontLoaders: [new GoogleFontsLoader(apiKey), new AppFontsLoader()],
	// ...
});
```

- `fetchFont` returns the font file (TTF, OTF, WOFF2 or a TrueType
  collection) and its metadata. In a collection, `metadata.postScriptName`
  selects the face.
- Return `null` when the loader has no such font, or throw when fetching
  fails. Either way the text renders with the fallback font.
- The font is registered for DOM text under `metadata.family`. Set
  `cssFamily` on the returned file to use another name.
- Each loader `id` must be unique among the registered loaders.
- A loader whose catalog cannot tell which writing systems a font covers may
  implement the optional `getScripts` and `resolveScripts` to detect them later.

Fonts of every loader are listed by `paplico.fonts.queryAllFonts()`.
Build the `FontSource` of a listed font from its `loaderId` and `fontId`.

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
| `@paplico/core/typography` | Font loaders and text layout |
| `@paplico/core/filters` | Filter types and the filter catalog |
| `@paplico/core/utils` | Geometry, color and easing helpers |
| `@paplico/core/infra` | Clipboard, browser local font backend |
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

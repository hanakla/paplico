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
| `@paplico/core/export` | Artboard exporters and the `IExporter` interface |
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

### Export formats

An artboard is exported by passing an `IExporter` to
`paplico.exportArtboard`. Each exporter takes its format settings in the
constructor, so one instance describes one output.

```typescript
import { PNGExporter } from "@paplico/core/export";

const result = await paplico.exportArtboard(
	new PNGExporter({ scale: 2, backgroundColor: { r: 0, g: 0, b: 0, a: 0 } }),
	artboardId,
);
if (result) download(result.blob);
```

`exportArtboard` resolves to `{ blob, width, height }`, or `null` when the
artboard does not exist or cannot be rendered.

| Exporter | Output |
| --- | --- |
| `PNGExporter` | PNG, optionally converted to and tagged with an ICC profile |
| `JPEGExporter` | JPEG, transparency flattened over the background color |
| `AvifHdrExporter` | 10-bit AVIF, PQ when the document has HDR enabled |
| `PSDExporter` | PSD with one raster layer per document layer |
| `TIFFExporter` | RGB TIFF, or CMYK when given a CMYK profile |
| `SVGExporter` | SVG with vector markup; elements SVG cannot express are embedded as PNG |

#### Adding a custom exporter

Implement `IExporter` and pass an instance to `exportArtboard`. The engine
calls `export` with an `ExportContext` built for that call:

- `document` is the document at the time of the call. Look the artboard up
  in `document.artboards` by the given id.
- `renderer` offers the engine's export rendering. `renderArtboardToImageData`
  returns 8-bit RGBA pixels in the document's working color space, and
  `renderArtboardToFloat32` returns float pixels for HDR output.
- `getBuiltinProfileBytes` returns the bytes the host passed to
  `Paplico.create` for a builtin ICC profile.

```typescript
import type { ExportContext, ExportResult, IExporter } from "@paplico/core/export";

class WebPExporter implements IExporter {
	public constructor(private options: { scale?: number; quality?: number } = {}) {}

	public async export(ctx: ExportContext, artboardId: string): Promise<ExportResult | null> {
		const artboard = ctx.document.artboards.find((a) => a.id === artboardId);
		if (!artboard) return null;

		const imageData = await ctx.renderer.renderArtboardToImageData(
			artboard,
			ctx.document,
			this.options.scale ?? 1,
			{ r: 0, g: 0, b: 0, a: 0 },
		);
		if (!imageData) return null;

		const canvas = new OffscreenCanvas(imageData.width, imageData.height);
		canvas.getContext("2d")?.putImageData(imageData, 0, 0);
		const blob = await canvas.convertToBlob({
			type: "image/webp",
			quality: this.options.quality ?? 0.9,
		});
		return { blob, width: imageData.width, height: imageData.height };
	}
}

const result = await paplico.exportArtboard(new WebPExporter({ scale: 2 }), artboardId);
```

- Return `null` when the artboard is missing or rendering fails. Throw only
  for errors the caller should see.
- `width` and `height` are the output size in pixels. A vector format
  reports the artboard size.
- Keep format settings in the constructor rather than in `export`, so the
  host can build the exporter once and reuse it for every selected artboard.

## License

AGPL-3.0-or-later

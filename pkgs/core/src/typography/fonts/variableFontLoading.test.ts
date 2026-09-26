import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTO_SANS_JP_PATH } from "../../testUtils/fontSetup";
import { createDefaultTextStyle } from "../../tools/TextTool";
import { FontManager } from "./FontManager";
import { GoogleFontsLoader } from "./GoogleFontsLoader";
import { type LocalFontBackend, LocalFontsLoader } from "./LocalFontsLoader";

describe("variable font loading", () => {
	const data = Uint8Array.from(readFileSync(NOTO_SANS_JP_PATH)).buffer;
	const faces: FontFaceDescriptors[] = [];
	beforeEach(() => {
		faces.length = 0;
		vi.stubGlobal(
			"FontFace",
			class {
				public constructor(
					family: string,
					bytes: ArrayBuffer,
					descriptors: FontFaceDescriptors,
				) {
					expect(family).toBeTruthy();
					expect(bytes.byteLength).toBe(data.byteLength);
					faces.push(descriptors);
				}
				public async load() {
					return this;
				}
			},
		);
		vi.stubGlobal("document", { fonts: { add: vi.fn() } });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("requests VF files with the API key and caches the catalog", async () => {
		const fetchFont = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						items: [
							{
								family: "Noto Sans JP",
								variants: ["regular"],
								subsets: ["japanese"],
								files: { regular: "https://fonts.example/full.ttf" },
							},
						],
					}),
				),
		);
		vi.stubGlobal("fetch", fetchFont);
		const loader = new GoogleFontsLoader("first");
		await loader.queryFonts();
		await loader.queryFonts();
		expect(fetchFont).toHaveBeenCalledTimes(1);
		expect(fetchFont).toHaveBeenCalledWith(
			expect.stringMatching(/key=first.*capability=VF/),
		);
		fetchFont.mockResolvedValue(new Response(data));
		const font = await loader.loadFont("Noto Sans JP");
		expect(font?.fontkit.hasGlyphForCodePoint(0x3042)).toBe(true);
		expect(faces).toEqual([{ weight: "100 900", style: "normal" }]);
		const manager = new FontManager({ loaders: [loader] });
		if (!font) throw new Error("Font failed to load");
		for (let weight = 100; weight < 400; weight++)
			manager.resolveFontForStyle(font, {
				...createDefaultTextStyle(),
				fontWeight: weight,
			});
		expect(fetchFont).toHaveBeenCalledTimes(2);
	});

	it("downloads the weight file a Google fontId pins", async () => {
		const fetchFont = vi.fn(async (url: string) =>
			url.includes("webfonts")
				? new Response(
						JSON.stringify({
							items: [
								{
									family: "Static Sans",
									variants: ["regular", "700"],
									subsets: ["latin"],
									files: {
										regular: "https://fonts.example/regular.ttf",
										"700": "https://fonts.example/bold.ttf",
									},
								},
							],
						}),
					)
				: new Response(data),
		);
		vi.stubGlobal("fetch", fetchFont);
		const manager = new FontManager({ loaders: [new GoogleFontsLoader()] });

		await manager.loadFont({ loaderId: "google", fontId: "Static Sans:700" });
		await manager.loadFont({ loaderId: "google", fontId: "Static Sans" });

		expect(fetchFont.mock.calls.map(([url]) => url).slice(1)).toEqual([
			"https://fonts.example/bold.ttf",
			"https://fonts.example/regular.ttf",
		]);
	});

	it("exposes axes from a local font and registers its full DOM weight range", async () => {
		const blob = vi.fn(async () => new Blob([data]));
		const fontData = {
			family: "Noto Sans JP",
			fullName: "Noto Sans JP",
			postScriptName: "NotoSansJP",
			style: "Regular",
			blob,
			readRange: async (offset: number, length: number) =>
				data.slice(offset, offset + length),
		};
		const backend: LocalFontBackend = {
			isSupported: () => true,
			queryFonts: async () => [fontData],
			queryFontsByPostScriptNames: async () => [fontData],
		};
		const manager = new FontManager({
			loaders: [new LocalFontsLoader(backend)],
		});
		const source = { loaderId: "local", fontId: "NotoSansJP" };
		expect(manager.getVariationAxes(source)).toBeUndefined();
		const font = await manager.loadFont(source);
		expect(manager.getVariationAxes(source)?.wght).toMatchObject({
			min: 100,
			max: 900,
		});
		expect(faces[0].weight).toBe("100 900");
		if (!font) throw new Error("Font failed to load");
		for (let weight = 100; weight < 400; weight++)
			manager.resolveFontForStyle(font, {
				...createDefaultTextStyle(),
				fontWeight: weight,
			});
		expect(blob).toHaveBeenCalledTimes(1);
	});
});

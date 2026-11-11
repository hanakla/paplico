/**
 * FontManager
 * Resolves fonts through the font loaders the host app registers.
 * Provides glyph path extraction and text shaping helpers.
 */

import type { Font, Glyph } from "@cantoo/fontkit";
import * as fontkit from "@cantoo/fontkit";
import type {
	CubicBezierSegment,
	FontSource,
	Point,
	TextStyle,
} from "../../schema";
import { Emitter } from "../../utils/emitter";
import {
	extractLocalizedNames,
	type FontLoader,
	type FontMetadata,
	type LoadedFont,
} from "./FontLoader";
import { fontVariationKey, resolveFontVariations } from "./fontVariations";
import type { FontScript } from "./os2Scripts";

/**
 * Events emitted by FontManager.
 */
type FontManagerEvents = {
	/** Fired after a font has been parsed via fontkit and its metadata
	 * (including any localized name records) is available. */
	fontLoaded: undefined;
	/** Fired while loaders detect font scripts from font headers, throttled,
	 * and once more after each loader resolves its last font. */
	fontScriptsResolved: undefined;
};

/**
 * Shaping options.
 */
export interface ShapingOptions {
	letterSpacing?: number; // in em
	features?: Record<string, boolean>; // OpenType features
	direction?: "ltr" | "rtl";
	script?: string; // ISO 15924 script tag
	language?: string; // BCP 47 language tag
	/** When true, all glyphs are replaced with fallback font's .notdef (tofu). */
	forceNotdef?: boolean;
}

/**
 * Shaped glyph data.
 */
export interface ShapedGlyph {
	char: string;
	/** UTF-16 index into the ORIGINAL run text (ligatures skip merged chars) */
	charIndex: number;
	/** UTF-16 length of the source characters this glyph covers (ligature > 1) */
	charLength: number;
	glyphId: number;
	x: number; // accumulated X position
	y: number; // accumulated Y position
	advanceWidth: number;
	path: CubicBezierSegment[];
}

/**
 * FontManager - unified font management.
 */
export class FontManager extends Emitter<FontManagerEvents> {
	/** Registered loaders keyed by `FontLoader.id`, in registration order. */
	public readonly loaders: ReadonlyMap<string, FontLoader>;
	private glyphPathCache = new WeakMap<
		Font,
		Map<number, CubicBezierSegment[]>
	>();
	private variationCache = new WeakMap<Font, Map<string, LoadedFont>>();
	private fallbackFont: LoadedFont | undefined;
	private fallbackFontUrl: string | undefined;
	private fallbackFontLoadPromise: Promise<LoadedFont> | undefined;

	/**
	 * @param options.fallbackFontUrl Where the built-in fallback font is
	 * fetched from. The host app serves the file, so only it knows the URL.
	 */
	public constructor(options: {
		loaders: FontLoader[];
		fallbackFontUrl?: string;
	}) {
		super();
		this.loaders = new Map(
			options.loaders.map((loader) => [loader.id, loader]),
		);
		this.fallbackFontUrl = options.fallbackFontUrl;
	}

	/** Read axes from the loaded face, rather than catalog metadata. */
	public getVariationAxes(
		source: FontSource,
	): Font["variationAxes"] | undefined {
		return this.getLoadedFont(source)?.fontkit.variationAxes;
	}

	/** Share immutable variable instances between shaping and outline extraction. */
	public resolveFontForStyle(font: LoadedFont, style: TextStyle): LoadedFont {
		const values = resolveFontVariations(style, font.fontkit.variationAxes);
		if (Object.keys(values).length === 0) return font;
		let cache = this.variationCache.get(font.fontkit);
		if (!cache) {
			cache = new Map();
			this.variationCache.set(font.fontkit, cache);
		}
		const key = fontVariationKey(values);
		const cached = cache.get(key);
		if (cached) {
			cache.delete(key);
			cache.set(key, cached);
			return cached;
		}
		const resolved = { ...font, fontkit: font.fontkit.getVariation(values) };
		cache.set(key, resolved);
		if (cache.size > 32) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return resolved;
	}

	/**
	 * Get localized names for an already-loaded font, or null when the font
	 * has not been loaded yet or carries no localized name records.
	 */
	public getLocalizedNames(source: FontSource): {
		localizedFamily?: string;
		localizedFullName?: string;
	} | null {
		const loaded = this.getLoadedFont(source);
		if (!loaded) return null;
		const { localizedFamily, localizedFullName } = loaded.metadata;
		if (!localizedFamily && !localizedFullName) return null;
		return {
			...(localizedFamily ? { localizedFamily } : {}),
			...(localizedFullName ? { localizedFullName } : {}),
		};
	}

	/**
	 * Scripts a loader detected for a font after querying, or null when the
	 * loader does not detect them or detection is still pending. Fonts whose
	 * catalog knows their scripts carry them on their metadata instead.
	 */
	public getFontScripts(source: FontSource): FontScript[] | null {
		return (
			this.loaders.get(source.loaderId)?.getScripts?.(source.fontId) ?? null
		);
	}

	/**
	 * Load a font from the specified source.
	 * @throws when no loader is registered for `source.loaderId`
	 */
	public async loadFont(source: FontSource): Promise<LoadedFont | null> {
		const loader = this.loaders.get(source.loaderId);
		if (!loader) {
			throw new Error(`No font loader registered for "${source.loaderId}"`);
		}
		const loaded = await loader.loadFont(source.fontId);
		if (loaded) this.emit("fontLoaded");
		return loaded;
	}

	/**
	 * Query the fonts of every registered loader.
	 * Each loader is settled independently so a failing one (e.g. Google Fonts
	 * answering 403 without an API key) still lets the others through.
	 */
	public async queryAllFonts(): Promise<FontMetadata[]> {
		const loaders = [...this.loaders.values()];
		const results = await Promise.allSettled(
			loaders.map((loader) => loader.queryFonts()),
		);
		this.startScriptResolution();
		return results.flatMap((result, i) =>
			unwrapQueriedFonts(result, loaders[i].label),
		);
	}

	/**
	 * Kick off header-only script detection for the queried fonts.
	 * Not awaited: the catalog is usable immediately and listeners refresh
	 * through `fontScriptsResolved`.
	 */
	private startScriptResolution(): void {
		for (const loader of this.loaders.values()) {
			void loader.resolveScripts?.(() => this.emit("fontScriptsResolved"));
		}
	}

	/** Cache em-normalized outlines by the actual shaped glyph and variable face. */
	private getGlyphPath(font: LoadedFont, glyph: Glyph): CubicBezierSegment[] {
		let cache = this.glyphPathCache.get(font.fontkit);
		if (!cache) {
			cache = new Map();
			this.glyphPathCache.set(font.fontkit, cache);
		}
		const cached = cache.get(glyph.id);
		if (cached) {
			cache.delete(glyph.id);
			cache.set(glyph.id, cached);
			return cached;
		}
		const path = this.extractGlyphPath(glyph, font.fontkit);
		cache.set(glyph.id, path);
		if (cache.size > 2_048) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		return path;
	}

	/**
	 * Extract bezier path segments from a Fontkit glyph.
	 */
	private extractGlyphPath(glyph: Glyph, font: Font): CubicBezierSegment[] {
		const unitsPerEm = font.unitsPerEm;
		// Keep geometry in em space for cache reuse across font sizes.
		const scale = 1 / unitsPerEm;

		const glyphPath = glyph.path;

		if (!glyphPath) {
			return [];
		}

		const segments: CubicBezierSegment[] = [];
		let currentPoint: Point = { x: 0, y: 0 };
		let startPoint: Point = { x: 0, y: 0 };
		let markNextAsMoved = true; // first segment always starts a subpath

		for (const cmd of glyphPath.commands) {
			switch (cmd.command) {
				case "moveTo":
					currentPoint = {
						x: cmd.args[0] * scale,
						y: cmd.args[1] * scale,
					};
					startPoint = currentPoint;
					markNextAsMoved = true; // mark next segment as subpath start
					break;

				case "lineTo": {
					const end: Point = {
						x: cmd.args[0] * scale,
						y: cmd.args[1] * scale,
					};
					// Represent a straight line as a cubic bezier segment.
					const isMoved = markNextAsMoved;
					if (markNextAsMoved) markNextAsMoved = false;
					// cp1/cp2 are relative offsets: cp1 from start, cp2 from end
					const dx = end.x - currentPoint.x;
					const dy = end.y - currentPoint.y;
					const segment: CubicBezierSegment = {
						start: currentPoint,
						cp1: { x: dx / 3, y: dy / 3 },
						cp2: { x: -dx / 3, y: -dy / 3 },
						end,
						isMoved,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
					};
					segments.push(segment);
					currentPoint = end;
					break;
				}

				case "quadraticCurveTo": {
					// Convert quadratic bezier to cubic bezier.
					const qcp: Point = {
						x: cmd.args[0] * scale,
						y: cmd.args[1] * scale,
					};
					const end: Point = {
						x: cmd.args[2] * scale,
						y: cmd.args[3] * scale,
					};
					const isMoved = markNextAsMoved;
					if (markNextAsMoved) markNextAsMoved = false;
					// Cubic cp1_abs = start + 2/3*(qcp - start), cp1_rel = 2/3*(qcp - start)
					// Cubic cp2_abs = end + 2/3*(qcp - end), cp2_rel = 2/3*(qcp - end)
					const segment: CubicBezierSegment = {
						start: currentPoint,
						cp1: {
							x: ((qcp.x - currentPoint.x) * 2) / 3,
							y: ((qcp.y - currentPoint.y) * 2) / 3,
						},
						cp2: {
							x: ((qcp.x - end.x) * 2) / 3,
							y: ((qcp.y - end.y) * 2) / 3,
						},
						end,
						isMoved,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
					};
					segments.push(segment);
					currentPoint = end;
					break;
				}

				case "bezierCurveTo": {
					const absCp1: Point = {
						x: cmd.args[0] * scale,
						y: cmd.args[1] * scale,
					};
					const absCp2: Point = {
						x: cmd.args[2] * scale,
						y: cmd.args[3] * scale,
					};
					const end: Point = {
						x: cmd.args[4] * scale,
						y: cmd.args[5] * scale,
					};
					const isMoved = markNextAsMoved;
					if (markNextAsMoved) markNextAsMoved = false;
					const segment: CubicBezierSegment = {
						start: currentPoint,
						cp1: { x: absCp1.x - currentPoint.x, y: absCp1.y - currentPoint.y },
						cp2: { x: absCp2.x - end.x, y: absCp2.y - end.y },
						end,
						isMoved,
						startTiltX: 0,
						startTiltY: 0,
						endTiltX: 0,
						endTiltY: 0,
						startDeltaTime: 0,
						endDeltaTime: 0,
					};
					segments.push(segment);
					currentPoint = end;
					break;
				}

				case "closePath": {
					if (
						currentPoint.x !== startPoint.x ||
						currentPoint.y !== startPoint.y
					) {
						// Closing line segment is not a subpath start.
						const cdx = startPoint.x - currentPoint.x;
						const cdy = startPoint.y - currentPoint.y;
						segments.push({
							start: currentPoint,
							cp1: { x: cdx / 3, y: cdy / 3 },
							cp2: { x: -cdx / 3, y: -cdy / 3 },
							end: startPoint,
							isMoved: false,
							isClosed: true,
							startTiltX: 0,
							startTiltY: 0,
							endTiltX: 0,
							endTiltY: 0,
							startDeltaTime: 0,
							endDeltaTime: 0,
						});
					} else {
						// Already coincident: mark the subpath's last segment
						// closed so path booleans recognize the contour
						const last = segments.at(-1);
						if (last) last.isClosed = true;
					}
					currentPoint = startPoint;
					markNextAsMoved = true; // next segment starts a new subpath
					break;
				}
			}
		}

		return segments;
	}

	/**
	 * Shape text into positioned glyphs.
	 */
	public async shapeText(
		font: LoadedFont,
		text: string,
		fontSize: number,
		options: ShapingOptions = {},
	): Promise<ShapedGlyph[]> {
		const { letterSpacing = 0, features = {}, forceNotdef = false } = options;
		// Exclude control characters to avoid rendering .notdef glyphs for line breaks.
		const cleanText = text.replace(/[\n\r\t]/g, "");
		if (cleanText.length === 0) return [];

		const run = font.fontkit.layout(cleanText, Object.keys(features));

		const unitsPerEm = font.fontkit.unitsPerEm;
		const scale = fontSize / unitsPerEm;
		const letterSpacingPx = letterSpacing * fontSize;

		const shaped: ShapedGlyph[] = [];
		let x = 0;
		let y = 0;

		// Build character array once for index lookups.
		const chars = [...cleanText];

		// Map clean code-point positions back to UTF-16 indices of the ORIGINAL
		// text (control chars were stripped above but still occupy content
		// indices — the caret/insertion accounting is UTF-16 based).
		const cleanToOriginalUtf16: number[] = [];
		let originalUtf16 = 0;
		for (const ch of text) {
			if (ch !== "\n" && ch !== "\r" && ch !== "\t") {
				cleanToOriginalUtf16.push(originalUtf16);
			}
			originalUtf16 += ch.length;
		}
		cleanToOriginalUtf16.push(text.length); // sentinel: end of text

		// Cluster cursor in clean code-point space: a ligature glyph covers
		// several source characters (fontkit exposes them via glyph.codePoints)
		let cleanCursor = 0;

		const { glyphs, positions } = run;
		if (!positions) {
			throw new Error("layout() returned a run without glyph positions");
		}

		for (let i = 0; i < glyphs.length; i++) {
			const glyph = glyphs[i];
			const position = positions[i];

			const span = Math.max(glyph.codePoints?.length ?? 1, 1);
			const cleanIndex = cleanCursor;
			cleanCursor += span;

			const charIndex = cleanToOriginalUtf16[cleanIndex] ?? text.length;
			const nextCharIndex =
				cleanToOriginalUtf16[
					Math.min(cleanIndex + span, cleanToOriginalUtf16.length - 1)
				] ?? text.length;
			const charLength = Math.max(nextCharIndex - charIndex, 1);
			const char = chars[cleanIndex] ?? "";

			const glyphX = x + position.xOffset * scale;
			const glyphY = y + position.yOffset * scale;
			let emPath: CubicBezierSegment[];
			let advanceWidth = position.xAdvance * scale;

			const useNotdef = (forceNotdef || glyph.id === 0) && char.trim() !== "";

			if (useNotdef) {
				const fallback = await this.getFallbackFont();
				const notdefGlyph = fallback.fontkit.glyphForCodePoint(0);
				if (!notdefGlyph) {
					throw new Error("Fallback font has no .notdef glyph");
				}
				emPath = this.getGlyphPath(fallback, notdefGlyph);
				advanceWidth =
					(notdefGlyph.advanceWidth * fontSize) / fallback.fontkit.unitsPerEm;
			} else {
				emPath = this.getGlyphPath(font, glyph);
			}

			const offsetPath = emPath.map((seg) => ({
				start: seg.start
					? { x: seg.start.x * fontSize, y: seg.start.y * fontSize }
					: undefined,
				cp1: { x: seg.cp1.x * fontSize, y: seg.cp1.y * fontSize },
				cp2: { x: seg.cp2.x * fontSize, y: seg.cp2.y * fontSize },
				end: { x: seg.end.x * fontSize, y: seg.end.y * fontSize },
				isMoved: seg.isMoved,
				isClosed: seg.isClosed,
				startTiltX: seg.startTiltX,
				startTiltY: seg.startTiltY,
				endTiltX: seg.endTiltX,
				endTiltY: seg.endTiltY,
				startDeltaTime: seg.startDeltaTime,
				endDeltaTime: seg.endDeltaTime,
			}));

			shaped.push({
				char,
				charIndex,
				charLength,
				glyphId: glyph.id,
				x: glyphX,
				y: glyphY,
				advanceWidth,
				path: offsetPath,
			});

			x += advanceWidth + letterSpacingPx;
			y += position.yAdvance * scale;
		}

		return shaped;
	}

	/**
	 * Check whether a font provides OpenType `vert` feature.
	 */
	private hasVertFeature(font: LoadedFont): boolean {
		return font.fontkit.availableFeatures.includes("vert");
	}

	/**
	 * Get vertical-writing glyph path (em-normalized coordinates).
	 * Returns GSUB-substituted glyph path when `vert` replacement happens.
	 * Returns null when no `vert` feature is available or no replacement occurs.
	 */
	public getVerticalGlyphPath(
		font: LoadedFont,
		char: string,
	): CubicBezierSegment[] | null {
		if (!this.hasVertFeature(font)) return null;

		// Enable `vert` feature and fetch substituted glyph.
		const run = font.fontkit.layout(char, ["vert"]);
		if (run.glyphs.length === 0) return null;

		const vertGlyphId = run.glyphs[0].id;

		// Compare with default glyph to detect actual replacement.
		const originalRun = font.fontkit.layout(char);
		const originalGlyphId = originalRun.glyphs[0]?.id;

		// No GSUB replacement happened, so this font has no dedicated vertical glyph.
		if (vertGlyphId === originalGlyphId) {
			return null;
		}

		return this.getGlyphPath(font, run.glyphs[0]);
	}

	/**
	 * Get the built-in Noto Sans JP fallback font.
	 * Loads from the URL given to setFallbackFontUrl on first call.
	 * Subsequent calls return the cached instance.
	 */
	public getFallbackFont(): Promise<LoadedFont> {
		if (this.fallbackFont) {
			return Promise.resolve(this.fallbackFont);
		}
		if (this.fallbackFontLoadPromise) {
			return this.fallbackFontLoadPromise;
		}
		const url = this.fallbackFontUrl;
		if (!url) {
			return Promise.reject(
				new Error(
					"Fallback font URL is not set; pass fallbackFontUrl to Paplico.create",
				),
			);
		}

		this.fallbackFontLoadPromise = (async () => {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Failed to fetch fallback font: ${response.status}`);
			}
			const data = await response.arrayBuffer();

			const fontResult = fontkit.create(new Uint8Array(data));
			const font = "fonts" in fontResult ? fontResult.fonts[0] : fontResult;

			if (typeof document !== "undefined") {
				try {
					const fontFace = new FontFace("Noto Sans JP", data, {
						weight: "400",
						style: "normal",
					});
					await fontFace.load();
					document.fonts.add(fontFace);
				} catch (err) {
					console.warn("Failed to register fallback font face:", err);
				}
			}

			const loadedFont: LoadedFont = {
				metadata: {
					family: "Noto Sans JP",
					fullName: "Noto Sans JP",
					postScriptName: "NotoSansJP",
					style: "normal",
					weight: 400,
					loaderId: "fallback",
					fontId: "NotoSansJP",
					...extractLocalizedNames(font),
				},
				fontkit: font,
				data,
			};

			this.fallbackFont = loadedFont;
			return loadedFont;
		})();

		// A failed load must not be cached forever — drop the promise so the
		// next caller retries (e.g. after a transient network failure).
		this.fallbackFontLoadPromise.catch(() => {
			this.fallbackFontLoadPromise = undefined;
		});

		return this.fallbackFontLoadPromise;
	}

	/**
	 * Get loaded font instance for a source.
	 */
	public getLoadedFont(source: FontSource): LoadedFont | undefined {
		if (!source?.loaderId) {
			console.error("Invalid FontSource:", source);
			return undefined;
		}
		return this.loaders.get(source.loaderId)?.getLoadedFont(source.fontId);
	}
}

/**
 * Read one settled font query, reporting a rejection instead of propagating it
 * so that one unavailable source never hides the fonts of another.
 */
function unwrapQueriedFonts(
	result: PromiseSettledResult<FontMetadata[]>,
	sourceLabel: string,
): FontMetadata[] {
	if (result.status === "fulfilled") return result.value;
	console.error(`Failed to query ${sourceLabel}:`, result.reason);
	return [];
}

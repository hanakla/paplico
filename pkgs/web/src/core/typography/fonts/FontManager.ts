/**
 * FontManager
 * Unified manager for Google Fonts and Local Fonts.
 * Provides glyph path extraction and text shaping helpers.
 */

import type { Font, Glyph } from "fontkit";
import * as fontkit from "fontkit";
import type { CubicBezierSegment, FontSource, Point } from "@/core/schema";
import { DomLocalFontBackend } from "../../infra/localfonts.dom";
import { Emitter } from "../../utils/emitter";
import {
	extractLocalizedNames,
	type FontMetadata,
	type LoadedFont,
} from "./FontLoader";
import { GoogleFontsLoader } from "./GoogleFontsLoader";
import { type LocalFontBackend, LocalFontsLoader } from "./LocalFontsLoader";

/**
 * Events emitted by FontManager.
 */
type FontManagerEvents = {
	/** Fired after a font has been parsed via fontkit and its metadata
	 * (including any localized name records) is available. */
	fontLoaded: undefined;
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
 * Glyph cache key (code-point based).
 */
function getGlyphCacheKeyByCodePoint(
	postScriptName: string,
	codePoint: number,
): string {
	return `${postScriptName}:cp${codePoint}`;
}
/**
 * FontManager - unified font management.
 */
export class FontManager extends Emitter<FontManagerEvents> {
	private googleLoader: GoogleFontsLoader;
	private localLoader: LocalFontsLoader;
	private glyphPathCache: Map<string, CubicBezierSegment[]> = new Map();
	private fallbackFont: LoadedFont | undefined;
	private fallbackFontLoadPromise: Promise<LoadedFont> | undefined;

	public constructor(
		googleFontsApiKey?: string,
		localFontBackend?: LocalFontBackend,
	) {
		super();
		this.googleLoader = new GoogleFontsLoader(googleFontsApiKey);
		this.localLoader = new LocalFontsLoader(
			localFontBackend ?? new DomLocalFontBackend(),
		);
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
	 * Inject API key after singleton creation without a key.
	 * This also resets GoogleFontsLoader list cache so the next query uses
	 * the authenticated endpoint.
	 */
	public setGoogleFontsApiKey(apiKey: string): void {
		this.googleLoader.setApiKey(apiKey);
	}

	/**
	 * Replace the local font backend at runtime (e.g. switch to Tauri backend).
	 * Resets the font list cache so the next query re-enumerates fonts.
	 */
	public setLocalFontBackend(backend: LocalFontBackend): void {
		this.localLoader = new LocalFontsLoader(backend);
	}

	/**
	 * Load a font from the specified source.
	 */
	public async loadFont(source: FontSource): Promise<LoadedFont | null> {
		let loaded: LoadedFont | null = null;
		switch (source.type) {
			case "google": {
				// Select an appropriate weight from variants (default: 400).
				const weight = this.extractWeightFromVariants(source.variants);
				loaded = await this.googleLoader.loadFont(source.family, weight);
				break;
			}

			case "local":
				loaded = await this.localLoader.loadFont(source.postScriptName);
				break;

			case "embedded":
				throw new Error(
					`Embedded font loading not yet implemented: ${source.fileUid}`,
				);
		}
		if (loaded) this.emit("fontLoaded");
		return loaded;
	}

	/**
	 * Query local fonts catalog.
	 */
	public async queryLocalFonts(): Promise<FontMetadata[]> {
		return this.localLoader.queryFonts();
	}

	/**
	 * Query all fonts from Google and local sources.
	 */
	public async queryAllFonts(): Promise<FontMetadata[]> {
		const [google, local] = await Promise.all([
			this.googleLoader.queryFonts(),
			this.localLoader.queryFonts(),
		]);
		return [...google, ...local];
	}

	/**
	 * Extract glyph path for a character (em-normalized coordinates).
	 * Returned path uses 1em = 1.0; callers scale by font size to pixels.
	 */
	private getGlyphPath(font: LoadedFont, char: string): CubicBezierSegment[] {
		const codePoint = char.codePointAt(0) ?? 0;
		const cacheKey = getGlyphCacheKeyByCodePoint(
			font.metadata.postScriptName,
			codePoint,
		);

		const cached = this.glyphPathCache.get(cacheKey);
		if (cached) return cached;

		const glyph = font.fontkit.glyphForCodePoint(codePoint);
		const path = this.extractGlyphPath(glyph, font.fontkit);

		this.glyphPathCache.set(cacheKey, path);
		return path;
	}

	private getNotdefGlyphPath(font: LoadedFont): CubicBezierSegment[] {
		const cacheKey = `${font.metadata.postScriptName}:.notdef`;
		const cached = this.glyphPathCache.get(cacheKey);
		if (cached) return cached;

		const notdefGlyph = font.fontkit.glyphForCodePoint(0);
		const path = this.extractGlyphPath(notdefGlyph, font.fontkit);
		this.glyphPathCache.set(cacheKey, path);
		return path;
	}

	/**
	 * Extract bezier path segments from a Fontkit glyph.
	 */
	private extractGlyphPath(glyph: Glyph, font: Font): CubicBezierSegment[] {
		const unitsPerEm = font.unitsPerEm;
		// Keep geometry in em space for cache reuse across font sizes.
		const scale = 1 / unitsPerEm;

		// Read Fontkit path commands.
		const glyphPath = glyph.path;

		if (!glyphPath) {
			return [];
		}

		const segments: CubicBezierSegment[] = [];
		let currentPoint: Point = { x: 0, y: 0 };
		let startPoint: Point = { x: 0, y: 0 };
		let markNextAsMoved = true; // first segment always starts a subpath

		// Parse Fontkit path commands.
		const commands = (
			glyphPath as unknown as {
				commands: { command: string; args: number[] }[];
			}
		).commands;

		for (const cmd of commands) {
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

		for (let i = 0; i < run.glyphs.length; i++) {
			const glyph = run.glyphs[i];
			const position = run.positions[i];

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
			const codePoint = char.codePointAt(0) ?? 0;
			let emPath: CubicBezierSegment[];
			let advanceWidth = position.xAdvance * scale;

			const useNotdef = (forceNotdef || glyph.id === 0) && char.trim() !== "";

			if (useNotdef) {
				const fallback = await this.getFallbackFont();
				emPath = this.getNotdefGlyphPath(fallback);
				const fallbackScale = fontSize / fallback.fontkit.unitsPerEm;
				const notdefGlyph = fallback.fontkit.glyphForCodePoint(0);
				advanceWidth =
					(notdefGlyph.advanceWidth ?? fallback.fontkit.unitsPerEm * 0.6) *
					fallbackScale;
			} else {
				emPath = this.getGlyphPath(font, String.fromCodePoint(codePoint));
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
		return font.fontkit.availableFeatures?.includes("vert") ?? false;
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

		const codePoint = char.codePointAt(0) ?? 0;
		const cacheKey = `${font.metadata.postScriptName}:vert:cp${codePoint}`;

		const cached = this.glyphPathCache.get(cacheKey);
		if (cached) return cached;

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

		const path = this.extractGlyphPath(
			font.fontkit.getGlyph(vertGlyphId),
			font.fontkit,
		);
		this.glyphPathCache.set(cacheKey, path);
		return path;
	}

	/**
	 * Register a pre-built LoadedFont into the local font cache.
	 * Useful for injecting test fonts or embedded fonts without going through
	 * the Local Font Access API.
	 */
	public registerLoadedFont(font: LoadedFont): void {
		this.localLoader.registerLoadedFont(font);
		this.googleLoader.registerLoadedFont(font);
	}

	/**
	 * Get the built-in Noto Sans JP fallback font.
	 * Loads from /assets/fonts/NotoSansJP-VariableFont_wght.ttf on first call.
	 * Subsequent calls return the cached instance.
	 */
	public getFallbackFont(): Promise<LoadedFont> {
		if (this.fallbackFont) {
			return Promise.resolve(this.fallbackFont);
		}
		if (this.fallbackFontLoadPromise) {
			return this.fallbackFontLoadPromise;
		}

		this.fallbackFontLoadPromise = (async () => {
			const response = await fetch(
				"/assets/fonts/NotoSansJP-VariableFont_wght.ttf",
			);
			if (!response.ok) {
				throw new Error(`Failed to fetch fallback font: ${response.status}`);
			}
			const data = await response.arrayBuffer();

			const fontResult = fontkit.create(
				new Uint8Array(data) as unknown as Buffer,
			);
			const font =
				"fonts" in fontResult
					? (fontResult as { fonts: fontkit.Font[] }).fonts[0]
					: fontResult;

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
					source: "embedded",
					...extractLocalizedNames(font),
				},
				fontkit: font,
				cssFontFamily: '"Noto Sans JP", sans-serif',
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
		if (!source?.type) {
			console.error("Invalid FontSource:", source);
			return undefined;
		}

		switch (source.type) {
			case "google": {
				const weight = this.extractWeightFromVariants(source.variants);
				return this.googleLoader.getLoadedFont(`${source.family}:${weight}`);
			}
			case "local":
				if (!source.postScriptName) {
					console.error("Local FontSource missing postScriptName:", source);
					return undefined;
				}
				return this.localLoader.getLoadedFont(source.postScriptName);
			case "embedded":
				// TODO: Embedded font loading
				return undefined;
		}
	}

	/**
	 * Extract the first available weight from variants.
	 */
	private extractWeightFromVariants(variants: string[]): number {
		// Treat "regular" as 400 before checking numeric variants.
		if (variants.includes("regular")) return 400;

		for (const variant of variants) {
			const numMatch = variant.match(/^(\d+)$/);
			if (numMatch) {
				return Number.parseInt(numMatch[1], 10);
			}
		}
		return 400;
	}
}

// Singleton instance
let fontManagerInstance: FontManager | null = null;

/**
 * Get FontManager singleton.
 */
export function getFontManager(googleFontsApiKey?: string): FontManager {
	if (!fontManagerInstance) {
		fontManagerInstance = new FontManager(googleFontsApiKey);
		// Expose in window for debugging.
		if (typeof window !== "undefined") {
			(window as unknown as { __fontManager: FontManager }).__fontManager =
				fontManagerInstance;
		}
	} else if (googleFontsApiKey) {
		fontManagerInstance.setGoogleFontsApiKey(googleFontsApiKey);
	}
	return fontManagerInstance;
}

/**
 * LocalFontsLoader
 * Local Font Access APIを使用してローカルフォントを読み込み
 */

import * as fontkit from "fontkit";
import {
	extractLocalizedNames,
	type FontLoader,
	type FontMetadata,
	getFontCacheKey,
	type LoadedFont,
	parseWeightString,
} from "./FontLoader";
import { fontFaceWeight } from "./fontVariations";
import { detectFontScripts, type FontScript } from "./os2Scripts";

const SCRIPT_RESOLVE_CONCURRENCY = 8;
const SCRIPT_PROGRESS_INTERVAL_MS = 200;

/**
 * Local Font Access APIの型定義
 */
export interface FontData {
	family: string;
	fullName: string;
	postScriptName: string;
	style: string;
	blob(): Promise<Blob>;
	/** Read a byte range of the font file without materializing the whole file. */
	readRange(offset: number, length: number): Promise<ArrayBuffer>;
}

/**
 * Platform-specific backend for querying local fonts.
 */
export interface LocalFontBackend {
	isSupported(): boolean;
	queryFonts(): Promise<FontData[]>;
	queryFontsByPostScriptNames(names: string[]): Promise<FontData[]>;
}

/**
 * ローカルフォントローダー
 */
export class LocalFontsLoader implements FontLoader {
	private backend: LocalFontBackend;
	private loadedFonts: Map<string, LoadedFont> = new Map();
	private fontList: FontMetadata[] | null = null;
	private loadingPromises: Map<string, Promise<LoadedFont | null>> = new Map();
	private fontDataCache: Map<string, FontData> = new Map();
	private scripts: Map<string, FontScript[]> = new Map();
	private scriptsResolution: Promise<void> | null = null;

	public constructor(backend: LocalFontBackend) {
		this.backend = backend;
	}

	/**
	 * Local Font Access APIがサポートされているかチェック
	 */
	public isSupported(): boolean {
		return this.backend.isSupported();
	}

	/**
	 * 利用可能なローカルフォント一覧を取得
	 */
	public async queryFonts(): Promise<FontMetadata[]> {
		if (this.fontList) {
			return this.fontList;
		}

		if (!this.isSupported()) {
			console.warn("Local Font Access API is not supported");
			return [];
		}

		try {
			const fonts: FontData[] = await this.backend.queryFonts();

			// FontDataをキャッシュ（postScriptNameまたはfullNameをキーとして使用）
			for (const font of fonts) {
				const key = font.postScriptName ?? font.fullName;
				if (key) {
					this.fontDataCache.set(key, font);
				}
			}

			// ファミリーごとにグループ化してメタデータ作成
			const familyMap = new Map<string, FontData[]>();
			for (const font of fonts) {
				const existing = familyMap.get(font.family) ?? [];
				existing.push(font);
				familyMap.set(font.family, existing);
			}

			this.fontList = [];

			for (const [family, variants] of familyMap) {
				// 各バリアント
				for (const variant of variants) {
					// postScriptNameがない場合はfullNameをフォールバックとして使用
					const identifier = variant.postScriptName ?? variant.fullName;
					if (!identifier) {
						console.warn(
							`Skipping font "${variant.fullName}" - no postScriptName or fullName`,
						);
						continue;
					}
					this.fontList.push({
						family,
						fullName: variant.fullName,
						postScriptName: identifier,
						style: variant.style,
						weight: this.inferWeightFromStyle(variant.style),
						source: "local" as const,
					});
				}
			}

			return this.fontList;
		} catch (error) {
			// ユーザーが権限を拒否した場合など
			console.error("Failed to query local fonts:", error);
			return [];
		}
	}

	/**
	 * Scripts detected for a queried font, or null while still unresolved.
	 */
	public getScripts(identifier: string): FontScript[] | null {
		return this.scripts.get(identifier) ?? null;
	}

	/**
	 * Detect writing systems for every queried font by reading only font
	 * headers. Runs once per loader; `onProgress` is throttled and always
	 * called after the last font so listeners can refresh their view.
	 */
	public resolveScripts(onProgress: () => void): Promise<void> {
		this.scriptsResolution ??= this.doResolveScripts(onProgress);
		return this.scriptsResolution;
	}

	private async doResolveScripts(onProgress: () => void): Promise<void> {
		const pending = [...this.fontDataCache.entries()].filter(
			([key]) => !this.scripts.has(key),
		);
		let lastProgress = 0;
		const resolveOne = async ([key, fontData]: [string, FontData]) => {
			this.scripts.set(
				key,
				await detectFontScripts(fontData.readRange).catch(() => []),
			);
			const now = performance.now();
			if (now - lastProgress < SCRIPT_PROGRESS_INTERVAL_MS) return;
			lastProgress = now;
			onProgress();
		};
		const workers = Array.from(
			{ length: SCRIPT_RESOLVE_CONCURRENCY },
			async () => {
				for (let entry = pending.pop(); entry; entry = pending.pop()) {
					await resolveOne(entry);
				}
			},
		);
		await Promise.all(workers);
		onProgress();
	}

	/**
	 * フォントをロード
	 */
	public async loadFont(
		postScriptName: string,
		weight = 400,
	): Promise<LoadedFont | null> {
		const cacheKey = getFontCacheKey(postScriptName, weight);

		// キャッシュチェック
		const cached = this.loadedFonts.get(cacheKey);
		if (cached) {
			return cached;
		}

		// ロード中の場合は待機
		const loading = this.loadingPromises.get(cacheKey);
		if (loading) {
			return loading;
		}

		// ロード開始
		const loadPromise = this.doLoadFont(postScriptName, weight, cacheKey);
		this.loadingPromises.set(cacheKey, loadPromise);

		try {
			return await loadPromise;
		} finally {
			this.loadingPromises.delete(cacheKey);
		}
	}

	private async doLoadFont(
		postScriptName: string,
		_weight: number,
		cacheKey: string,
	): Promise<LoadedFont | null> {
		// キャッシュされたFontDataを探す
		let fontData = this.fontDataCache.get(postScriptName);

		// キャッシュになければ再取得
		if (!fontData) {
			if (!this.isSupported()) {
				throw new Error("Local Font Access API is not supported");
			}

			const fonts: FontData[] = await this.backend.queryFontsByPostScriptNames([
				postScriptName,
			]);

			if (fonts.length === 0) {
				throw new Error(`Font not found: ${postScriptName}`);
			}

			fontData = fonts[0];
			this.fontDataCache.set(postScriptName, fontData);
		}

		// フォントデータをBlob→ArrayBufferとして取得
		const blob = await fontData.blob();
		const data = await blob.arrayBuffer();

		// Fontkitでパース
		const fontResult = fontkit.create(Buffer.from(data));
		// TTC (TrueType Collection) の場合はpostScriptNameでマッチ
		let font: fontkit.Font;
		if ("fonts" in fontResult) {
			const matched = (fontResult as { fonts: fontkit.Font[] }).fonts.find(
				(f) => f.postscriptName === postScriptName,
			);
			if (!matched) return null;
			font = matched;
		} else {
			font = fontResult;
		}

		// DOMでフォントを使えるようにする（@font-face登録）
		await this.registerFontFace(fontData, data, font);

		const loadedFont: LoadedFont = {
			metadata: {
				family: fontData.family,
				fullName: fontData.fullName,
				postScriptName: fontData.postScriptName,
				style: fontData.style,
				weight: this.inferWeightFromStyle(fontData.style),
				source: "local",
				...extractLocalizedNames(font),
			},
			fontkit: font,
			cssFontFamily: `"${fontData.postScriptName}", "${fontData.family}", sans-serif`,
			data,
		};

		this.loadedFonts.set(cacheKey, loadedFont);
		return loadedFont;
	}

	/**
	 * @font-faceを登録してDOMで使えるようにする
	 */
	private async registerFontFace(
		fontData: FontData,
		data: ArrayBuffer,
		font: fontkit.Font,
	): Promise<void> {
		try {
			// PostScriptNameをfont-familyとして登録（重複回避）
			const fontFace = new FontFace(fontData.postScriptName, data, {
				weight: fontFaceWeight(font, this.inferWeightFromStyle(fontData.style)),
				style: this.inferFontStyle(fontData.style),
			});

			await fontFace.load();
			document.fonts.add(fontFace);

			console.log(`📝 Registered local font face: ${fontData.postScriptName}`);
		} catch (error) {
			console.error(
				`Failed to register font face ${fontData.postScriptName}:`,
				error,
			);
		}
	}

	/**
	 * Register a pre-built LoadedFont into the cache (used in tests and embedded font injection).
	 */
	public registerLoadedFont(font: LoadedFont): void {
		const cacheKey = getFontCacheKey(
			font.metadata.postScriptName,
			font.metadata.weight,
		);
		this.loadedFonts.set(cacheKey, font);
	}

	/**
	 * フォントがロード済みかチェック
	 */
	public isLoaded(identifier: string): boolean {
		const [postScriptName, weightStr] = identifier.split(":");
		const weight = weightStr ? parseWeightString(weightStr) : 400;
		return this.loadedFonts.has(getFontCacheKey(postScriptName, weight));
	}

	/**
	 * ロード済みフォントを取得
	 */
	public getLoadedFont(identifier: string): LoadedFont | undefined {
		const [postScriptName, weightStr] = identifier.split(":");
		const weight = weightStr ? parseWeightString(weightStr) : 400;
		return this.loadedFonts.get(getFontCacheKey(postScriptName, weight));
	}

	/**
	 * フォントを検索
	 */
	public async searchFonts(query: string): Promise<FontMetadata[]> {
		const fonts = await this.queryFonts();
		const normalizedQuery = query.toLowerCase();

		return fonts.filter(
			(font) =>
				font.family.toLowerCase().includes(normalizedQuery) ||
				font.fullName.toLowerCase().includes(normalizedQuery) ||
				font.postScriptName.toLowerCase().includes(normalizedQuery),
		);
	}

	/**
	 * スタイル文字列からウェイトを推測
	 */
	private inferWeightFromStyle(style: string): number {
		const normalized = style.toLowerCase();

		if (normalized.includes("thin") || normalized.includes("hairline"))
			return 100;
		if (normalized.includes("extralight") || normalized.includes("ultralight"))
			return 200;
		if (
			normalized.includes("light") &&
			!normalized.includes("extralight") &&
			!normalized.includes("ultralight")
		)
			return 300;
		if (normalized.includes("regular") || normalized.includes("normal"))
			return 400;
		if (normalized.includes("medium")) return 500;
		if (normalized.includes("semibold") || normalized.includes("demibold"))
			return 600;
		if (
			normalized.includes("bold") &&
			!normalized.includes("semibold") &&
			!normalized.includes("extrabold") &&
			!normalized.includes("ultrabold")
		)
			return 700;
		if (normalized.includes("extrabold") || normalized.includes("ultrabold"))
			return 800;
		if (normalized.includes("black") || normalized.includes("heavy"))
			return 900;

		return 400;
	}

	/**
	 * スタイル文字列からfont-styleを推測
	 */
	private inferFontStyle(style: string): "normal" | "italic" | "oblique" {
		const normalized = style.toLowerCase();
		if (normalized.includes("italic")) return "italic";
		if (normalized.includes("oblique")) return "oblique";
		return "normal";
	}
}

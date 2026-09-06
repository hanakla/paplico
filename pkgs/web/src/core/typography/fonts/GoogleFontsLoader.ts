/**
 * GoogleFontsLoader
 * Google Fonts APIを使用してフォントを読み込み
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
import { googleSubsetsToScripts } from "./os2Scripts";

/**
 * Google Fonts API レスポンス型
 */
interface GoogleFontsAPIResponse {
	kind: string;
	items: GoogleFontItem[];
}

interface GoogleFontItem {
	family: string;
	variants: string[];
	subsets: string[];
	version: string;
	lastModified: string;
	files: Record<string, string>;
	category: string;
	kind: string;
}

/**
 * Google Fontsローダー
 */
export class GoogleFontsLoader implements FontLoader {
	private apiKey: string | null;
	private loadedFonts: Map<string, LoadedFont> = new Map();
	private fontList: FontMetadata[] | null = null;
	private loadingPromises: Map<string, Promise<LoadedFont>> = new Map();
	/** family → (variant → TTF URL) のマッピング。queryFonts時にAPIレスポンスから構築 */
	private fontFiles: Map<string, Record<string, string>> = new Map();

	public constructor(apiKey?: string) {
		this.apiKey = apiKey ?? null;
	}

	/**
	 * APIキーを後から設定（シングルトン初期化順序問題の対策）
	 * フォント一覧キャッシュはクリアして再取得を促す
	 * @returns キーが実際に変わった場合true（呼び出し側が一覧の再取得をトリガーする判断に使う）
	 */
	public setApiKey(apiKey: string): boolean {
		if (this.apiKey === apiKey) return false;
		this.apiKey = apiKey;
		this.fontList = null;
		this.fontFiles.clear();
		return true;
	}

	/**
	 * 利用可能なフォント一覧を取得
	 */
	public async queryFonts(): Promise<FontMetadata[]> {
		if (this.fontList) {
			return this.fontList;
		}

		try {
			const url = this.apiKey
				? `https://www.googleapis.com/webfonts/v1/webfonts?key=${this.apiKey}&sort=popularity`
				: "https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity";

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`Google Fonts API error: ${response.status}`);
			}

			const data: GoogleFontsAPIResponse = await response.json();

			this.fontList = data.items.map((item) => {
				this.fontFiles.set(item.family, item.files);
				return {
					family: item.family,
					fullName: item.family,
					postScriptName: item.family.replace(/\s+/g, ""),
					style: "Regular",
					weight: 400,
					source: "google" as const,
					variants: item.variants,
					scripts: googleSubsetsToScripts(item.subsets),
				};
			});

			return this.fontList;
		} catch (error) {
			console.error("Failed to fetch Google Fonts list:", error);
			return [];
		}
	}

	/**
	 * フォントをロード
	 */
	public async loadFont(
		family: string,
		weight = 400,
	): Promise<LoadedFont | null> {
		const cacheKey = getFontCacheKey(family, weight);

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
		const loadPromise = this.doLoadFont(family, weight, cacheKey);
		this.loadingPromises.set(cacheKey, loadPromise);

		try {
			const font = await loadPromise;
			return font;
		} finally {
			this.loadingPromises.delete(cacheKey);
		}
	}

	private async doLoadFont(
		family: string,
		weight: number,
		cacheKey: string,
	): Promise<LoadedFont> {
		// fontFilesが未構築の場合はqueryFontsを先に呼んでAPIレスポンスを取得
		if (this.fontFiles.size === 0) {
			await this.queryFonts();
		}

		// fontFiles（APIレスポンスのfiles）からフルフォントのTTF URLを取得。
		// CSS2 APIの&text=パラメータはサブセット化を引き起こすため、
		// CJKフォントで日本語グリフが欠落する問題が発生する。
		const fontUrl = this.getFontFileUrl(family, weight);
		if (!fontUrl) {
			throw new Error(`No font file URL for ${family}:${weight}`);
		}

		const response = await fetch(fontUrl);
		if (!response.ok) {
			throw new Error(`Failed to download font: ${response.status}`);
		}

		const data = await response.arrayBuffer();

		// Fontkitでパース（ブラウザではUint8Arrayを使用）
		const fontResult = fontkit.create(
			new Uint8Array(data) as unknown as Buffer,
		);
		// 単一フォントを想定（FontCollectionではない）
		const font =
			"fonts" in fontResult
				? (fontResult as { fonts: fontkit.Font[] }).fonts[0]
				: fontResult;

		// DOMでフォントを使えるようにする（@font-face登録）
		await this.registerFontFace(family, weight, data);

		const loadedFont: LoadedFont = {
			metadata: {
				family,
				fullName: font.fullName ?? family,
				postScriptName: font.postscriptName ?? family.replace(/\s+/g, ""),
				style: this.getStyleFromWeight(weight),
				weight,
				source: "google",
				...extractLocalizedNames(font),
			},
			fontkit: font,
			cssUrl: fontUrl,
			cssFontFamily: `"${family}", sans-serif`,
			data,
		};

		this.loadedFonts.set(cacheKey, loadedFont);
		return loadedFont;
	}

	/**
	 * fontFilesマップからフォントファイルURLを取得する。
	 * Google Fonts APIレスポンスのfilesフィールドにはウェイト別のフルTTF URLが含まれ、
	 * CSS2 APIのtext=パラメータによるサブセット化問題を回避できる。
	 */
	private getFontFileUrl(family: string, weight: number): string | null {
		const files = this.fontFiles.get(family);
		if (!files) return null;

		// ウェイト数値 → variantキー: 400="regular", 400italic="italic", 700="700"
		const variantKey = weight === 400 ? "regular" : String(weight);
		const url = files[variantKey] ?? files.regular ?? Object.values(files)[0];
		if (!url) return null;

		// Google Fonts APIはhttp://を返すことがあるのでhttps://に変換
		return url.replace(/^http:\/\//, "https://");
	}

	/**
	 * @font-faceを登録してDOMで使えるようにする
	 */
	private async registerFontFace(
		family: string,
		weight: number,
		data: ArrayBuffer,
	): Promise<void> {
		try {
			const fontFace = new FontFace(family, data, {
				weight: String(weight),
				style: "normal",
			});

			await fontFace.load();
			document.fonts.add(fontFace);

			console.log(`📝 Registered font face: ${family}:${weight}`);
		} catch (error) {
			console.error(`Failed to register font face ${family}:`, error);
		}
	}

	/**
	 * フォントがロード済みかチェック
	 */
	public isLoaded(identifier: string): boolean {
		// identifier形式: "family" または "family:weight"
		const [family, weightStr] = identifier.split(":");
		const weight = weightStr ? parseWeightString(weightStr) : 400;
		return this.loadedFonts.has(getFontCacheKey(family, weight));
	}

	/**
	 * ロード済みフォントを取得
	 */
	public getLoadedFont(identifier: string): LoadedFont | undefined {
		const [family, weightStr] = identifier.split(":");
		const weight = weightStr ? parseWeightString(weightStr) : 400;
		return this.loadedFonts.get(getFontCacheKey(family, weight));
	}

	/**
	 * Pre-register a LoadedFont directly into the cache.
	 * Used for injecting test fonts or pre-loaded fonts that should be
	 * resolvable via Google font source references.
	 */
	public registerLoadedFont(font: LoadedFont): void {
		const cacheKey = getFontCacheKey(
			font.metadata.family,
			font.metadata.weight,
		);
		this.loadedFonts.set(cacheKey, font);
	}

	/**
	 * フォントを検索
	 */
	public async searchFonts(query: string): Promise<FontMetadata[]> {
		const fonts = await this.queryFonts();
		const normalizedQuery = query.toLowerCase();

		return fonts.filter((font) =>
			font.family.toLowerCase().includes(normalizedQuery),
		);
	}

	/**
	 * ウェイトからスタイル文字列を取得
	 */
	private getStyleFromWeight(weight: number): string {
		if (weight <= 200) return "Thin";
		if (weight <= 300) return "Light";
		if (weight <= 400) return "Regular";
		if (weight <= 500) return "Medium";
		if (weight <= 600) return "SemiBold";
		if (weight <= 700) return "Bold";
		if (weight <= 800) return "ExtraBold";
		return "Black";
	}
}

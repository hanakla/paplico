/**
 * GoogleFontsLoader
 * Google Fonts APIを使用してフォントを読み込み
 */

import { type FontFile, FontLoader, type FontMetadata } from "./FontLoader";
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
 * Google Fonts loader. A fontId is a family name, optionally suffixed with
 * `:<weight>` to pin one weight file of a family that has no variable file.
 */
export class GoogleFontsLoader extends FontLoader {
	public readonly id = "google";
	public readonly label = "Google Fonts";
	private apiKey: string | null;
	private fontList: FontMetadata[] | null = null;
	/** family → (variant → TTF URL) のマッピング。queryFonts時にAPIレスポンスから構築 */
	private fontFiles: Map<string, Record<string, string>> = new Map();

	public constructor(apiKey?: string) {
		super();
		this.apiKey = apiKey ?? null;
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
				? `https://www.googleapis.com/webfonts/v1/webfonts?key=${this.apiKey}&sort=popularity&capability=VF`
				: "https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&capability=VF";

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
					loaderId: this.id,
					fontId: item.family,
					scripts: googleSubsetsToScripts(item.subsets),
				};
			});

			return this.fontList;
		} catch (error) {
			console.error("Failed to fetch Google Fonts list:", error);
			return [];
		}
	}

	protected async fetchFont(fontId: string): Promise<FontFile> {
		const [family, pinnedWeight] = fontId.split(":");
		// fontFilesが未構築の場合はqueryFontsを先に呼んでAPIレスポンスを取得
		if (this.fontFiles.size === 0) {
			await this.queryFonts();
		}

		// fontFiles（APIレスポンスのfiles）からフルフォントのTTF URLを取得。
		// CSS2 APIの&text=パラメータはサブセット化を引き起こすため、
		// CJKフォントで日本語グリフが欠落する問題が発生する。
		const file = this.getFontFile(family, pinnedWeight);
		if (!file) {
			throw new Error(`No font file URL for ${fontId}`);
		}

		const response = await fetch(file.url);
		if (!response.ok) {
			throw new Error(`Failed to download font: ${response.status}`);
		}

		return {
			data: await response.arrayBuffer(),
			metadata: {
				family,
				fullName: family,
				postScriptName: family.replace(/\s+/g, ""),
				style: this.getStyleFromWeight(file.weight),
				weight: file.weight,
			},
		};
	}

	/**
	 * Pick one weight file of a family from the API response's `files`.
	 * Without a pinned weight the regular file wins, then the first numeric one.
	 */
	private getFontFile(
		family: string,
		pinnedWeight: string | undefined,
	): { url: string; weight: number } | null {
		const files = this.fontFiles.get(family);
		if (!files) return null;

		const variants = Object.keys(files);
		const weight = Number(
			pinnedWeight ??
				(variants.includes("regular")
					? 400
					: (variants.find((variant) => /^\d+$/.test(variant)) ?? 400)),
		);
		// Variant keys: 400 = "regular", 400 italic = "italic", 700 = "700"
		const url =
			files[weight === 400 ? "regular" : String(weight)] ??
			files.regular ??
			Object.values(files)[0];
		if (!url) return null;

		return {
			// Google Fonts APIはhttp://を返すことがあるのでhttps://に変換
			url: url.replace(/^http:\/\//, "https://"),
			weight,
		};
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

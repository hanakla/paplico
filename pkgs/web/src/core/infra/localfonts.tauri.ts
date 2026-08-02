/**
 * Tauri implementation of LocalFontBackend using tauri-plugin-system-fonts.
 */

import type {
	FontData,
	LocalFontBackend,
} from "../typography/fonts/LocalFontsLoader";

interface SystemFont {
	id: string;
	name: string;
	fontName: string;
	path: string;
	weight: number;
	style: "normal" | "italic" | "oblique";
	monospaced: boolean;
}

const WEIGHT_NAMES: Record<number, string> = {
	100: "Thin",
	200: "ExtraLight",
	300: "Light",
	400: "Regular",
	500: "Medium",
	600: "SemiBold",
	700: "Bold",
	800: "ExtraBold",
	900: "Black",
};

function buildStyleString(weight: number, style: string): string {
	const nearest = [100, 200, 300, 400, 500, 600, 700, 800, 900].reduce(
		(prev, curr) =>
			Math.abs(curr - weight) < Math.abs(prev - weight) ? curr : prev,
	);
	const weightName = WEIGHT_NAMES[nearest] ?? "Regular";
	if (style === "italic") return `${weightName} Italic`;
	if (style === "oblique") return `${weightName} Oblique`;
	return weightName;
}

export class TauriLocalFontBackend implements LocalFontBackend {
	private cache: Map<string, SystemFont> | null = null;

	public isSupported(): boolean {
		return true;
	}

	public async queryFonts(): Promise<FontData[]> {
		const { getSystemFonts } = await import("tauri-plugin-system-fonts-api");
		const systemFonts: SystemFont[] = await getSystemFonts();

		this.cache = new Map();
		for (const sf of systemFonts) {
			if (sf.fontName) {
				this.cache.set(sf.fontName, sf);
			}
		}

		return systemFonts
			.filter((sf) => sf.fontName)
			.map((sf) => this.toFontData(sf));
	}

	public async queryFontsByPostScriptNames(
		names: string[],
	): Promise<FontData[]> {
		if (!this.cache) await this.queryFonts();

		const nameSet = new Set(names);
		return [...this.cache!.entries()]
			.filter(([psName]) => nameSet.has(psName))
			.map(([, sf]) => this.toFontData(sf));
	}

	private toFontData(sf: SystemFont): FontData {
		return {
			family: sf.name,
			fullName: sf.fontName,
			postScriptName: sf.fontName,
			style: buildStyleString(sf.weight, sf.style),
			blob: () => this.loadFontBlob(sf.path),
		};
	}

	private async loadFontBlob(path: string): Promise<Blob> {
		const { invoke } = await import("@tauri-apps/api/core");
		const bytes: number[] = await invoke("load_font_data", { path });
		return new Blob([new Uint8Array(bytes)]);
	}
}

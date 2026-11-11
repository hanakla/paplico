import { DomLocalFontBackend } from "@paplico/core/infra";
import {
	type FontLoader,
	GoogleFontsLoader,
	LocalFontsLoader,
} from "@paplico/core/typography";
import { IS_TAURI_ENV } from "@/utils/platform";
import { TauriLocalFontBackend } from "./localfonts.tauri";

/**
 * Font loaders the app registers with Paplico: Google Fonts, and the fonts
 * installed on this device read through the platform's own API.
 */
export function createFontLoaders(
	googleFontsApiKey: string | undefined,
): FontLoader[] {
	const localBackend = IS_TAURI_ENV
		? new TauriLocalFontBackend()
		: new DomLocalFontBackend();
	return [
		new GoogleFontsLoader(googleFontsApiKey),
		new LocalFontsLoader(localBackend),
	];
}

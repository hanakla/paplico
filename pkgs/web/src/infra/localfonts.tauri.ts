/**
 * Tauri implementation of LocalFontBackend on the app's own
 * `queryLocalFonts` plugin, which asks the OS for its fonts the way the
 * browser does.
 */

import { pollFontChanges } from "@paplico/core/infra";
import type { FontData, LocalFontBackend } from "@paplico/core/typography";
import {
	hasNativeChangeEvents,
	onLocalFontsChanged,
	type FontData as PluginFontData,
	queryLocalFonts,
	readFontRange,
} from "@paplico/tauri-plugin-query-local-fonts";

/** One install writes several times, so changes settle before reporting. */
const CHANGE_SETTLE_MS = 1_000;

export class TauriLocalFontBackend implements LocalFontBackend {
	public isSupported(): boolean {
		return true;
	}

	public async queryFonts(): Promise<FontData[]> {
		return (await queryLocalFonts()).map(toFontData);
	}

	public async queryFontsByPostScriptNames(
		names: string[],
	): Promise<FontData[]> {
		return (await queryLocalFonts({ postscriptNames: names })).map(toFontData);
	}

	public onFontsChanged(listener: () => void): () => void {
		let stop = () => {};
		let stopped = false;
		void (async () => {
			const stopListening = (await hasNativeChangeEvents())
				? await listenToNativeChanges(listener)
				: pollFontChanges(() => this.queryFonts(), listener);
			if (stopped) stopListening();
			else stop = stopListening;
		})();
		return () => {
			stopped = true;
			stop();
		};
	}
}

async function listenToNativeChanges(
	listener: () => void,
): Promise<() => void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const unlisten = await onLocalFontsChanged(() => {
		clearTimeout(timer);
		timer = setTimeout(listener, CHANGE_SETTLE_MS);
	});
	return () => {
		clearTimeout(timer);
		unlisten();
	};
}

function toFontData(font: PluginFontData): FontData {
	return {
		family: font.family,
		fullName: font.fullName,
		postScriptName: font.postscriptName,
		style: font.style,
		blob: () => font.blob(),
		readRange: (offset, length) => readFontRange(font, offset, length),
	};
}

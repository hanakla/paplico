import type { FontSource } from "@paplico/core/schema";
import type { FontMetadata } from "@paplico/core/typography";

export function buildFontSource(font: FontMetadata): FontSource {
	return { loaderId: font.loaderId, fontId: font.fontId };
}

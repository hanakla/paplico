import { type Document, type FontSource, isText } from "../../schema";
import type { Migration } from "./index";

type LegacyFontSource =
	| { type: "google"; family: string; variants: string[] }
	| { type: "local"; postScriptName: string }
	| { type: "embedded"; fileUid: string };

/**
 * Rewrite text font sources from the fixed google/local/embedded kinds into
 * `{ loaderId, fontId }`, so any registered font loader can resolve them.
 * A Google source keeps the single weight file it loaded by carrying that
 * weight in its fontId.
 */
export const migFontSourceLoader: Migration = {
	version: 20260927,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (!element || !isText(element)) continue;

			element.defaultStyle.fontSource = toFontSource(
				element.defaultStyle.fontSource as unknown as LegacyFontSource,
			);
			for (const paragraph of element.content.paragraphs) {
				for (const run of paragraph.runs) {
					run.style.fontSource = toFontSource(
						run.style.fontSource as unknown as LegacyFontSource,
					);
				}
			}
		}
	},
};

function toFontSource(legacy: LegacyFontSource): FontSource {
	switch (legacy.type) {
		case "google": {
			const weight = legacy.variants.includes("regular")
				? undefined
				: legacy.variants.find((variant) => /^\d+$/.test(variant));
			return {
				loaderId: "google",
				fontId:
					weight && weight !== "400"
						? `${legacy.family}:${weight}`
						: legacy.family,
			};
		}
		case "local":
			return { loaderId: "local", fontId: legacy.postScriptName };
		case "embedded":
			return { loaderId: "embedded", fontId: legacy.fileUid };
	}
}

import type { FontMetadata } from "@/core/index";
import type { FontSource } from "@/core/schema";

export const BRUSH_WIDTH_STEP = 0.1;

// --- Mixed value sentinel ---

export const MIXED = Symbol("mixed");
type MaybeM<T> = T | typeof MIXED;

/** Aggregate value from multiple elements. Returns the value if all match, MIXED otherwise */
export function resolveValue<E, V>(
	elements: E[],
	getter: (el: E) => V,
): MaybeM<V> {
	if (elements.length === 0) return undefined as MaybeM<V>;
	const first = getter(elements[0]);
	for (let i = 1; i < elements.length; i++) {
		if (getter(elements[i]) !== first) return MIXED;
	}
	return first;
}

/** Build FontSource from FontMetadata */
export function buildFontSource(font: FontMetadata): FontSource | null {
	if (font.source === "google") {
		return {
			type: "google",
			family: font.family,
			variants: font.variants ?? ["regular"],
		};
	}
	if (font.source === "local") {
		if (!font.postScriptName) {
			console.error("Local font missing postScriptName:", font);
			return null;
		}
		return { type: "local", postScriptName: font.postScriptName };
	}
	return null;
}

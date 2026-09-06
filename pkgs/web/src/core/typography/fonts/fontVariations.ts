import type { Font } from "fontkit";
import type { TextStyle } from "../../schema";

/** Resolve coordinates without changing the document's stored style. */
export function resolveFontVariations(
	style: TextStyle,
	axes: Font["variationAxes"],
): Record<string, number> {
	const values: Record<string, number> = {};
	for (const tag of Object.keys(axes).sort()) {
		const axis = axes[tag];
		if (!axis) continue;
		const explicit = style.fontVariationSettings?.[tag];
		const requested =
			tag === "wght"
				? style.fontWeight
				: explicit !== undefined && Number.isFinite(explicit)
					? explicit
					: tag === "ital"
						? style.fontStyle === "italic"
							? 1
							: 0
						: axis.default;
		values[tag] = Number.isFinite(requested)
			? Math.max(axis.min, Math.min(axis.max, requested))
			: axis.default;
	}
	return values;
}

/** Update one axis while preserving every other run-specific coordinate. */
export function updateFontVariation(
	style: TextStyle,
	axes: Font["variationAxes"],
	tag: string,
	value: number | null,
): TextStyle {
	const axis = axes[tag];
	if (!axis || (value !== null && !Number.isFinite(value))) return style;
	const settings = { ...style.fontVariationSettings };
	delete settings.wght;
	if (tag === "wght") {
		return {
			...style,
			fontWeight: Math.max(axis.min, Math.min(axis.max, value ?? axis.default)),
			fontVariationSettings: settings,
		};
	}
	if (value === null) delete settings[tag];
	else settings[tag] = Math.max(axis.min, Math.min(axis.max, value));
	return {
		...style,
		fontVariationSettings: settings,
		...(tag === "ital" && value === null
			? {
					fontStyle:
						axis.default === 0 ? ("normal" as const) : ("italic" as const),
				}
			: {}),
	};
}

/** Canonical order makes equivalent coordinates share an instance. */
export function fontVariationKey(values: Record<string, number>): string {
	return JSON.stringify(
		Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
	);
}

/** FontFace needs the complete weight range to expose variable weights to DOM text. */
export function fontFaceWeight(font: Font, weight: number): string {
	const axis = font.variationAxes?.wght;
	return axis ? `${axis.min} ${axis.max}` : String(weight);
}

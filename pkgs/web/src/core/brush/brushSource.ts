import {
	type BrushArtSource,
	type BrushSettings,
	type BrushSettingsV2,
	BUILTIN_BRUSH_IDS,
} from "../schema";

/**
 * Resolver supplied by the renderer to translate a brush `def` source into a
 * cached GPUTexture key (see DefRasterizer.textureUidFor). Returning `null`
 * triggers the built-in-texture fallback so missing / broken defs do not
 * break the stamp pipeline.
 */
export interface DefSourceResolver {
	resolveDefTextureUid(defId: string): string | null;
}

/**
 * Return a copy of `settings` whose primary texture source points at `fileUid`.
 * Texture-backed methods (scatter/art/pattern) get their `source` re-pointed;
 * texture-less methods (stroke/calligraphy) are returned unchanged.
 *
 * Legacy flat records (no `type` discriminator) can still reach this function
 * at runtime from unnormalized persisted data — normalization must happen at
 * the read boundary (see normalizeBrushSettings), but this function returns
 * `settings` unchanged rather than `undefined` as a last-resort backstop.
 */
export function withTextureFileUid<T extends BrushSettings | BrushSettingsV2>(
	settings: T,
	fileUid: string,
): T {
	if ("version" in settings && settings.version === 2) {
		const v2 = settings as BrushSettingsV2;
		if (v2.tip?.kind === "image") {
			return {
				...v2,
				tip: {
					...v2.tip,
					sources: [{ kind: "file", fileUid }, ...v2.tip.sources.slice(1)],
				},
			} as T;
		}
		if (v2.ribbon) {
			return {
				...v2,
				ribbon: { ...v2.ribbon, source: { kind: "file", fileUid } },
			} as T;
		}
		return settings;
	}
	switch ((settings as BrushSettings).type) {
		case "scatter":
		case "art":
		case "pattern":
			return { ...settings, source: { kind: "file", fileUid } };
		case "stroke":
		case "calligraphy":
			return settings;
		default:
			return settings;
	}
}

/**
 * Resolve the texture UID a brush stamp/ribbon pipeline should sample.
 * Returns null for geometric stroke (no texture). `def` sources will be
 * rasterized via DefRasterizer in a later step; until then they fall back to a
 * built-in texture so existing rendering keeps working.
 */
export function resolveBrushTextureUid(
	s: BrushSettings | BrushSettingsV2,
	defResolver?: DefSourceResolver,
): string | null {
	if ("version" in s) {
		if (s.tip?.kind === "image") {
			return resolveSourceUid(s.tip.sources[0], defResolver);
		}
		if (s.ribbon) return resolveSourceUid(s.ribbon.source, defResolver);
		if (s.engine === "geometric") return null;
		// Procedural dab tips render without an image but the stamp pipeline
		// still needs a bound texture (same as calligraphy below).
		return BUILTIN_BRUSH_IDS.hardCircle;
	}
	switch (s.type) {
		case "stroke":
			return null;
		case "scatter":
		case "art":
		case "pattern":
			return resolveSourceUid(s.source, defResolver);
		case "calligraphy":
			// Calligraphy renders as a procedural elliptical nib via texture
			// scaling, but the stamp pipeline still needs a bound texture —
			// the hard circle keeps the bind group valid.
			return BUILTIN_BRUSH_IDS.hardCircle;
	}
}

/** Resolve scatter variant sources (if any) to texture UIDs. */
export function resolveScatterSourceUids(
	sources: readonly BrushArtSource[] | undefined,
	defResolver?: DefSourceResolver,
): string[] {
	return sources?.map((s) => resolveSourceUid(s, defResolver)) ?? [];
}

/** Resolve an optional named source slot (start/end) to a texture UID. */
export function resolveOptionalSourceUid(
	source: BrushArtSource | undefined,
	defResolver?: DefSourceResolver,
): string | undefined {
	return source ? resolveSourceUid(source, defResolver) : undefined;
}

function resolveSourceUid(
	source: BrushArtSource,
	defResolver?: DefSourceResolver,
): string {
	if (source.kind === "file") return source.fileUid;
	// `def` source: route through the supplied resolver (DefRasterizer-backed).
	// When the caller did not pass a resolver, or the resolver could not
	// resolve the def (missing entry, circular reference, render failure),
	// fall back to a built-in texture so existing rendering keeps working.
	const resolved = defResolver?.resolveDefTextureUid(source.defId) ?? null;
	return resolved ?? BUILTIN_BRUSH_IDS.hardCircle;
}

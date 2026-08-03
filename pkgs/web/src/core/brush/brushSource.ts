import {
	type BrushArtSource,
	type BrushSettings,
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
export function withTextureFileUid(
	settings: BrushSettings,
	fileUid: string,
): BrushSettings {
	switch (settings.type) {
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
	s: BrushSettings,
	defResolver?: DefSourceResolver,
): string | null {
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

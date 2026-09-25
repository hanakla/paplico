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
 * Image tips and ribbons get their source re-pointed; procedural tips and the
 * geometric engine sample no texture and come back unchanged.
 */
export function withTextureFileUid(
	settings: BrushSettings,
	fileUid: string,
): BrushSettings {
	if (settings.tip?.kind === "image") {
		return {
			...settings,
			tip: {
				...settings.tip,
				sources: [{ kind: "file", fileUid }, ...settings.tip.sources.slice(1)],
			},
		};
	}
	if (settings.ribbon) {
		return {
			...settings,
			ribbon: { ...settings.ribbon, source: { kind: "file", fileUid } },
		};
	}
	return settings;
}

/**
 * Resolve the texture UID a brush stamp/ribbon pipeline should sample.
 * Returns null for geometric stroke (no texture). `def` sources are rasterized
 * via DefRasterizer; without a resolver they fall back to a built-in texture
 * so rendering keeps working.
 */
export function resolveBrushTextureUid(
	s: BrushSettings,
	defResolver?: DefSourceResolver,
): string | null {
	if (s.tip?.kind === "image") {
		return resolveSourceUid(s.tip.sources[0], defResolver);
	}
	if (s.ribbon) return resolveSourceUid(s.ribbon.source, defResolver);
	if (s.engine === "geometric") return null;
	// Procedural dab tips render without an image but the stamp pipeline
	// still needs a bound texture.
	return BUILTIN_BRUSH_IDS.hardCircle;
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

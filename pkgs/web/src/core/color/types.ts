/** Builtin ICC profiles bundled under /assets/icc/. */
export type BuiltinIccProfileId = "srgb" | "display-p3";

/** ICC rendering intent for color conversions. */
export type RenderingIntent =
	| "perceptual"
	| "relative-colorimetric"
	| "saturation"
	| "absolute-colorimetric";

/** Reference to a proof profile: bundled builtin or document-embedded ICC file. */
export type ProofProfileRef =
	| { kind: "builtin"; id: BuiltinIccProfileId }
	| { kind: "embedded"; fileUid: string };

/** RGBA 3D LUT baked from an RGB->CMYK->RGB roundtrip, size^3 entries. */
export interface SoftProofLutResult {
	size: number;
	data: Uint8Array;
}

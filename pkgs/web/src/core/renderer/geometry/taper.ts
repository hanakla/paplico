/**
 * Entry/exit taper (length-based size falloff at stroke ends).
 *
 * Pure helpers shared by StampGenerator, strokeTessellator, and
 * RibbonGenerator. Lengths are expressed in world units.
 */

interface ResolvedTaper {
	/** Taper-in length in world units (0 = no entry taper). */
	taperIn: number;
	/** Taper-out length in world units (0 = no exit taper). */
	taperOut: number;
}

/**
 * Resolve requested taper lengths against the whole-stroke length and the
 * rendered fragment range.
 *
 * - `pathStart > 0` suppresses the entry taper (the fragment begins mid-stroke).
 * - `pathEnd < 1` suppresses the exit taper (the fragment ends mid-stroke).
 * - When taperIn + taperOut exceeds `wholeLength`, both are scaled
 *   proportionally so they meet in the middle (CSP behavior).
 *
 * Returns null when no taper applies.
 */
export function resolveTaper(
	taperStart: number | undefined,
	taperEnd: number | undefined,
	wholeLength: number,
	pathStart: number,
	pathEnd: number,
): ResolvedTaper | null {
	if (wholeLength <= 0) return null;

	let taperIn = pathStart > 0 ? 0 : Math.max(taperStart ?? 0, 0);
	let taperOut = pathEnd < 1 ? 0 : Math.max(taperEnd ?? 0, 0);
	if (taperIn <= 0 && taperOut <= 0) return null;

	const total = taperIn + taperOut;
	if (total > wholeLength) {
		const scale = wholeLength / total;
		taperIn *= scale;
		taperOut *= scale;
	}
	return { taperIn, taperOut };
}

/**
 * Evaluate the taper size factor at arc distance `dist` along a fragment of
 * length `fragLength`. Both sides use smoothstep easing so the tip rounds
 * off instead of forming a hard cone.
 */
export function taperFactor(
	taper: ResolvedTaper,
	dist: number,
	fragLength: number,
): number {
	const inFactor =
		taper.taperIn > 0 ? smoothstep01(Math.min(1, dist / taper.taperIn)) : 1;
	const outFactor =
		taper.taperOut > 0
			? smoothstep01(Math.min(1, (fragLength - dist) / taper.taperOut))
			: 1;
	return inFactor * outFactor;
}

function smoothstep01(t: number): number {
	return t * t * (3 - 2 * t);
}

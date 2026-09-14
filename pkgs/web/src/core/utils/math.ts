/** Linear interpolation from `a` to `b` by `t`. */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Restrict `value` into the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Restrict `value` into the inclusive range `[0, 1]`. */
export function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

/** Convert an angle in degrees into radians. */
export function degToRad(deg: number): number {
	return (deg * Math.PI) / 180;
}

/** Seeded 32-bit PRNG returning uniform values in `[0, 1)`; the same seed yields the same sequence. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

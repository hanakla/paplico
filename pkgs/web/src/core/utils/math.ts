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

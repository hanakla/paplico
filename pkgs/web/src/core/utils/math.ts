/** Linear interpolation from `a` to `b` by `t`. */
export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

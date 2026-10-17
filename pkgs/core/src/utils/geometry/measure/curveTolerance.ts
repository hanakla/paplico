/** Screen-space error budget of curve flattening and stroke arcs, in device px. */
export const DEVICE_CURVE_TOLERANCE_PX = 0.25;

const MIN_SCALE_BUCKET = -20;
const MAX_SCALE_BUCKET = 20;

/**
 * Power-of-two bucket of the transform's scale. Flattening local geometry at
 * `DEVICE_CURVE_TOLERANCE_PX / 2^bucket` keeps the device error within budget
 * for every scale in the bucket, so outlines survive small zoom changes.
 */
export function deviceScaleBucket(t: {
	a: number;
	b: number;
	c: number;
	d: number;
}): number {
	const scale = Math.sqrt(Math.abs(t.a * t.d - t.b * t.c));
	if (!(scale > 0)) return 0;
	return Math.min(
		MAX_SCALE_BUCKET,
		Math.max(MIN_SCALE_BUCKET, Math.ceil(Math.log2(scale))),
	);
}

/** Local-space flattening tolerance for a scale bucket. */
export function localCurveTolerance(scaleBucket: number): number {
	return DEVICE_CURVE_TOLERANCE_PX / 2 ** scaleBucket;
}

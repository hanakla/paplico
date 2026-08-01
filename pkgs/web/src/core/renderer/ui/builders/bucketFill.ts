import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";
import type { BucketFillUIData } from "../types";

/** hitId prefix of leak markers; the suffix is the leak's index. */
export const BUCKET_FILL_LEAK_HIT_PREFIX = "bucketFillLeak:";

/**
 * Bucket fill overlay: confirmed and in-progress cut paths (orange
 * polylines), plus leak markers when the last fill was unbounded.
 */
export function buildBucketFillOverlay(
	data: BucketFillUIData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	const stroke = {
		color: theme.colors.bucketFillCutPath,
		width: theme.strokeWidth.default,
	};

	for (const path of data.cutPaths) {
		prims.push({ kind: "polyline", points: path, stroke });
	}

	if (data.activeCutPath && data.activeCutPath.length >= 2) {
		prims.push({ kind: "polyline", points: data.activeCutPath, stroke });
	}

	if (data.leaks) {
		const leakColor = theme.colors.bucketFillLeakMarker;
		data.leaks.forEach((leak, i) => {
			// Real gap extent (world units) so the opening width is visible
			prims.push({
				kind: "circle",
				cx: leak.x,
				cy: leak.y,
				radius: { world: leak.gapWidthWorld / 2 },
				stroke: { color: leakColor, width: 1.5 },
				zIndex: 1,
			});
			// Screen-fixed marker: ring + center dot, clickable
			prims.push({
				kind: "circle",
				cx: leak.x,
				cy: leak.y,
				radius: { screen: 8 },
				stroke: { color: leakColor, width: 2 },
				zIndex: 2,
				hitId: `${BUCKET_FILL_LEAK_HIT_PREFIX}${i}`,
				hitPadding: { screen: 6 },
			});
			prims.push({
				kind: "circle",
				cx: leak.x,
				cy: leak.y,
				radius: { screen: 2 },
				fill: { color: leakColor },
				zIndex: 2,
			});
		});
	}

	return prims;
}

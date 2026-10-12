import type { BezierPoint, Document, PathSegment } from "../../schema";
import type { Migration } from "./index";

const EPSILON = 1e-6;

/**
 * Files older than this version stored a vertex's cornerRadius as the
 * distance from the vertex to where the rounding meets each edge. It is now
 * the radius of the arc, so a stored distance d becomes d / tan(φ/2), φ being
 * the angle the path turns at that vertex, and every rounding still starts
 * where it did.
 */
export const migCornerRadiusArc: Migration = {
	version: 20261012,
	migrate(doc: Document): void {
		for (const element of Object.values(doc.objects)) {
			if (element?.type !== "path") continue;
			const { segments } = element;
			if (segments.length < 2) continue;

			const isClosed = segments.at(-1)?.isClosed === true;
			for (const [i, seg] of segments.entries()) {
				if (!seg.cornerRadius) continue;

				const isLast = i === segments.length - 1;
				const segOut = isLast
					? isClosed
						? segments[0]
						: null
					: segments[i + 1];
				if (segOut == null || (!isLast && segOut.isMoved)) continue;

				const turnAngle = legacyTurnAngle(
					seg,
					segOut,
					seg.start ?? segments[i - 1]?.end,
				);
				if (turnAngle == null || turnAngle < EPSILON) continue;

				seg.cornerRadius /= Math.tan(turnAngle / 2);
			}
		}
	},
};

/**
 * The angle the path turns at segIn.end, measured the way the renderer of
 * this version did: along the handles, or along the chords where a handle
 * sits on its anchor.
 */
function legacyTurnAngle(
	segIn: PathSegment,
	segOut: PathSegment,
	prevEnd: BezierPoint | undefined,
): number | null {
	const start = segIn.start ?? prevEnd;
	const inDir = handleOrChord(
		{ x: -segIn.cp2.x, y: -segIn.cp2.y },
		start && { x: segIn.end.x - start.x, y: segIn.end.y - start.y },
	);
	const outDir = handleOrChord(segOut.cp1, {
		x: segOut.end.x - segIn.end.x,
		y: segOut.end.y - segIn.end.y,
	});
	if (inDir == null || outDir == null) return null;

	const cos = inDir.x * outDir.x + inDir.y * outDir.y;
	return Math.acos(Math.max(-1, Math.min(1, cos)));
}

function handleOrChord(
	handle: BezierPoint,
	chord: BezierPoint | undefined,
): BezierPoint | null {
	const dir = Math.hypot(handle.x, handle.y) >= EPSILON ? handle : chord;
	if (dir == null) return null;
	const len = Math.hypot(dir.x, dir.y);
	if (len < EPSILON) return null;
	return { x: dir.x / len, y: dir.y / len };
}

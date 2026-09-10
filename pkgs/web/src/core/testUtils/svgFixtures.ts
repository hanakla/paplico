import {
	type FillAppearance,
	type Filter,
	generateUid,
	type Path,
	type PathSegment,
} from "../schema";

/** Axis-aligned rectangle path centred at `center`, in world px. */
export function rectPath(
	id: string,
	center: { x: number; y: number },
	width: number,
	height: number,
	filters: Filter[],
): Path {
	const seg = (partial: Partial<PathSegment>): PathSegment => ({
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 0, y: 0 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
		...partial,
	});
	const halfW = width / 2;
	const halfH = height / 2;
	return {
		type: "path",
		id,
		opacity: 1,
		blendMode: "normal",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: [
			seg({
				start: { x: center.x - halfW, y: center.y + halfH },
				end: { x: center.x + halfW, y: center.y + halfH },
				isMoved: true,
			}),
			seg({ end: { x: center.x + halfW, y: center.y - halfH } }),
			seg({ end: { x: center.x - halfW, y: center.y - halfH } }),
			// The renderer strokes only explicit segments, so the closing edge
			// must be spelled out for its stroke to match SVG's Z.
			seg({
				end: { x: center.x - halfW, y: center.y + halfH },
				isClosed: true,
			}),
		],
		filters,
	};
}

export function solidFillAppearance(
	r: number,
	g: number,
	b: number,
): FillAppearance {
	return {
		uid: generateUid("app"),
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r, g, b, a: 1 } },
			},
		},
	};
}

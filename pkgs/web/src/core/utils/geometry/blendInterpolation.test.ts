import { describe, expect, it } from "vitest";
import { localAppearances } from "../../document/appearancePresets";
import { createIdentityTransform } from "../../document/factory";
import type {
	BlendObject,
	CompoundPath,
	FillAppearance,
	FillColor,
	Path,
	PathSegment,
} from "../../schema";
import {
	blendKeyOutlines,
	computeBlendIntermediates,
	computeSpineKeyPlacements,
	relocateSpineAnchorsToKeys,
	resolveBlendSourcePath,
} from "./blendInterpolation";

const Z = {
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
};

function rectSegments(cx: number, cy: number, size: number): PathSegment[] {
	const h = size / 2;
	return [
		{
			start: { x: cx - h, y: cy - h },
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx + h, y: cy - h },
			isMoved: true,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx + h, y: cy + h },
			isMoved: false,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx - h, y: cy + h },
			isMoved: false,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx - h, y: cy - h },
			isMoved: false,
			isClosed: true,
			...Z,
		},
	];
}

function rectSegmentsWH(
	cx: number,
	cy: number,
	w: number,
	h: number,
): PathSegment[] {
	const hw = w / 2;
	const hh = h / 2;
	return [
		{
			start: { x: cx - hw, y: cy - hh },
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx + hw, y: cy - hh },
			isMoved: true,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx + hw, y: cy + hh },
			isMoved: false,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx - hw, y: cy + hh },
			isMoved: false,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: cx - hw, y: cy - hh },
			isMoved: false,
			isClosed: true,
			...Z,
		},
	];
}

function makeRect(
	id: string,
	cx: number,
	cy: number,
	size = 50,
	fill = { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 },
): Path {
	const fillFilter: FillAppearance = {
		uid: `${id}-fill`,
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: { fill: { type: "solid", color: fill } },
		},
	};
	return {
		type: "path",
		id,
		segments: rectSegments(cx, cy, size),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		filters: [fillFilter],
	};
}

function makeBlend(
	objectIds: string[],
	spacing: BlendObject["spacing"] = { type: "steps", count: 3 },
	spineSourceId?: string,
): BlendObject {
	return {
		type: "blend",
		id: "blend-1",
		objectIds,
		spacing,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		spineSourceId,
	};
}

function bbox(segments: PathSegment[]): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
} {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of segments) {
		for (const p of [s.start, s.end]) {
			if (!p) continue;
			minX = Math.min(minX, p.x);
			minY = Math.min(minY, p.y);
			maxX = Math.max(maxX, p.x);
			maxY = Math.max(maxY, p.y);
		}
	}
	return { minX, minY, maxX, maxY };
}

function bboxCenter(segments: PathSegment[]): { x: number; y: number } {
	const b = bbox(segments);
	return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

function bboxSize(segments: PathSegment[]): { w: number; h: number } {
	const b = bbox(segments);
	return { w: b.maxX - b.minX, h: b.maxY - b.minY };
}

describe("computeBlendIntermediates", () => {
	it("returns empty when fewer than 2 objects", () => {
		const r = computeBlendIntermediates(makeBlend(["a"]), [
			makeRect("a", 0, 0),
		]);
		expect(r).toEqual([]);
	});

	it("produces N intermediates per pair (steps mode), grouped per pair", () => {
		const objs = [makeRect("a", 0, 0), makeRect("b", 100, 0)];
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], {
				type: "steps",
				count: 5,
			}),
			objs,
		);
		expect(r).toHaveLength(1); // one pair
		expect(r[0]).toHaveLength(5);
	});

	it("groups intermediates per pair for a 3-object chain", () => {
		const objs = [
			makeRect("a", 0, 0),
			makeRect("b", 100, 0),
			makeRect("c", 200, 0),
		];
		const r = computeBlendIntermediates(
			makeBlend(["a", "b", "c"], { type: "steps", count: 4 }),
			objs,
		);
		expect(r).toHaveLength(2); // two pairs
		expect(r[0]).toHaveLength(4);
		expect(r[1]).toHaveLength(4);
	});

	// Regression for bug 1: distance spacing yields a DIFFERENT count per pair.
	// A flat list could not be sliced back into pairs; the 2D grouping must.
	it("distance mode: each pair keeps its own intermediate count", () => {
		const objs = [
			makeRect("a", 0, 0),
			makeRect("b", 100, 0), // a→b centers 100 apart
			makeRect("c", 400, 0), // b→c centers 300 apart
		];
		const r = computeBlendIntermediates(
			makeBlend(["a", "b", "c"], { type: "distance", spacing: 50 }),
			objs,
		);
		expect(r).toHaveLength(2);
		// a→b: floor(100/50)-1 = 1 ; b→c: floor(300/50)-1 = 5
		expect(r[0]).toHaveLength(1);
		expect(r[1]).toHaveLength(5);
	});

	it("interpolates anchor positions linearly at the midpoint", () => {
		const objs = [makeRect("a", 0, 0, 50), makeRect("b", 100, 0, 50)];
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 1 }),
			objs,
		);
		const mid = r[0][0];
		// at t=0.5 the first anchor x is midway between -25 and 75 → 25
		expect(mid.segments[0].start?.x).toBeCloseTo(25, 1);
	});

	it("normalizes mismatched segment counts to the max", () => {
		const a = makeRect("a", 0, 0);
		const b: Path = {
			...makeRect("b", 100, 0),
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 100, y: 0 },
					isMoved: true,
					...Z,
				},
				{
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 0, y: 0 },
					isMoved: false,
					isClosed: true,
					...Z,
				},
			],
		};
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 2 }),
			[a, b],
		);
		for (const p of r[0]) expect(p.segments).toHaveLength(4);
	});

	it("interpolates fill color through OKLab (desaturated midpoint)", () => {
		const a = makeRect("a", 0, 0, 50, { type: "rgb", r: 1, g: 0, b: 0, a: 1 });
		const b = makeRect("b", 100, 0, 50, {
			type: "rgb",
			r: 0,
			g: 0,
			b: 1,
			a: 1,
		});
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 1 }),
			[a, b],
		);
		const fill = localAppearances(r[0][0].filters).find(
			(f) => f.processor === "fill",
		) as FillAppearance | undefined;
		const color = fill?.paramData.params.fill;
		expect(color?.type).toBe("solid");
		if (color?.type === "solid" && color.color.type === "rgb") {
			expect(color.color.r).toBeGreaterThan(0);
			expect(color.color.r).toBeLessThan(1);
			expect(color.color.b).toBeGreaterThan(0);
			expect(color.color.b).toBeLessThan(1);
		}
	});

	// Regression for bug 2: with a spine, the intermediate's geometry center must
	// land ON the spine point — not be double-offset by its absolute coordinates.
	it("spine mode: intermediate geometry center lands on the spine", () => {
		// Sources at distinct non-origin positions so absolute coords are non-zero.
		const objs = [makeRect("a", 0, 0, 20), makeRect("b", 300, 0, 20)];
		// Straight spine source path from (0,0) to (300,0).
		const spineSource: Path = {
			type: "path",
			id: "spine",
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 300, y: 0 },
					isMoved: true,
					...Z,
				},
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 1 }, spineSource.id),
			objs,
			spineSource,
		);
		const mid = r[0][0];
		// World-space approach: placement is baked into the segments and the
		// transform stays identity (intermediates have no transform-index slot).
		// At t=0.5 the shape's geometry center sits on the spine at x≈150.
		expect(mid.transform.x).toBeCloseTo(0, 3);
		expect(mid.transform.y).toBeCloseTo(0, 3);
		const center = bboxCenter(mid.segments);
		expect(center.x).toBeCloseTo(150, 0);
		expect(center.y).toBeCloseTo(0, 3);
	});

	it("bounds each pair's intermediates by the ACTUAL key positions, not an even split", () => {
		// 3 keys on a straight spine, with the middle key biased toward the start
		// (x=50, not the even-split x=150). Intermediates of pair 0 must sit between
		// key0 (x=0) and key1 (x=50), and pair 1 between key1 and key2 (x=300) —
		// not at the even-split midpoints (75 and 225).
		const objs = [
			makeRect("a", 0, 0, 20),
			makeRect("b", 50, 0, 20),
			makeRect("c", 300, 0, 20),
		];
		const spineSource: Path = {
			type: "path",
			id: "spine",
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 300, y: 0 },
					isMoved: true,
					...Z,
				},
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const r = computeBlendIntermediates(
			makeBlend(["a", "b", "c"], { type: "steps", count: 1 }, spineSource.id),
			objs,
			spineSource,
		);
		const c0 = bboxCenter(r[0][0].segments); // pair 0 (key0→key1)
		const c1 = bboxCenter(r[1][0].segments); // pair 1 (key1→key2)
		expect(c0.x).toBeGreaterThan(0);
		expect(c0.x).toBeLessThan(50); // within key0→key1, NOT the even-split 75
		expect(c1.x).toBeGreaterThan(50);
		expect(c1.x).toBeLessThan(300);
	});

	// tiltToSpine off (default): intermediates stay upright; on: they rotate to
	// the spine tangent. A wide rect on a vertical spine makes the 90° rotation
	// detectable as a width/height swap.
	const verticalSpine: Path = {
		type: "path",
		id: "vspine",
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 0, y: 300 },
				isMoved: true,
				...Z,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
	const wideRects = (): Path[] => [
		{ ...makeRect("a", 0, 0), segments: rectSegmentsWH(0, 0, 40, 10) },
		{ ...makeRect("b", 0, 300), segments: rectSegmentsWH(0, 300, 40, 10) },
	];

	it("keeps intermediates upright when tiltToSpine is off (default)", () => {
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 1 }, verticalSpine.id),
			wideRects(),
			verticalSpine,
		);
		const size = bboxSize(r[0][0].segments);
		expect(size.w).toBeCloseTo(40, 0);
		expect(size.h).toBeCloseTo(10, 0);
	});

	it("rotates intermediates to the spine tangent when tiltToSpine is on", () => {
		const blend = makeBlend(
			["a", "b"],
			{ type: "steps", count: 1 },
			verticalSpine.id,
		);
		blend.tiltToSpine = true;
		const r = computeBlendIntermediates(blend, wideRects(), verticalSpine);
		const size = bboxSize(r[0][0].segments);
		expect(size.w).toBeCloseTo(10, 0);
		expect(size.h).toBeCloseTo(40, 0);
	});

	// Regression: once segment counts are normalized, the two shapes' anchors may
	// start at different corners. Without correspondence alignment the midpoint
	// collapses through the center (a twisted/degenerate shape). With alignment a
	// square blended to the same square (anchors started at the opposite corner)
	// stays that square.
	it("aligns anchor correspondence so a square blends to itself without twisting", () => {
		const squareFrom = (id: string, startCorner: number): Path => {
			const corners = [
				{ x: -50, y: -50 },
				{ x: 50, y: -50 },
				{ x: 50, y: 50 },
				{ x: -50, y: 50 },
			];
			const ordered = [
				...corners.slice(startCorner),
				...corners.slice(0, startCorner),
			];
			const segs: PathSegment[] = ordered.map((c, i) => ({
				start: i === 0 ? c : undefined,
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: ordered[(i + 1) % 4],
				isMoved: i === 0,
				isClosed: i === 3 ? true : undefined,
				...Z,
			}));
			return {
				type: "path",
				id,
				segments: segs,
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};
		};

		const a = squareFrom("a", 0);
		const b = squareFrom("b", 2); // same square, anchors start at opposite corner
		const r = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 1 }),
			[a, b],
		);
		const mid = r[0][0];
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const s of mid.segments) {
			for (const p of [s.start, s.end]) {
				if (!p) continue;
				minX = Math.min(minX, p.x);
				minY = Math.min(minY, p.y);
				maxX = Math.max(maxX, p.x);
				maxY = Math.max(maxY, p.y);
			}
		}
		expect(minX).toBeCloseTo(-50, 0);
		expect(minY).toBeCloseTo(-50, 0);
		expect(maxX).toBeCloseTo(50, 0);
		expect(maxY).toBeCloseTo(50, 0);
	});

	it("reverses intermediate order when objectIds are reversed", () => {
		const a = makeRect("a", 0, 0);
		const b = makeRect("b", 100, 0);
		const fwd = computeBlendIntermediates(
			makeBlend(["a", "b"], { type: "steps", count: 3 }),
			[a, b],
		);
		const rev = computeBlendIntermediates(
			makeBlend(["b", "a"], { type: "steps", count: 3 }),
			[b, a],
		);
		const fwdFirst = fwd[0][0].segments[0].start?.x;
		const revFirst = rev[0][0].segments[0].start?.x;
		expect(fwdFirst).toBeDefined();
		expect(revFirst).toBeDefined();
		expect((fwdFirst as number) < (revFirst as number)).toBe(true);
	});

	describe("compound (holey) source blending", () => {
		const countSubPaths = (segs: PathSegment[]): number =>
			segs.filter((s, i) => i === 0 || s.isMoved).length;

		it("resolves a compound (outer − inner) to a multi-subpath outline", () => {
			const outer = makeRect("outer", 0, 0, 100);
			const inner = makeRect("inner", 0, 0, 40);
			const compound: CompoundPath = {
				type: "compound-path",
				id: "cp",
				sources: [
					{ id: "outer", op: "union" },
					{ id: "inner", op: "subtract" },
				],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};
			const map: Record<string, Path> = { outer, inner };
			const resolved = resolveBlendSourcePath(compound, (id) => map[id]);
			expect(resolved).not.toBeNull();
			// donut → outer ring + inner hole = at least 2 sub-paths
			expect(countSubPaths(resolved!.segments)).toBeGreaterThanOrEqual(2);
		});

		it("blends a compound with a plain path without throwing, finite output", () => {
			const outer = makeRect("outer", 0, 0, 100);
			const inner = makeRect("inner", 0, 0, 40);
			const compound: CompoundPath = {
				type: "compound-path",
				id: "cp",
				sources: [
					{ id: "outer", op: "union" },
					{ id: "inner", op: "subtract" },
				],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			};
			const map: Record<string, Path> = { outer, inner };
			const resolvedCompound = resolveBlendSourcePath(
				compound,
				(id) => map[id],
			);
			const target = makeRect("t", 300, 0, 80);
			const r = computeBlendIntermediates(
				makeBlend(["cp", "t"], { type: "steps", count: 3 }),
				[resolvedCompound!, target],
			);
			expect(r[0]).toHaveLength(3);
			for (const inter of r[0]) {
				for (const s of inter.segments) {
					expect(Number.isFinite(s.end.x)).toBe(true);
					expect(Number.isFinite(s.end.y)).toBe(true);
				}
			}
			// The compound's extra (hole) sub-path is preserved as it fades, so an
			// early intermediate keeps more than one sub-path.
			expect(countSubPaths(r[0][0].segments)).toBeGreaterThanOrEqual(2);
		});
	});

	describe("gradient color interpolation", () => {
		const RED = { type: "rgb" as const, r: 1, g: 0, b: 0, a: 1 };
		const BLUE = { type: "rgb" as const, r: 0, g: 0, b: 1, a: 1 };

		const withFill = (id: string, cx: number, fill: FillColor): Path => ({
			...makeRect(id, cx, 0, 50),
			filters: [
				{
					uid: `${id}-fill`,
					processor: "fill",
					opacity: 1,
					blendMode: "normal",
					paramData: { version: "1", params: { fill } },
				} as FillAppearance,
			],
		});

		const fillOf = (p: Path): FillColor | undefined =>
			(
				localAppearances(p.filters).find(
					(f) => f.processor === "fill",
				) as FillAppearance
			)?.paramData.params.fill;

		it("interpolates a solid into a linear gradient (solid as uniform)", () => {
			const a = withFill("a", 0, { type: "solid", color: RED });
			const b = withFill("b", 100, {
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [
					{ offset: 0, color: RED, midpoint: 0.5 },
					{ offset: 1, color: BLUE, midpoint: 0.5 },
				],
			});
			const r = computeBlendIntermediates(
				makeBlend(["a", "b"], { type: "steps", count: 1 }),
				[a, b],
			);
			const c = fillOf(r[0][0]);
			expect(c?.type).toBe("linear");
			if (c?.type === "linear") {
				expect(c.stops).toHaveLength(2);
				// last stop blends solid red → gradient blue → purple (r>0, b>0)
				const last = c.stops[1].color;
				if (last.type === "rgb") {
					expect(last.r).toBeGreaterThan(0);
					expect(last.r).toBeLessThan(1);
					expect(last.b).toBeGreaterThan(0);
				}
			}
		});

		it("normalizes mismatched stop counts (2 vs 3) for linear↔linear", () => {
			const a = withFill("a", 0, {
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [
					{ offset: 0, color: RED, midpoint: 0.5 },
					{ offset: 1, color: BLUE, midpoint: 0.5 },
				],
			});
			const b = withFill("b", 100, {
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [
					{ offset: 0, color: BLUE, midpoint: 0.5 },
					{ offset: 0.5, color: RED, midpoint: 0.5 },
					{ offset: 1, color: BLUE, midpoint: 0.5 },
				],
			});
			const r = computeBlendIntermediates(
				makeBlend(["a", "b"], { type: "steps", count: 1 }),
				[a, b],
			);
			const c = fillOf(r[0][0]);
			expect(c?.type).toBe("linear");
			if (c?.type === "linear") expect(c.stops).toHaveLength(3);
		});

		it("switches at the midpoint for linear↔radial (type mismatch)", () => {
			const a = withFill("a", 0, {
				type: "linear",
				x1: 0,
				y1: 0,
				x2: 1,
				y2: 0,
				stops: [
					{ offset: 0, color: RED, midpoint: 0.5 },
					{ offset: 1, color: BLUE, midpoint: 0.5 },
				],
			});
			const b = withFill("b", 200, {
				type: "radial",
				cx: 0.5,
				cy: 0.5,
				radiusX: 0.5,
				radiusY: 0.5,
				rotation: 0,
				stops: [
					{ offset: 0, color: BLUE, midpoint: 0.5 },
					{ offset: 1, color: RED, midpoint: 0.5 },
				],
			});
			const r = computeBlendIntermediates(
				makeBlend(["a", "b"], { type: "steps", count: 3 }),
				[a, b],
			);
			// t = 0.25, 0.5, 0.75 → before midpoint = linear (a), at/after = radial (b)
			expect(fillOf(r[0][0])?.type).toBe("linear");
			expect(fillOf(r[0][2])?.type).toBe("radial");
		});
	});
});

describe("blendKeyOutlines", () => {
	it("rotates key outlines around the blend's bbox center, not each source's own center", () => {
		// Two squares 300 apart → blend bbox center at x=150 (≠ either source's own
		// center). Matches renderBlend, which rotates world-baked sources around the
		// blend's center.
		const s0 = makeRect("s0", 0, 0, 50); // center (0,0), corners ±25
		const s1 = makeRect("s1", 300, 0, 50); // center (300,0)
		const objects: Record<string, Path> = { s0, s1 };
		const blend = makeBlend(["s0", "s1"]);
		blend.transform = { ...createIdentityTransform(), rotation: Math.PI };

		const outlines = blendKeyOutlines(
			blend,
			(id) => objects[id],
			() => null,
		);

		expect(outlines).toHaveLength(2);

		// s0's first segment start is local (-25,-25). Rotating 180° around the blend
		// center (150,0): (x,y) → (2*150 - x, -y) = (325, 25).
		const start = outlines[0][0].start;
		if (!start) throw new Error("expected a start point on s0's outline");
		expect(start.x).toBeCloseTo(325, 4);
		expect(start.y).toBeCloseTo(25, 4);
		// Rotating around s0's OWN center (0,0) would give (25,25) — the bug.
		expect(start.x).not.toBeCloseTo(25, 1);
	});

	it("returns world-baked outlines unchanged when the blend has no transform", () => {
		const s0 = makeRect("s0", 0, 0, 50);
		const s1 = makeRect("s1", 300, 0, 50);
		const objects: Record<string, Path> = { s0, s1 };
		const outlines = blendKeyOutlines(
			makeBlend(["s0", "s1"]),
			(id) => objects[id],
			() => null,
		);

		expect(outlines).toHaveLength(2);
		// Identity blend transform → outline equals the source geometry as-is.
		const start = outlines[0][0].start;
		if (!start) throw new Error("expected a start point on s0's outline");
		expect(start.x).toBeCloseTo(-25, 4);
		expect(start.y).toBeCloseTo(-25, 4);
	});
});

describe("computeSpineKeyPlacements", () => {
	const straightSpine = (x0: number, x1: number): Path => ({
		type: "path",
		id: "spine",
		segments: [
			{
				start: { x: x0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x1, y: 0 },
				isMoved: true,
				...Z,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	});

	it("places keys at equal arc-length along the spine (first/last at the ends)", () => {
		const placements = computeSpineKeyPlacements(straightSpine(0, 600), 3);
		expect(placements).not.toBeNull();
		// key i at arc i/(N-1)*total = 0, 300, 600 along the straight spine.
		expect(placements?.map((p) => p.x)).toEqual([0, 300, 600]);
		for (const p of placements ?? []) expect(p.y).toBeCloseTo(0, 6);
	});

	it("returns null when there is no spine", () => {
		expect(computeSpineKeyPlacements(null, 3)).toBeNull();
	});

	it("glides keys by arc-length, not snapped to extra curve anchors", () => {
		// A spine with an extra anchor at (100,0) near the start (total length 600).
		// The middle key must land at arc-length 300 — NOT snapped onto the (100,0)
		// anchor — so adding curve detail does not yank keys onto vertices.
		const spineWithMidAnchor: Path = {
			type: "path",
			id: "spine",
			segments: [
				{
					start: { x: 0, y: 0 },
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 100, y: 0 },
					isMoved: true,
					...Z,
				},
				{
					cp1: { x: 0, y: 0 },
					cp2: { x: 0, y: 0 },
					end: { x: 600, y: 0 },
					isMoved: false,
					...Z,
				},
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const placements = computeSpineKeyPlacements(spineWithMidAnchor, 3);
		expect(placements).not.toBeNull();
		if (!placements) return;
		expect(placements[0].x).toBeCloseTo(0, 1);
		// Middle key glides to ~arc-length 300, NOT snapped onto the (100,0) anchor.
		expect(placements[1].x).toBeCloseTo(300, 0);
		expect(placements[2].x).toBeCloseTo(600, 1);
	});
});

describe("relocateSpineAnchorsToKeys", () => {
	it("moves anchors onto the key centers while keeping curve handles", () => {
		// A single curved segment (non-zero handles) from (0,0) to (100,0).
		const segments: PathSegment[] = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 20, y: 40 },
				cp2: { x: -20, y: 40 },
				end: { x: 100, y: 0 },
				isMoved: true,
				...Z,
			},
		];
		// Key 1 moved to (100, 80); the spine end must follow it.
		const out = relocateSpineAnchorsToKeys(segments, [
			{ x: 0, y: 0 },
			{ x: 100, y: 80 },
		]);
		expect(out).not.toBeNull();
		if (!out) return;
		expect(out[0].start).toEqual({ x: 0, y: 0 });
		expect(out[0].end).toEqual({ x: 100, y: 80 });
		// Relative handles are preserved, so the curve is not flattened.
		expect(out[0].cp1).toEqual({ x: 20, y: 40 });
		expect(out[0].cp2).toEqual({ x: -20, y: 40 });
	});

	it("keeps interior anchors (curve) when the spine has more anchors than keys", () => {
		// 3-anchor spine (2 segments) with a bumped middle handle.
		const segments: PathSegment[] = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 50, y: 30 },
				isMoved: true,
				...Z,
			},
			{
				cp1: { x: 10, y: 5 },
				cp2: { x: -10, y: 5 },
				end: { x: 100, y: 0 },
				isMoved: false,
				...Z,
			},
		];
		// 2 keys -> pin anchor 0 (start) and anchor 2 (end); anchor 1 stays put.
		const out = relocateSpineAnchorsToKeys(segments, [
			{ x: -10, y: -10 },
			{ x: 120, y: 0 },
		]);
		expect(out).not.toBeNull();
		if (!out) return;
		expect(out[0].start).toEqual({ x: -10, y: -10 });
		expect(out[1].end).toEqual({ x: 120, y: 0 });
		// Interior anchor and its handles are untouched -> curve preserved.
		expect(out[0].end).toEqual({ x: 50, y: 30 });
		expect(out[1].cp1).toEqual({ x: 10, y: 5 });
		expect(out[1].cp2).toEqual({ x: -10, y: 5 });
	});

	it("subdivides the spine so every key gets an anchor when it has fewer", () => {
		// 1 segment = 2 anchors, but 3 keys -> subdivide to 2 segments (3 anchors),
		// then pin each key. The straight spine splits at its midpoint (50,0).
		const segments: PathSegment[] = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 100, y: 0 },
				isMoved: true,
				...Z,
			},
		];
		const out = relocateSpineAnchorsToKeys(segments, [
			{ x: 0, y: 0 },
			{ x: 50, y: 40 },
			{ x: 100, y: 0 },
		]);
		expect(out).not.toBeNull();
		if (!out) return;
		expect(out).toHaveLength(2); // subdivided to 2 segments = 3 anchors
		expect(out[0].start).toEqual({ x: 0, y: 0 }); // key 0
		expect(out[0].end).toEqual({ x: 50, y: 40 }); // key 1 (was the split midpoint)
		expect(out[1].end).toEqual({ x: 100, y: 0 }); // key 2
	});
});

import type {
	BoundingBox,
	CubicBezierSegment,
	MeshArtObject,
	Point,
} from "@/core/schema";
import { createIdentityTransform } from "../../document/factory";
import { cubicBez, getBaseHandle } from "./meshGradient";
import { createMeshWarpSampler, createWarpCageFromRect } from "./meshWarp";
import {
	buildWarpGeometryFromContour,
	mapWarpGeometryPositions,
	remapWarpGeometrySrc,
	type WarpGeometry,
} from "./meshWarpShape";

const CONTENT: BoundingBox = {
	minX: 10,
	minY: 20,
	maxX: 110,
	maxY: 70,
	width: 100,
	height: 50,
};

describe("buildWarpGeometryFromContour", () => {
	it("should turn a rectangle into one face whose src spans the content bounds", () => {
		const result = buildWarpGeometryFromContour(
			polygon([
				{ x: 0, y: 0 },
				{ x: 200, y: 0 },
				{ x: 200, y: 100 },
				{ x: 0, y: 100 },
			]),
			CONTENT,
		);
		const geometry = expectOk(result);
		expect(geometry.faces).toEqual([{ type: "quad", verts: [0, 1, 3, 2] }]);
		expect(geometry.vertices.map((v) => [v.x, v.y])).toEqual([
			[0, 0],
			[200, 0],
			[0, 100],
			[200, 100],
		]);
		expect(geometry.vertices.map((v) => [v.src.x, v.src.y])).toEqual([
			[10, 20],
			[110, 20],
			[10, 70],
			[110, 70],
		]);
	});

	it("should reproduce a circle's arcs on the outer boundary", () => {
		const geometry = expectOk(
			buildWarpGeometryFromContour(circle(50, 50, 40), CONTENT),
		);
		const warp = createMeshWarpSampler(geometry.vertices, geometry.faces);
		for (let i = 0; i < 32; i++) {
			const u = i / 32;
			const bottom = warp({
				x: CONTENT.minX + u * CONTENT.width,
				y: CONTENT.minY,
			});
			const top = warp({
				x: CONTENT.minX + u * CONTENT.width,
				y: CONTENT.maxY,
			});
			expect(Math.hypot(bottom.x - 50, bottom.y - 50)).toBeCloseTo(40, 1);
			expect(Math.hypot(top.x - 50, top.y - 50)).toBeCloseTo(40, 1);
		}
	});

	it("should map the content corners onto the contour corners", () => {
		const geometry = expectOk(
			buildWarpGeometryFromContour(circle(0, 0, 10), CONTENT),
		);
		const warp = createMeshWarpSampler(geometry.vertices, geometry.faces);
		const bl = warp({ x: CONTENT.minX, y: CONTENT.minY });
		const tr = warp({ x: CONTENT.maxX, y: CONTENT.maxY });
		expect(bl.x).toBeLessThan(0);
		expect(bl.y).toBeLessThan(0);
		expect(tr.x).toBeGreaterThan(0);
		expect(tr.y).toBeGreaterThan(0);
	});

	it("should pick the same corners regardless of start anchor and winding", () => {
		const points = hexagon();
		const reference = boundaryPositions(
			expectOk(buildWarpGeometryFromContour(polygon(points), CONTENT)),
		);
		const rotated = boundaryPositions(
			expectOk(
				buildWarpGeometryFromContour(
					polygon([...points.slice(2), ...points.slice(0, 2)]),
					CONTENT,
				),
			),
		);
		const reversed = boundaryPositions(
			expectOk(
				buildWarpGeometryFromContour(polygon([...points].reverse()), CONTENT),
			),
		);
		expect(rotated).toEqual(reference);
		expect(reversed).toEqual(reference);
	});

	it("should split a triangle into a grid whose faces share their interior edges", () => {
		const geometry = expectOk(
			buildWarpGeometryFromContour(
				polygon([
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 50, y: 80 },
				]),
				CONTENT,
			),
		);
		expect(geometry.faces.length).toBeGreaterThan(1);
		const edgeUse = new Map<string, number>();
		for (const face of geometry.faces) {
			expect(face.type).toBe("quad");
			expectCounterClockwiseSrc(geometry, face.verts);
			for (let e = 0; e < 4; e++) {
				const a = face.verts[e];
				const b = face.verts[(e + 1) % 4];
				const key = a < b ? `${a}:${b}` : `${b}:${a}`;
				edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
				expect(geometry.vertices[a].handles[b]).toBeDefined();
				expect(geometry.vertices[b].handles[a]).toBeDefined();
			}
		}
		expect([...edgeUse.values()].some((count) => count === 2)).toBe(true);
		for (const vertex of geometry.vertices) {
			expect(vertex.positionSource).toBeUndefined();
			expect(vertex.subdivisionSource).toBeUndefined();
		}
	});

	it("should keep interior edges continuous with the Coons interpolation", () => {
		const geometry = expectOk(
			buildWarpGeometryFromContour(
				polygon([
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{ x: 50, y: 80 },
				]),
				CONTENT,
			),
		);
		const warp = createMeshWarpSampler(geometry.vertices, geometry.faces);
		for (const face of geometry.faces) {
			for (let e = 0; e < 4; e++) {
				const a = face.verts[e];
				const b = face.verts[(e + 1) % 4];
				const va = geometry.vertices[a];
				const vb = geometry.vertices[b];
				const mid = warp({
					x: (va.src.x + vb.src.x) / 2,
					y: (va.src.y + vb.src.y) / 2,
				});
				const onEdge = cubicBez(
					va,
					getBaseHandle(geometry.vertices, a, b),
					getBaseHandle(geometry.vertices, b, a),
					vb,
					0.5,
				);
				expect(mid.x).toBeCloseTo(onEdge.x, 6);
				expect(mid.y).toBeCloseTo(onEdge.y, 6);
			}
		}
	});

	it("should handle straight sides whose control points sit on the line", () => {
		const geometry = expectOk(
			buildWarpGeometryFromContour(
				[
					segment(
						{ x: -550, y: 575 },
						{ x: -350, y: 575 },
						{ cp1: { x: 100, y: 0 }, cp2: { x: -100, y: 0 } },
					),
					segment(
						undefined,
						{ x: -350, y: 425 },
						{ cp1: { x: 0, y: -75 }, cp2: { x: 0, y: 75 } },
					),
					segment(
						undefined,
						{ x: -550, y: 425 },
						{ cp1: { x: -100, y: 0 }, cp2: { x: 100, y: 0 } },
					),
					segment(
						undefined,
						{ x: -550, y: 575 },
						{ cp1: { x: 0, y: 75 }, cp2: { x: 0, y: -75 }, isClosed: true },
					),
				],
				CONTENT,
			),
		);
		expect(geometry.faces).toHaveLength(1);
	});

	it("should reject an open contour", () => {
		const segments = polygon([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 50, y: 80 },
		]).slice(0, 2);
		expect(buildWarpGeometryFromContour(segments, CONTENT)).toEqual({
			ok: false,
			reason: "open-contour",
		});
	});

	it("should reject a path with several sub-paths", () => {
		const outer = polygon([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
		]);
		const inner = polygon([
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
			{ x: 20, y: 20 },
		]);
		expect(buildWarpGeometryFromContour([...outer, ...inner], CONTENT)).toEqual(
			{
				ok: false,
				reason: "multiple-subpaths",
			},
		);
	});

	it("should reject a self-intersecting contour", () => {
		expect(
			buildWarpGeometryFromContour(
				polygon([
					{ x: 0, y: 0 },
					{ x: 100, y: 100 },
					{ x: 100, y: 0 },
					{ x: 0, y: 100 },
				]),
				CONTENT,
			),
		).toEqual({ ok: false, reason: "self-intersecting" });
	});

	it("should reject a curve that loops over itself", () => {
		expect(
			buildWarpGeometryFromContour(
				[
					segment(
						{ x: 0, y: 0 },
						{ x: 100, y: 0 },
						{
							cp1: { x: 150, y: 100 },
							cp2: { x: -150, y: 100 },
						},
					),
					segment(
						undefined,
						{ x: 0, y: 0 },
						{
							cp1: { x: 0, y: -30 },
							cp2: { x: 0, y: -30 },
							isClosed: true,
						},
					),
				],
				CONTENT,
			),
		).toEqual({ ok: false, reason: "self-intersecting" });
	});

	it("should accept an S curve that does not loop", () => {
		const result = buildWarpGeometryFromContour(
			[
				segment(
					{ x: 0, y: 0 },
					{ x: 100, y: 0 },
					{
						cp1: { x: 30, y: 60 },
						cp2: { x: -30, y: -60 },
					},
				),
				segment(
					undefined,
					{ x: 0, y: 0 },
					{
						cp1: { x: 0, y: -80 },
						cp2: { x: 0, y: -80 },
						isClosed: true,
					},
				),
			],
			CONTENT,
		);
		expect(result.ok).toBe(true);
	});

	it("should reject a zero-area contour", () => {
		expect(
			buildWarpGeometryFromContour(
				polygon([
					{ x: 5, y: 5 },
					{ x: 5, y: 5 },
					{ x: 5, y: 5 },
				]),
				CONTENT,
			),
		).toEqual({ ok: false, reason: "zero-area" });
	});

	it("should reject non-finite coordinates", () => {
		expect(
			buildWarpGeometryFromContour(
				polygon([
					{ x: 0, y: 0 },
					{ x: Number.NaN, y: 0 },
					{ x: 50, y: 80 },
				]),
				CONTENT,
			),
		).toEqual({ ok: false, reason: "non-finite" });
	});
});

describe("remapWarpGeometrySrc", () => {
	it("should map the old src extent onto the new content bounds and keep everything else", () => {
		const cage = createWarpCageFromRect({
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
		});
		cage.vertices[1] = {
			...cage.vertices[1],
			x: 120,
			hidden: true,
			handles: { 2: { x: 130, y: 30 } },
		};
		const geometry = remapWarpGeometrySrc(mesh(cage), CONTENT);
		expect(geometry).not.toBeNull();
		expect(geometry?.faces).toEqual(cage.faces);
		expect(geometry?.vertices.map((v) => [v.src.x, v.src.y])).toEqual([
			[10, 20],
			[110, 20],
			[110, 70],
			[10, 70],
		]);
		expect(geometry?.vertices[1]).toMatchObject({
			x: 120,
			hidden: true,
			handles: { 2: { x: 130, y: 30 } },
		});
	});

	it("should return null for an empty, broken or degenerate cage", () => {
		const cage = createWarpCageFromRect({
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
		});
		expect(
			remapWarpGeometrySrc(mesh({ vertices: [], faces: [] }), CONTENT),
		).toBeNull();
		expect(
			remapWarpGeometrySrc(
				mesh({ ...cage, faces: [{ type: "quad", verts: [0, 1, 2, 9] }] }),
				CONTENT,
			),
		).toBeNull();
		expect(
			remapWarpGeometrySrc(
				mesh({
					...cage,
					vertices: cage.vertices.map((v) => ({
						...v,
						src: { x: v.src.x, y: 0 },
					})),
				}),
				CONTENT,
			),
		).toBeNull();
	});
});

describe("mapWarpGeometryPositions", () => {
	it("should move positions and handles but not src", () => {
		const cage = createWarpCageFromRect({
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 100,
		});
		cage.vertices[0].handles[1] = { x: 30, y: 5 };
		const moved = mapWarpGeometryPositions(cage, (p) => ({
			x: p.x + 10,
			y: p.y - 5,
		}));
		expect(moved.vertices[0]).toMatchObject({
			x: 10,
			y: -5,
			src: { x: 0, y: 0 },
			handles: { 1: { x: 40, y: 0 } },
		});
		expect(moved.faces).toBe(cage.faces);
	});
});

function expectOk(
	result: ReturnType<typeof buildWarpGeometryFromContour>,
): WarpGeometry {
	if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
	return result.geometry;
}

function mesh(geometry: WarpGeometry): MeshArtObject {
	return {
		id: "mesh",
		type: "mesh",
		childIds: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...geometry,
	};
}

function boundaryPositions(geometry: WarpGeometry): string[] {
	const counts = new Map<number, number>();
	for (const face of geometry.faces) {
		for (const index of face.verts)
			counts.set(index, (counts.get(index) ?? 0) + 1);
	}
	return geometry.vertices
		.filter((_, i) => (counts.get(i) ?? 0) < 4)
		.map((v) => `${v.x.toFixed(6)},${v.y.toFixed(6)}`)
		.sort();
}

function expectCounterClockwiseSrc(
	geometry: WarpGeometry,
	verts: number[],
): void {
	let area = 0;
	for (let i = 0; i < verts.length; i++) {
		const a = geometry.vertices[verts[i]].src;
		const b = geometry.vertices[verts[(i + 1) % verts.length]].src;
		area += a.x * b.y - b.x * a.y;
	}
	expect(area).toBeGreaterThan(0);
}

function hexagon(): Point[] {
	return Array.from({ length: 6 }, (_, i) => {
		const angle = (Math.PI / 3) * i + 0.2;
		return { x: 100 * Math.cos(angle), y: 60 * Math.sin(angle) };
	});
}

function polygon(points: Point[]): CubicBezierSegment[] {
	return points.map((point, i) => {
		const next = points[(i + 1) % points.length];
		return segment(i === 0 ? point : undefined, next, {
			isClosed: i === points.length - 1,
		});
	});
}

function circle(cx: number, cy: number, r: number): CubicBezierSegment[] {
	const k = 0.5522847498 * r;
	const anchors: Point[] = [
		{ x: cx + r, y: cy },
		{ x: cx, y: cy + r },
		{ x: cx - r, y: cy },
		{ x: cx, y: cy - r },
	];
	const tangents: Point[] = [
		{ x: 0, y: k },
		{ x: -k, y: 0 },
		{ x: 0, y: -k },
		{ x: k, y: 0 },
	];
	return anchors.map((anchor, i) => {
		const next = anchors[(i + 1) % 4];
		const out = tangents[i];
		const into = tangents[(i + 1) % 4];
		return segment(i === 0 ? anchor : undefined, next, {
			cp1: out,
			cp2: { x: -into.x, y: -into.y },
			isClosed: i === 3,
		});
	});
}

function segment(
	start: Point | undefined,
	end: Point,
	options: { cp1?: Point; cp2?: Point; isClosed?: boolean },
): CubicBezierSegment {
	return {
		...(start ? { start } : {}),
		cp1: options.cp1 ?? { x: 0, y: 0 },
		cp2: options.cp2 ?? { x: 0, y: 0 },
		end,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
		isClosed: options.isClosed,
	};
}

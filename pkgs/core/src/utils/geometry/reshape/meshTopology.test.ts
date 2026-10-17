import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import {
	type MeshFace,
	type MeshGradientVertex,
	toRGBColor,
} from "../../../schema";
import {
	createEdgeDerivedGeometryVertex,
	createQuadDerivedGeometryVertex,
} from "../generate/meshVertexFactory";
import { bilinearUV, type MeshVertexLike } from "../measure/meshTopology";
import { pointInBezierFace } from "../query/meshHitTest";
import { deleteMeshVertex, subdivideFace } from "./meshTopology";

/** CCW on screen (y-down): top-left → bottom-left → bottom-right → top-right */
function makeExplicitCenterFixture(): {
	vertices: MeshVertexLike[];
	faces: MeshFace[];
} {
	return {
		vertices: [
			{ x: 0, y: 0, handles: {}, colorMode: "explicit" },
			{ x: 1, y: 0, handles: {}, colorMode: "explicit" },
			{ x: 1, y: 1, handles: {}, colorMode: "explicit" },
			{ x: 0, y: 1, handles: {}, colorMode: "explicit" },
			{ x: 0.5, y: 0.5, handles: {}, colorMode: "explicit" },
			{
				x: 0.5,
				y: 0,
				handles: {},
				colorMode: "derived",
				splitLineId: 1,
			},
			{
				x: 1,
				y: 0.5,
				handles: {},
				colorMode: "derived",
				splitLineId: 2,
			},
			{
				x: 0.5,
				y: 1,
				handles: {},
				colorMode: "derived",
				splitLineId: 1,
			},
			{
				x: 0,
				y: 0.5,
				handles: {},
				colorMode: "derived",
				splitLineId: 2,
			},
		],
		faces: [
			{ type: "quad", verts: [0, 5, 4, 8] },
			{ type: "quad", verts: [5, 1, 6, 4] },
			{ type: "quad", verts: [4, 6, 2, 7] },
			{ type: "quad", verts: [8, 4, 7, 3] },
		],
	};
}

function makeMeshGradientQuadFixture(): {
	vertices: MeshGradientVertex[];
	faces: MeshFace[];
} {
	return {
		vertices: [0.1, 0.2, 0.3, 0.4].map((marker, index) => ({
			x: index >= 2 ? 1 : 0,
			y: index === 1 || index === 2 ? 1 : 0,
			color: markerColor(marker),
			colorMode: "explicit",
			handles: {},
		})),
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

function subdivideMeshGradientAt(
	vertices: MeshGradientVertex[],
	faces: MeshFace[],
	x: number,
	y: number,
	marker: number,
) {
	const faceIdx = faces.findIndex((face) =>
		pointInBezierFace(vertices, faces, face, x, y),
	);
	if (faceIdx < 0) return null;
	const { u, v } = bilinearUV(vertices, faces[faceIdx].verts, x, y);
	let nextId =
		vertices.reduce(
			(maxId, vertex) => Math.max(maxId, vertex.splitLineId ?? 0),
			0,
		) + 1;
	return subdivideFace<MeshGradientVertex>(vertices, faces, faceIdx, u, v, {
		makeCenterExplicit: (position) => ({
			...position,
			color: markerColor(marker),
			colorMode: "explicit",
			handles: {},
		}),
		makeEdgeDerived: (position, edgeVerts, t) => ({
			...position,
			color: markerColor(0),
			colorMode: "derived",
			colorSource: { kind: "edge", edgeVerts: [...edgeVerts], t },
			positionSource: { edgeVerts: [...edgeVerts], t },
			meshSource: { edgeVerts: [...edgeVerts], t },
			handles: {},
		}),
		makeQuadDerived: (position, faceVerts, u, v) => ({
			...position,
			color: markerColor(0),
			colorMode: "derived",
			colorSource: { kind: "quad", faceVerts: [...faceVerts], u, v },
			handles: {},
		}),
		nextSplitLineId: () => nextId++,
	});
}

function markerColor(marker: number) {
	return toRGBColor({ r: marker, g: 0, b: 0, a: 1 });
}

function explicitMarker(vertex: MeshGradientVertex): number | null {
	if (vertex.colorMode !== "explicit" || vertex.color.type !== "rgb")
		return null;
	return vertex.color.r;
}

function explicitMarkers(vertices: readonly MeshGradientVertex[]): number[] {
	return vertices
		.map(explicitMarker)
		.filter((marker): marker is number => marker !== null)
		.sort((a, b) => a - b);
}

function expectGridTopology(
	mesh: {
		vertices: readonly MeshGradientVertex[];
		faces: readonly MeshFace[];
	},
	cellCount: number,
	addedExplicitMarkers: readonly number[],
): void {
	const sideVertexCount = cellCount + 1;
	expect(mesh.vertices).toHaveLength(sideVertexCount ** 2);
	expect(mesh.faces).toHaveLength(cellCount ** 2);
	expect(mesh.faces.every((face) => face.type === "quad")).toBe(true);

	const edges = new Set<string>();
	const degrees = Array.from({ length: mesh.vertices.length }, () => 0);
	for (const face of mesh.faces) {
		expect(new Set(face.verts)).toHaveLength(4);
		expect(
			Math.abs(screenSignedArea(mesh.vertices, face.verts)),
		).toBeGreaterThan(1e-8);
		for (let index = 0; index < face.verts.length; index++) {
			const from = face.verts[index];
			const to = face.verts[(index + 1) % face.verts.length];
			expect(mesh.vertices[from]).toBeDefined();
			expect(mesh.vertices[to]).toBeDefined();
			edges.add(testMeshEdgeKey(from, to));
		}
	}
	for (const edge of edges) {
		const [from, to] = edge.split(":").map(Number);
		degrees[from]++;
		degrees[to]++;
	}

	expect(edges).toHaveLength(2 * cellCount * sideVertexCount);
	expect(degrees.toSorted((a, b) => a - b)).toEqual(
		[
			...Array.from({ length: 4 }, () => 2),
			...Array.from({ length: 4 * (cellCount - 1) }, () => 3),
			...Array.from({ length: (cellCount - 1) ** 2 }, () => 4),
		].toSorted((a, b) => a - b),
	);
	expect(explicitMarkers(mesh.vertices)).toEqual(
		[0.1, 0.2, 0.3, 0.4, ...addedExplicitMarkers].toSorted((a, b) => a - b),
	);

	const xs = [
		...new Set(mesh.vertices.map((vertex) => testMeshCoordinate(vertex.x))),
	].toSorted((a, b) => a - b);
	const ys = [
		...new Set(mesh.vertices.map((vertex) => testMeshCoordinate(vertex.y))),
	].toSorted((a, b) => a - b);
	expect(xs).toHaveLength(sideVertexCount);
	expect(ys).toHaveLength(sideVertexCount);
	const vertexAt = new Map(
		mesh.vertices.map((vertex, index) => [
			`${testMeshCoordinate(vertex.x)}:${testMeshCoordinate(vertex.y)}`,
			index,
		]),
	);
	expect(vertexAt).toHaveLength(mesh.vertices.length);
	const expectedEdges = new Set<string>();
	const expectedFaces = new Set<string>();
	for (let row = 0; row < sideVertexCount; row++) {
		for (let column = 0; column < sideVertexCount; column++) {
			const current = getTestVertexIndex(vertexAt, `${xs[column]}:${ys[row]}`);
			if (column < cellCount) {
				const right = getTestVertexIndex(
					vertexAt,
					`${xs[column + 1]}:${ys[row]}`,
				);
				expectedEdges.add(testMeshEdgeKey(current, right));
			}
			if (row < cellCount) {
				const bottom = getTestVertexIndex(
					vertexAt,
					`${xs[column]}:${ys[row + 1]}`,
				);
				expectedEdges.add(testMeshEdgeKey(current, bottom));
			}
			if (column < cellCount && row < cellCount) {
				const faceVertices = [
					current,
					getTestVertexIndex(vertexAt, `${xs[column]}:${ys[row + 1]}`),
					getTestVertexIndex(vertexAt, `${xs[column + 1]}:${ys[row + 1]}`),
					getTestVertexIndex(vertexAt, `${xs[column + 1]}:${ys[row]}`),
				];
				expectedFaces.add(testMeshFaceKey(faceVertices));
			}
		}
	}
	expect(edges).toEqual(expectedEdges);
	expect(
		new Set(mesh.faces.map((face) => testMeshFaceKey(face.verts))),
	).toEqual(expectedFaces);

	const markerIndices = new Map(
		mesh.vertices.flatMap((vertex, index) => {
			const marker = explicitMarker(vertex);
			return marker === null ? [] : [[marker, index] as const];
		}),
	);
	for (const cornerMarker of [0.1, 0.2, 0.3, 0.4]) {
		for (const addedMarker of addedExplicitMarkers) {
			const cornerIdx = markerIndices.get(cornerMarker);
			const addedIdx = markerIndices.get(addedMarker);
			expect(cornerIdx).toBeDefined();
			expect(addedIdx).toBeDefined();
			if (cornerIdx === undefined || addedIdx === undefined) {
				throw new Error("Missing explicit test vertex marker");
			}
			expect(edges.has(testMeshEdgeKey(cornerIdx, addedIdx))).toBe(false);
		}
	}
}

function testMeshEdgeKey(a: number, b: number): string {
	return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function testMeshFaceKey(vertices: readonly number[]): string {
	return vertices.toSorted((a, b) => a - b).join(":");
}

function testMeshCoordinate(value: number): number {
	return Number(value.toFixed(12));
}

function requireMeshGradientSubdivision(
	result: ReturnType<typeof subdivideMeshGradientAt>,
): NonNullable<ReturnType<typeof subdivideMeshGradientAt>> {
	expect(result).not.toBeNull();
	if (result === null) throw new Error("Expected mesh subdivision");
	return result;
}

function getTestVertexIndex(
	vertices: ReadonlyMap<string, number>,
	key: string,
): number {
	const index = vertices.get(key);
	expect(index).toBeDefined();
	if (index === undefined) throw new Error(`Missing test vertex at ${key}`);
	return index;
}

function meshTopologyByVertexIdentity(mesh: {
	vertices: readonly MeshGradientVertex[];
	faces: readonly MeshFace[];
}) {
	const vertexIdentity = (index: number) =>
		testMeshVertexIdentity(mesh.vertices[index]);
	const edges = new Set<string>();
	for (const face of mesh.faces) {
		for (let index = 0; index < face.verts.length; index++) {
			const from = vertexIdentity(face.verts[index]);
			const to = vertexIdentity(face.verts[(index + 1) % face.verts.length]);
			edges.add(from < to ? `${from}:${to}` : `${to}:${from}`);
		}
	}
	return {
		vertices: mesh.vertices.map(testMeshVertexIdentity).toSorted(),
		edges: [...edges].toSorted(),
		faces: mesh.faces
			.map((face) =>
				face.verts
					.map(vertexIdentity)
					.toSorted((a, b) => a - b)
					.join(":"),
			)
			.toSorted(),
	};
}

function testMeshVertexIdentity(vertex: MeshGradientVertex): number {
	if (vertex.color.type !== "rgb") {
		throw new Error("Expected RGB test vertex color");
	}
	return vertex.color.b;
}

function makeCCWQuadFixture(): {
	vertices: MeshVertexLike[];
	faces: MeshFace[];
} {
	const vertices: MeshVertexLike[] = [
		{ x: 0, y: 0, handles: {} },
		{ x: 0, y: 1, handles: {} },
		{ x: 1, y: 1, handles: {} },
		{ x: 1, y: 0, handles: {} },
	];
	const faces: MeshFace[] = [{ type: "quad", verts: [0, 1, 2, 3] }];
	return { vertices, faces };
}

function subdivideCCWQuad(
	vertices: MeshVertexLike[],
	faces: MeshFace[],
	faceIdx = 0,
) {
	let nextId =
		vertices.reduce(
			(maxId, vertex) => Math.max(maxId, vertex.splitLineId ?? 0),
			0,
		) + 1;
	return subdivideFace<MeshVertexLike>(vertices, faces, faceIdx, 0.5, 0.5, {
		makeCenterExplicit: (position) => ({
			x: position.x,
			y: position.y,
			handles: {},
		}),
		makeEdgeDerived: (position, edgeVerts, t) =>
			createEdgeDerivedGeometryVertex<MeshVertexLike>(
				position,
				edgeVerts,
				t,
				(fields) => ({
					x: fields.x,
					y: fields.y,
					handles: fields.handles,
					positionSource: fields.positionSource,
				}),
			),
		makeQuadDerived: (position) =>
			createQuadDerivedGeometryVertex<MeshVertexLike>(position, (fields) => ({
				x: fields.x,
				y: fields.y,
				handles: fields.handles,
			})),
		nextSplitLineId: () => nextId++,
	});
}

/**
 * Signed polygon area via the standard shoelace formula. In this y-down mesh
 * space a loop that runs counter-clockwise on screen yields a NEGATIVE value.
 */
function screenSignedArea(
	vertices: readonly MeshVertexLike[],
	verts: readonly number[],
): number {
	let area = 0;
	for (let i = 0; i < verts.length; i++) {
		const a = vertices[verts[i]];
		const b = vertices[verts[(i + 1) % verts.length]];
		area += a.x * b.y - b.x * a.y;
	}
	return area / 2;
}

describe("counter-clockwise mesh winding", () => {
	it("should hit-test points inside a CCW quad", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		expect(pointInBezierFace(vertices, faces, faces[0], 0.5, 0.5)).toBe(true);
		expect(pointInBezierFace(vertices, faces, faces[0], 1.5, 0.5)).toBe(false);
	});

	it("should keep subdivided faces counter-clockwise", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const result = subdivideCCWQuad(vertices, faces);
		expect(result).not.toBeNull();
		expect(result!.faces.length).toBeGreaterThan(1);
		for (const face of result!.faces) {
			expect(screenSignedArea(result!.vertices, face.verts)).toBeLessThan(0);
		}
	});

	it("should resolve subdivided faces top-left first, counter-clockwise", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const result = subdivideCCWQuad(vertices, faces);
		expect(result).not.toBeNull();
		expect(result!.faces.length).toBe(4);

		const centroids = result!.faces.map((face) => {
			let cx = 0;
			let cy = 0;
			for (const vi of face.verts) {
				cx += result!.vertices[vi].x;
				cy += result!.vertices[vi].y;
			}
			return { x: cx / face.verts.length, y: cy / face.verts.length };
		});

		// faces[0] wins overlaps (first-hit-wins in the shaders), so the
		// resolution order must start at the top-left patch and continue
		// counter-clockwise: TL → BL → BR → TR.
		expect(centroids[0].x).toBeLessThan(0.5); // TL
		expect(centroids[0].y).toBeLessThan(0.5);
		expect(centroids[1].x).toBeLessThan(0.5); // BL
		expect(centroids[1].y).toBeGreaterThan(0.5);
		expect(centroids[2].x).toBeGreaterThan(0.5); // BR
		expect(centroids[2].y).toBeGreaterThan(0.5);
		expect(centroids[3].x).toBeGreaterThan(0.5); // TR
		expect(centroids[3].y).toBeLessThan(0.5);
	});

	it("should rebuild a counter-clockwise quad when deleting a split vertex", () => {
		const { vertices, faces } = makeCCWQuadFixture();
		const subdivided = subdivideCCWQuad(vertices, faces);
		expect(subdivided).not.toBeNull();

		const removeIdx = subdivided!.vertices.findIndex(
			(v) => v.splitLineId != null,
		);
		expect(removeIdx).toBeGreaterThanOrEqual(4);

		const rebuilt = deleteMeshVertex(
			subdivided!.vertices,
			subdivided!.faces,
			removeIdx,
		);
		expect(rebuilt.faces.length).toBeGreaterThan(0);
		for (const face of rebuilt.faces) {
			expect(screenSignedArea(rebuilt.vertices, face.verts)).toBeLessThan(0);
		}
	});

	it("should remove implicit arms connected to a deleted explicit vertex", () => {
		const { vertices, faces } = makeExplicitCenterFixture();

		const rebuilt = deleteMeshVertex(vertices, faces, 4);

		expect(rebuilt.vertices).toHaveLength(4);
		expect(rebuilt.faces).toHaveLength(1);
		expect(rebuilt.faces[0].type).toBe("quad");
	});

	it("should restore the exact grid topology after deleting A → B → C", () => {
		const initial = makeMeshGradientQuadFixture();
		expectGridTopology(initial, 1, []);

		const afterA = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(initial.vertices, initial.faces, 0.2, 0.66, 0.5),
		);
		expectGridTopology(afterA, 2, [0.5]);

		const afterB = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(afterA.vertices, afterA.faces, 0.64, 0.34, 0.6),
		);
		expectGridTopology(afterB, 3, [0.5, 0.6]);

		const afterC = requireMeshGradientSubdivision(
			subdivideMeshGradientAt(afterB.vertices, afterB.faces, 0.48, 0.78, 0.7),
		);
		expectGridTopology(afterC, 4, [0.5, 0.6, 0.7]);
		const identifiedAfterC = {
			vertices: afterC.vertices.map((vertex, index) => ({
				...vertex,
				color: { ...vertex.color, b: (index + 1) / 100 },
				handles: { ...vertex.handles },
			})),
			faces: afterC.faces.map((face) => ({
				type: face.type,
				verts: [...face.verts],
			})),
		};

		const removeAIdx = identifiedAfterC.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.5,
		);
		expect(removeAIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteA = deleteMeshVertex(
			identifiedAfterC.vertices,
			identifiedAfterC.faces,
			removeAIdx,
		);
		expectGridTopology(afterDeleteA, 3, [0.6, 0.7]);
		const warpedAfterC = {
			vertices: identifiedAfterC.vertices.map((vertex) => ({
				...vertex,
				y: vertex.y + 8 * (vertex.x - 0.2) ** 2,
				handles: { ...vertex.handles },
			})),
			faces: identifiedAfterC.faces.map((face) => ({
				type: face.type,
				verts: [...face.verts],
			})),
		};
		const warpedAfterDeleteA = deleteMeshVertex(
			warpedAfterC.vertices,
			warpedAfterC.faces,
			removeAIdx,
		);
		expect(meshTopologyByVertexIdentity(warpedAfterDeleteA)).toEqual(
			meshTopologyByVertexIdentity(afterDeleteA),
		);

		const removeBIdx = afterDeleteA.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.6,
		);
		expect(removeBIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteB = deleteMeshVertex(
			afterDeleteA.vertices,
			afterDeleteA.faces,
			removeBIdx,
		);
		expectGridTopology(afterDeleteB, 2, [0.7]);

		const removeCIdx = afterDeleteB.vertices.findIndex(
			(vertex) => explicitMarker(vertex) === 0.7,
		);
		expect(removeCIdx).toBeGreaterThanOrEqual(4);

		const afterDeleteC = deleteMeshVertex(
			afterDeleteB.vertices,
			afterDeleteB.faces,
			removeCIdx,
		);
		expectGridTopology(afterDeleteC, 1, []);
		expect(
			afterDeleteC.vertices.filter((vertex) => vertex.colorMode === "derived"),
		).toHaveLength(0);
		expect(meshTopologyByVertexIdentity(afterDeleteC)).toEqual({
			vertices: [0.01, 0.02, 0.03, 0.04],
			edges: ["0.01:0.02", "0.01:0.04", "0.02:0.03", "0.03:0.04"],
			faces: ["0.01:0.02:0.03:0.04"],
		});
	});

	it("should stop an implicit arm at another explicit vertex", () => {
		const { vertices, faces } = makeExplicitCenterFixture();
		vertices[5].colorMode = "explicit";

		const rebuilt = deleteMeshVertex(vertices, faces, 4);

		expect(
			rebuilt.vertices.some((vertex) => vertex.x === 0.5 && vertex.y === 0),
		).toBe(true);
		expect(
			rebuilt.vertices.filter((vertex) => vertex.colorMode === "derived"),
		).toHaveLength(0);
	});
});

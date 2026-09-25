import { describe, expect, it, vi } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type {
	AnyArtObject,
	ImageObject,
	MeshArtObject,
	Path,
} from "../../../schema";
import { resolveSegment } from "../../../utils/geometry/segmentOps";
import { MeshWarpCache } from "../caches/MeshWarpCache";
import { MeshElementRenderer } from "./MeshElementRenderer";

describe("MeshElementRenderer", () => {
	it("should dispatch warped transient paths under the mesh alpha without touching child data", () => {
		const child = createChildPath();
		const mesh = createMeshContainer([child.id]);
		const elementsMap = new Map<string, AnyArtObject>([
			[child.id, child],
			[mesh.id, mesh],
		]);
		const cache = new MeshWarpCache();
		const dispatchElement = vi.fn();
		const renderer = new MeshElementRenderer({
			getMeshWarpCache: () => cache,
			dispatchElement,
			renderWarpedImage: vi.fn(),
			getTextGlyphPaths: () => null,
			getTransientMask: () => null,
			getComposedTransform: () => createIdentityTransform(),
			getLocalBounds: () => null,
			getTransformIndex: () => 0,
			renderState: makeRenderState(),
		});
		const childSegmentsBefore = structuredClone(child.segments);

		renderer.render({} as GPURenderPassEncoder, mesh, elementsMap, 1, "main");

		expect(dispatchElement).toHaveBeenCalledTimes(1);
		const [, transient, , alpha] = dispatchElement.mock.calls[0];
		expect(transient.type).toBe("path");
		expect(transient.id).toBe(`${mesh.id}::warp::${child.id}`);
		expect(alpha).toBeCloseTo(mesh.opacity, 9);
		// Non-destructive: the stored child is untouched.
		expect(child.segments).toEqual(childSegmentsBefore);
		// The dragged cage corner (100,100)->(140,150) pulls the child's
		// top-right anchor (world (100,100)) to the new corner position.
		const warped = transient as Path;
		const anchors = collectAnchors(warped);
		expect(anchors).toContainEqual({ x: 140, y: 150 });
		// Anchor at the fixed origin corner stays put.
		expect(anchors).toContainEqual({ x: 0, y: 0 });
	});

	it("should render image children through the tessellated warp, not dispatch", () => {
		const image: ImageObject = {
			id: "img-1",
			type: "image",
			fileUid: "file-1",
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			opacity: 0.8,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const mesh = createMeshContainer([image.id]);
		const elementsMap = new Map<string, AnyArtObject>([
			[image.id, image],
			[mesh.id, mesh],
		]);
		const dispatchElement = vi.fn();
		const renderWarpedImage = vi.fn();
		const renderer = new MeshElementRenderer({
			getMeshWarpCache: () => new MeshWarpCache(),
			dispatchElement,
			renderWarpedImage,
			getTextGlyphPaths: () => null,
			getTransientMask: () => null,
			getComposedTransform: () => createIdentityTransform(),
			getLocalBounds: () => null,
			getTransformIndex: () => 0,
			renderState: makeRenderState(),
		});

		renderer.render({} as GPURenderPassEncoder, mesh, elementsMap, 1, "main");

		expect(dispatchElement).not.toHaveBeenCalled();
		expect(renderWarpedImage).toHaveBeenCalledTimes(1);
		const [, transient, alpha, grid] = renderWarpedImage.mock.calls[0];
		expect(transient.id).toBe(`${mesh.id}::warp::${image.id}`);
		// mesh.opacity (0.5) × image.opacity (0.8)
		expect(alpha).toBeCloseTo(0.4, 9);
		// Interleaved (x, y, u, v) triangle-list data.
		expect(grid).toBeInstanceOf(Float32Array);
		expect(grid.length % 12).toBe(0);
		// The grid midpoint (source (50,50)) must follow the Coons surface, not
		// the projective interpolation of the 4 warped corners: with only the
		// (100,100) corner dragged to (140,150), the surface pulls it beyond
		// the undeformed midpoint.
		let found = false;
		for (let i = 0; i < grid.length; i += 4) {
			if (grid[i + 2] === 0.5 && grid[i + 3] === 0.5) {
				expect(grid[i]).toBeCloseTo(60, 6);
				expect(grid[i + 1]).toBeCloseTo(62.5, 6);
				found = true;
				break;
			}
		}
		expect(found).toBe(true);
	});

	it("should bake the container's transform into the warped image grid", () => {
		const image: ImageObject = {
			id: "image-1",
			type: "image",
			fileUid: "file-1",
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};
		const mesh = createMeshContainer([image.id]);
		const elementsMap = new Map<string, AnyArtObject>([
			[image.id, image],
			[mesh.id, mesh],
		]);
		const renderWarpedImage = vi.fn();
		const renderer = new MeshElementRenderer({
			getMeshWarpCache: () => new MeshWarpCache(),
			dispatchElement: vi.fn(),
			renderWarpedImage,
			getTextGlyphPaths: () => null,
			getTransientMask: () => null,
			// The container was moved 200 to the right; its vector siblings ride
			// the GPU transform entry, and the blit has no transform input at all.
			getComposedTransform: () => ({ ...createIdentityTransform(), x: 200 }),
			getLocalBounds: () => ({
				minX: 0,
				minY: 0,
				maxX: 140,
				maxY: 150,
				width: 140,
				height: 150,
			}),
			getTransformIndex: () => 0,
			renderState: makeRenderState(),
		});

		renderer.render({} as GPURenderPassEncoder, mesh, elementsMap, 1, "main");

		const [, , , grid] = renderWarpedImage.mock.calls[0];
		for (let i = 0; i < grid.length; i += 4) {
			if (grid[i + 2] === 0.5 && grid[i + 3] === 0.5) {
				// Same surface point as the untransformed case (60, 62.5), moved.
				expect(grid[i]).toBeCloseTo(260, 6);
				expect(grid[i + 1]).toBeCloseTo(62.5, 6);
				return;
			}
		}
		throw new Error("grid midpoint not found");
	});

	it("should render nothing for an empty container", () => {
		const mesh = createMeshContainer([]);
		const dispatchElement = vi.fn();
		const renderer = new MeshElementRenderer({
			getMeshWarpCache: () => new MeshWarpCache(),
			dispatchElement,
			renderWarpedImage: vi.fn(),
			getTextGlyphPaths: () => null,
			getTransientMask: () => null,
			getComposedTransform: () => createIdentityTransform(),
			getLocalBounds: () => null,
			getTransformIndex: () => 0,
			renderState: makeRenderState(),
		});

		renderer.render({} as GPURenderPassEncoder, mesh, new Map(), 1, "main");

		expect(dispatchElement).not.toHaveBeenCalled();
	});

	it("should draw the children unwarped over a faint warp once inside the container", () => {
		const child = createChildPath();
		const mesh = createMeshContainer([child.id]);
		const elementsMap = new Map<string, AnyArtObject>([
			[child.id, child],
			[mesh.id, mesh],
		]);
		const renderState = makeRenderState([mesh.id]);
		renderState.currentTransformIndex = 3;
		const slots = { [mesh.id]: 3, [child.id]: 7 };
		// Each call records the transform entry it was drawn through.
		const drawnThrough: number[] = [];
		const dispatchElement = vi.fn(
			(
				..._args: [
					GPURenderPassEncoder,
					AnyArtObject,
					Map<string, AnyArtObject>,
					number,
					string,
				]
			) => {
				drawnThrough.push(renderState.currentTransformIndex);
			},
		);
		const renderer = new MeshElementRenderer({
			getMeshWarpCache: () => new MeshWarpCache(),
			dispatchElement,
			renderWarpedImage: vi.fn(),
			getTextGlyphPaths: () => null,
			getTransientMask: () => null,
			getComposedTransform: () => createIdentityTransform(),
			getLocalBounds: () => null,
			getTransformIndex: (id) => slots[id] ?? 0,
			renderState,
		});

		renderer.render({} as GPURenderPassEncoder, mesh, elementsMap, 1, "main");

		expect(dispatchElement).toHaveBeenCalledTimes(2);
		// The warp result goes down first, faint, through the container's entry...
		const [, ghost, , ghostAlpha] = dispatchElement.mock.calls[0];
		expect(ghost.id).toBe(`${mesh.id}::warp::${child.id}`);
		expect(ghostAlpha).toBeLessThan(mesh.opacity);
		expect(drawnThrough[0]).toBe(slots[mesh.id]);
		// ...then the child itself, as stored, at full strength and through its
		// own entry, or it would land wherever the container sits instead.
		const [, edited, , editedAlpha] = dispatchElement.mock.calls[1];
		expect(edited).toBe(child);
		expect(editedAlpha).toBeCloseTo(mesh.opacity, 9);
		expect(drawnThrough[1]).toBe(slots[child.id]);
		// The container's entry is back in place for whatever renders next.
		expect(renderState.currentTransformIndex).toBe(slots[mesh.id]);
	});
});

/** Minimal render state: only the two fields transient masking swaps. */
function makeRenderState(editingScopeStack: string[] = []) {
	return {
		currentTransformIndex: 0,
		currentMaskBindGroup: {} as GPUBindGroup,
		editingScopeStack,
	};
}

function createMeshContainer(childIds: string[]): MeshArtObject {
	return {
		id: "mesh-1",
		type: "mesh",
		opacity: 0.5,
		blendMode: "normal",
		transform: createIdentityTransform(),
		childIds,
		vertices: [
			{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
			{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
			// Dragged corner: source (100,100) now renders at (140,150).
			{ x: 140, y: 150, src: { x: 100, y: 100 }, handles: {} },
			{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
		],
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

function createChildPath(): Path {
	const corner = (
		x: number,
		y: number,
		first: boolean,
		last: boolean,
	): Path["segments"][number] => ({
		start: first ? { x: 0, y: 0 } : undefined,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x, y },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: first,
		isClosed: last ? true : undefined,
	});
	return {
		id: "child-1",
		type: "path",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		segments: [
			corner(100, 0, true, false),
			corner(100, 100, false, false),
			corner(0, 100, false, false),
			corner(0, 0, false, true),
		],
	};
}

function collectAnchors(path: Path): Array<{ x: number; y: number }> {
	const anchors: Array<{ x: number; y: number }> = [];
	let prevEnd: Path["segments"][number]["end"] | undefined;
	for (let i = 0; i < path.segments.length; i++) {
		const { start, end } = resolveSegment(path.segments[i], prevEnd);
		if (i === 0) anchors.push({ x: round6(start.x), y: round6(start.y) });
		anchors.push({ x: round6(end.x), y: round6(end.y) });
		prevEnd = path.segments[i].end;
	}
	return anchors;
}

function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

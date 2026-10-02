import { describe, expect, it } from "vitest";
import { extractDocumentFromYDoc } from "./collaboration/extractDocumentFromYDoc";
import {
	YjsProvider,
	type YjsProviderCallbacks,
} from "./collaboration/YjsProvider";
import { createIdentityTransform } from "./document/factory";
import { createRendererState } from "./document/rendererState";
import { SpatialIndex } from "./document/SpatialIndex";
import { PaplicoCommands } from "./PaplicoCommands";
import type {
	AnyArtObject,
	BoundingBox,
	FillAppearance,
	FillColor,
	ImageObject,
	Layer,
	Path,
	Point,
} from "./schema";
import { rectPath } from "./testUtils/svgFixtures";
import { applyTransformToPoint } from "./utils/geometry/geometry";
import { worldFrame } from "./utils/geometry/selectionFrame";

const COMBINED_PATH_IDS = ["a", "b"];

describe("PaplicoCommands.resizeElements", () => {
	describe("resizing a rotated path in a world-axis frame", () => {
		it("should keep the path's rotation and map its outline", () => {
			const f = createFixture();
			f.addPath({
				...rectPath("p", { x: 40, y: 20 }, 60, 30, []),
				transform: { ...createIdentityTransform(), rotation: 0.5 },
			});
			const original = f.worldBounds("p");
			const before = f.worldCorners("p");

			f.commands.resizeElements(
				["p"],
				worldFrame(original),
				scaleFromMinCorner(original, original, 1.5),
			);

			expect(f.element("p").transform.rotation).toBeCloseTo(0.5);
			f.worldCorners("p").forEach((corner, i) => {
				expect(corner.x).toBeCloseTo(
					original.minX + (before[i].x - original.minX) * 1.5,
					6,
				);
				expect(corner.y).toBeCloseTo(
					original.minY + (before[i].y - original.minY) * 1.5,
					6,
				);
			});
		});
	});

	describe("resizing a rotated image in its own frame", () => {
		it("should change only the sides the frame's axes scale", () => {
			const f = createFixture();
			f.addElement(makeImage("i", 0.5));
			const frame = f.frame("i");

			f.commands.resizeElements(["i"], frame, {
				...frame.bounds,
				maxX: frame.bounds.minX + frame.bounds.width * 2,
				width: frame.bounds.width * 2,
			});

			const image = f.element("i") as ImageObject;
			expect(image.width).toBeCloseTo(160);
			expect(image.height).toBeCloseTo(40);
			expect(image.transform.rotation).toBeCloseTo(0.5);
			expect(image.transform.skewX ?? 0).toBeCloseTo(0);
		});
	});

	describe("resizing a group with rotated children", () => {
		it("should map every child's outline through the resize", () => {
			const f = createFixture();
			f.addPath({
				...rectPath("a", { x: 0, y: 0 }, 20, 20, []),
				transform: { ...createIdentityTransform(), rotation: 0.4 },
			});
			f.addPath({
				...rectPath("b", { x: 60, y: 30 }, 80, 40, []),
				transform: { ...createIdentityTransform(), x: 10, rotation: -1.1 },
			});
			const groupId = f.group(["a", "b"]);
			const original = f.worldBounds(groupId);
			const before = ["a", "b"].map((id) => f.worldCorners(id));

			f.commands.resizeElements(
				[groupId],
				worldFrame(original),
				scaleFromMinCorner(original, original, 1.5),
			);

			["a", "b"].forEach((id, i) => {
				f.worldCorners(id).forEach((corner, j) => {
					expect(corner.x).toBeCloseTo(
						original.minX + (before[i][j].x - original.minX) * 1.5,
						6,
					);
					expect(corner.y).toBeCloseTo(
						original.minY + (before[i][j].y - original.minY) * 1.5,
						6,
					);
				});
			});
		});
	});

	describe("resizing with locked elements", () => {
		it("should map a locked child's outline through its group's resize", () => {
			const f = createFixture();
			f.addPath(rectPath("a", { x: 0, y: 0 }, 20, 20, []));
			f.addPath(rectPath("b", { x: 60, y: 30 }, 80, 40, []));
			const groupId = f.group(["a", "b"]);
			f.lock("a");
			const original = f.worldBounds(groupId);
			const before = f.worldBounds("a");

			f.commands.resizeElements(
				[groupId],
				worldFrame(original),
				scaleFromMinCorner(original, original, 1.5),
			);

			const after = f.worldBounds("a");
			const expected = scaleFromMinCorner(before, original, 1.5);
			for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
				expect(after[key]).toBeCloseTo(expected[key], 6);
			}
		});

		it("should leave a locked element as it is when it is resized itself", () => {
			const f = createFixture();
			f.addPath(rectPath("p", { x: 40, y: 20 }, 60, 30, []));
			f.lock("p");
			const original = f.worldBounds("p");

			f.commands.resizeElements(
				["p"],
				worldFrame(original),
				scaleFromMinCorner(original, original, 1.5),
			);

			const after = f.worldBounds("p");
			for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
				expect(after[key]).toBeCloseTo(original[key], 6);
			}
		});
	});

	describe("flipping a rotated path with a gradient in a world-axis frame", () => {
		it("should turn the gradient with the shape", () => {
			const f = createFixture();
			f.addPath({
				...rectPath("p", { x: 0, y: 0 }, 100, 40, [
					makeFill({
						type: "linear",
						x1: 0,
						y1: 0.5,
						x2: 1,
						y2: 0.5,
						stops: [],
					}),
				]),
				transform: { ...createIdentityTransform(), rotation: Math.PI / 4 },
			});
			f.addPath(rectPath("q", { x: 200, y: 0 }, 20, 20, []));
			const p = f.worldBounds("p");
			const q = f.worldBounds("q");
			const minX = Math.min(p.minX, q.minX);
			const minY = Math.min(p.minY, q.minY);
			const maxX = Math.max(p.maxX, q.maxX);
			const maxY = Math.max(p.maxY, q.maxY);
			const frame = worldFrame({
				minX,
				minY,
				maxX,
				maxY,
				width: maxX - minX,
				height: maxY - minY,
			});
			const before = f.gradientEndpointsInWorld("p");

			f.commands.resizeElements(["p", "q"], frame, frame.bounds, {
				x: true,
				y: false,
			});

			// The world mirror across the frame's middle moves each endpoint of
			// the gradient the way it moves the shape.
			const mirrorX = (x: number) => frame.bounds.minX + frame.bounds.maxX - x;
			const after = f.gradientEndpointsInWorld("p");

			expect(after.start.x).toBeCloseTo(mirrorX(before.start.x), 4);
			expect(after.start.y).toBeCloseTo(before.start.y, 4);
			expect(after.end.x).toBeCloseTo(mirrorX(before.end.x), 4);
			expect(after.end.y).toBeCloseTo(before.end.y, 4);
		});
	});

	describe("flipping a rotated element", () => {
		it("should mirror it across the world's vertical axis through its middle", () => {
			const f = createFixture();
			f.addPath({
				...rectPath("p", { x: 40, y: 20 }, 60, 30, []),
				transform: { ...createIdentityTransform(), x: 5, rotation: 0.5 },
			});
			const bounds = f.worldBounds("p");
			const before = f.worldCorners("p");

			f.commands.flipElements(["p"], { x: true, y: false });

			const after = f.worldBounds("p");
			for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
				expect(after[key]).toBeCloseTo(bounds[key], 6);
			}
			const mirrorX = (x: number) => bounds.minX + bounds.maxX - x;
			f.worldCorners("p").forEach((corner, i) => {
				expect(corner.x).toBeCloseTo(mirrorX(before[i].x), 6);
				expect(corner.y).toBeCloseTo(before[i].y, 6);
			});
		});
	});

	describe("resizing a group that holds a rotated compound path", () => {
		it("should scale the compound path in place with its siblings", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() =>
				f.commands.createCompoundPathFromSelection("union"),
			);

			expectScaledInPlace(f, groupId);
		});
	});

	describe("resizing a group that holds a rotated blend", () => {
		it("should scale the blend in place with its siblings", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() => {
				const result = f.commands.createBlendFromSelection();
				return result.ok ? result.blendId : null;
			});

			expectScaledInPlace(f, groupId);
		});

		it("should scale a rotated compound path key in place", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() => {
				const compoundId = f.commands.createCompoundPathFromSelection("union");
				if (!compoundId) return null;
				f.rotate(compoundId, 0.4);
				f.addPath(rectPath("d", { x: 150, y: -20 }, 30, 30, []));
				f.select([compoundId, "d"]);
				const result = f.commands.createBlendFromSelection();
				return result.ok ? result.blendId : null;
			});

			expectScaledInPlace(f, groupId);
		});
	});
});

function createFixture() {
	const store = createRendererState();
	const callbacks: YjsProviderCallbacks = {
		onDocumentUpdate: (doc) => {
			store.document = doc;
		},
		onObjectsChange: () => sync(),
		onLayersUpdate: () => {},
		getCurrentLayerId: () => store.currentLayerId,
		setCurrentLayerId: (id) => {
			store.currentLayerId = id;
		},
	};
	const provider = new YjsProvider({ callbacks });
	const spatial = new SpatialIndex(store);
	const sync = (): void => {
		store.document = extractDocumentFromYDoc(provider.ydoc);
		spatial.rebuildAllIndices();
		spatial.rebuildParentGroupMap();
	};
	const commands = new PaplicoCommands({
		store,
		yjsProvider: provider,
		spatial,
		isReadonly: () => false,
	});
	const layer: Layer = {
		id: "layer",
		name: "layer",
		visible: true,
		locked: false,
		opacity: 1,
		elementIds: [],
	};
	provider.addLayer(layer);
	store.currentLayerId = "layer";
	sync();

	return {
		commands,
		addPath(path: Path): void {
			provider.addElement("layer", path);
			sync();
		},
		addElement(element: AnyArtObject): void {
			provider.addElement("layer", element);
			sync();
		},
		element(id: string): AnyArtObject {
			const element = store.document.objects[id];
			if (!element) throw new Error(`no element ${id}`);
			return element;
		},
		group(ids: string[]): string {
			const groupId = provider.groupElements("layer", ids);
			if (!groupId) throw new Error("group should be created");
			sync();
			return groupId;
		},
		frame(id: string) {
			const frame = spatial.getElementFrame(id);
			if (!frame) throw new Error(`no frame for ${id}`);
			return frame;
		},
		/** Where a path's linear gradient starts and ends in the world. */
		gradientEndpointsInWorld(id: string): { start: Point; end: Point } {
			const path = this.element(id);
			const fill = (path.filters?.[0] as FillAppearance | undefined)?.paramData
				.params.fill;
			if (fill?.type !== "linear") throw new Error(`${id} has no linear fill`);
			const bounds = spatial.getLocalBounds(id);
			const matrix = spatial.getElementWorldMatrix(id);
			if (!bounds || !matrix) throw new Error(`no placement for ${id}`);
			const place = (u: number, v: number) =>
				applyTransformToPoint(
					bounds.minX + u * bounds.width,
					bounds.minY + v * bounds.height,
					matrix,
				);
			return { start: place(fill.x1, fill.y1), end: place(fill.x2, fill.y2) };
		},
		/** A path's anchors placed in the world, in segment order. */
		worldCorners(id: string): Array<{ x: number; y: number }> {
			const path = this.element(id);
			if (path.type !== "path") throw new Error(`${id} is not a path`);
			const matrix = spatial.getElementWorldMatrix(id);
			if (!matrix) throw new Error(`no matrix for ${id}`);
			return path.segments.map((segment) =>
				applyTransformToPoint(segment.end.x, segment.end.y, matrix),
			);
		},
		select(ids: string[]): void {
			store.selectedElementIds = ids;
		},
		lock(id: string): void {
			provider.updateElement("layer", id, { locked: true });
			sync();
		},
		rotate(id: string, rotation: number): void {
			provider.updateElement("layer", id, {
				transform: { ...createIdentityTransform(), rotation },
			});
			sync();
		},
		worldBounds(id: string): BoundingBox {
			const bounds = spatial.getWorldGeometryBounds(id);
			if (!bounds) throw new Error(`no bounds for ${id}`);
			return bounds;
		},
		/**
		 * A translated group holding a rotated combination of two paths that
		 * differ in size, so the combination's own centre moves as they scale.
		 */
		createGroupWithRotated(combine: () => string | null): string {
			provider.addElement("layer", rectPath("a", { x: 0, y: 0 }, 20, 20, []));
			provider.addElement("layer", rectPath("b", { x: 60, y: 30 }, 80, 40, []));
			sync();
			store.selectedElementIds = [...COMBINED_PATH_IDS];
			const targetId = combine();
			if (!targetId) throw new Error("combination should be created");
			provider.updateElement("layer", targetId, {
				transform: {
					...createIdentityTransform(),
					x: 100,
					y: -50,
					rotation: -0.3,
				},
			});
			provider.addElement("layer", rectPath("c", { x: -40, y: 0 }, 10, 10, []));
			const groupId = provider.groupElements("layer", [targetId, "c"]);
			if (!groupId) throw new Error("group should be created");
			provider.updateElement("layer", groupId, {
				transform: { ...createIdentityTransform(), x: 40, y: 70 },
			});
			sync();
			return groupId;
		},
	};
}

/**
 * Resize the group by 1.5 and expect the combined paths to follow it exactly.
 * They are measured one by one because a rotated combination's own bounds
 * are a loose box that tightens once its rotation is baked away.
 */
function expectScaledInPlace(
	f: ReturnType<typeof createFixture>,
	groupId: string,
): void {
	const original = f.worldBounds(groupId);
	const before = COMBINED_PATH_IDS.map((id) => f.worldBounds(id));
	const scale = 1.5;

	f.commands.resizeElements(
		[groupId],
		worldFrame(original),
		scaleFromMinCorner(original, original, scale),
	);

	COMBINED_PATH_IDS.forEach((id, i) => {
		const after = f.worldBounds(id);
		const expected = scaleFromMinCorner(before[i], original, scale);
		for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
			expect(after[key]).toBeCloseTo(expected[key], 6);
		}
	});
}

/** Map `box` by the resize that scales `frame` about its min corner. */
function scaleFromMinCorner(
	box: BoundingBox,
	frame: BoundingBox,
	scale: number,
): BoundingBox {
	const minX = frame.minX + (box.minX - frame.minX) * scale;
	const minY = frame.minY + (box.minY - frame.minY) * scale;
	const width = box.width * scale;
	const height = box.height * scale;
	return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

/** An 80×40 image centred on the origin, turned by `rotation`. */
function makeImage(id: string, rotation: number): ImageObject {
	return {
		type: "image",
		id,
		fileUid: "file",
		x: 0,
		y: 0,
		width: 80,
		height: 40,
		opacity: 1,
		blendMode: "normal",
		transform: { ...createIdentityTransform(), rotation },
	};
}

function makeFill(fill: FillColor): FillAppearance {
	return {
		uid: "app-fill",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: { fill } },
	};
}

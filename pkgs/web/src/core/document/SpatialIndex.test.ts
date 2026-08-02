import { describe, expect, it } from "vitest";
import type { RendererState } from "../Paplico";
import type {
	AnyArtObject,
	Artboard,
	BlendObject,
	Group,
	ImageObject,
	Layer,
	MeshArtObject,
	Path,
	PathSegment,
	RepeatObject,
	TextElement,
	TextStyle,
} from "../schema";
import {
	brandLocalBBox,
	brandWorldBBox,
	type WorldBBox,
} from "../utils/geometry/bounds";
import { createIdentityTransform } from "./factory";
import { SpatialIndex } from "./SpatialIndex";

// ===== Test helpers =====

function makeStore(
	layers: Layer[],
	objects: Record<string, AnyArtObject>,
	editingScopeStack: string[] = [],
	artboards: Artboard[] = [],
): RendererState {
	return {
		editingScopeStack,
		document: {
			id: "doc",
			layers,
			objects,
			viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
			files: [],
			artboards,
			brushPresets: [],
		},
	} as unknown as RendererState;
}

function makeLayer(id: string, elementIds: string[]): Layer {
	return {
		id,
		name: id,
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal",
		elementIds,
	};
}

/**
 * Create an ImageObject at center (cx, cy) with the given dimensions.
 * ImageObjects use AABB hit-testing, making them convenient for deterministic tests.
 */
function makeImage(
	id: string,
	cx: number,
	cy: number,
	w: number,
	h: number,
	overrides: Partial<ImageObject> = {},
): ImageObject {
	return {
		type: "image",
		id,
		fileUid: "file-1",
		x: cx,
		y: cy,
		width: w,
		height: h,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...overrides,
	};
}

function makeGroup(
	id: string,
	childIds: string[],
	overrides: Partial<Group> = {},
): Group {
	return {
		type: "group",
		id,
		childIds,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...overrides,
	};
}

/**
 * Create a TextElement with baseline anchor at (x, y).
 * The synchronous bounds estimate for this element ("Hello", 16px, lineHeight
 * 1.5) is (x, y-24)-(x+80, y+16); tests pass precise bounds that differ from it.
 */
function makeText(
	id: string,
	x: number,
	y: number,
	overrides: Partial<TextElement> = {},
): TextElement {
	const style: TextStyle = {
		fontFamily: "sans-serif",
		fontSource: { type: "local", postScriptName: "sans-serif" },
		fontSize: 16,
		fontWeight: 400,
		fontStyle: "normal",
		fill: null,
		underline: false,
		strikethrough: false,
		letterSpacing: 0,
		baselineShift: 0,
	};
	return {
		type: "text",
		id,
		x,
		y,
		content: {
			paragraphs: [
				{
					runs: [{ text: "Hello", style }],
					alignment: "left",
					lineHeight: 1.5,
					indent: 0,
					spacing: { before: 0, after: 0 },
				},
			],
		},
		defaultStyle: style,
		layout: {
			writingMode: "horizontal-tb",
			boxWidth: "auto",
			boxHeight: "auto",
			overflow: "visible",
			wordWrap: true,
		},
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...overrides,
	};
}

function makeArtboard(
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
): Artboard {
	return {
		id,
		name: id,
		x,
		y,
		width,
		height,
	};
}

/**
 * Create a simple straight-line Path through the origin.
 * The path spans from (-50,0) to (50,0) so any point near y=0 within x∈[-50,50]
 * will be detected by isPointOnPath with the default tolerance.
 */
function makePath(id: string): Path {
	const seg: PathSegment = {
		start: { x: -50, y: 0 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 50, y: 0 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};
	return {
		type: "path",
		id,
		segments: [seg],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	} as Path;
}

/**
 * Create a closed rectangular Path centered at origin (no fill filter).
 * Forms a 100×100 square from (-50,-50) to (50,50).
 * Useful for testing fill-area hit detection on clip paths.
 */
function makeClosedPath(id: string): Path {
	const tilt = { startTiltX: 0, startTiltY: 0, endTiltX: 0, endTiltY: 0 };
	const time = { startDeltaTime: 0, endDeltaTime: 0 };
	const cp = { x: 0, y: 0 };
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x: -50, y: -50 },
				cp1: cp,
				cp2: cp,
				end: { x: 50, y: -50 },
				isMoved: false,
				...tilt,
				...time,
			},
			{
				cp1: cp,
				cp2: cp,
				end: { x: 50, y: 50 },
				isMoved: false,
				...tilt,
				...time,
			},
			{
				cp1: cp,
				cp2: cp,
				end: { x: -50, y: 50 },
				isMoved: false,
				...tilt,
				...time,
			},
			{
				cp1: cp,
				cp2: cp,
				end: { x: -50, y: -50 },
				isMoved: false,
				isClosed: true,
				...tilt,
				...time,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	} as Path;
}

function makeBounds(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): WorldBBox {
	return brandWorldBBox({
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	});
}

// ===== Tests =====

describe("SpatialIndex", () => {
	describe("snapBoundsToElements", () => {
		it("should snap candidate bounds to other artboard edges", () => {
			const layer = makeLayer("layer-1", []);
			const artboard = makeArtboard("ab-1", 200, 0, 100, 100);
			const store = makeStore([layer], {}, [], [artboard]);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const result = idx.snapBoundsToElements(
				brandWorldBBox({
					minX: 140,
					minY: -50,
					maxX: 245,
					maxY: 50,
					width: 105,
					height: 100,
				}),
				1,
			);

			expect(result.deltaX).toBe(5);
			expect(result.deltaY).toBe(0);
			expect(result.snapLines).toContainEqual({
				axis: "vertical",
				position: 250,
				extentMin: -50,
				extentMax: 50,
			});
		});
	});

	describe("getBounds / setBounds", () => {
		it("returns null for an unknown element", () => {
			const store = makeStore([], {});
			const idx = new SpatialIndex(store);
			expect(idx.getBounds("nonexistent")).toBeNull();
		});

		it("computes and caches bounds on first call", () => {
			const img = makeImage("img-1", 0, 0, 100, 60);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const bounds = idx.getBounds("img-1");
			expect(bounds).toEqual(
				expect.objectContaining({ minX: -50, minY: -30, maxX: 50, maxY: 30 }),
			);
			// Second call should return the cached value (same reference).
			expect(idx.getBounds("img-1")).toBe(bounds);
		});

		it("setBounds updates the cache and quadtree", () => {
			const img = makeImage("img-1", 0, 0, 100, 60);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const newBounds = brandWorldBBox(makeBounds(200, 200, 300, 260));
			idx.setBounds("img-1", newBounds);

			expect(idx.getBounds("img-1")).toEqual(newBounds);
			// The element should now be findable at the new position.
			expect(idx.findElementAtPoint("layer-1", 250, 230)).not.toBeNull();
			// And no longer findable at the old position.
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBeNull();
		});
	});

	describe("insertElement / removeElement", () => {
		it("makes an element findable after insertion", () => {
			const img = makeImage("img-1", 50, 50, 100, 100);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.createLayerIndex("layer-1");

			idx.insertElement("layer-1", img);

			expect(idx.findElementAtPoint("layer-1", 50, 50)).toBe(img);
		});

		it("removes an element from the index", () => {
			const img = makeImage("img-1", 50, 50, 100, 100);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.createLayerIndex("layer-1");
			idx.insertElement("layer-1", img);

			idx.removeElement("layer-1", "img-1");

			expect(idx.findElementAtPoint("layer-1", 50, 50)).toBeNull();
		});

		it("registers group children in parentGroupMap on insertion", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child });
			const idx = new SpatialIndex(store);
			idx.createLayerIndex("layer-1");
			idx.insertElement("layer-1", group);

			expect(idx.getParentGroupId("child-1")).toBe("group-1");
		});

		it("clears parentGroupMap entries when group is removed", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			idx.removeElement("layer-1", "group-1");

			expect(idx.getParentGroupId("child-1")).toBeNull();
		});
	});

	describe("findElementAtPoint", () => {
		it("returns null when no element is at the point", () => {
			const img = makeImage("img-1", 0, 0, 40, 40);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 9999, 9999)).toBeNull();
		});

		it("returns the element at the given point", () => {
			const img = makeImage("img-1", 0, 0, 100, 100);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(img);
		});

		it("respects layer Z-order: returns the frontmost (last in elementIds) overlapping element", () => {
			// Both images occupy the same point (0, 0).
			// "back" is elementIds[0] (backmost), "front" is elementIds[1] (frontmost).
			const back = makeImage("back", 0, 0, 100, 100);
			const front = makeImage("front", 0, 0, 100, 100);
			const layer = makeLayer("layer-1", ["back", "front"]);
			const store = makeStore([layer], { back, front });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(front);
		});

		it("skips invisible elements", () => {
			const hidden = makeImage("hidden", 0, 0, 100, 100, { visible: false });
			const visible = makeImage("visible", 0, 0, 100, 100);
			const layer = makeLayer("layer-1", ["hidden", "visible"]);
			const store = makeStore([layer], { hidden, visible });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(visible);
		});

		it("returns the parent group when a group child is hit", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], {
				"group-1": group,
				"child-1": child,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(group);
		});

		it("in group edit mode, returns the child directly (respecting Z-order within group)", () => {
			const back = makeImage("back", 0, 0, 100, 100);
			const front = makeImage("front", 0, 0, 100, 100);
			const group = makeGroup("group-1", ["back", "front"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore(
				[layer],
				{ "group-1": group, back, front },
				["group-1"], // editingScopeStack: inside group-1
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// In group edit mode, queryElements returns children of the editing group
			// and the loop iterates in reverse, so "front" (last in childIds) wins.
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(front);
		});

		it("returns null in group edit mode when point is outside all children", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child }, [
				"group-1",
			]);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 9999, 9999)).toBeNull();
		});

		it("in a single-element scope, hits only the scope element", () => {
			const scoped = makeImage("scoped", 0, 0, 40, 40);
			const other = makeImage("other", 100, 0, 40, 40);
			const layer = makeLayer("layer-1", ["scoped", "other"]);
			const store = makeStore([layer], { scoped, other }, ["scoped"]);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(scoped);
			// "other" is outside the scope, so its position hits nothing.
			expect(idx.findElementAtPoint("layer-1", 100, 0)).toBeNull();
		});

		it("in a single-element scope, hit-tests a group child through the parent transform", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"], {
				transform: { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			});
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child }, [
				"group-1",
				"child-1",
			]);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// The child lives at world (100, 0) through the group transform.
			expect(idx.findElementAtPoint("layer-1", 100, 0)).toBe(child);
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBeNull();
		});

		it("in a single-element scope, does not promote the scope element to its clip group", () => {
			const clipPath = makeImage("clip-path", 0, 0, 100, 100);
			const child = makeImage("child-1", 0, 0, 40, 40);
			const clipGroup = makeGroup("clip-group", ["clip-path", "child-1"], {
				clipPathId: "clip-path",
			});
			const layer = makeLayer("layer-1", ["clip-group"]);
			const store = makeStore(
				[layer],
				{ "clip-group": clipGroup, "clip-path": clipPath, "child-1": child },
				["child-1"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(child);
		});

		it("in a scaled editing scope, hits a plain child group offset from the scope origin", () => {
			// The renderer applies the composed ancestor transform around each
			// element's own origin, so with scale 2 the far image (own origin
			// (200,0)) is drawn spanning world (160..240, -40..40).
			const imgNear = makeImage("img-near", 0, 0, 40, 40);
			const imgFar = makeImage("img-far", 200, 0, 40, 40);
			const childGroup = makeGroup("child-group", ["img-far"]);
			const scope = makeGroup("scope", ["img-near", "child-group"], {
				transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 2 },
			});
			const layer = makeLayer("layer-1", ["scope"]);
			const store = makeStore(
				[layer],
				{
					scope,
					"img-near": imgNear,
					"child-group": childGroup,
					"img-far": imgFar,
				},
				["scope"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Clicking the drawn content selects the child group…
			expect(idx.findElementAtPoint("layer-1", 200, 0)).toBe(childGroup);
			// …and empty canvas beside it selects nothing.
			expect(idx.findElementAtPoint("layer-1", 300, 0)).toBeNull();
		});

		it("in a translated editing scope, hits a clip group child on its clipped content", () => {
			const clipPath = makeClosedPath("clip-path");
			const content = makeImage("content", 0, 0, 40, 40);
			const clipGroup = makeGroup("clip-group", ["clip-path", "content"], {
				clipPathId: "clip-path",
			});
			const scope = makeGroup("scope", ["clip-group"], {
				transform: { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			});
			const layer = makeLayer("layer-1", ["scope"]);
			const store = makeStore(
				[layer],
				{
					scope,
					"clip-group": clipGroup,
					"clip-path": clipPath,
					content,
				},
				["scope"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// World (100,0) is the clipped content's center through the scope
			// translation. The clip test runs in the clip group's local space,
			// so the ancestor translation must not be applied twice.
			expect(idx.findElementAtPoint("layer-1", 100, 0)).toBe(clipGroup);
		});

		it("hits a moved top-level clip group on its clipped content", () => {
			const clipPath = makeClosedPath("clip-path");
			const content = makeImage("content", 0, 0, 40, 40);
			const clipGroup = makeGroup("clip-group", ["clip-path", "content"], {
				clipPathId: "clip-path",
				transform: { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			});
			const layer = makeLayer("layer-1", ["clip-group"]);
			const store = makeStore([layer], {
				"clip-group": clipGroup,
				"clip-path": clipPath,
				content,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 100, 0)).toBe(clipGroup);
		});
	});

	describe("queryElements in a single-element scope", () => {
		it("returns only the scope element as candidate", () => {
			const scoped = makeImage("scoped", 0, 0, 40, 40);
			const other = makeImage("other", 100, 0, 40, 40);
			const layer = makeLayer("layer-1", ["scoped", "other"]);
			const store = makeStore([layer], { scoped, other }, ["scoped"]);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const bounds = makeBounds(-200, -200, 200, 200);
			expect(idx.queryElements("layer-1", bounds, "scoped")).toEqual([scoped]);
		});
	});

	describe("findElementsInRect", () => {
		it("returns elements whose bounds overlap the rect", () => {
			const a = makeImage("a", -50, 0, 40, 40);
			const b = makeImage("b", 50, 0, 40, 40);
			const layer = makeLayer("layer-1", ["a", "b"]);
			const store = makeStore([layer], { a, b });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Query only covers left half
			const results = idx.findElementsInRect("layer-1", -100, -50, 0, 50);
			expect(results).toContain(a);
			expect(results).not.toContain(b);
		});

		it("excludes invisible elements", () => {
			const hidden = makeImage("hidden", 0, 0, 40, 40, { visible: false });
			const layer = makeLayer("layer-1", ["hidden"]);
			const store = makeStore([layer], { hidden });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(
				idx.findElementsInRect("layer-1", -100, -100, 100, 100),
			).toHaveLength(0);
		});
	});

	describe("rebuildAllIndices", () => {
		it("makes elements findable after rebuild", () => {
			const img = makeImage("img-1", 0, 0, 100, 100);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);

			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(img);
		});

		it("rebuilds parentGroupMap for containers", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child });
			const idx = new SpatialIndex(store);

			idx.rebuildAllIndices();

			expect(idx.getParentGroupId("child-1")).toBe("group-1");
		});
	});

	describe("queryElements", () => {
		it("returns elements within the given bounds", () => {
			const inside = makeImage("inside", 0, 0, 20, 20);
			const outside = makeImage("outside", 500, 500, 20, 20);
			const layer = makeLayer("layer-1", ["inside", "outside"]);
			const store = makeStore([layer], { inside, outside });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const results = idx.queryElements(
				"layer-1",
				makeBounds(-100, -100, 100, 100),
			);
			expect(results).toContain(inside);
			expect(results).not.toContain(outside);
		});

		it("returns empty array for unknown layer", () => {
			const store = makeStore([], {});
			const idx = new SpatialIndex(store);

			expect(
				idx.queryElements("nonexistent", makeBounds(0, 0, 100, 100)),
			).toEqual([]);
		});

		it("with parentGroupId, returns children of the container within bounds", () => {
			const childIn = makeImage("childIn", 0, 0, 20, 20);
			const childOut = makeImage("childOut", 500, 500, 20, 20);
			const group = makeGroup("group-1", ["childIn", "childOut"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], {
				"group-1": group,
				childIn,
				childOut,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const results = idx.queryElements(
				"layer-1",
				makeBounds(-100, -100, 100, 100),
				"group-1",
			);
			expect(results).toContain(childIn);
			expect(results).not.toContain(childOut);
		});

		it("with a layer id as editing scope, returns elements from that layer within bounds", () => {
			const childIn = makeImage("childIn", 0, 0, 20, 20);
			const childOut = makeImage("childOut", 500, 500, 20, 20);
			const scopedLayer = makeLayer("pattern-edit-layer", [
				"childIn",
				"childOut",
			]);
			const store = makeStore([scopedLayer], { childIn, childOut });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			const results = idx.queryElements(
				"pattern-edit-layer",
				makeBounds(-100, -100, 100, 100),
				"pattern-edit-layer",
			);
			expect(results).toContain(childIn);
			expect(results).not.toContain(childOut);
		});
	});

	describe("getParentGroupId", () => {
		it("returns the parent group ID for a child element", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.getParentGroupId("child-1")).toBe("group-1");
		});

		it("returns null for a top-level element", () => {
			const img = makeImage("img-1", 0, 0, 40, 40);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.getParentGroupId("img-1")).toBeNull();
		});
	});

	describe("rebuildParentGroupMap", () => {
		it("re-registers all container-child relationships", () => {
			const child = makeImage("child-1", 0, 0, 40, 40);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "child-1": child });
			const idx = new SpatialIndex(store);

			// Manually clear then rebuild via rebuildParentGroupMap.
			idx.rebuildParentGroupMap();

			expect(idx.getParentGroupId("child-1")).toBe("group-1");
		});
	});

	describe("updateElement", () => {
		it("reflects new bounds after update", () => {
			const img = makeImage("img-1", 0, 0, 100, 100);
			const layer = makeLayer("layer-1", ["img-1"]);
			const store = makeStore([layer], { "img-1": img });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Move the element to a new position.
			const moved = makeImage("img-1", 500, 500, 100, 100);
			store.document.objects["img-1"] = moved;
			idx.updateElement("layer-1", moved);

			expect(idx.findElementAtPoint("layer-1", 500, 500)).toBe(moved);
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBeNull();
		});
	});

	describe("clip group hit testing", () => {
		it("findElementAtPoint returns the clip group when clicking its child (non-editing-group)", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const clipGroup = makeGroup("clip-1", ["child-1"], {
				clipPathId: "child-1",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore([layer], {
				"clip-1": clipGroup,
				"child-1": child,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(clipGroup);
		});

		it("findElementAtPoint returns the child directly when editing inside the clip group", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const clipGroup = makeGroup("clip-1", ["child-1"], {
				clipPathId: "child-1",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore(
				[layer],
				{ "clip-1": clipGroup, "child-1": child },
				["clip-1"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(child);
		});

		it("findElementAtPoint resolves nested groups to the top-level container", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const innerGroup = makeGroup("inner", ["child-1"]);
			const outerGroup = makeGroup("outer", ["inner"]);
			const layer = makeLayer("layer-1", ["outer"]);
			const store = makeStore([layer], {
				outer: outerGroup,
				inner: innerGroup,
				"child-1": child,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(outerGroup);
		});

		it("findElementAtPoint resolves clip group nested inside editing group to the clip group", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const clipGroup = makeGroup("clip-inner", ["child-1"], {
				clipPathId: "child-1",
			});
			const outerGroup = makeGroup("outer", ["clip-inner"]);
			const layer = makeLayer("layer-1", ["outer"]);
			const store = makeStore(
				[layer],
				{
					outer: outerGroup,
					"clip-inner": clipGroup,
					"child-1": child,
				},
				["outer"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(clipGroup);
		});

		it("findPathAtPoint returns null for container child when not editing inside it", () => {
			const child = makeImage("child-1", 0, 0, 100, 100);
			const group = makeGroup("group-1", ["child-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], {
				"group-1": group,
				"child-1": child,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findPathAtPoint("layer-1", 0, 0)).toBeNull();
		});

		it("findPathAtPoint returns a path inside a clip group that is a child of the editing group", () => {
			const clipShape = makeClosedPath("clip-shape");
			const pathChild = makePath("path-a");
			const clipGroup = makeGroup("clip-1", ["clip-shape", "path-a"], {
				clipPathId: "clip-shape",
			});
			const outerGroup = makeGroup("outer", ["clip-1"]);
			const layer = makeLayer("layer-1", ["outer"]);
			const store = makeStore(
				[layer],
				{
					outer: outerGroup,
					"clip-1": clipGroup,
					"clip-shape": clipShape,
					"path-a": pathChild,
				},
				["outer"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// (0,0) is inside clip shape and on path-a's stroke
			expect(idx.findPathAtPoint("layer-1", 0, 0)).toBe(pathChild);
		});

		it("findElementAtPoint rejects points outside the clip path shape", () => {
			// Clip path is a closed 100×100 square centered at origin
			const clipPath = makeClosedPath("clip-shape");
			// Child image extends well beyond the clip path bounds
			const child = makeImage("child-1", 0, 0, 400, 400);
			const clipGroup = makeGroup("clip-1", ["clip-shape", "child-1"], {
				clipPathId: "clip-shape",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore([layer], {
				"clip-1": clipGroup,
				"clip-shape": clipPath,
				"child-1": child,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Inside clip path → hits the clip group
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(clipGroup);
			// Outside clip path but inside child bounds → no hit
			expect(idx.findElementAtPoint("layer-1", 100, 100)).toBeNull();
		});

		it("findElementAtPoint hits clip group when clicking on a filled path inside it (normal mode)", () => {
			const clipShape = makeClosedPath("clip-shape");
			// A filled path inside the clip group (with fill filter)
			const filledPath = {
				...makeClosedPath("filled-path"),
				filters: [
					{
						processor: "fill" as const,
						paramData: {
							params: {
								fill: { type: "solid", color: { r: 255, g: 0, b: 0, a: 1 } },
							},
						},
						enabled: true,
					},
				],
			} as unknown as Path;
			const clipGroup = makeGroup("clip-1", ["clip-shape", "filled-path"], {
				clipPathId: "clip-shape",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore([layer], {
				"clip-1": clipGroup,
				"clip-shape": clipShape,
				"filled-path": filledPath,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// (0,0) is inside clip shape and inside filled path's fill area
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(clipGroup);
		});

		it("findPathAtPoint finds a path inside a nested container (group → clip group → path)", () => {
			const clipShape = makeClosedPath("clip-shape");
			const pathChild = makePath("path-a");
			const clipGroup = makeGroup("clip-1", ["clip-shape", "path-a"], {
				clipPathId: "clip-shape",
			});
			// innerGroup wraps the clipGroup, adding an extra nesting level
			const innerGroup = makeGroup("inner", ["clip-1"]);
			const outerGroup = makeGroup("outer", ["inner"]);
			const layer = makeLayer("layer-1", ["outer"]);
			const store = makeStore(
				[layer],
				{
					outer: outerGroup,
					inner: innerGroup,
					"clip-1": clipGroup,
					"clip-shape": clipShape,
					"path-a": pathChild,
				},
				["outer"],
			);
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// (0,0) is inside clip shape and on path-a's stroke
			expect(idx.findPathAtPoint("layer-1", 0, 0)).toBe(pathChild);
		});

		it("findPathAtPoint returns null for a clip group path when not editing its parent", () => {
			const pathChild = makePath("path-a");
			const clipGroup = makeGroup("clip-1", ["path-a"], {
				clipPathId: "path-a",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore([layer], {
				"clip-1": clipGroup,
				"path-a": pathChild,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findPathAtPoint("layer-1", 0, 0)).toBeNull();
		});

		it("findPathAtPoint with deepSearch bypasses the group editing guard", () => {
			const pathChild = makePath("path-a");
			const group = makeGroup("group-1", ["path-a"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], {
				"group-1": group,
				"path-a": pathChild,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Without deepSearch: blocked by group editing guard
			expect(idx.findPathAtPoint("layer-1", 0, 0)).toBeNull();
			// With deepSearch: digs into the group
			expect(idx.findPathAtPoint("layer-1", 0, 0, 5, true)).toBe(pathChild);
		});

		it("findPathAtPoint with deepSearch finds paths in nested groups", () => {
			const pathChild = makePath("path-a");
			const innerGroup = makeGroup("inner", ["path-a"]);
			const outerGroup = makeGroup("outer", ["inner"]);
			const layer = makeLayer("layer-1", ["outer"]);
			const store = makeStore([layer], {
				outer: outerGroup,
				inner: innerGroup,
				"path-a": pathChild,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			expect(idx.findPathAtPoint("layer-1", 0, 0, 5, true)).toBe(pathChild);
		});

		it("findPathAtPoint with deepSearch still respects clip path rejection", () => {
			const clipShape = makeClosedPath("clip-shape");
			const pathChild = makePath("path-a");
			const clipGroup = makeGroup("clip-1", ["clip-shape", "path-a"], {
				clipPathId: "clip-shape",
			});
			const layer = makeLayer("layer-1", ["clip-1"]);
			const store = makeStore([layer], {
				"clip-1": clipGroup,
				"clip-shape": clipShape,
				"path-a": pathChild,
			});
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Inside clip shape → finds the path
			expect(idx.findPathAtPoint("layer-1", 0, 0, 5, true)).toBe(pathChild);
			// Outside clip shape → rejected even with deepSearch
			expect(idx.findPathAtPoint("layer-1", 100, 100, 5, true)).toBeNull();
		});
	});

	describe("blend intermediate hit-testing", () => {
		const filledSquareAt = (id: string, cx: number): Path => {
			const base = makeClosedPath(id);
			return {
				...base,
				segments: base.segments.map((s) => ({
					...s,
					start: s.start ? { x: s.start.x + cx, y: s.start.y } : undefined,
					end: { x: s.end.x + cx, y: s.end.y },
				})),
				filters: [
					{
						uid: `${id}-fill`,
						processor: "fill",
						opacity: 1,
						blendMode: "normal",
						paramData: {
							version: "1",
							params: {
								fill: {
									type: "solid",
									color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
								},
							},
						},
					},
				],
			} as Path;
		};

		const makeBlendObj = (id: string, objectIds: string[]): AnyArtObject =>
			({
				type: "blend",
				id,
				objectIds,
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			}) as unknown as AnyArtObject;

		it("selects the blend when an intermediate (between sources) is clicked", () => {
			const s0 = filledSquareAt("s0", 0); // square -50..50
			const s1 = filledSquareAt("s1", 400); // square 350..450
			const blend = makeBlendObj("blend-1", ["s0", "s1"]);
			const layer = makeLayer("layer-1", ["blend-1"]);
			const store = makeStore([layer], { "blend-1": blend, s0, s1 });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// The midpoint intermediate sits at x≈200 — covered by no source, only by
			// the synthetic intermediate. Without intermediate hit-testing this misses.
			expect(idx.findElementAtPoint("layer-1", 200, 0)).toBe(blend);
			// Clicking a source still resolves to the blend.
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(blend);
			// Empty space outside every shape misses.
			expect(idx.findElementAtPoint("layer-1", 200, 300)).toBeNull();
		});

		it("findPathAtPoint (deepSearch) selects a blend source positioned via its own transform", () => {
			// Blend keys typically carry their offset in transform.x/y (not baked into
			// segments). A body click reaches findPathInChildren in the blend's local
			// space, so the source's own transform must be inverse-applied before the
			// hit test — otherwise PathEditTool can never directly select the inner
			// object.
			const s0 = filledSquareAt("s0", 0); // identity transform, square -50..50
			const s1: Path = {
				...filledSquareAt("s1", 0),
				transform: { ...createIdentityTransform(), x: 400 }, // displayed 350..450
			};
			const blend = makeBlendObj("blend-1", ["s0", "s1"]);
			const layer = makeLayer("layer-1", ["blend-1"]);
			const store = makeStore([layer], { "blend-1": blend, s0, s1 });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Body click on the transform-positioned source resolves to that source.
			expect(idx.findPathAtPoint("layer-1", 400, 0, 5, true)).toBe(s1);
			// The identity-transform source still resolves.
			expect(idx.findPathAtPoint("layer-1", 0, 0, 5, true)).toBe(s0);
		});

		it("rotates a blend source's world bounds/segments around the blend's center, not its own", () => {
			const s0 = filledSquareAt("s0", 0); // square -50..50
			const s1 = filledSquareAt("s1", 400); // square 350..450
			const blend = makeBlendObj("blend-1", ["s0", "s1"]) as BlendObject;
			blend.transform = { ...createIdentityTransform(), rotation: Math.PI / 2 };
			const layer = makeLayer("layer-1", ["blend-1"]);
			const store = makeStore([layer], { "blend-1": blend, s0, s1 });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Blend local bbox center = ((-50+450)/2, 0) = (200, 0). Rotating the
			// ±50 source 90° around (200,0): x → 200 - y, y → x - 200, so the box
			// lands at x[150,250], y[-250,-150]. (Rotating around the source's own
			// center (0,0) — the bug — would leave it at ±50.)
			const bounds = idx.getWorldBounds("s0");
			expect(bounds).not.toBeNull();
			expect(bounds!.minX).toBeCloseTo(150, 4);
			expect(bounds!.maxX).toBeCloseTo(250, 4);
			expect(bounds!.minY).toBeCloseTo(-250, 4);
			expect(bounds!.maxY).toBeCloseTo(-150, 4);

			// Same pivot for the selection outline segments.
			const segs = idx.getElementWorldSegments("s0");
			expect(segs).not.toBeNull();
			const start = segs![0].start;
			if (!start) throw new Error("expected a start point on s0's segments");
			expect(start.x).toBeCloseTo(250, 4);
			expect(start.y).toBeCloseTo(-250, 4);

			// The compensation lives in the ancestor transform, so
			// PathEditTool/rotate/stroke-width consumers that read it get the
			// blend-center pivot too: blendT.t + (I−A)(Ob−Os) with Ob=(200,0),
			// Os=(0,0), 90° → translation (200,-200), rotation kept.
			const at = idx.getAncestorTransform("s0");
			expect(at).not.toBeNull();
			expect(at!.x).toBeCloseTo(200, 4);
			expect(at!.y).toBeCloseTo(-200, 4);
			expect(at!.rotation).toBeCloseTo(Math.PI / 2, 4);
		});
	});

	describe("repeat instance hit-testing", () => {
		const makeRepeat = (
			id: string,
			sourceIds: string[],
			overrides: Partial<RepeatObject> = {},
		): RepeatObject =>
			({
				type: "repeat",
				id,
				sourceIds,
				mode: "grid",
				grid: { width: 0, height: 0, spacingX: 0, spacingY: 0 },
				radial: {
					count: 1,
					radius: 0,
					startAngle: 0,
					sweep: Math.PI * 2,
					rotateInstances: false,
				},
				mirror: { axisAngle: Math.PI / 2, offset: 0 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				...overrides,
			}) as RepeatObject;

		it("selects the repeat when a grid instance clone is clicked", () => {
			// Source image spans -50..50; spacingX=200 clones it to 150..250. The
			// fill region (width 300 from source left -50) reaches x=250, so both
			// copies are within it. Only the sources exist in document.objects.
			const src = makeImage("src", 0, 0, 100, 100);
			const repeat = makeRepeat("repeat-1", ["src"], {
				grid: { width: 300, height: 0, spacingX: 200, spacingY: 0 },
			});
			const layer = makeLayer("layer-1", ["repeat-1"]);
			const store = makeStore([layer], { "repeat-1": repeat, src });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Original instance.
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(repeat);
			// Second (synthetic) instance at x≈200, within the fill region.
			expect(idx.findElementAtPoint("layer-1", 200, 0)).toBe(repeat);
			// Gap between the two clones is empty.
			expect(idx.findElementAtPoint("layer-1", 120, 0)).toBeNull();
			// Beyond the fill region (x > 250) nothing is hit even though an
			// unclipped tile would reach there.
			expect(idx.findElementAtPoint("layer-1", 300, 0)).toBeNull();
		});

		it("selects the repeat when a mirror instance clone is clicked", () => {
			// Vertical mirror axis offset +200 reflects the -50..50 source across
			// x=200, placing the mirrored clone at 350..450.
			const src = makeImage("src", 0, 0, 100, 100);
			const repeat = makeRepeat("repeat-1", ["src"], {
				mode: "mirror",
				mirror: { axisAngle: Math.PI / 2, offset: 200 },
			});
			const layer = makeLayer("layer-1", ["repeat-1"]);
			const store = makeStore([layer], { "repeat-1": repeat, src });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Original instance.
			expect(idx.findElementAtPoint("layer-1", 0, 0)).toBe(repeat);
			// Mirrored instance at x≈400.
			expect(idx.findElementAtPoint("layer-1", 400, 0)).toBe(repeat);
			// The reflection axis at x=200 sits between the two clones — empty.
			expect(idx.findElementAtPoint("layer-1", 200, 0)).toBeNull();
		});
	});

	describe("setTextBounds (precise text layout bounds)", () => {
		// Chosen to differ from the synchronous estimate (0,-24)-(80,16) on every edge.
		const preciseLocal = () => brandLocalBBox(makeBounds(5, -18, 60, 9));
		const preciseWorld = () => brandWorldBBox(makeBounds(5, -18, 60, 9));

		it("uses the precise local bounds for getWorldBounds of text inside a translated group", () => {
			const text = makeText("txt-1", 0, 0);
			const group = makeGroup("group-1", ["txt-1"], {
				transform: { ...createIdentityTransform(), x: 100, y: 50 },
			});
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "txt-1": text });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			idx.setTextBounds("txt-1", preciseWorld(), preciseLocal());

			// Precise local box translated by the group's transform.
			const bounds = idx.getWorldBounds("txt-1");
			expect(bounds).not.toBeNull();
			expect(bounds!.minX).toBeCloseTo(105, 4);
			expect(bounds!.minY).toBeCloseTo(32, 4);
			expect(bounds!.maxX).toBeCloseTo(160, 4);
			expect(bounds!.maxY).toBeCloseTo(59, 4);
		});

		it("recomputes an ancestor group's bounds from the precise text bounds", () => {
			const text = makeText("txt-1", 0, 0);
			const group = makeGroup("group-1", ["txt-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "txt-1": text });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();

			// Populate the group's cached bounds from the estimate first.
			const before = idx.getBounds("group-1");

			idx.setTextBounds("txt-1", preciseWorld(), preciseLocal());

			const after = idx.getBounds("group-1");
			expect(after).not.toEqual(before);
			expect(after).toEqual(
				expect.objectContaining({ minX: 5, minY: -18, maxX: 60, maxY: 9 }),
			);
		});

		it("keeps precise bounds of grouped text through rebuildAllIndices", () => {
			const text = makeText("txt-1", 0, 0);
			const group = makeGroup("group-1", ["txt-1"]);
			const layer = makeLayer("layer-1", ["group-1"]);
			const store = makeStore([layer], { "group-1": group, "txt-1": text });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();
			idx.setTextBounds("txt-1", preciseWorld(), preciseLocal());

			idx.rebuildAllIndices();

			expect(idx.getBounds("txt-1")).toEqual(
				expect.objectContaining({ minX: 5, minY: -18, maxX: 60, maxY: 9 }),
			);
			// The group's bounds are recomputed from the preserved precise local bounds.
			expect(idx.getBounds("group-1")).toEqual(
				expect.objectContaining({ minX: 5, minY: -18, maxX: 60, maxY: 9 }),
			);
		});

		it("drops stored precise bounds on updateElement so stale values are not served", () => {
			const text = makeText("txt-1", 0, 0);
			const layer = makeLayer("layer-1", ["txt-1"]);
			const store = makeStore([layer], { "txt-1": text });
			const idx = new SpatialIndex(store);
			idx.rebuildAllIndices();
			idx.setTextBounds("txt-1", preciseWorld(), preciseLocal());

			const moved = makeText("txt-1", 500, 0);
			store.document.objects["txt-1"] = moved;
			idx.updateElement("layer-1", moved);

			// Recomputed from the document (estimate at the new position),
			// not the precise bounds stored for the old position.
			expect(idx.getBounds("txt-1")).toEqual(
				expect.objectContaining({ minX: 500 }),
			);
		});
	});
});

describe("object mask hit testing", () => {
	it("should hit the whole element, including where the mask hides it", () => {
		const owner = makeImage("owner", 0, 0, 200, 200, {
			mask: { elementIds: ["mask-shape"] },
		});
		const maskShape: Path = {
			...makeClosedPath("mask-shape"),
			transform: { x: 60, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		};
		const layer = makeLayer("layer-1", ["owner"]);
		const idx = new SpatialIndex(
			makeStore([layer], { owner, "mask-shape": maskShape }),
		);
		idx.rebuildAllIndices();

		// A mask changes how an element looks, not what it is. Selecting it by
		// what happens to be painted would make a heavily masked element
		// practically unreachable.
		expect(idx.findElementAtPoint("layer-1", 60, 0)).toBe(owner);
		expect(idx.findElementAtPoint("layer-1", -60, 0)).toBe(owner);
	});
});

describe("mesh warp container hit testing", () => {
	function makeMesh(
		id: string,
		childIds: string[],
		draggedCorner: { x: number; y: number },
	): MeshArtObject {
		return {
			type: "mesh",
			id,
			childIds,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			vertices: [
				{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
				{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
				{ ...draggedCorner, src: { x: 100, y: 100 }, handles: {} },
				{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
			],
			faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
		};
	}

	it("should hit at the warped position when the cage is stretched", () => {
		const child = makeImage("child-1", 50, 50, 100, 100);
		const mesh = makeMesh("mesh-1", ["child-1"], { x: 200, y: 200 });
		const layer = makeLayer("layer-1", ["mesh-1"]);
		const idx = new SpatialIndex(
			makeStore([layer], { "mesh-1": mesh, "child-1": child }),
		);
		idx.rebuildAllIndices();

		// Inside the stretched region (outside the undeformed 0..100 square).
		expect(idx.findElementAtPoint("layer-1", 140, 140)).toBe(mesh);
		// Outside the deformed cage silhouette.
		expect(idx.findElementAtPoint("layer-1", 150, 80)).toBeNull();
	});

	it("should miss at the undeformed position when the cage is shrunk", () => {
		const child = makeImage("child-1", 50, 50, 100, 100);
		const mesh = makeMesh("mesh-1", ["child-1"], { x: 50, y: 50 });
		const layer = makeLayer("layer-1", ["mesh-1"]);
		const idx = new SpatialIndex(
			makeStore([layer], { "mesh-1": mesh, "child-1": child }),
		);
		idx.rebuildAllIndices();

		// The child originally covered (80, 80), but the warped result no
		// longer does.
		expect(idx.findElementAtPoint("layer-1", 80, 80)).toBeNull();
		expect(idx.findElementAtPoint("layer-1", 20, 20)).toBe(mesh);
	});
});

import { describe, expect, it, vi } from "vitest";
import type {
	AnyArtObject,
	BezierPoint,
	CubicBezierSegment,
	ElementTransform,
} from "../../../schema";
import type { StructuredView } from "../../../utils/wgpu-utils";
import type { ChangedElements } from "../../types";
import { ElementHierarchyCache } from "./ElementHierarchyCache";
import { ViewportManager } from "./ViewportManager";

const STRIDE_VALUES = 12;
const STRIDE_BYTES = STRIDE_VALUES * 4;

describe("ViewportManager transforms buffer", () => {
	describe("stable slot assignment", () => {
		it("should keep surviving elements' slots when another element is deleted", () => {
			const { vm } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("b"), path("c")));
			const slotA = vm.getTransformIndex("a");
			const slotC = vm.getTransformIndex("c");

			vm.markTransformsDirty();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("c")));

			expect(vm.getTransformIndex("a")).toBe(slotA);
			expect(vm.getTransformIndex("c")).toBe(slotC);
		});

		it("should reuse a freed slot for a newly added element", () => {
			const { vm } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("b"), path("c")));
			const freed = vm.getTransformIndex("b");

			vm.markTransformsDirty();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("c")));
			vm.markTransformsDirty();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("c"), path("d")));

			expect(vm.getTransformIndex("d")).toBe(freed);
		});
	});

	describe("partial updates", () => {
		it("should write only the changed element's slot range", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("b")));
			writes.length = 0;

			vm.markElementTransformsDirty(changed(["a"]), false);
			vm.updateTransformsBuffer(
				elementsMap(path("a", { x: 30, y: -10 }), path("b")),
			);

			expect(writes).toHaveLength(1);
			const slot = vm.getTransformIndex("a");
			expect(writes[0].offset).toBe(slot * STRIDE_BYTES);
			expect(writes[0].size).toBe(STRIDE_BYTES);
			expect(writes[0].data[0]).toBe(30);
			expect(writes[0].data[1]).toBe(-10);
		});

		it("should upload nothing when the tracked change set is empty", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a")));
			writes.length = 0;

			vm.markElementTransformsDirty(changed([]), false);
			vm.updateTransformsBuffer(elementsMap(path("a")));

			expect(writes).toHaveLength(0);
		});

		it("should recompose descendants when their group moves", () => {
			const { vm, writes } = createManager();
			const build = () =>
				elementsMap(group("g", ["a"], { x: 100 }), path("a", { x: 5 }));
			vm.updateTransformsBuffer(build());
			writes.length = 0;

			vm.markElementTransformsDirty(changed(["g"]), false);
			vm.updateTransformsBuffer(
				elementsMap(group("g", ["a"], { x: 200 }), path("a", { x: 5 })),
			);

			expect(writes).toHaveLength(1);
			const write = writes[0];
			const slotA = vm.getTransformIndex("a");
			const composedX = write.data[slotA * STRIDE_VALUES - write.offset / 4];
			expect(composedX).toBe(205);
		});

		it("should leave an ancestor group's placement alone when a child moves", () => {
			const { vm, writes } = createManager();
			// g's local bounds = union of its children: a at 0..40, b at 100..140.
			const b = path("b", { x: 100 });
			vm.updateTransformsBuffer(
				elementsMap(group("g", ["a", "b"]), path("a"), b),
			);
			writes.length = 0;

			// Move a to -60: g's union becomes -60..140, yet g's entry stays the
			// identity it was written as.
			vm.markElementTransformsDirty(changed(["a"]), false);
			vm.updateTransformsBuffer(
				elementsMap(group("g", ["a", "b"]), path("a", { x: -60 }), b),
			);

			expect(writes).toHaveLength(1);
			const write = writes[0];
			const slotG =
				vm.getTransformIndex("g") * STRIDE_VALUES - write.offset / 4;
			expect(write.data[slotG]).toBe(0);
			expect(write.data[slotG + 2]).toBe(1);
		});

		it("should fall back to a full rebuild when a blend references a changed element", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a"), blend("bl", ["a"])));
			writes.length = 0;

			vm.markElementTransformsDirty(changed(["a"]), false);
			vm.updateTransformsBuffer(
				elementsMap(path("a", { x: 30 }), blend("bl", ["a"])),
			);

			expect(writes).toHaveLength(1);
			expect(writes[0].offset).toBe(0);
			expect(writes[0].size).toBeGreaterThan(STRIDE_BYTES);
		});

		it("should fall back to a full rebuild when new elements exceed the capacity", () => {
			const { vm, writes, buffers } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a")));
			const initialBuffers = buffers.length;
			writes.length = 0;

			vm.markElementTransformsDirty(changed(["b", "c", "d", "e"]), false);
			vm.updateTransformsBuffer(
				elementsMap(path("a"), path("b"), path("c"), path("d"), path("e")),
			);

			expect(writes[0].offset).toBe(0);
			expect(buffers.length).toBeGreaterThan(initialBuffers);
			expect(vm.getTransformIndex("e")).toBeGreaterThan(0);
		});

		it("should free a deleted element's slot and reuse it on the partial path", () => {
			const { vm } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a"), path("b")));
			const freed = vm.getTransformIndex("b");

			vm.markElementTransformsDirty(changed([], ["b"]), false);
			vm.updateTransformsBuffer(elementsMap(path("a")));
			expect(vm.getTransformIndex("b")).toBe(0);

			vm.markElementTransformsDirty(changed(["c"]), false);
			vm.updateTransformsBuffer(elementsMap(path("a"), path("c")));
			expect(vm.getTransformIndex("c")).toBe(freed);
		});
	});

	describe("local bounds after a move", () => {
		it("should keep a moved group's and its children's local bounds but recompute its parent's", () => {
			const { vm, hierarchy } = createManager();
			const child = path("a");
			vm.updateTransformsBuffer(
				elementsMap(group("outer", ["g"]), group("g", ["a"]), child),
			);
			const groupBounds = hierarchy.localBounds.get("g");
			const childBounds = hierarchy.localBounds.get("a");

			vm.markElementTransformsDirty(changed(["g"]), true);
			vm.updateTransformsBuffer(
				elementsMap(
					group("outer", ["g"]),
					group("g", ["a"], { x: 100 }),
					child,
				),
			);

			expect(hierarchy.localBounds.get("g")).toBe(groupBounds);
			expect(hierarchy.localBounds.get("a")).toBe(childBounds);
			expect(hierarchy.localBounds.get("outer")?.minX).toBe(100);
		});

		it("should recompute a group's local bounds when a duplicate joins it", () => {
			const { vm, hierarchy } = createManager();
			vm.updateTransformsBuffer(elementsMap(group("g", ["a"]), path("a")));

			vm.markElementTransformsDirty(changed(["g", "copy"]), true);
			vm.updateTransformsBuffer(
				elementsMap(
					group("g", ["a", "copy"]),
					path("a"),
					path("copy", { x: 100 }),
				),
			);

			expect(hierarchy.localBounds.get("g")?.maxX).toBe(140);
		});

		it("should recompute a changed element's local bounds when the change may reshape it", () => {
			const { vm, hierarchy } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a")));

			vm.markElementTransformsDirty(changed(["a"]), false);
			vm.updateTransformsBuffer(elementsMap(path("a", {}, 80)));

			expect(hierarchy.localBounds.get("a")?.maxX).toBe(80);
		});
	});

	describe("mesh container parenting", () => {
		it("should compose a mesh container's children under the container", () => {
			const { vm, hierarchy } = createManager();

			vm.updateTransformsBuffer(
				elementsMap(mesh("cage", ["c"], { y: -100 }), path("c", { y: 20 })),
			);

			// The child's stored geometry is laid out in the cage's own space, so
			// wherever the container goes it goes too.
			expect(hierarchy.parentMap.get("c")).toBe("cage");
			expect(vm.getComposedTransformCache().get("c")?.y).toBe(-80);
		});
	});

	describe("object mask parenting", () => {
		it("should compose mask content under the element it masks", () => {
			const { vm, hierarchy } = createManager();

			vm.updateTransformsBuffer(
				elementsMap(
					maskedPath("owner", ["m"], { x: 100 }),
					path("m", { x: 5 }),
				),
			);

			expect(hierarchy.parentMap.get("m")).toBe("owner");
			expect(vm.getComposedTransformCache().get("m")?.x).toBe(105);
		});

		it("should recompose mask content when its owner moves", () => {
			const { vm } = createManager();
			vm.updateTransformsBuffer(
				elementsMap(
					maskedPath("owner", ["m"], { x: 100 }),
					path("m", { x: 5 }),
				),
			);

			vm.markElementTransformsDirty(changed(["owner"]), false);
			vm.updateTransformsBuffer(
				elementsMap(
					maskedPath("owner", ["m"], { x: 200 }),
					path("m", { x: 5 }),
				),
			);

			expect(vm.getComposedTransformCache().get("m")?.x).toBe(205);
		});

		it("should drop the mask edge when the mask content is deleted", () => {
			const { vm, hierarchy } = createManager();
			vm.updateTransformsBuffer(
				elementsMap(
					maskedPath("owner", ["m"], { x: 100 }),
					path("m", { x: 5 }),
				),
			);

			vm.markElementTransformsDirty(changed(["owner"], ["m"]), false);
			vm.updateTransformsBuffer(elementsMap(path("owner", { x: 100 })));

			expect(hierarchy.parentMap.has("m")).toBe(false);
		});

		it("should report the object mask when the parent edges were derived before the rebuild", () => {
			const { vm, hierarchy } = createManager();
			const elements = elementsMap(maskedPath("owner", ["m"]), path("m"));

			hierarchy.ensureParents(elements);
			vm.updateTransformsBuffer(elements);

			expect(vm.hasObjectMasks).toBe(true);
		});
	});

	describe("mask info writes", () => {
		it("should upload only the masked element's slot", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(
				elementsMap(path("a"), path("b", { x: 30 }), path("c")),
			);
			writes.length = 0;

			vm.writeMaskInfoOnly(
				new Map([
					[
						"b",
						{
							layerIndex: 3,
							bounds: {
								minX: 1,
								minY: 2,
								maxX: 3,
								maxY: 4,
								width: 2,
								height: 2,
							},
						},
					],
				]),
			);

			expect(writes).toHaveLength(1);
			expect(writes[0].offset).toBe(vm.getTransformIndex("b") * STRIDE_BYTES);
			expect(writes[0].size).toBe(STRIDE_BYTES);
			expect(writes[0].data[0]).toBe(30);
			expect([...writes[0].data.slice(8, 12)]).toEqual([1, 2, 3, 4]);
		});

		it("should upload nothing when no masked element owns a slot", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("a")));
			writes.length = 0;

			vm.writeMaskInfoOnly(
				new Map([
					[
						"missing",
						{
							layerIndex: 0,
							bounds: {
								minX: 0,
								minY: 0,
								maxX: 1,
								maxY: 1,
								width: 1,
								height: 1,
							},
						},
					],
				]),
			);

			expect(writes).toHaveLength(0);
		});

		it("should upload a reserved auxiliary slot with its container's transform", () => {
			const { vm, writes } = createManager();
			vm.updateTransformsBuffer(
				elementsMap(path("a"), path("container", { x: 50, y: -20 })),
			);
			writes.length = 0;

			vm.reserveAuxiliaryMaskSlots([{ id: "aux", inheritFromId: "container" }]);

			expect(writes).toHaveLength(1);
			expect(writes[0].offset).toBe(vm.getTransformIndex("aux") * STRIDE_BYTES);
			expect(writes[0].size).toBe(STRIDE_BYTES);
			expect(writes[0].data[0]).toBe(50);
			expect(writes[0].data[1]).toBe(-20);
		});

		it("should not upload an auxiliary slot past the end of the GPU buffer", () => {
			const { vm, writes, buffers } = createManager();
			vm.updateTransformsBuffer(elementsMap(path("container")));
			writes.length = 0;

			vm.reserveAuxiliaryMaskSlots([
				{ id: "aux1", inheritFromId: "container" },
				{ id: "aux2", inheritFromId: "container" },
			]);

			expect(writes).toHaveLength(1);
			expect(writes[0].offset + writes[0].size).toBe(buffers[0].size);
			expect(writes[0].size).toBe(STRIDE_BYTES);
		});
	});
});

// Helpers

function changed(upserted: string[], deleted: string[] = []): ChangedElements {
	return { upserted: new Set(upserted), deleted: new Set(deleted) };
}

function elementsMap(...elements: AnyArtObject[]): Map<string, AnyArtObject> {
	return new Map(elements.map((el) => [el.id, el]));
}

function path(
	id: string,
	transform?: Partial<ElementTransform>,
	size = 40,
): AnyArtObject {
	const points: BezierPoint[] = [
		{ x: 0, y: 0 },
		{ x: size, y: 0 },
		{ x: size, y: size },
		{ x: 0, y: size },
	];
	return {
		id,
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...transform },
		segments: points.map((p, i) =>
			lineSeg(p, points[(i + 1) % points.length], i === 0),
		),
	} as unknown as AnyArtObject;
}

function maskedPath(
	id: string,
	maskElementIds: string[],
	transform?: Partial<ElementTransform>,
): AnyArtObject {
	return {
		...path(id, transform),
		mask: { elementIds: maskElementIds },
	} as AnyArtObject;
}

function group(
	id: string,
	childIds: string[],
	transform?: Partial<ElementTransform>,
): AnyArtObject {
	return {
		id,
		type: "group",
		childIds,
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...transform },
	} as unknown as AnyArtObject;
}

function mesh(
	id: string,
	childIds: string[],
	transform?: Partial<ElementTransform>,
): AnyArtObject {
	return {
		id,
		type: "mesh",
		childIds,
		vertices: [],
		faces: [],
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, ...transform },
	} as unknown as AnyArtObject;
}

function blend(id: string, objectIds: string[]): AnyArtObject {
	return {
		id,
		type: "blend",
		objectIds,
		steps: 1,
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	} as unknown as AnyArtObject;
}

function lineSeg(
	start: BezierPoint,
	end: BezierPoint,
	isMoved: boolean,
): CubicBezierSegment {
	return {
		start,
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end,
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved,
	};
}

function createManager() {
	const writes: Array<{ offset: number; size: number; data: Float32Array }> =
		[];
	const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> =
		[];
	const device = {
		createBuffer: vi.fn((desc: { size: number }) => {
			const buffer = { size: desc.size, destroy: vi.fn() };
			buffers.push(buffer);
			return buffer;
		}),
		createBindGroup: vi.fn(() => ({})),
		queue: {
			writeBuffer: vi.fn(
				(
					_buffer: unknown,
					offset: number,
					data: ArrayBuffer,
					dataOffset?: number,
					size?: number,
				) => {
					const byteOffset = dataOffset ?? 0;
					const byteLength = size ?? data.byteLength - byteOffset;
					writes.push({
						offset,
						size: byteLength,
						data: new Float32Array(
							data.slice(byteOffset, byteOffset + byteLength),
						),
					});
				},
			),
		},
	} as unknown as GPUDevice;

	const hierarchy = new ElementHierarchyCache();
	const vm = new ViewportManager(
		device,
		{} as GPUBuffer,
		{
			set: () => {},
			arrayBuffer: new ArrayBuffer(0),
		} as unknown as StructuredView,
		{} as GPUBindGroupLayout,
		hierarchy,
	);
	return { vm, hierarchy, writes, buffers };
}

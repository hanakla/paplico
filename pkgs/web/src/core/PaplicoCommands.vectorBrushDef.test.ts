import { describe, expect, it, vi } from "vitest";
import type { YjsProvider } from "./collaboration/YjsProvider";
import { createIdentityTransform } from "./document/factory";
import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoCommands } from "./PaplicoCommands";
import type { AnyArtObject, DefEntry, Layer, Path } from "./schema";

describe("PaplicoCommands.createVectorBrushDefFromSelection", () => {
	it("returns null when nothing is selected", () => {
		const { commands } = setup([], []);
		expect(commands.createVectorBrushDefFromSelection("brush")).toBeNull();
	});

	it("clones selected elements with fresh ids and creates a vector-brush def without a tile", () => {
		// Two paths placed in world space at distinct positions so the
		// selection bbox has a clear center the def-local clones must
		// translate to.
		const a = createPath("a", 0, 0, 100, 100);
		const b = createPath("b", 200, 50, 300, 200);
		const layer = createLayer("L", [a.id, b.id]);
		const objects: Record<string, AnyArtObject> = { [a.id]: a, [b.id]: b };

		const { commands, addObjectOnly, createDef } = setup(
			[layer],
			[a.id, b.id],
			objects,
		);

		const defId = commands.createVectorBrushDefFromSelection("my-brush");
		expect(defId).toBeTypeOf("string");
		expect(defId).not.toEqual(a.id);
		expect(defId).not.toEqual(b.id);

		// Two cloned elements were added to objects (without a layer ref).
		expect(addObjectOnly).toHaveBeenCalledTimes(2);
		const clonedIds = addObjectOnly.mock.calls.map(
			(c) => (c[0] as AnyArtObject).id,
		);
		expect(clonedIds).not.toContain(a.id);
		expect(clonedIds).not.toContain(b.id);

		// The def was created with the clone ids, kind "vector-brush", and no
		// tile rectangle (tile is a pattern-only concept).
		expect(createDef).toHaveBeenCalledTimes(1);
		const entry = createDef.mock.calls[0][0] as DefEntry;
		expect(entry.kind).toBe("vector-brush");
		expect(entry.name).toBe("my-brush");
		expect(entry.rootElementIds).toHaveLength(2);
		expect(entry.rootElementIds).toEqual(expect.arrayContaining(clonedIds));
		expect(entry.tile).toBeUndefined();
	});
});

function setup(
	layers: Layer[],
	selectedIds: string[],
	objects: Record<string, AnyArtObject> = {},
) {
	const addObjectOnly = vi.fn();
	const createDef = vi.fn();

	const store = {
		currentLayerId: layers[0]?.id ?? null,
		selectedElementIds: [...selectedIds],
		editingScopeStack: [],
		document: { layers, objects },
	} as unknown as RendererState;

	const commands = new PaplicoCommands({
		store,
		yjsProvider: {
			addObjectOnly,
			createDef,
			transact: vi.fn((fn: () => void) => fn()),
			isAnimationUndoMode: vi.fn(() => false),
		} as unknown as YjsProvider,
		spatial: {
			insertElement: vi.fn(),
			isElementLocked: () => false,
		} as unknown as SpatialIndex,
		isReadonly: () => false,
	});

	return { commands, addObjectOnly, createDef };
}

function createPath(
	id: string,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
): Path {
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x: x0, y: y0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x1, y: y1 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	} as Path;
}

function createLayer(id: string, elementIds: string[]): Layer {
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

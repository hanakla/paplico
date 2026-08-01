import { describe, expect, it, vi } from "vitest";
import type { YjsProvider } from "./collaboration/YjsProvider";
import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoCommands } from "./PaplicoCommands";
import type { AnyArtObject, Layer } from "./schema";
import { isEffectivelyLocked } from "./utils/elementQuery";

describe("Lock system integration", () => {
	describe("updateElement", () => {
		it("should not call yjsProvider when element is locked", () => {
			const path = makePath("e1", true);
			const layer = makeLayer({ id: "l1", elementIds: ["e1"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).not.toHaveBeenCalled();
		});

		it("should call yjsProvider when element is unlocked", () => {
			const path = makePath("e1");
			const layer = makeLayer({ id: "l1", elementIds: ["e1"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).toHaveBeenCalledTimes(1);
		});
	});

	describe("deleteElements", () => {
		it("should skip locked elements from the delete list", () => {
			const locked = makePath("e1", true);
			const unlocked = makePath("e2");
			const layer = makeLayer({ id: "l1", elementIds: ["e1", "e2"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1: locked,
				e2: unlocked,
			});

			commands.deleteElements(["e1", "e2"]);
			// Only the unlocked element should be passed to deleteElements
			expect(yjsProvider.deleteElements).toHaveBeenCalledTimes(1);
			const byLayer = yjsProvider.deleteElements.mock.calls[0][0] as Record<
				string,
				string[]
			>;
			expect(byLayer.l1).toEqual(["e2"]);
		});

		it("should delete nothing when all elements are locked", () => {
			const e1 = makePath("e1", true);
			const e2 = makePath("e2", true);
			const layer = makeLayer({ id: "l1", elementIds: ["e1", "e2"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1,
				e2,
			});

			commands.deleteElements(["e1", "e2"]);
			expect(yjsProvider.deleteElements).not.toHaveBeenCalled();
		});
	});

	describe("toggleElementLock", () => {
		it("should toggle lock on a locked element (unlock)", () => {
			const path = makePath("e1", true);
			const layer = makeLayer({ id: "l1", elementIds: ["e1"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.toggleElementLock("l1", "e1");
			expect(yjsProvider.updateElement).toHaveBeenCalledTimes(1);
			expect(yjsProvider.updateElement).toHaveBeenCalledWith(
				"l1",
				"e1",
				{ locked: false },
				undefined,
			);
		});

		it("should toggle lock on an unlocked element (lock)", () => {
			const path = makePath("e1");
			const layer = makeLayer({ id: "l1", elementIds: ["e1"] });
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.toggleElementLock("l1", "e1");
			expect(yjsProvider.updateElement).toHaveBeenCalledTimes(1);
			expect(yjsProvider.updateElement).toHaveBeenCalledWith(
				"l1",
				"e1",
				{ locked: true },
				undefined,
			);
		});
	});

	describe("toggleLayerLock", () => {
		it("should toggle lock on a locked layer (unlock)", () => {
			const layer = makeLayer({
				id: "l1",
				locked: true,
				elementIds: [],
			});
			const { commands, yjsProvider } = createCommands(layer, {});

			commands.toggleLayerLock("l1");
			expect(yjsProvider.updateLayerAttributes).toHaveBeenCalledWith("l1", {
				locked: false,
			});
		});

		it("should toggle lock on an unlocked layer (lock)", () => {
			const layer = makeLayer({ id: "l1", elementIds: [] });
			const { commands, yjsProvider } = createCommands(layer, {});

			commands.toggleLayerLock("l1");
			expect(yjsProvider.updateLayerAttributes).toHaveBeenCalledWith("l1", {
				locked: true,
			});
		});
	});

	describe("group lock propagation", () => {
		it("should block updateElement on child when parent group is locked", () => {
			const group = makeGroup("g1", true);
			const child = makePath("e1");
			const layer = makeLayer({ id: "l1", elementIds: ["g1"] });
			const parentGroupMap = new Map([["e1", "g1"]]);
			const { commands, yjsProvider } = createCommands(
				layer,
				{ g1: group, e1: child },
				{ parentGroupMap },
			);

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).not.toHaveBeenCalled();
		});

		it("should block updateElement on grandchild when grandparent group is locked", () => {
			const grandparent = makeGroup("g1", true);
			const parent = makeGroup("g2");
			const child = makePath("e1");
			const layer = makeLayer({ id: "l1", elementIds: ["g1"] });
			const parentGroupMap = new Map([
				["e1", "g2"],
				["g2", "g1"],
			]);
			const { commands, yjsProvider } = createCommands(
				layer,
				{ g1: grandparent, g2: parent, e1: child },
				{ parentGroupMap },
			);

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).not.toHaveBeenCalled();
		});

		it("should allow updateElement on child when parent group is unlocked", () => {
			const group = makeGroup("g1");
			const child = makePath("e1");
			const layer = makeLayer({ id: "l1", elementIds: ["g1"] });
			const parentGroupMap = new Map([["e1", "g1"]]);
			const { commands, yjsProvider } = createCommands(
				layer,
				{ g1: group, e1: child },
				{ parentGroupMap },
			);

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).toHaveBeenCalledTimes(1);
		});
	});

	describe("layer lock blocks element mutations", () => {
		it("should block updateElement when element's layer is locked", () => {
			const path = makePath("e1");
			const layer = makeLayer({
				id: "l1",
				locked: true,
				elementIds: ["e1"],
			});
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.updateElement("l1", "e1", { opacity: 0.5 });
			expect(yjsProvider.updateElement).not.toHaveBeenCalled();
		});

		it("should block deleteElements when element's layer is locked", () => {
			const path = makePath("e1");
			const layer = makeLayer({
				id: "l1",
				locked: true,
				elementIds: ["e1"],
			});
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.deleteElements(["e1"]);
			expect(yjsProvider.deleteElements).not.toHaveBeenCalled();
		});

		it("should allow toggleElementLock even when layer is locked", () => {
			const path = makePath("e1");
			const layer = makeLayer({
				id: "l1",
				locked: true,
				elementIds: ["e1"],
			});
			const { commands, yjsProvider } = createCommands(layer, {
				e1: path,
			});

			commands.toggleElementLock("l1", "e1");
			// toggleElementLock only checks cannotMutate, not isElementLocked
			expect(yjsProvider.updateElement).toHaveBeenCalledTimes(1);
		});
	});
});

// --- Test Helpers ---

function makeLayer(
	overrides: Partial<Layer> & Pick<Layer, "id" | "elementIds">,
): Layer {
	return {
		name: overrides.id,
		visible: true,
		locked: false,
		opacity: 1,
		blendMode: "normal",
		...overrides,
	};
}

function makePath(id: string, locked?: boolean): AnyArtObject {
	return {
		type: "path",
		id,
		locked,
		opacity: 1,
		visible: true,
		blendMode: "normal",
		rotation: 0,
		segments: [],
		filters: [],
	} as unknown as AnyArtObject;
}

function makeGroup(id: string, locked?: boolean): AnyArtObject {
	return {
		type: "group",
		id,
		locked,
		opacity: 1,
		visible: true,
		blendMode: "normal",
		rotation: 0,
		childIds: [],
		filters: [],
	} as unknown as AnyArtObject;
}

function createCommands(
	layer: Layer,
	objects: Record<string, AnyArtObject>,
	options?: {
		parentGroupMap?: Map<string, string>;
		currentLayerId?: string;
		editingScopeStack?: string[];
	},
) {
	const yjsProvider = {
		updateElement: vi.fn(),
		deleteElement: vi.fn(),
		deleteElements: vi.fn(),
		updateLayerAttributes: vi.fn(),
		isAnimationUndoMode: vi.fn(() => false),
	};

	const parentGroupMap = options?.parentGroupMap ?? new Map<string, string>();

	const store = {
		currentLayerId: options?.currentLayerId ?? layer.id,
		selectedElementIds: [],
		editingScopeStack: options?.editingScopeStack ?? [],
		animationMode: false,
		document: {
			layers: [layer],
			objects,
		},
	} as unknown as RendererState;

	const spatialIndex = {
		insertElement: vi.fn(),
		removeElement: vi.fn(),
		getBounds: vi.fn(() => null),
		getParentGroupId: vi.fn(() => null),
		isElementLocked: (elementId: string) =>
			isEffectivelyLocked(
				elementId,
				store.document.objects,
				store.document.layers,
				parentGroupMap,
			),
		parentGroupMap,
	};

	const commands = new PaplicoCommands({
		store,
		yjsProvider: yjsProvider as unknown as YjsProvider,
		spatial: spatialIndex as unknown as SpatialIndex,
		isReadonly: () => false,
	});

	return { commands, store, yjsProvider, spatialIndex };
}

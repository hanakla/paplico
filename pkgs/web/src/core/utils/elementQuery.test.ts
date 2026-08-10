import { describe, expect, it } from "vitest";
import type { AnyArtObject, Filter, Layer } from "../schema";
import {
	findLayerForElement,
	getStrokeWidth,
	isEffectivelyLocked,
} from "./elementQuery";

describe("isEffectivelyLocked", () => {
	it("should return true when element itself is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			e1: makePath("e1", true),
		};
		const layers = [makeLayer({ id: "l1", elementIds: ["e1"] })];
		const parentGroupMap = new Map<string, string>();

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			true,
		);
	});

	it("should return true when parent group is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			g1: makeGroup("g1", true),
			e1: makePath("e1"),
		};
		const layers = [makeLayer({ id: "l1", elementIds: ["g1"] })];
		const parentGroupMap = new Map([["e1", "g1"]]);

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			true,
		);
	});

	it("should return true when containing layer is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			e1: makePath("e1"),
		};
		const layers = [makeLayer({ id: "l1", locked: true, elementIds: ["e1"] })];
		const parentGroupMap = new Map<string, string>();

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			true,
		);
	});

	it("should return true when grandparent group is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			g1: makeGroup("g1", true),
			g2: makeGroup("g2"),
			e1: makePath("e1"),
		};
		const layers = [makeLayer({ id: "l1", elementIds: ["g1"] })];
		const parentGroupMap = new Map([
			["e1", "g2"],
			["g2", "g1"],
		]);

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			true,
		);
	});

	it("should return false when nothing is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			g1: makeGroup("g1"),
			e1: makePath("e1"),
		};
		const layers = [makeLayer({ id: "l1", elementIds: ["g1"] })];
		const parentGroupMap = new Map([["e1", "g1"]]);

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			false,
		);
	});

	it("should return true when CompoundPath parent is locked", () => {
		const objects: Record<string, AnyArtObject> = {
			cp1: makeCompoundPath("cp1", true),
			e1: makePath("e1"),
		};
		const layers = [makeLayer({ id: "l1", elementIds: ["cp1"] })];
		const parentGroupMap = new Map([["e1", "cp1"]]);

		expect(isEffectivelyLocked("e1", objects, layers, parentGroupMap)).toBe(
			true,
		);
	});

	it("should return false for element not found in objects", () => {
		const objects: Record<string, AnyArtObject> = {};
		const layers = [makeLayer({ id: "l1", elementIds: ["e1"] })];
		const parentGroupMap = new Map<string, string>();

		expect(
			isEffectivelyLocked("unknown", objects, layers, parentGroupMap),
		).toBe(false);
	});
});

describe("findLayerForElement", () => {
	it("should find layer for direct element", () => {
		const layers = [
			makeLayer({ id: "l1", elementIds: ["e1", "e2"] }),
			makeLayer({ id: "l2", elementIds: ["e3"] }),
		];
		const parentGroupMap = new Map<string, string>();

		expect(findLayerForElement("e2", layers, parentGroupMap)?.id).toBe("l1");
		expect(findLayerForElement("e3", layers, parentGroupMap)?.id).toBe("l2");
	});

	it("should find layer for nested element via parentGroupMap", () => {
		const layers = [makeLayer({ id: "l1", elementIds: ["g1"] })];
		const parentGroupMap = new Map([
			["e1", "g2"],
			["g2", "g1"],
		]);

		expect(findLayerForElement("e1", layers, parentGroupMap)?.id).toBe("l1");
	});

	it("should return null for unknown element", () => {
		const layers = [makeLayer({ id: "l1", elementIds: ["e1"] })];
		const parentGroupMap = new Map<string, string>();

		expect(findLayerForElement("unknown", layers, parentGroupMap)).toBeNull();
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

function makeCompoundPath(id: string, locked?: boolean): AnyArtObject {
	return {
		type: "compoundPath",
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

describe("getStrokeWidth", () => {
	function strokeFilter(brushSettings: unknown): Filter {
		return {
			uid: "app-1",
			processor: "stroke",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: { strokeColor: null, brushSettings },
			},
		} as unknown as Filter;
	}

	it("should read the size base from stored v2 settings", () => {
		expect(
			getStrokeWidth([
				strokeFilter({
					version: 2,
					engine: "dab",
					strokeOpacity: 1,
					paintMode: "buildup",
					properties: { size: { base: 24 } },
					randomSeed: 0,
				}),
			]),
		).toBe(24);
	});
});

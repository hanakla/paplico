import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import type { AnyArtObject, CompoundPath, Path } from "../../../schema";
import {
	mockCompoundPath,
	mockDocument,
	mockLayer,
} from "../../../testUtils/mockElements";
import { rectPath, solidFillAppearance } from "../../../testUtils/svgFixtures";

vi.mock("./pathOps", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./pathOps")>();
	return {
		...actual,
		computeBooleanOperation: vi.fn(actual.computeBooleanOperation),
	};
});

// The test setup imports the renderer before the mock above exists, so the
// modules under test are imported afresh to see the spied boolean op.
let booleanOp: Mock;
let calculateElementBounds: typeof import("../elementBounds").calculateElementBounds;
let buildFramePlanStructure: typeof import("../../../renderer/canvas/pipeline/RenderPlanner").buildFramePlanStructure;
let SpatialIndex: typeof import("../../../document/SpatialIndex").SpatialIndex;
let CompoundPathCache: typeof import("../../../document/elementGeometry/CompoundPathCache").CompoundPathCache;

beforeAll(async () => {
	vi.resetModules();
	booleanOp = vi.mocked((await import("./pathOps")).computeBooleanOperation);
	({ calculateElementBounds } = await import("../elementBounds"));
	({ buildFramePlanStructure } = await import(
		"../../../renderer/canvas/pipeline/RenderPlanner"
	));
	({ SpatialIndex } = await import("../../../document/SpatialIndex"));
	({ CompoundPathCache } = await import(
		"../../../document/elementGeometry/CompoundPathCache"
	));
});

describe("bakeCompoundPathSegments", () => {
	beforeEach(() => {
		booleanOp.mockClear();
	});

	it("should give a moved compound path fresh bounds without combining its sources again", () => {
		const compound = mockCompoundPath("moved-compound", ["a", "b"]);
		const elements = elementsOf(square("a", 0), square("b", 30), compound);
		calculateElementBounds(compound, elements);
		booleanOp.mockClear();

		const moved: CompoundPath = {
			...compound,
			transform: { ...compound.transform, x: 100, y: 50 },
		};
		const movedBounds = calculateElementBounds(moved, elements);

		expect(booleanOp).not.toHaveBeenCalled();
		const fresh = calculateElementBounds(
			{ ...moved, id: "fresh-compound" },
			elements,
		);
		expect(booleanOp).toHaveBeenCalledTimes(1);
		expect(movedBounds).toEqual(fresh);
	});

	it("should combine the sources once for the bounds, the frame plan, the spatial index and the renderer", () => {
		const compound = mockCompoundPath("shared-compound", ["a", "b"]);
		const document = mockDocument(
			[square("a", 0), square("b", 30), compound],
			[mockLayer("layer", [compound.id])],
		);
		const elements = elementsOf(...Object.values(document.objects));

		calculateElementBounds(compound, elements);
		buildFramePlanStructure(document, new Map(), false, new Map());
		const spatialIndex = new SpatialIndex({
			document,
			editingScopeStack: [],
		});
		spatialIndex.rebuildAllIndices();
		spatialIndex.getWorldGeometryBounds(compound.id);
		new CompoundPathCache().resolveDrawn(
			compound,
			(id) => document.objects[id],
			{ getHandler: () => undefined },
		);

		expect(booleanOp).toHaveBeenCalledTimes(1);
	});

	it("should combine the sources again when a source's segments change", () => {
		const compound = mockCompoundPath("reshaped-compound", ["a", "b"]);
		const before = calculateElementBounds(
			compound,
			elementsOf(square("a", 0), square("b", 30), compound),
		);
		booleanOp.mockClear();

		const after = calculateElementBounds(
			compound,
			elementsOf(square("a", -40), square("b", 30), compound),
		);

		expect(booleanOp).toHaveBeenCalledTimes(1);
		expect(after.minX).toBeLessThan(before.minX);
	});

	it("should leave a source out of the bounds once it is hidden", () => {
		const compound = mockCompoundPath("hidden-source-compound", ["a", "b"]);
		const before = calculateElementBounds(
			compound,
			elementsOf(square("a", 0), square("b", 30), compound),
		);

		const after = calculateElementBounds(
			compound,
			elementsOf(
				square("a", 0),
				{ ...square("b", 30), visible: false },
				compound,
			),
		);

		expect(after.maxX).toBeLessThan(before.maxX);
	});
});

// Helpers

function square(id: string, centerX: number): Path {
	return rectPath(id, { x: centerX, y: 0 }, 40, 40, [
		solidFillAppearance(0, 0, 0),
	]);
}

function elementsOf(...elements: AnyArtObject[]): Map<string, AnyArtObject> {
	return new Map(elements.map((element) => [element.id, element]));
}

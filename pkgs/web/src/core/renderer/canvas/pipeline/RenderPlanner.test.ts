import { describe, expect, it } from "vitest";
import type {
	BezierPoint,
	BlendMode,
	CubicBezierSegment,
	Document,
	Filter,
	Path,
} from "../../../schema";
import { Extrude3DFilterHandler } from "../../filters/Extrude3DFilterHandler";
import type { FilterHandler } from "./FilterRenderer";
import {
	buildFramePlanStructure,
	buildFramePlanView,
	buildPassPlan,
} from "./RenderPlanner";

describe("RenderPlanner frame planning", () => {
	describe("extrude3d appearance routing", () => {
		it("should route an opaque extrude-only element to the post-filter fast path", () => {
			const element = pathWithExtrude("multiply");
			const plan = buildViewOf(makeDocument(element));

			const filterPlan = plan.filterPlans.get(element.id);
			expect(filterPlan).toBeDefined();
			expect(filterPlan!.postFilters.map((f) => f.processor)).toEqual([
				"extrude3d",
			]);
			// Opaque extrude self-sizes on the fast path, never per-appearance.
			expect(filterPlan!.allAppearancePlans).toBeUndefined();
		});

		it("should route an opaque extrude-only normal-blend element to the post-filter fast path", () => {
			const element = pathWithExtrude("normal");
			const plan = buildViewOf(makeDocument(element));

			const filterPlan = plan.filterPlans.get(element.id);
			expect(filterPlan).toBeDefined();
			expect(filterPlan!.postFilters.map((f) => f.processor)).toEqual([
				"extrude3d",
			]);
			expect(filterPlan!.allAppearancePlans).toBeUndefined();
		});

		it("should keep a glass extrude appearance off the post-filter path", () => {
			const element = pathWithExtrude("normal");
			makeGlass(element);
			const plan = buildViewOf(makeDocument(element));

			// Glass routes through the mid-pass refraction compositor, not a plan.
			expect(plan.filterPlans.has(element.id)).toBe(false);
		});
	});

	describe("flat appearance suppression under extrude3d", () => {
		it("should suppress fill and route only extrude to the post-filter path", () => {
			const element = pathWithExtrude("normal");
			element.filters = [fillAppearance("multiply"), ...element.filters!];
			const plan = buildViewOf(makeDocument(element));

			const filterPlan = plan.filterPlans.get(element.id);
			expect(filterPlan).toBeDefined();
			expect(filterPlan!.postFilters.map((f) => f.processor)).toEqual([
				"extrude3d",
			]);
			expect(filterPlan!.allAppearancePlans).toBeUndefined();
		});

		it("should exclude fill from routing while extrude3d is enabled", () => {
			const element = pathWithExtrude("multiply");
			element.filters = [fillAppearance("normal"), ...element.filters!];
			const plan = buildViewOf(makeDocument(element));

			const filterPlan = plan.filterPlans.get(element.id);
			expect(filterPlan!.postFilters.map((f) => f.processor)).toEqual([
				"extrude3d",
			]);
			expect(filterPlan!.allAppearancePlans).toBeUndefined();
		});

		it("should plan fill again when the extrude3d appearance is disabled", () => {
			const element = pathWithExtrude("normal");
			element.filters = [
				fillAppearance("multiply"),
				{ ...element.filters![0], enabled: false },
			];
			const plan = buildViewOf(makeDocument(element));

			const plans = plan.filterPlans.get(element.id)?.allAppearancePlans;
			expect(plans).toBeDefined();
			expect(plans!.map((p) => p.appearance.processor)).toEqual(["fill"]);
		});
	});

	describe("structure/view split", () => {
		it("should serve any viewport from one structure, culling per view", () => {
			const element = pathWithExtrude("normal");
			const structure = buildFramePlanStructure(
				makeDocument(element),
				makeFilterHandlers(),
				false,
			);

			// The element (bounds ≈ 0..40) is far outside a viewport centred at
			// world (100000, 100000): its candidate must be culled from the view.
			const offscreen = buildFramePlanView(
				structure,
				{ x: 100_000, y: 100_000, zoom: 1, rotation: 0 },
				800,
				600,
			);
			expect(offscreen.filterPlans.has(element.id)).toBe(false);
			expect(offscreen.layerPlans).toHaveLength(1);

			// The SAME structure serves the on-screen viewport with the plan intact.
			const onscreen = buildFramePlanView(
				structure,
				{ x: 0, y: 0, zoom: 1, rotation: 0 },
				800,
				600,
			);
			expect(onscreen.filterPlans.has(element.id)).toBe(true);
		});

		it("should keep a filter plan when only its expanded bounds intersect the viewport", () => {
			const element = plainPath();
			element.filters = [
				{
					uid: "shadow-1",
					processor: "test-shadow",
					enabled: true,
					opacity: 1,
					blendMode: "normal",
					paramData: { version: "1", params: {} },
				} as Filter,
			];
			const handlers = new Map<string, FilterHandler>([
				[
					"test-shadow",
					{
						getExpansionMargin: () => 30,
						postProcess: () => undefined,
					} as unknown as FilterHandler,
				],
			]);
			const structure = buildFramePlanStructure(
				makeDocument(element),
				handlers,
				false,
			);

			const plan = buildFramePlanView(
				structure,
				{ x: 55, y: 20, zoom: 1, rotation: 0 },
				20,
				20,
			);

			expect(plan.filterPlans.has(element.id)).toBe(true);
		});
	});

	describe("glass inline backdrop compose break", () => {
		it("should break a glass element into an inlineBackdropCompose segment when hasInlineComposite reports it", () => {
			const element = pathWithExtrude("normal");
			makeGlass(element);
			const framePlan = buildViewOf(makeDocument(element));

			const passPlans = buildPassPlan(framePlan, (el) => el.id === element.id);

			const breaks = passPlans[0].segments.map((s) => s.breakAfter);
			expect(breaks).toContainEqual({
				kind: "inlineBackdropCompose",
				elementId: element.id,
			});
			const runElementIds = passPlans[0].segments.flatMap((s) =>
				s.elements.map((e) => e.id),
			);
			expect(runElementIds).not.toContain(element.id);
		});

		it("should keep a glass element in the normal element run when hasInlineComposite reports false", () => {
			const element = pathWithExtrude("normal");
			makeGlass(element);
			const framePlan = buildViewOf(makeDocument(element));

			const passPlans = buildPassPlan(framePlan, () => false);

			const runElementIds = passPlans[0].segments.flatMap((s) =>
				s.elements.map((e) => e.id),
			);
			expect(runElementIds).toContain(element.id);
			expect(passPlans[0].segments.every((s) => s.breakAfter === null)).toBe(
				true,
			);
		});
	});

	describe("frame-local backdrop classification", () => {
		it("should classify a backdrop-needing element as a backdropAfter break between element segments", () => {
			const background = pathAt("background-1", 0, 0);
			const backdropElement = pathAt("backdrop-1", 200, 0);
			backdropElement.filters = [backdropAppearance()];
			const framePlan = buildViewOf(
				makeDocumentOf([background, backdropElement]),
			);

			expect(framePlan.allBackdropEntries.map((e) => e.element.id)).toEqual([
				backdropElement.id,
			]);

			const layerPlan = framePlan.layerPlans[0];
			expect(layerPlan.segments).toHaveLength(2);
			expect(layerPlan.segments[0].elements.map((e) => e.id)).toEqual([
				background.id,
			]);
			expect(layerPlan.segments[0].backdropAfter?.element.id).toBe(
				backdropElement.id,
			);
			expect(layerPlan.segments[1].elements).toEqual([]);
			expect(layerPlan.segments[1].backdropAfter).toBeNull();
		});

		it("should cull an off-viewport backdrop element from allBackdropEntries", () => {
			const background = pathAt("background-1", 0, 0);
			const backdropElement = pathAt("backdrop-1", 100_000, 100_000);
			backdropElement.filters = [backdropAppearance()];
			const framePlan = buildViewOf(
				makeDocumentOf([background, backdropElement]),
			);

			expect(framePlan.allBackdropEntries).toHaveLength(0);

			const layerPlan = framePlan.layerPlans[0];
			expect(layerPlan.segments).toHaveLength(1);
			expect(layerPlan.segments[0].backdropAfter).toBeNull();
		});
	});
});

// Helpers

function plainPath(): Path {
	const element = pathWithExtrude("normal");
	element.filters = [];
	return element;
}

function buildViewOf(document: Document, skipBackdropFilters = false) {
	return buildFramePlanView(
		buildFramePlanStructure(
			document,
			makeFilterHandlers(),
			skipBackdropFilters,
		),
		{ x: 0, y: 0, zoom: 1, rotation: 0 },
		800,
		600,
	);
}

function makeFilterHandlers(): ReadonlyMap<string, FilterHandler> {
	return new Map<string, FilterHandler>([
		["extrude3d", new Extrude3DFilterHandler() as unknown as FilterHandler],
		[
			"backdrop-test",
			{
				getRenderConfigure: () => ({ needsBackdrop: true }),
				postProcess: () => undefined,
			} as unknown as FilterHandler,
		],
	]);
}

function lineSeg(
	start: BezierPoint,
	end: BezierPoint,
	isMoved = false,
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

function fillAppearance(blendMode: BlendMode): Filter {
	return {
		uid: "app-fill",
		processor: "fill",
		enabled: true,
		opacity: 1,
		blendMode,
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 } },
			},
		},
	} as unknown as Filter;
}

function pathWithExtrude(blendMode: BlendMode): Path {
	const points: BezierPoint[] = [
		{ x: 0, y: 0 },
		{ x: 40, y: 0 },
		{ x: 40, y: 40 },
		{ x: 0, y: 40 },
	];
	return {
		id: "path-1",
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: points.map((p, i) =>
			lineSeg(p, points[(i + 1) % points.length], i === 0),
		),
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode,
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: {
							shading: "lambert",
							lightDir: [0, 0, 1],
						},
					},
				},
			},
		],
	} as unknown as Path;
}

/** Turn the element's extrude appearance into distortion glass (ior > 1). */
function makeGlass(element: Path): void {
	const params = element.filters![0].paramData.params as {
		material: { refraction?: number };
	};
	params.material.refraction = 1.5;
}

function makeDocument(element: Path): Document {
	return makeDocumentOf([element]);
}

function makeDocumentOf(elements: Path[]): Document {
	return {
		id: "doc-1",
		objects: Object.fromEntries(elements.map((e) => [e.id, e])),
		layers: [
			{
				id: "layer-1",
				name: "Layer 1",
				visible: true,
				locked: false,
				opacity: 1,
				elementIds: elements.map((e) => e.id),
			},
		],
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [],
		brushPresets: [],
	} as unknown as Document;
}

/** A plain untransformed 40x40 square path at the given world offset. */
function pathAt(id: string, offsetX: number, offsetY: number): Path {
	const points: BezierPoint[] = [
		{ x: offsetX, y: offsetY },
		{ x: offsetX + 40, y: offsetY },
		{ x: offsetX + 40, y: offsetY + 40 },
		{ x: offsetX, y: offsetY + 40 },
	];
	return {
		id,
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: points.map((p, i) =>
			lineSeg(p, points[(i + 1) % points.length], i === 0),
		),
		filters: [],
	} as unknown as Path;
}

/** An appearance filter whose handler reports needsBackdrop (frame-local backdrop). */
function backdropAppearance(): Filter {
	return {
		uid: "app-backdrop",
		processor: "backdrop-test",
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	} as unknown as Filter;
}

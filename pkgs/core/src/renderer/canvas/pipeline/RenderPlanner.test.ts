import { describe, expect, it } from "vitest";
import { localAppearances } from "../../../document/appearancePresets";
import { planBoundsOf } from "../../../document/elementGeometry/filteredBounds";
import { createIdentityTransform } from "../../../document/factory";
import {
	type BezierPoint,
	type BlendMode,
	type BoundingBox,
	type CubicBezierSegment,
	type Document,
	type ElementTransform,
	type Filter,
	getTransform,
	type Path,
} from "../../../schema";
import {
	mockDocument,
	mockGroup,
	mockLayer,
	mockPath,
} from "../../../testUtils/mockElements";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { createTestTextElement } from "../../../testUtils/typographyFixtures";
import { Extrude3DFilterHandler } from "../../filters/Extrude3DFilter/Extrude3DFilter";
import type { FilterHandler } from "./FilterRenderer";
import {
	buildFilterPlansForElements,
	buildFramePlanStructure,
	buildFramePlanView,
	buildPassPlan,
	type PartialRedrawState,
	planPartialRedraw,
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
				{ ...localAppearances(element.filters)[0], enabled: false },
			];
			const plan = buildViewOf(makeDocument(element));

			const plans = plan.filterPlans.get(element.id)?.allAppearancePlans;
			expect(plans).toBeDefined();
			expect(plans!.map((p) => p.appearance.processor)).toEqual(["fill"]);
		});
	});

	describe("geometry sub-filters of an appearance", () => {
		it("should leave a text to deform its glyphs itself instead of baking the appearance", () => {
			const text = createTestTextElement("a");
			text.filters = [
				{ ...fillAppearance("normal"), subFilters: [shiftAppearance()] },
			];
			const plan = buildViewOf(makeDocumentOf([text as unknown as Path]));

			expect(plan.filterPlans.get(text.id)?.allAppearancePlans).toBeUndefined();
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
		it("should list a backdrop-needing element without breaking its layer's pass", () => {
			const background = pathAt("background-1", 0, 0);
			const backdropElement = pathAt("backdrop-1", 200, 0);
			backdropElement.filters = [backdropAppearance()];
			const framePlan = buildViewOf(
				makeDocumentOf([background, backdropElement]),
			);

			expect([...framePlan.backdropEntries.keys()]).toEqual([
				backdropElement.id,
			]);

			const [passPlan] = buildPassPlan(framePlan, () => false);
			expect(passPlan.segments).toHaveLength(1);
			expect(passPlan.segments[0].elements.map((e) => e.id)).toEqual([
				background.id,
				backdropElement.id,
			]);
		});

		it("should list a backdrop child while keeping its group whole in the pass", () => {
			const below = pathAt("below-1", 0, 0);
			const child = pathAt("backdrop-1", 0, 0);
			child.filters = [backdropAppearance()];
			const above = pathAt("above-1", 0, 0);
			const group = mockGroup("group-1", [below.id, child.id, above.id]);
			const framePlan = buildViewOf(
				mockDocument(
					[below, child, above, group],
					[mockLayer("layer-1", [group.id])],
				),
			);

			expect([...framePlan.backdropEntries.keys()]).toEqual([child.id]);

			const [passPlan] = buildPassPlan(framePlan, () => false);
			expect(passPlan.segments).toHaveLength(1);
			expect(passPlan.segments[0].elements.map((e) => e.id)).toEqual([
				group.id,
			]);
		});

		it("should cull an off-viewport backdrop element from backdropEntries", () => {
			const background = pathAt("background-1", 0, 0);
			const backdropElement = pathAt("backdrop-1", 100_000, 100_000);
			backdropElement.filters = [backdropAppearance()];
			const framePlan = buildViewOf(
				makeDocumentOf([background, backdropElement]),
			);

			expect(framePlan.backdropEntries.size).toBe(0);
		});

		it("should size a backdrop child's entry by the deformation its group applies", () => {
			const child = pathAt("backdrop-1", 0, 0);
			child.filters = [backdropAppearance()];
			const group = mockGroup("group-1", [child.id]);
			group.filters = [shiftAppearance()];
			const document = mockDocument(
				[child, group],
				[mockLayer("layer-1", [group.id])],
			);

			const [entry] = buildViewOf(document).backdropEntries.values();

			expect(entry.element.id).toBe(child.id);
			expect(entry.bounds.maxX).toBeCloseTo(140);
			expect(localAppearances(entry.element.filters)).toContainEqual(
				shiftAppearance(),
			);
		});
	});
});

// Helpers

describe("transient element bounds", () => {
	it("should ignore stale cached bounds for transient (preview) elements", () => {
		// A live preview mutates under a stable id with no document-change
		// invalidation: a stale cache entry must not pin the plan's texture
		// bounds to the first frame's size.
		const preview = plainPath();
		preview.id = "__pen_preview__";
		preview.segments = [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: 300, y: 0 },
				startPressure: 1,
				endPressure: 1,
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 100,
				isMoved: true,
			} as CubicBezierSegment,
		];
		preview.filters = [
			{
				uid: "preview-stroke",
				processor: "stroke",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						strokeColor: {
							type: "solid",
							color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
						},
						brushSettings: {
							version: 2,
							engine: "dab",
							strokeOpacity: 0.5,
							paintMode: "wash",
							properties: {
								size: { base: 20 },
								spacing: { base: 0.2 },
								flow: { base: 1 },
							},
							tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
							randomSeed: 0,
						},
					},
				},
			} as unknown as Filter,
		];

		// Stale cache: the first frame's tiny bounds under the preview's id.
		const staleCache = new Map();
		staleCache.set(preview.id, {
			minX: 0,
			minY: 0,
			maxX: 2,
			maxY: 2,
			width: 2,
			height: 2,
		});

		const structure = buildFramePlanStructure(
			makeDocument(plainPath()),
			makeFilterHandlers(),
			false,
			staleCache as Parameters<typeof buildFramePlanStructure>[3],
			undefined,
			new Map([
				[preview.id, { layerId: "layer-1", element: preview }],
			]) as Parameters<typeof buildFramePlanStructure>[5],
		);
		const view = buildFramePlanView(
			structure,
			{ x: 150, y: 0, zoom: 1, rotation: 0 },
			800,
			600,
		);
		const plan = view.filterPlans.get(preview.id);
		expect(plan).toBeDefined();
		expect(plan!.textureBounds.width).toBeGreaterThan(250);
	});
});

describe("group child filter plans", () => {
	it("should place a moved group's child plan at the child's world position", () => {
		const { child, document } = groupedChild({ x: 500, y: 0 });

		const plan = planFor(document, child.id, { x: 520, y: 20 });
		expect(plan.textureBounds.minX).toBeCloseTo(500);
		expect(plan.textureBounds.maxX).toBeCloseTo(540);
	});

	it("should turn a rotated group's child around the group's local origin", () => {
		// Child square at 0..40 shifted by x:100 under a group rotated 90°. The
		// group turns its space around its local origin, so the square at
		// x 100..140, y 0..40 lands at x -40..0, y 100..140.
		const { child, document } = groupedChild(
			{ x: 0, y: 0, rotation: Math.PI / 2 },
			{ x: 100, y: 0 },
		);

		const plan = planFor(document, child.id, { x: -20, y: 120 });
		expect(plan.textureBounds.minX).toBeCloseTo(-40);
		expect(plan.textureBounds.maxX).toBeCloseTo(0);
		expect(plan.textureBounds.minY).toBeCloseTo(100);
		expect(plan.textureBounds.maxY).toBeCloseTo(140);
	});

	it("should bake a child plan in the shape its group's geometry filter deforms", () => {
		const { child, document } = groupedChild({});
		document.objects["group-1"].filters = [shiftAppearance()];

		const plan = planFor(document, child.id, { x: 120, y: 20 });
		expect(plan.textureBounds.maxX).toBeCloseTo(140);
		expect(localAppearances(plan.element.filters)).toContainEqual(
			shiftAppearance(),
		);
	});

	it("should size a standalone plan from the parent transform it is given", () => {
		const child = blendedSquare("child-1");
		const document = mockDocument([child], [mockLayer("layer-1", [child.id])]);

		const plans = buildFilterPlansForElements(
			[child],
			new Map(Object.entries(document.objects)),
			{
				getHandler: (processor) => makeFilterHandlers().get(processor),
				getHandlers: () => makeFilterHandlers(),
			},
			undefined,
			() => ({ ...createIdentityTransform(), x: 500 }),
		);

		const plan = plans.get(child.id);
		expect(plan).toBeDefined();
		expect(plan!.textureBounds.minX).toBeCloseTo(500);
		expect(plan!.textureBounds.maxX).toBeCloseTo(540);
	});
});

describe("planBoundsOf", () => {
	it("should turn a rotated group's child around the group's local origin without a filter renderer", () => {
		// The flat-bounds form every mask, clip and backdrop box goes through:
		// the same child square as above, read with no geometry filters.
		const { child, document } = groupedChild(
			{ x: 0, y: 0, rotation: Math.PI / 2 },
			{ x: 100, y: 0 },
		);
		const group = document.objects["group-1"];

		const bounds = planBoundsOf(
			child,
			new Map(Object.entries(document.objects)),
			null,
			undefined,
			getTransform(group),
		);
		expect(bounds.minX).toBeCloseTo(-40);
		expect(bounds.maxX).toBeCloseTo(0);
		expect(bounds.minY).toBeCloseTo(100);
		expect(bounds.maxY).toBeCloseTo(140);
	});
});

/** A 40x40 square with a multiply fill, so it always gets a filter plan. */
describe("planPartialRedraw", () => {
	const storeBox = box(0, 0, 100, 100);

	it("should return null when the change set is untracked", () => {
		const plan = plan_({ changed: undefined, untracked: true });

		expect(plan).toBeNull();
	});

	it("should return null when the previous composite cannot be restored", () => {
		const plan = plan_({ state: { canRestore: false } });

		expect(plan).toBeNull();
	});

	it("should return null when the store moved by a fraction of a texel since the capture", () => {
		const plan = plan_({
			state: { capturedStoreBounds: box(5.5, 0, 105.5, 100) },
		});

		expect(plan).toBeNull();
	});

	it("should return null when the store density changed since the capture", () => {
		const plan = plan_({ state: { capturedStoreDensity: 2 } });

		expect(plan).toBeNull();
	});

	it("should redraw only the exposed strip when a viewport frame re-anchors the store", () => {
		// The store moved 20 texels right: its right 20 columns were never baked.
		const plan = plan_({
			changed: { upserted: new Set(), deleted: new Set() },
			target: storeBox,
			state: {
				capturedStoreBounds: box(-20, 0, 80, 100),
				bakedWorldBounds: box(-20, 0, 80, 100),
			},
		});

		expect(plan?.scissor).toEqual({ x: 80, y: 0, width: 20, height: 100 });
		expect(plan?.cacheOffset).toEqual({ x: 20, y: 0 });
		expect(plan?.bakedUnion).toEqual(storeBox);
	});

	it("should redraw what a backdrop read left incomplete at an edge the store moved past", () => {
		// The store moved 20 texels right; the captured right edge at x=80 is
		// now inside it, and a read with a 5 px footprint touches that edge.
		const plan = plan_({
			changed: { upserted: new Set(), deleted: new Set() },
			target: storeBox,
			state: {
				capturedStoreBounds: box(-20, 0, 80, 100),
				bakedWorldBounds: box(-20, 0, 80, 100),
				backdropReads: [{ bounds: box(70, 0, 90, 100), footprint: 5 }],
			},
		});

		expect(plan?.restoreBands).toEqual([
			{ x: 0, y: 0, width: 75, height: 100 },
		]);
	});

	it("should restore the texels a full render cut at the viewport's edges", () => {
		const plan = plan_({
			target: box(20.3, 20.3, 79.3, 79.3),
			state: { bakedWorldBounds: box(20.3, 20.3, 79.3, 79.3) },
		});

		expect(plan?.restoreBands).toEqual([
			{ x: 20, y: 20, width: 60, height: 22 },
			{ x: 20, y: 68, width: 60, height: 12 },
			{ x: 20, y: 42, width: 12, height: 26 },
			{ x: 58, y: 42, width: 22, height: 26 },
		]);
	});

	it("should return null when a viewport frame needs nothing the cache lacks", () => {
		const plan = plan_({
			changed: { upserted: new Set(), deleted: new Set() },
			target: storeBox,
		});

		expect(plan).toBeNull();
	});

	it("should redraw a bounded backdrop footprint past the dirty rect", () => {
		const plan = plan_({
			state: {
				backdropReads: [{ bounds: box(0, 0, 100, 100), footprint: 4 }],
			},
		});

		expect(plan?.scissor).toEqual({ x: 24, y: 34, width: 42, height: 42 });
	});

	it("should redraw a backdrop read's output that reads the change", () => {
		// A glass with a 6 px footprint over the change reads it from up to
		// 6 px away, so its output there changes and is redrawn, not restored.
		const plan = plan_({
			state: {
				backdropReads: [{ bounds: box(30, 30, 75, 75), footprint: 6 }],
			},
		});

		expect(plan?.restoreBands).toEqual([
			{ x: 0, y: 0, width: 100, height: 36 },
			{ x: 0, y: 70, width: 100, height: 30 },
			{ x: 0, y: 36, width: 30, height: 34 },
			{ x: 64, y: 36, width: 36, height: 34 },
		]);
	});

	it("should redraw a backdrop read beside the change that reaches it", () => {
		const plan = plan_({
			state: {
				backdropReads: [{ bounds: box(60, 40, 70, 50), footprint: 5 }],
			},
		});

		expect(plan?.restoreBands.at(-1)).toEqual({
			x: 63,
			y: 42,
			width: 37,
			height: 26,
		});
	});

	it("should restore every cached texel outside the dirty rect", () => {
		const plan = plan_({
			state: {
				backdropReads: [{ bounds: box(0, 0, 100, 100), footprint: 4 }],
			},
		});

		expect(plan?.restoreBands).toEqual([
			{ x: 0, y: 0, width: 100, height: 38 },
			{ x: 0, y: 72, width: 100, height: 28 },
			{ x: 0, y: 38, width: 28, height: 34 },
			{ x: 62, y: 38, width: 38, height: 34 },
		]);
	});

	it("should restore only the texels the cache holds", () => {
		const plan = plan_({
			changed: { upserted: new Set(), deleted: new Set() },
			target: storeBox,
			state: {
				capturedStoreBounds: box(-20, 0, 80, 100),
				bakedWorldBounds: box(-20, 0, 80, 100),
			},
		});

		expect(plan?.restoreBands).toEqual([
			{ x: 0, y: 0, width: 80, height: 100 },
		]);
	});

	it("should snap the dirty rect of a small edit to the store texel grid", () => {
		const plan = plan_({
			state: { currentWorldBoundsOf: () => box(40.3, 40.3, 50.2, 50.2) },
		});

		expect(plan?.scissor).toEqual({ x: 32, y: 41, width: 27, height: 27 });
		expect(plan?.dirtyWorld).toEqual(box(32, 32, 59, 59));
	});

	it("should union the previous bounds of a deleted element into the dirty rect", () => {
		const plan = plan_({
			changed: { upserted: new Set(), deleted: new Set(["gone"]) },
			elements: new Map(),
			state: {
				previousWorldBoundsOf: (id) =>
					id === "gone" ? box(10, 10, 20, 20) : null,
				currentWorldBoundsOf: () => null,
			},
		});

		expect(plan?.dirtyWorld).toEqual(box(2, 2, 28, 28));
	});

	it("should extend the baked region by a dirty rect that adjoins it", () => {
		const plan = plan_({
			target: box(0, 0, 10, 10),
			state: {
				bakedWorldBounds: box(0, 0, 32, 100),
				currentWorldBoundsOf: () => box(40, 0, 50, 100),
			},
		});

		expect(plan?.bakedUnion).toEqual(box(0, 0, 58, 100));
	});

	it("should keep the baked region to what the frame holds when the union is not a rectangle", () => {
		const plan = plan_({
			target: box(0, 0, 10, 10),
			state: {
				bakedWorldBounds: box(0, 0, 10, 10),
				currentWorldBoundsOf: () => box(40, 40, 50, 50),
			},
		});

		expect(plan?.bakedUnion).toEqual(box(0, 0, 10, 10));
	});

	it("should return null when the dirty rect covers most of the store", () => {
		const plan = plan_({
			state: { currentWorldBoundsOf: () => box(0, 0, 90, 90) },
		});

		expect(plan).toBeNull();
	});

	it("should return null when a changed element has its own filter plan", () => {
		const plan = plan_({
			structure: {
				candidates: [{ filterPlan: { elementId: "a" } }],
			},
		});

		expect(plan).toBeNull();
	});

	it("should spread a change inside a filtered group by the group's filter reach", () => {
		// The group's filter reaches 5 px: the change spreads that far, and the
		// frame draws 5 px further so the filter reads complete content there.
		const plan = plan_({
			elements: pathInGroup(),
			structure: {
				candidates: [
					{
						filterPlan: {
							elementId: "g",
							bounds: box(20, 20, 80, 80),
							textureBounds: box(15, 15, 85, 85),
							postFilters: [{}],
						},
					},
				],
			},
			state: { parentOf: (id) => (id === "a" ? "g" : undefined) },
		});

		expect(plan?.scissor).toEqual({ x: 22, y: 32, width: 46, height: 46 });
		expect(plan?.restoreBands).toEqual([
			{ x: 0, y: 0, width: 100, height: 37 },
			{ x: 0, y: 73, width: 100, height: 27 },
			{ x: 0, y: 37, width: 27, height: 36 },
			{ x: 63, y: 37, width: 37, height: 36 },
		]);
	});

	it("should return null when a group around the change reads its backdrop", () => {
		const plan = plan_({
			elements: pathInGroup(),
			structure: {
				candidates: [{ backdropEntry: { element: { id: "g" } } }],
			},
			state: { parentOf: (id) => (id === "a" ? "g" : undefined) },
		});

		expect(plan).toBeNull();
	});

	function plan_(
		options: {
			changed?: { upserted: Set<string>; deleted: Set<string> };
			untracked?: boolean;
			elements?: Map<
				string,
				ReturnType<typeof mockPath> | ReturnType<typeof mockGroup>
			>;
			structure?: object;
			target?: BoundingBox;
			state?: Partial<PartialRedrawState>;
		} = {},
	) {
		const state: PartialRedrawState = {
			canRestore: true,
			bakedWorldBounds: box(0, 0, 100, 100),
			capturedStoreBounds: storeBox,
			capturedStoreDensity: 1,
			backdropReads: [],
			previousWorldBoundsOf: () => null,
			currentWorldBoundsOf: () => box(40, 40, 50, 50),
			parentOf: () => undefined,
			...options.state,
		};
		return planPartialRedraw(
			options.untracked
				? undefined
				: (options.changed ?? { upserted: new Set(["a"]), deleted: new Set() }),
			options.elements ?? new Map([["a", mockPath("a")]]),
			{ candidates: [], ...options.structure } as never,
			storeBox,
			options.target ?? box(0, 0, 100, 100),
			100,
			100,
			1,
			state,
		);
	}
});

/** Path "a" inside group "g". */
function pathInGroup() {
	return new Map<
		string,
		ReturnType<typeof mockPath> | ReturnType<typeof mockGroup>
	>([
		["a", mockPath("a")],
		["g", mockGroup("g", ["a"])],
	]);
}

function box(
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
): BoundingBox {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	};
}

function blendedSquare(id: string, transform: Partial<ElementTransform> = {}) {
	const path = mockPath(id);
	path.segments = closedRectSegments(0, 0, 40, 40);
	path.filters = [fillAppearance("multiply")];
	path.transform = { ...createIdentityTransform(), ...transform };
	return path;
}

function groupedChild(
	groupTransform: Partial<ElementTransform>,
	childTransform: Partial<ElementTransform> = {},
) {
	const child = blendedSquare("child-1", childTransform);
	const group = mockGroup("group-1", [child.id], groupTransform);
	const document = mockDocument(
		[child, group],
		[mockLayer("layer-1", [group.id])],
	);
	return { child, document };
}

function planFor(
	document: Document,
	elementId: string,
	viewportCenter: { x: number; y: number },
) {
	const view = buildFramePlanView(
		buildFramePlanStructure(document, makeFilterHandlers(), false),
		{ ...viewportCenter, zoom: 1, rotation: 0 },
		800,
		600,
	);
	const plan = view.filterPlans.get(elementId);
	expect(plan).toBeDefined();
	return plan!;
}

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
		[
			"shift-test",
			{
				getExpansionMargin: () => 0,
				preProcess: (segments: CubicBezierSegment[]) =>
					segments.map((segment) => ({
						...segment,
						start: segment.start && {
							...segment.start,
							x: segment.start.x + 100,
						},
						end: { ...segment.end, x: segment.end.x + 100 },
					})),
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
	const params = localAppearances(element.filters)[0].paramData.params as {
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

/** A geometry filter that moves every point 100 to the right. */
function shiftAppearance(): Filter {
	return {
		uid: "app-shift",
		processor: "shift-test",
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	} as unknown as Filter;
}

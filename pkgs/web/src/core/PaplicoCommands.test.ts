import { describe, expect, it, vi } from "vitest";
import { readStoredBrushSize } from "./brush/access";
import type { YjsProvider } from "./collaboration/YjsProvider";
import {
	createDefaultBrushSettings,
	createIdentityTransform,
} from "./document/factory";
import type { SpatialIndex } from "./document/SpatialIndex";
import type { RendererState } from "./Paplico";
import { PaplicoCommands } from "./PaplicoCommands";
import type {
	AnyArtObject,
	BlendObject,
	BrushSettingsV2,
	FillAppearance,
	Filter,
	Group,
	Layer,
	LinearGradient,
	MeshGradient,
	ObjectMask,
	Path,
	RadialGradient,
	StrokeAppearance,
	TextElement,
	Vec2,
} from "./schema";
import { toRGBColor } from "./schema";
import {
	createMockFontManager,
	createTestTextElement,
} from "./testUtils/typographyFixtures";
import type { ToolSettings } from "./tools/toolSettings";
import { TextLayoutEngine } from "./typography/TextLayoutEngine";
import { TextRenderer } from "./typography/TextRenderer";
import { calculateElementBounds } from "./utils/geometry/bounds";

describe("PaplicoCommands", () => {
	it("copy/paste keeps cp offsets while translating only anchors", () => {
		const sourcePath = createPath("path-1");
		const layer = createLayer("layer-1", [sourcePath.id]);
		const addElement = vi.fn();
		const insertElement = vi.fn();

		const store = {
			currentLayerId: layer.id,
			selectedElementIds: [sourcePath.id],
			editingScopeStack: [],

			document: {
				layers: [layer],
				objects: {
					[sourcePath.id]: sourcePath,
				},
			},
		} as unknown as RendererState;

		const commands = new PaplicoCommands({
			store,
			yjsProvider: {
				addElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				insertElement,
				isElementLocked: () => false,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});

		const pastedIds = commands.pasteElements([sourcePath], {
			viewport: { x: 200, y: 300 },
		});
		expect(pastedIds).toHaveLength(1);
		expect(addElement).toHaveBeenCalledTimes(1);
		expect(store.selectedElementIds).toEqual(pastedIds);

		const [layerId, pastedPath] = addElement.mock.calls[0] as [
			string,
			Path,
			unknown,
		];
		expect(layerId).toBe(layer.id);
		expect(pastedPath.type).toBe("path");
		expect(pastedPath.id).toBe(pastedIds[0]);

		const originalSegments = sourcePath.segments;
		const translatedSegments = pastedPath.segments;
		expect(translatedSegments).toHaveLength(originalSegments.length);

		const originalStart = originalSegments[0].start;
		const translatedStart = translatedSegments[0].start;
		if (!originalStart || !translatedStart)
			throw new Error("first segment must have start");

		const deltaX = translatedStart.x - originalStart.x;
		const deltaY = translatedStart.y - originalStart.y;

		for (let i = 0; i < originalSegments.length; i++) {
			const original = originalSegments[i];
			const translated = translatedSegments[i];
			expect(translated.cp1).toEqual(original.cp1);
			expect(translated.cp2).toEqual(original.cp2);

			if (original.start) {
				expect(translated.start).toEqual({
					...original.start,
					x: original.start.x + deltaX,
					y: original.start.y + deltaY,
				});
			} else {
				expect(translated.start).toBeUndefined();
			}

			expect(translated.end.x - original.end.x).toBe(deltaX);
			expect(translated.end.y - original.end.y).toBe(deltaY);
		}
	});

	it("skips brush-setting updates when selected paths already match semantically", () => {
		const brushSettings = createDefaultBrushSettings();
		const legacyFlatBrushSettings = {
			size: brushSettings.size,
			sizeByPressure: brushSettings.sizeByPressure,
			opacity: brushSettings.opacity,
			opacityByPressure: brushSettings.opacityByPressure,
			randomSeed: brushSettings.randomSeed,
			colorMode: brushSettings.colorMode,
			textureFileUid:
				brushSettings.source.kind === "file"
					? brushSettings.source.fileUid
					: "builtin-brush-soft-circle",
			spacing: brushSettings.spacing,
			flow: brushSettings.flow,
			stampRotation: brushSettings.stampRotation,
			stampAngle: brushSettings.stampAngle,
			rotationByTilt: brushSettings.rotationByTilt,
			aspectRatioByTilt: brushSettings.aspectRatioByTilt,
			sizeBySpeed: brushSettings.sizeBySpeed,
			pooling: brushSettings.pooling,
			poolingSizeRatio: brushSettings.poolingSizeRatio,
		};
		const path = {
			...createPath("path-1"),
			filters: [
				{
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
							brushSettings: legacyFlatBrushSettings,
						},
					},
				},
			],
		} as Path;
		const layer = createLayer("layer-1", [path.id]);
		const updateElement = vi.fn();

		const commands = new PaplicoCommands({
			store: {
				currentLayerId: layer.id,
				selectedElementIds: [path.id],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { [path.id]: path },
				},
			} as unknown as RendererState,
			yjsProvider: {
				updateElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				isElementLocked: () => false,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});

		commands.updateSelectedElementsBrushSettings(brushSettings);

		expect(updateElement).not.toHaveBeenCalled();
	});

	// The panel edits v2 settings; writing them to a selected stroke has to
	// carry the parts v1 cannot hold, or every mixing and wet value silently
	// reverts the moment the stroke is selected.
	it("keeps mixing and curves when writing v2 settings to the selection", () => {
		const path = {
			...createPath("path-1"),
			filters: [
				{
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
							brushSettings: createDefaultBrushSettings(),
						},
					},
				},
			],
		} as Path;
		const layer = createLayer("layer-1", [path.id]);
		const updateElement = vi.fn();

		const commands = new PaplicoCommands({
			store: {
				currentLayerId: layer.id,
				selectedElementIds: [path.id],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { [path.id]: path },
				},
			} as unknown as RendererState,
			yjsProvider: {
				updateElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				isElementLocked: () => false,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});

		commands.updateSelectedElementsBrushSettings({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: { base: 24 },
				colorRate: {
					base: 0,
					curves: [
						{
							input: "pressure",
							points: [
								[0, 0],
								[1, 0.5],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			mixing: {
				enabled: true,
				mode: "dulling",
				sampleRadius: 2,
				sampleTrail: 0,
				blendStyle: 1,
			},
			randomSeed: 5,
		});

		expect(updateElement).toHaveBeenCalledTimes(1);
		const [, , patch] = updateElement.mock.calls[0] as [
			string,
			string,
			{ filters: Filter[] },
		];
		const written = (
			patch.filters[0] as unknown as {
				paramData: { params: { brushSettings: BrushSettingsV2 } };
			}
		).paramData.params.brushSettings;
		expect(written.mixing?.enabled).toBe(true);
		expect(written.mixing?.sampleRadius).toBe(2);
		expect(written.properties.colorRate?.curves?.[0].input).toBe("pressure");
	});

	// Two settings that differ only in what v1 cannot express must not read as
	// the same, or the write carrying them to the element is skipped and the
	// change is lost the moment the stroke is selected again.
	it("writes a change only the v2 shape can express", () => {
		const base = {
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "wash",
			properties: { size: { base: 20 } },
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			wet: {
				enabled: true,
				bleedRadius: 0.8,
				pigmentLoad: 1,
				grainScale: 1,
				scatter: 0.4,
			},
			randomSeed: 1,
		};
		const path = {
			...createPath("path-1"),
			filters: [
				{
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
							brushSettings: base,
						},
					},
				},
			],
		} as unknown as Path;
		const layer = createLayer("layer-1", [path.id]);
		const updateElement = vi.fn();

		const commands = new PaplicoCommands({
			store: {
				currentLayerId: layer.id,
				selectedElementIds: [path.id],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { [path.id]: path },
				},
			} as unknown as RendererState,
			yjsProvider: {
				updateElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				isElementLocked: () => false,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});

		commands.updateSelectedElementsBrushSettings({
			...base,
			wet: { ...base.wet, scatter: 2.5 },
		} as unknown as BrushSettingsV2);

		expect(updateElement).toHaveBeenCalledTimes(1);
		const [, , patch] = updateElement.mock.calls[0] as [
			string,
			string,
			{ filters: Filter[] },
		];
		const written = (
			patch.filters[0] as unknown as {
				paramData: { params: { brushSettings: BrushSettingsV2 } };
			}
		).paramData.params.brushSettings;
		expect(written.wet?.scatter).toBe(2.5);
	});

	describe("pasteElements", () => {
		it("pastes in place when no position is given (offset = 0,0)", () => {
			const sourcePath = createPath("path-1");
			const layer = createLayer("layer-1", [sourcePath.id]);
			const { commands, addElement } = createCommands(
				layer,
				{ [sourcePath.id]: sourcePath },
				[sourcePath.id],
			);

			const pastedIds = commands.pasteElements([sourcePath]);
			expect(pastedIds).toHaveLength(1);

			const [, pastedPath] = addElement.mock.calls[0] as [
				string,
				Path,
				unknown,
			];
			// anchor positions must be identical to source (offset zero)
			expect(pastedPath.segments[0].start).toEqual(
				sourcePath.segments[0].start,
			);
			expect(pastedPath.segments[1].end).toEqual(sourcePath.segments[1].end);
		});

		it("pastes centered at given world position when coords are provided", () => {
			const sourcePath = createPath("path-1");
			const layer = createLayer("layer-1", [sourcePath.id]);
			const { commands, addElement } = createCommands(
				layer,
				{ [sourcePath.id]: sourcePath },
				[sourcePath.id],
			);

			const pastedIds = commands.pasteElements([sourcePath], {
				viewport: { x: 200, y: 300 },
			});
			expect(pastedIds).toHaveLength(1);

			const [, pastedPath] = addElement.mock.calls[0] as [
				string,
				Path,
				unknown,
			];
			// anchor positions must differ from source (offset applied)
			const sourceStart = sourcePath.segments[0].start;
			const pastedStart = pastedPath.segments[0].start;
			if (!sourceStart || !pastedStart)
				throw new Error("first segment must have start");

			const deltaX = pastedStart.x - sourceStart.x;
			const deltaY = pastedStart.y - sourceStart.y;
			expect(deltaX).not.toBe(0);
			expect(deltaY).not.toBe(0);
			// cp offsets must be unchanged
			expect(pastedPath.segments[0].cp1).toEqual(sourcePath.segments[0].cp1);
		});

		it('placement "back" reorders pasted elements to index 0', () => {
			const existing = createPath("existing");
			const sourcePath = createPath("path-1");
			const layer = createLayer("layer-1", [existing.id, sourcePath.id]);
			const { commands, reorderElements } = createCommands(
				layer,
				{ [existing.id]: existing, [sourcePath.id]: sourcePath },
				[sourcePath.id],
			);

			const pastedIds = commands.pasteElements([sourcePath], {
				placement: "back",
			});
			expect(pastedIds).toHaveLength(1);

			// reorderElements must have been called once to move pasted element to front of array
			expect(reorderElements).toHaveBeenCalledTimes(1);
			const [layerId, fromIndex, toIndex] = reorderElements.mock.calls[0] as [
				string,
				number,
				number,
			];
			expect(layerId).toBe(layer.id);
			expect(toIndex).toBe(0);
			expect(fromIndex).toBeGreaterThan(0);
		});

		it('placement "front" does not call reorderElements', () => {
			const sourcePath = createPath("path-1");
			const layer = createLayer("layer-1", [sourcePath.id]);
			const { commands, reorderElements } = createCommands(
				layer,
				{ [sourcePath.id]: sourcePath },
				[sourcePath.id],
			);

			commands.pasteElements([sourcePath]);
			expect(reorderElements).not.toHaveBeenCalled();
		});

		it("returns empty array when elements are empty", () => {
			const layer = createLayer("layer-1", []);
			const { commands } = createCommands(layer, {}, []);

			const result = commands.pasteElements([]);
			expect(result).toEqual([]);
		});
	});

	describe("duplicating a Blend object", () => {
		it("clones the blend's sources with fresh ids so the copy is independent", () => {
			const s0 = createPath("s0");
			const s1 = createPath("s1");
			const blend = {
				id: "blend-1",
				type: "blend",
				objectIds: ["s0", "s1"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			} as unknown as AnyArtObject;
			// Sources are absorbed: only the blend is in the layer.
			const layer = createLayer("layer-1", ["blend-1"]);
			const addElement = vi.fn();
			const createBlend = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: ["blend-1"],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { "blend-1": blend, s0, s1 },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					createBlend,
					transact: vi.fn((fn: () => void) => fn()),
					reorderElements: vi.fn(),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newIds = commands.duplicateElements();
			expect(newIds).toHaveLength(1);

			// The copy's blend references freshly-cloned sources, not the originals.
			expect(createBlend).toHaveBeenCalledTimes(1);
			const [, clonedBlend] = createBlend.mock.calls[0] as [
				string,
				BlendObject,
			];
			expect(clonedBlend.id).toBe(newIds[0]);
			expect(clonedBlend.objectIds).toHaveLength(2);
			expect(clonedBlend.objectIds).not.toContain("s0");
			expect(clonedBlend.objectIds).not.toContain("s1");

			// Those fresh sources were actually added to the document.
			const addedIds = addElement.mock.calls.map(
				(c) => (c[1] as AnyArtObject).id,
			);
			expect(addedIds).toEqual(expect.arrayContaining(clonedBlend.objectIds));
			expect(addedIds).not.toContain("s0");
			expect(addedIds).not.toContain("s1");
		});
	});

	describe("createBlendFromSelection", () => {
		it("orders objectIds by the layer's stacking (z) order, not the selection order", () => {
			const a = createPathAt("a", 0, 0, 10, 10);
			const b = createPathAt("b", 40, 0, 50, 10);
			const c = createPathAt("c", 80, 0, 90, 10);
			// Layer z-order: a (bottom) -> b -> c (top).
			const layer = createLayer("layer-1", ["a", "b", "c"]);
			const createBlend = vi.fn();
			const addObjectOnly = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				// Selection order scrambled vs. z-order (mimics a marquee selection
				// returning quadtree traversal order).
				selectedElementIds: ["c", "a", "b"],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { a, b, c },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					createBlend,
					addObjectOnly,
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const result = commands.createBlendFromSelection();
			expect(result.ok).toBe(true);
			expect(createBlend).toHaveBeenCalledTimes(1);
			const [parentId, blend] = createBlend.mock.calls[0] as [
				string,
				BlendObject,
			];
			expect(parentId).toBe("layer-1");
			expect(blend.objectIds).toEqual(["a", "b", "c"]);
		});
	});

	describe("extractChildFromBlend / reorderBlendChildren", () => {
		function makeBlendStore(objectIds: string[], spineSourceId?: string) {
			const blend = {
				id: "b-1",
				type: "blend",
				objectIds,
				spacing: { type: "steps", count: 5 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				spineSourceId,
			} as unknown as AnyArtObject;
			const objects: Record<string, AnyArtObject> = { "b-1": blend };
			for (const id of objectIds) objects[id] = createPath(id);
			const layer = createLayer("layer-1", ["b-1"]);
			const extractChildFromBlend = vi.fn();
			const reorderBlendChildren = vi.fn();
			const releaseBlend = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: ["b-1"],
				editingScopeStack: [],
				document: { layers: [layer], objects },
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					extractChildFromBlend,
					reorderBlendChildren,
					releaseBlend,
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});
			return {
				commands,
				extractChildFromBlend,
				reorderBlendChildren,
				releaseBlend,
			};
		}

		it("delegates extraction to YjsProvider when >= 2 sources remain", () => {
			const { commands, extractChildFromBlend, releaseBlend } = makeBlendStore([
				"a",
				"b",
				"c",
			]);

			commands.extractChildFromBlend("b-1", "b", "layer-1", 2);

			expect(extractChildFromBlend).toHaveBeenCalledWith(
				"b-1",
				"b",
				"layer-1",
				2,
			);
			expect(releaseBlend).not.toHaveBeenCalled();
		});

		it("releases the blend instead of extracting when it would drop below 2 sources", () => {
			const { commands, extractChildFromBlend, releaseBlend } = makeBlendStore([
				"a",
				"b",
			]);

			commands.extractChildFromBlend("b-1", "b", "layer-1");

			expect(releaseBlend).toHaveBeenCalledWith("b-1");
			expect(extractChildFromBlend).not.toHaveBeenCalled();
		});

		it("does nothing when asked to extract the spine", () => {
			const { commands, extractChildFromBlend, releaseBlend } = makeBlendStore(
				["a", "b"],
				"sp",
			);

			commands.extractChildFromBlend("b-1", "sp", "layer-1");

			expect(extractChildFromBlend).not.toHaveBeenCalled();
			expect(releaseBlend).not.toHaveBeenCalled();
		});

		it("delegates reordering to YjsProvider", () => {
			const { commands, reorderBlendChildren } = makeBlendStore([
				"a",
				"b",
				"c",
			]);

			commands.reorderBlendChildren("b-1", 0, 2);

			expect(reorderBlendChildren).toHaveBeenCalledWith("b-1", 0, 2);
		});
	});

	describe("duplicateElementsByIds (shared alt-drag / copy path)", () => {
		it("clones a group's children with fresh ids and re-links them", () => {
			const child = createPath("child-1");
			const group = {
				id: "group-1",
				type: "group",
				childIds: ["child-1"],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			} as unknown as AnyArtObject;
			const layer = createLayer("layer-1", ["group-1"]);
			const addElement = vi.fn();
			const addElementToGroup = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: ["group-1"],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { "group-1": group, "child-1": child },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					addElementToGroup,
					transact: vi.fn((fn: () => void) => fn()),
					reorderElements: vi.fn(),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
					getAncestorTransform: () => null,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newIds = commands.duplicateElementsByIds(["group-1"], {
				x: 0,
				y: 0,
			});
			expect(newIds).toHaveLength(1);

			const groupAdd = addElement.mock.calls.find(
				(c) => (c[1] as AnyArtObject).type === "group",
			);
			const clonedGroup = groupAdd?.[1] as Group;
			expect(clonedGroup.childIds).toHaveLength(1);
			expect(clonedGroup.childIds).not.toContain("child-1");

			const childAdd = addElement.mock.calls.find(
				(c) => (c[1] as AnyArtObject).type === "path",
			);
			expect((childAdd?.[1] as Path).id).not.toBe("child-1");
			expect((childAdd?.[1] as Path).id).toBe(clonedGroup.childIds[0]);
			expect(addElementToGroup).toHaveBeenCalled();
		});

		it("clones a mesh container's children with fresh ids and re-links them", () => {
			const child = createPath("child-1");
			const mesh = {
				id: "mesh-1",
				type: "mesh",
				childIds: ["child-1"],
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
				vertices: [
					{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
					{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
					{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
					{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
				],
				faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
			} as unknown as AnyArtObject;
			const layer = createLayer("layer-1", ["mesh-1"]);
			const addElement = vi.fn();
			const addObjectOnly = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: ["mesh-1"],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: { "mesh-1": mesh, "child-1": child },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					addObjectOnly,
					transact: vi.fn((fn: () => void) => fn()),
					reorderElements: vi.fn(),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
					getAncestorTransform: () => null,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newIds = commands.duplicateElementsByIds(["mesh-1"], {
				x: 0,
				y: 0,
			});
			expect(newIds).toHaveLength(1);

			// The clone gets its own child — sharing it with the original would
			// make edits inside one container repaint the other.
			const meshAdd = addElement.mock.calls.find(
				(c) => (c[1] as AnyArtObject).type === "mesh",
			);
			const clonedMesh = meshAdd?.[1] as { childIds: string[] };
			expect(clonedMesh.childIds).toHaveLength(1);
			expect(clonedMesh.childIds).not.toContain("child-1");

			// The child is absorbed: registered as an object, never in a layer.
			const childAdd = addObjectOnly.mock.calls.find(
				(c) => (c[0] as AnyArtObject).type === "path",
			);
			expect((childAdd?.[0] as Path).id).not.toBe("child-1");
			expect((childAdd?.[0] as Path).id).toBe(clonedMesh.childIds[0]);
		});

		it("duplicates a group child at its original world position while editing the group", () => {
			// The child is stored in group-local coordinates; the group itself
			// is translated in world space. Duplicating the child while editing
			// the group must keep the copy at the same world position instead of
			// re-applying the group's inverse transform to local coordinates.
			const groupTransform = {
				x: 100,
				y: 50,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			};
			const child = {
				...createPath("child-1"),
				transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
			};
			const group = {
				id: "group-1",
				type: "group",
				childIds: ["child-1"],
				opacity: 1,
				blendMode: "normal",
				transform: groupTransform,
			} as unknown as AnyArtObject;
			const layer = createLayer("layer-1", ["group-1"]);
			const addElement = vi.fn();
			const addElementToGroup = vi.fn();
			const updateElement = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: ["child-1"],
				editingScopeStack: ["group-1"],
				document: {
					layers: [layer],
					objects: { "group-1": group, "child-1": child },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					addElementToGroup,
					updateElement,
					transact: vi.fn((fn: () => void) => fn()),
					reorderElements: vi.fn(),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
					// Only the group's child has an ancestor chain; the group is
					// a layer-root element.
					getAncestorTransform: (id: string) =>
						id === "child-1" ? groupTransform : null,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newIds = commands.duplicateElementsByIds(["child-1"], {
				x: 0,
				y: 0,
			});
			expect(newIds).toHaveLength(1);

			// The clone is world-normalized on collection:
			// group(100,50) ∘ local(10,20) = world(110,70)
			const [, addedPath] = addElement.mock.calls[0] as [string, Path];
			expect(addedPath.transform).toMatchObject({ x: 110, y: 70 });

			// moveIntoEditingScope compensates it back into group-local
			// coordinates, so it renders at the same world spot as the source:
			// G⁻¹ ∘ world(110,70) = local(10,20)
			const compensation = updateElement.mock.calls.find(
				(c) => c[1] === newIds[0],
			);
			expect(
				(compensation?.[2] as { transform: unknown }).transform,
			).toMatchObject({ x: 10, y: 20 });
			expect(addElementToGroup).toHaveBeenCalledTimes(1);
			expect(addElementToGroup.mock.calls[0].slice(0, 3)).toEqual([
				"layer-1",
				"group-1",
				newIds[0],
			]);
		});

		it("clipboard paste resolves a blend's sources from the pasted array, not the document", () => {
			// Simulates pasting clipboard data whose source paths are NOT in the
			// current document (e.g. a different document, or originals deleted):
			// the sources travel in the pasted array and must still be cloned.
			const s0 = createPath("s0");
			const s1 = createPath("s1");
			const blend = {
				id: "blend-1",
				type: "blend",
				objectIds: ["s0", "s1"],
				spacing: { type: "steps", count: 3 },
				opacity: 1,
				blendMode: "normal",
				transform: createIdentityTransform(),
			} as unknown as AnyArtObject;
			const layer = createLayer("layer-1", []);
			const addElement = vi.fn();
			const createBlend = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: [],
				editingScopeStack: [],
				// Document does NOT contain the blend or its sources.
				document: { layers: [layer], objects: {} },
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					createBlend,
					transact: vi.fn((fn: () => void) => fn()),
					reorderElements: vi.fn(),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newIds = commands.pasteElements([blend, s0, s1]);
			expect(newIds).toHaveLength(1);

			expect(createBlend).toHaveBeenCalledTimes(1);
			const [, clonedBlend] = createBlend.mock.calls[0] as [
				string,
				BlendObject,
			];
			expect(clonedBlend.objectIds).toHaveLength(2);
			expect(clonedBlend.objectIds).not.toContain("s0");
			expect(clonedBlend.objectIds).not.toContain("s1");
			const addedIds = addElement.mock.calls.map(
				(c) => (c[1] as AnyArtObject).id,
			);
			expect(addedIds).toEqual(expect.arrayContaining(clonedBlend.objectIds));
		});
	});

	describe("addPath in a single-element editing scope", () => {
		it("adds new elements to the scoped element's parent group with compensation", () => {
			const groupTransform = {
				x: 100,
				y: 50,
				rotation: 0,
				scaleX: 1,
				scaleY: 1,
			};
			const child = createPath("child-1");
			const group = {
				id: "group-1",
				type: "group",
				childIds: ["child-1"],
				opacity: 1,
				blendMode: "normal",
				transform: groupTransform,
			} as unknown as AnyArtObject;
			const layer = createLayer("layer-1", ["group-1"]);
			const addElement = vi.fn();
			const addElementToGroup = vi.fn();
			const updateElement = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: [],
				// Nested single-element scope: group-1 -> child-1
				editingScopeStack: ["group-1", "child-1"],
				document: {
					layers: [layer],
					objects: { "group-1": group, "child-1": child },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					addElementToGroup,
					updateElement,
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
					getParentGroupId: (id: string) =>
						id === "child-1" ? "group-1" : null,
					// group-1 is a layer-root element with no ancestors.
					getAncestorTransform: () => null,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			const newPath = createPath("new-path");
			commands.addPath(newPath);

			// The new element reparents to the scoped element's parent group.
			expect(addElementToGroup).toHaveBeenCalledTimes(1);
			expect(addElementToGroup.mock.calls[0].slice(0, 3)).toEqual([
				"layer-1",
				"group-1",
				"new-path",
			]);
			// World position is preserved by compensating the group transform:
			// G⁻¹ ∘ world(0,0) = local(-100,-50)
			const compensation = updateElement.mock.calls.find(
				(c) => c[1] === "new-path",
			);
			expect(
				(compensation?.[2] as { transform: unknown }).transform,
			).toMatchObject({ x: -100, y: -50 });
		});

		it("keeps new elements at the layer root when the scoped element is top-level", () => {
			const scoped = createPath("scoped-path");
			const layer = createLayer("layer-1", ["scoped-path"]);
			const addElement = vi.fn();
			const addElementToGroup = vi.fn();
			const store = {
				currentLayerId: "layer-1",
				selectedElementIds: [],
				editingScopeStack: ["scoped-path"],
				document: {
					layers: [layer],
					objects: { "scoped-path": scoped },
				},
			} as unknown as RendererState;
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					addElement,
					addElementToGroup,
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
					getParentGroupId: () => null,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			commands.addPath(createPath("new-path"));

			// addElement already placed it at the layer root; nothing to move.
			expect(addElement).toHaveBeenCalledTimes(1);
			expect(addElementToGroup).not.toHaveBeenCalled();
		});
	});

	describe("collectElementsByIds ordering (selection order vs layer z-order)", () => {
		it("duplicateElementsByIds preserves layer z-order regardless of the ids argument order", () => {
			const a = createPathAt("a", 0, 0, 10, 10);
			const b = createPathAt("b", 40, 0, 50, 10);
			const c = createPathAt("c", 80, 0, 90, 10);
			// Layer z-order: a (bottom) -> b -> c (top).
			const layer = createLayer("layer-1", ["a", "b", "c"]);
			const { commands, addElement } = createCommands(layer, { a, b, c }, []);

			// Requested ids scrambled vs. z-order (mimics a marquee selection
			// returning quadtree traversal order).
			const newIds = commands.duplicateElementsByIds(["c", "a", "b"], {
				x: 0,
				y: 0,
			});
			expect(newIds).toHaveLength(3);

			// addElement must have been called in z-order (a, b, c), not the
			// requested-ids order (c, a, b). Match by geometry since pasted ids
			// are freshly minted.
			const pastedStarts = addElement.mock.calls.map(
				(call) => (call[1] as Path).segments[0].start,
			);
			expect(pastedStarts).toEqual([
				a.segments[0].start,
				b.segments[0].start,
				c.segments[0].start,
			]);
		});

		it("duplicateElements (via collectSelectedElements) preserves layer z-order regardless of selection order", () => {
			const a = createPathAt("a", 0, 0, 10, 10);
			const b = createPathAt("b", 40, 0, 50, 10);
			const c = createPathAt("c", 80, 0, 90, 10);
			const layer = createLayer("layer-1", ["a", "b", "c"]);
			// Selection order scrambled vs. z-order (e.g. shift-click order).
			const { commands, addElement } = createCommands(layer, { a, b, c }, [
				"c",
				"a",
				"b",
			]);

			const newIds = commands.duplicateElements();
			expect(newIds).toHaveLength(3);

			const pastedStarts = addElement.mock.calls.map(
				(call) => (call[1] as Path).segments[0].start,
			);
			expect(pastedStarts).toEqual([
				a.segments[0].start,
				b.segments[0].start,
				c.segments[0].start,
			]);
		});
	});

	describe("getMutationOrigin wiring", () => {
		it("should tag Yjs mutations with the origin returned by ctx.getMutationOrigin", () => {
			const reorderElements = vi.fn();
			const SESSION_ORIGIN = Symbol("session-origin");

			const commands = new PaplicoCommands({
				store: {
					currentLayerId: "layer-1",
					selectedElementIds: [],
					editingScopeStack: [],
					document: { layers: [], objects: {} },
				} as unknown as RendererState,
				yjsProvider: {
					reorderElements,
				} as unknown as YjsProvider,
				spatial: {} as unknown as SpatialIndex,
				isReadonly: () => false,
				getMutationOrigin: () => SESSION_ORIGIN,
			});

			commands.reorderElements("layer-1", 0, 1);

			expect(reorderElements).toHaveBeenCalledWith(
				"layer-1",
				0,
				1,
				SESSION_ORIGIN,
			);
		});

		it("should default to undefined origin when ctx.getMutationOrigin is not provided", () => {
			const reorderElements = vi.fn();

			const commands = new PaplicoCommands({
				store: {
					currentLayerId: "layer-1",
					selectedElementIds: [],
					editingScopeStack: [],
					document: { layers: [], objects: {} },
				} as unknown as RendererState,
				yjsProvider: {
					reorderElements,
				} as unknown as YjsProvider,
				spatial: {} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			commands.reorderElements("layer-1", 0, 1);

			expect(reorderElements).toHaveBeenCalledWith("layer-1", 0, 1, undefined);
		});
	});

	describe("rotateElements", () => {
		it("should only update rotation angle when the pivot is the element center", () => {
			const path = createPathAt("p1", 100, 100, 200, 200);
			const layer = createLayer("l1", [path.id]);
			const { commands, store } = createRotateCommands(layer, {
				[path.id]: path,
			});

			const bounds = calculateElementBounds(
				path,
				new Map(Object.entries(store.document.objects)) as ReadonlyMap<
					string,
					AnyArtObject
				>,
			);
			const cx = (bounds.minX + bounds.maxX) / 2;
			const cy = (bounds.minY + bounds.maxY) / 2;

			commands.rotateElements([path.id], 45, cx, cy);

			const updated = store.document.objects[path.id] as Path;
			expect(updated.transform.x).toBe(0);
			expect(updated.transform.y).toBe(0);
			expect(updated.transform.rotation).toBeCloseTo((45 * Math.PI) / 180);
		});

		it("should preserve existing rotation", () => {
			const path = createPathAt("p1", 0, 0, 100, 100);
			path.transform.rotation = Math.PI / 4;
			const layer = createLayer("l1", [path.id]);
			const { commands, store } = createRotateCommands(layer, {
				[path.id]: path,
			});

			commands.rotateElements([path.id], 90, 50, 50);

			const updated = store.document.objects[path.id] as Path;
			expect(updated.transform.rotation).toBeCloseTo(Math.PI / 4 + Math.PI / 2);
		});

		it("should rotate each element's visual center around the group center", () => {
			// Two elements side by side:
			// A: localBounds (0,0)-(100,100), transform=(0,0) → visualCenter=(50,50)
			// B: localBounds (0,0)-(100,100), transform=(200,0) → visualCenter=(250,50)
			const pathA = createPathAt("a", 0, 0, 100, 100);
			const pathB = createPathAt("b", 0, 0, 100, 100);
			pathB.transform.x = 200;

			const layer = createLayer("l1", [pathA.id, pathB.id]);
			const { commands, store } = createRotateCommands(layer, {
				[pathA.id]: pathA,
				[pathB.id]: pathB,
			});

			// Group BB center: visualCenter A=(50,50), B=(250,50) → groupCenter=(150,50)
			commands.rotateElements([pathA.id, pathB.id], 90, 150, 50);

			const a = store.document.objects[pathA.id] as Path;
			const b = store.document.objects[pathB.id] as Path;

			// A visual center (50,50) rotated 90° around (150,50):
			//   newVcx = 150 + (50-150)*cos90 - (50-50)*sin90 = 150
			//   newVcy = 50 + (50-150)*sin90 + (50-50)*cos90 = 50 + (-100) = -50
			//   newTx = 150 - 50 = 100, newTy = -50 - 50 = -100
			expect(a.transform.x).toBeCloseTo(100);
			expect(a.transform.y).toBeCloseTo(-100);
			expect(a.transform.rotation).toBeCloseTo(Math.PI / 2);

			// B visual center (250,50) rotated 90° around (150,50):
			//   newVcx = 150 + (250-150)*cos90 - (50-50)*sin90 = 150
			//   newVcy = 50 + (250-150)*sin90 + (50-50)*cos90 = 50 + 100 = 150
			//   newTx = 150 - 50 = 100, newTy = 150 - 50 = 100
			expect(b.transform.x).toBeCloseTo(100);
			expect(b.transform.y).toBeCloseTo(100);
			expect(b.transform.rotation).toBeCloseTo(Math.PI / 2);
		});

		it("should not move elements when rotated by 360 degrees", () => {
			const pathA = createPathAt("a", 50, 50, 150, 150);
			pathA.transform.x = 10;
			pathA.transform.y = 20;
			const layer = createLayer("l1", [pathA.id]);
			const { commands, store } = createRotateCommands(layer, {
				[pathA.id]: pathA,
			});

			commands.rotateElements([pathA.id], 360, 0, 0);

			const a = store.document.objects[pathA.id] as Path;
			expect(a.transform.x).toBeCloseTo(10);
			expect(a.transform.y).toBeCloseTo(20);
		});

		it("should handle elements with non-zero transform offset", () => {
			const path = createPathAt("p1", 0, 0, 100, 100);
			path.transform.x = 30;
			path.transform.y = 40;
			// Visual center = localCenter(50,50) + transform(30,40) = (80,90)
			const layer = createLayer("l1", [path.id]);
			const { commands, store } = createRotateCommands(layer, {
				[path.id]: path,
			});

			// Rotate 180° around (80, 90) — should return to same visual center
			commands.rotateElements([path.id], 180, 80, 90);

			const updated = store.document.objects[path.id] as Path;
			expect(updated.transform.x).toBeCloseTo(30);
			expect(updated.transform.y).toBeCloseTo(40);
			expect(updated.transform.rotation).toBeCloseTo(Math.PI);
		});

		it("should rotate group children individually instead of group transform", () => {
			// Child A: localBounds (0,0)-(100,100), center=(50,50)
			// Child B: localBounds (200,0)-(300,100), center=(250,50)
			// Group has identity transform
			const childA = createPathAt("childA", 0, 0, 100, 100);
			const childB = createPathAt("childB", 200, 0, 300, 100);
			const group = createGroup("g1", ["childA", "childB"]);
			const layer = createLayer("l1", [group.id]);
			const { commands, store } = createRotateCommands(layer, {
				[childA.id]: childA,
				[childB.id]: childB,
				[group.id]: group,
			});

			// Group visual center=(150,50), rotate 90° around it
			commands.rotateElements([group.id], 90, 150, 50);

			// Group transform should remain identity
			expect(store.document.objects[group.id]!.transform.x).toBe(0);
			expect(store.document.objects[group.id]!.transform.y).toBe(0);
			expect(store.document.objects[group.id]!.transform.rotation).toBe(0);

			// Child A visual center (50,50) rotated 90° around (150,50):
			//   newVcx = 150 + (50-150)*0 - (50-50)*1 = 150
			//   newVcy = 50 + (50-150)*1 + (50-50)*0 = -50
			//   newTx = 150 - 50 = 100, newTy = -50 - 50 = -100
			const a = store.document.objects[childA.id] as Path;
			expect(a.transform.x).toBeCloseTo(100);
			expect(a.transform.y).toBeCloseTo(-100);
			expect(a.transform.rotation).toBeCloseTo(Math.PI / 2);

			// Child B visual center (250,50) rotated 90° around (150,50):
			//   newVcx = 150 + (250-150)*0 - (50-50)*1 = 150
			//   newVcy = 50 + (250-150)*1 + (50-50)*0 = 150
			//   newTx = 150 - 250 = -100, newTy = 150 - 50 = 100
			const b = store.document.objects[childB.id] as Path;
			expect(b.transform.x).toBeCloseTo(-100);
			expect(b.transform.y).toBeCloseTo(100);
			expect(b.transform.rotation).toBeCloseTo(Math.PI / 2);
		});

		it("should rotate a group by rotating its children", () => {
			const child = createPathAt("c1", 0, 0, 100, 100);
			const group = createGroup("g1", ["c1"]);
			const layer = createLayer("l1", [group.id]);
			const { commands, store } = createRotateCommands(layer, {
				[child.id]: child,
				[group.id]: group,
			});

			// Single group rotation: rotate 90° around center (50,50)
			commands.rotateElements([group.id], 90, 50, 50);

			// Group transform stays identity
			expect(store.document.objects[group.id]!.transform.rotation).toBe(0);

			// Child center (50,50) rotated around (50,50) doesn't move
			const c = store.document.objects[child.id] as Path;
			expect(c.transform.x).toBeCloseTo(0);
			expect(c.transform.y).toBeCloseTo(0);
			expect(c.transform.rotation).toBeCloseTo(Math.PI / 2);
		});
	});

	describe("reference3d commands", () => {
		function createReference3DCommands(options: { readonly?: boolean } = {}) {
			const layer = createLayer("layer-1", []);
			const setReference3D = vi.fn();
			const addElement = vi.fn();
			const updateReference3DNodes = vi.fn();

			const store = {
				currentLayerId: layer.id,
				selectedElementIds: [],
				editingScopeStack: [],
				document: {
					layers: [layer],
					objects: {},
					references3d: {
						"scene-1": {
							id: "scene-1",
							nodes: [
								{
									id: "node-mesh",
									kind: "mesh",
									fileUid: "mesh-file",
									transform: {
										position: [0, 0, 0],
										rotation: [0, 0, 0, 1],
										scale: [1, 1, 1],
									},
								},
								{
									id: "node-box",
									kind: "primitive",
									shape: "box",
									transform: {
										position: [0, 0.5, 0],
										rotation: [0, 0, 0, 1],
										scale: [1, 1, 1],
									},
								},
							],
						},
					},
				},
			} as unknown as RendererState;

			const addFile = vi.fn(() => "file-dedup-uid");
			const commands = new PaplicoCommands({
				store,
				yjsProvider: {
					setReference3D,
					addElement,
					addFile,
					updateReference3DNodes,
					transact: vi.fn((fn: () => void) => fn()),
				} as unknown as YjsProvider,
				spatial: {
					insertElement: vi.fn(),
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => options.readonly ?? false,
			});

			return {
				commands,
				setReference3D,
				addElement,
				addFile,
				updateReference3DNodes,
			};
		}

		it("should create a shared scene (box) and a viewing element in one transaction", () => {
			const { commands, setReference3D, addElement } =
				createReference3DCommands();

			const element = commands.createReference3DScene(120, -40);

			expect(element).not.toBeNull();
			expect(setReference3D).toHaveBeenCalledOnce();
			const def = setReference3D.mock.calls[0][0];
			expect(def.nodes.map((n: { kind: string }) => n.kind)).toEqual([
				"primitive",
			]);

			expect(addElement).toHaveBeenCalledOnce();
			const [layerId, added] = addElement.mock.calls[0];
			expect(layerId).toBe("layer-1");
			expect(added.type).toBe("reference3d");
			expect(added.sceneId).toBe(def.id);
			expect(added.x).toBe(120);
			expect(added.y).toBe(-40);
		});

		it("should append a node via reference3dAddNode keeping existing nodes", () => {
			const { commands, updateReference3DNodes } = createReference3DCommands();

			commands.reference3dAddNode("scene-1", {
				id: "node-new",
				kind: "primitive",
				shape: "sphere",
				transform: {
					position: [1, 0.5, 0],
					rotation: [0, 0, 0, 1],
					scale: [1, 1, 1],
				},
			});

			const [sceneId, nodes] = updateReference3DNodes.mock.calls[0];
			expect(sceneId).toBe("scene-1");
			expect(nodes.map((n: { id: string }) => n.id)).toEqual([
				"node-mesh",
				"node-box",
				"node-new",
			]);
		});

		it("should patch only the targeted node via reference3dCommitNode", () => {
			const { commands, updateReference3DNodes } = createReference3DCommands();

			commands.reference3dCommitNode("scene-1", "node-box", {
				transform: {
					position: [2, 0.5, -1],
					rotation: [0, 0, 0, 1],
					scale: [1, 1, 1],
				},
			});

			const [, nodes] = updateReference3DNodes.mock.calls[0];
			const box = nodes.find((n: { id: string }) => n.id === "node-box");
			expect(box.transform.position).toEqual([2, 0.5, -1]);
			const mesh = nodes.find((n: { id: string }) => n.id === "node-mesh");
			expect(mesh.transform.position).toEqual([0, 0, 0]);
		});

		it("should reject all reference3d mutations while readonly", () => {
			const { commands, setReference3D, updateReference3DNodes } =
				createReference3DCommands({ readonly: true });

			expect(commands.createReference3DScene(0, 0)).toBeNull();
			commands.reference3dAddNode("scene-1", {
				id: "n",
				kind: "primitive",
				shape: "box",
				transform: {
					position: [0, 0, 0],
					rotation: [0, 0, 0, 1],
					scale: [1, 1, 1],
				},
			});
			commands.reference3dCommitNode("scene-1", "node-box", {});

			expect(setReference3D).not.toHaveBeenCalled();
			expect(updateReference3DNodes).not.toHaveBeenCalled();
		});

		it("should remove a node via reference3dRemoveNode keeping the others", () => {
			const { commands, updateReference3DNodes } = createReference3DCommands();

			commands.reference3dRemoveNode("scene-1", "node-box");

			const [sceneId, nodes] = updateReference3DNodes.mock.calls[0];
			expect(sceneId).toBe("scene-1");
			expect(nodes.map((n: { id: string }) => n.id)).toEqual(["node-mesh"]);
		});

		it("should not write when removing an unknown node", () => {
			const { commands, updateReference3DNodes } = createReference3DCommands();

			commands.reference3dRemoveNode("scene-1", "missing");

			expect(updateReference3DNodes).not.toHaveBeenCalled();
		});

		it("should duplicate a node with a new id and a position offset", () => {
			const { commands, updateReference3DNodes } = createReference3DCommands();

			const duplicate = commands.reference3dDuplicateNode(
				"scene-1",
				"node-box",
			);

			expect(duplicate).not.toBeNull();
			expect(duplicate!.id).not.toBe("node-box");
			expect(duplicate).toMatchObject({ kind: "primitive", shape: "box" });
			if (duplicate!.kind === "primitive") {
				expect(duplicate!.transform.position).toEqual([0.3, 0.5, 0.3]);
			}
			const [, nodes] = updateReference3DNodes.mock.calls[0];
			expect(nodes.at(-1)).toBe(duplicate);
			expect(nodes).toHaveLength(3);
		});

		it("should store a GLB file and append a static mesh node", () => {
			const { commands, addFile, updateReference3DNodes } =
				createReference3DCommands();

			const node = commands.reference3dAddMesh("scene-1", {
				uid: "file-original-uid",
				name: "prop.glb",
				type: "model/gltf-binary",
				hash: "sha256-prop",
				bin: new Uint8Array([1, 2, 3]),
			});

			expect(node).not.toBeNull();
			expect(addFile).toHaveBeenCalledOnce();
			expect(node).toMatchObject({
				kind: "mesh",
				fileUid: "file-dedup-uid",
			});
			const [, nodes] = updateReference3DNodes.mock.calls[0];
			expect(nodes.at(-1)).toBe(node);
		});

		it("should store the VRM file (hash-deduplicated) and append a rest-pose figure node", () => {
			const { commands, addFile, updateReference3DNodes } =
				createReference3DCommands();

			const node = commands.reference3dAddFigure("scene-1", {
				uid: "file-original-uid",
				name: "model.vrm",
				type: "model/gltf-binary",
				hash: "sha256-model",
				bin: new Uint8Array([1, 2, 3]),
			});

			expect(node).not.toBeNull();
			expect(addFile).toHaveBeenCalledOnce();
			// The node references the deduplicated uid returned by addFile.
			expect(node).toMatchObject({
				kind: "figure",
				fileUid: "file-dedup-uid",
				pose: { bones: {} },
			});
			const [, nodes] = updateReference3DNodes.mock.calls[0];
			expect(nodes.at(-1)).toBe(node);
		});
	});

	describe("updateFilterForSelectedElement", () => {
		it("should merge params updates into paramData.params even when keys collide with filter-level fields", () => {
			const { commands, updateElement } = createFilterCommands({
				uid: "filter-1",
				processor: "hk:chromatic-aberration",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: { opacity: 1, blendMode: "over", strength: 5 },
				},
			});

			commands.updateFilterForSelectedElement(0, {
				params: { opacity: 0.5, blendMode: "under" },
			});

			const [, , updates] = updateElement.mock.calls[0];
			if (!updates.filters) throw new Error("updates must contain filters");
			const updated = updates.filters[0];
			expect(updated.paramData.params).toEqual({
				opacity: 0.5,
				blendMode: "under",
				strength: 5,
			});
			expect(updated.opacity).toBe(1);
			expect(updated.blendMode).toBe("normal");
			expect(updated.paramData.version).toBe("1");
		});

		it("should apply filter-level updates without touching paramData.params", () => {
			const { commands, updateElement } = createFilterCommands({
				uid: "filter-1",
				processor: "hk:chromatic-aberration",
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: { opacity: 1, blendMode: "over", strength: 5 },
				},
			});

			commands.updateFilterForSelectedElement(0, {
				enabled: false,
				opacity: 0.25,
			});

			const [, , updates] = updateElement.mock.calls[0];
			if (!updates.filters) throw new Error("updates must contain filters");
			const updated = updates.filters[0];
			expect(updated.enabled).toBe(false);
			expect(updated.opacity).toBe(0.25);
			expect(updated.paramData.params).toEqual({
				opacity: 1,
				blendMode: "over",
				strength: 5,
			});
		});

		it("should set applyToBackdrop at the filter root without touching paramData", () => {
			const { commands, updateElement } = createFilterCommands({
				uid: "filter-1",
				processor: "blur",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: { radius: 4 } },
			});

			commands.updateFilterForSelectedElement(0, { applyToBackdrop: true });

			const [, , updates] = updateElement.mock.calls[0];
			if (!updates.filters) throw new Error("updates must contain filters");
			const updated = updates.filters[0];
			expect(updated.applyToBackdrop).toBe(true);
			expect(updated.paramData).toEqual({
				version: "1",
				params: { radius: 4 },
			});
		});
	});

	describe("removeFilterFromSelectedElement", () => {
		it("should not delete the content appearance", () => {
			const { commands, updateElement } = createFilterCommands({
				uid: "app-content",
				processor: "content",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: {} },
			});

			commands.removeFilterFromSelectedElement(0);

			expect(updateElement).not.toHaveBeenCalled();
		});

		it("should delete a non-content appearance", () => {
			const { commands, updateElement } = createFilterCommands({
				uid: "app-fill",
				processor: "fill",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: {} },
			});

			commands.removeFilterFromSelectedElement(0);

			const [, , updates] = updateElement.mock.calls[0];
			expect(updates.filters).toEqual([]);
		});
	});

	describe("object mask commands", () => {
		it("should attach an empty mask", () => {
			const { commands, updateElement } = createMaskCommands();

			commands.addMaskToElement("owner");

			const [, , updates] = updateElement.mock.calls[0];
			expect(updates.mask).toEqual({ elementIds: [] });
		});

		it("should not overwrite a mask the element already has", () => {
			const { commands, updateElement } = createMaskCommands({
				mask: { elementIds: ["m1"] },
			});

			commands.addMaskToElement("owner");

			expect(updateElement).not.toHaveBeenCalled();
		});

		it("should promote the mask content just above the element it masked", () => {
			const { commands, updateElement, addElement } = createMaskCommands({
				mask: { elementIds: ["m1", "m2"] },
				maskContent: ["m1", "m2"],
			});

			commands.removeMaskFromElement("owner");

			const [, , updates] = updateElement.mock.calls[0];
			expect(updates.mask).toBeNull();
			// Layer is [under, owner], so the content lands at 2 and 3 — above the
			// owner, in the order it had inside the mask.
			expect(
				addElement.mock.calls.map(([, element, , index]) => [
					element.id,
					index,
				]),
			).toEqual([
				["m1", 2],
				["m2", 3],
			]);
		});

		it("should leave promoted content where it appeared under the mask", () => {
			const { commands, addElement } = createMaskCommands({
				mask: { elementIds: ["m1"] },
				maskContent: ["m1"],
				// The owner is offset and scaled; the mask shape sat at its origin.
				ownerTransform: { x: 40, y: 25, rotation: 0, scaleX: 2, scaleY: 2 },
			});

			commands.removeMaskFromElement("owner");

			// Sitting at the owner's origin means inheriting the owner's placement.
			const [, promoted] = addElement.mock.calls[0];
			expect(promoted.transform).toEqual({
				x: 40,
				y: 25,
				rotation: 0,
				scaleX: 2,
				scaleY: 2,
			});
		});

		it("should offset promoted content by its position inside the mask", () => {
			const { commands, addElement } = createMaskCommands({
				mask: { elementIds: ["m1"] },
				maskContent: ["m1"],
				ownerTransform: { x: 40, y: 25, rotation: 0, scaleX: 2, scaleY: 2 },
				contentTransform: { x: 10, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			});

			commands.removeMaskFromElement("owner");

			// 10 to the right in the owner's space, which the owner doubles.
			const [, promoted] = addElement.mock.calls[0];
			expect(promoted.transform.x).toBe(60);
			expect(promoted.transform.y).toBe(25);
		});

		it("should keep the drawn content when the mask is only disabled", () => {
			const { commands, updateElement, addElement } = createMaskCommands({
				mask: { elementIds: ["m1"] },
				maskContent: ["m1"],
			});

			commands.setMaskEnabled("owner", false);

			const [, , updates] = updateElement.mock.calls[0];
			expect(updates.mask).toEqual({ elementIds: ["m1"], enabled: false });
			expect(addElement).not.toHaveBeenCalled();
		});

		it("should flip the mask without touching its content", () => {
			const { commands, updateElement } = createMaskCommands({
				mask: { elementIds: ["m1"], enabled: true },
			});

			commands.setMaskInverted("owner", true);

			const [, , updates] = updateElement.mock.calls[0];
			expect(updates.mask).toEqual({
				elementIds: ["m1"],
				enabled: true,
				inverted: true,
			});
		});

		it("should give a copied element its own mask content", () => {
			const owner = {
				...createPath("owner"),
				mask: { elementIds: ["m1"] },
			};
			const maskShape = createPath("m1");
			const layer = createLayer("layer-1", [owner.id]);
			const addElement = vi.fn<YjsProvider["addElement"]>();
			const addObjectOnly = vi.fn<YjsProvider["addObjectOnly"]>();

			const commands = new PaplicoCommands({
				store: {
					currentLayerId: layer.id,
					selectedElementIds: [owner.id],
					editingScopeStack: [],
					animationMode: false,
					document: {
						layers: [layer],
						objects: { owner, m1: maskShape },
					},
				} as unknown as RendererState,
				yjsProvider: {
					addElement,
					addObjectOnly,
					addElementToGroup: vi.fn(),
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					isElementLocked: () => false,
					getAncestorTransform: () => null,
					insertElement: vi.fn(),
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			commands.pasteElements([owner, maskShape], { offset: { x: 50, y: 0 } });

			// The copy must not point back at the original's shape: sharing it
			// makes one mask serve two elements, and moving either drags the
			// other's mask with it.
			const [, pastedOwner] = addElement.mock.calls[0];
			const [pastedMaskShape] = addObjectOnly.mock.calls[0];
			expect(pastedMaskShape.id).not.toBe("m1");
			expect(pastedOwner.mask?.elementIds).toEqual([pastedMaskShape.id]);
			// Mask content is never listed in a layer.
			expect(
				addElement.mock.calls.map(([, element]) => element.id),
			).not.toContain(pastedMaskShape.id);
		});

		it("should do nothing when the element has no mask", () => {
			const { commands, updateElement } = createMaskCommands();

			commands.setMaskInverted("owner", true);

			expect(updateElement).not.toHaveBeenCalled();
		});
	});

	describe("updateSelectedElementsStrokeColor", () => {
		it("should keep the existing appearance's opacity, blend mode and sub-filters", () => {
			const path = createPath("path-1");
			path.filters = [existingStrokeAppearance()];
			const layer = createLayer("layer-1", [path.id]);
			const updateElement = vi.fn();

			const commands = new PaplicoCommands({
				store: {
					currentLayerId: layer.id,
					selectedElementIds: [path.id],
					editingScopeStack: [],
					document: { layers: [layer], objects: { [path.id]: path } },
				} as unknown as RendererState,
				yjsProvider: {
					updateElement,
					transact: vi.fn((fn: () => void) => fn()),
					isAnimationUndoMode: vi.fn(() => false),
				} as unknown as YjsProvider,
				spatial: {
					isElementLocked: () => false,
				} as unknown as SpatialIndex,
				isReadonly: () => false,
			});

			commands.updateSelectedElementsStrokeColor({
				type: "solid",
				color: toRGBColor({ r: 1, g: 0, b: 0, a: 0.5 }),
			});

			const filters = updateElement.mock.calls[0][2].filters as Filter[];
			const stroke = filters[0] as StrokeAppearance;
			expect(stroke.uid).toBe("app-stroke");
			expect(stroke.opacity).toBe(0.3);
			expect(stroke.blendMode).toBe("multiply");
			expect(stroke.subFilters).toHaveLength(1);
			expect(stroke.paramData.params.strokeColor).toEqual({
				type: "solid",
				color: toRGBColor({ r: 1, g: 0, b: 0, a: 0.5 }),
			});
		});
	});
});

/** Stroke appearance the user has already customized beyond its color. */
function existingStrokeAppearance(): StrokeAppearance {
	return {
		uid: "app-stroke",
		processor: "stroke",
		opacity: 0.3,
		blendMode: "multiply",
		subFilters: [
			{
				uid: "sub-blur",
				processor: "blur",
				opacity: 1,
				blendMode: "normal",
				paramData: { version: "1", params: {} },
			},
		],
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: toRGBColor({ r: 0, g: 0, b: 0, a: 1 }),
				},
				brushSettings: createDefaultBrushSettings(),
			},
		},
	};
}

describe("cut/copy of axis-bound texts", () => {
	const createBoundText = (
		id: string,
		pathObjectId: string,
		next?: string,
	): AnyArtObject =>
		({
			type: "text",
			id,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			x: 0,
			y: 0,
			content: { paragraphs: [{ runs: [{ text: "hi", style: {} }] }] },
			defaultStyle: {},
			layout: {},
			axisBinding: {
				mode: "onPath",
				pathObjectId,
			},
			flow: next ? { nextTextElementId: next } : undefined,
		}) as unknown as AnyArtObject;

	const createCutHarness = (
		objects: Record<string, AnyArtObject>,
		selectedIds: string[],
	) => {
		const layer = createLayer("layer-1", Object.keys(objects));
		const deleteElements = vi.fn();
		const updateElement = vi.fn();

		const store = {
			currentLayerId: layer.id,
			selectedElementIds: [...selectedIds],
			editingScopeStack: [],
			document: { layers: [layer], objects },
		} as unknown as RendererState;

		const commands = new PaplicoCommands({
			store,
			yjsProvider: {
				deleteElements,
				updateElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				isElementLocked: () => false,
				getAncestorTransform: () => null,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
		});

		return { commands, deleteElements, layerId: layer.id };
	};

	it("cut deletes chain texts together with their exclusively-bound axis paths", async () => {
		const pA = createPath("pA");
		const pB = createPath("pB");
		const tA = createBoundText("tA", "pA", "tB");
		const tB = createBoundText("tB", "pB");
		const { commands, deleteElements, layerId } = createCutHarness(
			{ pA, pB, tA, tB },
			["tA", "tB"],
		);

		await commands.cutSelectedToClipboard();

		expect(deleteElements).toHaveBeenCalledTimes(1);
		const byLayer = deleteElements.mock.calls[0][0] as Record<string, string[]>;
		expect([...byLayer[layerId]].sort()).toEqual(["pA", "pB", "tA", "tB"]);
	});

	it("cut keeps an axis path still bound by a surviving text", async () => {
		const pShared = createPath("pShared");
		const tA = createBoundText("tA", "pShared");
		const tOther = createBoundText("tOther", "pShared");
		const { commands, deleteElements, layerId } = createCutHarness(
			{ pShared, tA, tOther },
			["tA"],
		);

		await commands.cutSelectedToClipboard();

		const byLayer = deleteElements.mock.calls[0][0] as Record<string, string[]>;
		expect(byLayer[layerId]).toEqual(["tA"]);
	});

	it("duplicate carries the axis path and rebinds the clone to it", () => {
		const pA = createPath("pA");
		const tA = createBoundText("tA", "pA");
		const layer = createLayer("layer-1", ["pA", "tA"]);
		const { commands, addElement } = createCommands(
			layer,
			{ pA, tA } as Record<string, ReturnType<typeof createPath>>,
			["tA"],
		);

		commands.duplicateElements();

		const added = addElement.mock.calls.map((c) => c[1] as AnyArtObject);
		const addedText = added.find((el) => el.type === "text") as TextElement;
		const addedPath = added.find((el) => el.type === "path");
		expect(addedPath).toBeDefined();
		expect(addedPath!.id).not.toBe("pA");
		expect(addedText.axisBinding?.pathObjectId).toBe(addedPath!.id);
	});
});

describe("flow-aware cut of chain members", () => {
	const regionLayout = {
		boxWidth: 40,
		boxHeight: 30,
		wordWrap: true,
		overflow: "hidden",
	} as const;

	const createFlowHarness = (
		objects: Record<string, TextElement>,
		selectedIds: string[],
	) => {
		const renderer = new TextRenderer(
			new TextLayoutEngine(createMockFontManager()),
		);
		renderer.setDocumentResolver({
			getElementById: (id) => objects[id] ?? null,
			getWorldSegments: () => null,
			getGeometryRevision: () => 0,
			findFlowSource: (textId) =>
				Object.values(objects).find(
					(el) => el.flow?.nextTextElementId === textId,
				) ?? null,
		});

		const layer = createLayer("layer-1", Object.keys(objects));
		const deleteElements = vi.fn();
		const updateElement = vi.fn();

		const store = {
			currentLayerId: layer.id,
			selectedElementIds: [...selectedIds],
			editingScopeStack: [],
			document: { layers: [layer], objects },
		} as unknown as RendererState;

		const commands = new PaplicoCommands({
			store,
			yjsProvider: {
				deleteElements,
				updateElement,
				transact: vi.fn((fn: () => void) => fn()),
				isAnimationUndoMode: vi.fn(() => false),
			} as unknown as YjsProvider,
			spatial: {
				isElementLocked: () => false,
				getAncestorTransform: () => null,
			} as unknown as SpatialIndex,
			isReadonly: () => false,
			getTextRenderer: () => renderer,
		});

		return { commands, deleteElements, updateElement, layerId: layer.id };
	};

	it("cutting the tail takes its flowed-in text along", async () => {
		// 8 chars at 10px in a 40px-wide single-line region: 4 stay on the
		// head, 4 flow into the tail
		const head = createTestTextElement("aaaaaaaa", {
			id: "head",
			layout: regionLayout,
			flow: { nextTextElementId: "tail" },
		});
		const tail = createTestTextElement("", {
			id: "tail",
			y: -100,
			layout: regionLayout,
		});
		const { commands, deleteElements, updateElement, layerId } =
			createFlowHarness({ head, tail }, ["tail"]);

		await commands.cutSelectedToClipboard();

		const truncation = updateElement.mock.calls.find((c) => c[1] === "head");
		const content = truncation?.[2].content as TextElement["content"];
		expect(content.paragraphs[0].runs[0].text).toBe("aaaa");
		expect(deleteElements.mock.calls[0][0][layerId]).toEqual(["tail"]);
	});

	it("cutting a middle region splices the flow and keeps the content", async () => {
		const a = createTestTextElement("aaaaaaaa", {
			id: "a",
			layout: regionLayout,
			flow: { nextTextElementId: "b" },
		});
		const b = createTestTextElement("", {
			id: "b",
			layout: regionLayout,
			flow: { nextTextElementId: "c" },
		});
		const c = createTestTextElement("", { id: "c", layout: regionLayout });
		const { commands, updateElement } = createFlowHarness({ a, b, c }, ["b"]);

		await commands.cutSelectedToClipboard();

		const spliced = updateElement.mock.calls.find((call) => call[1] === "a");
		expect(spliced?.[2].flow).toEqual({ nextTextElementId: "c" });
		// No content truncation for a middle cut
		expect(
			updateElement.mock.calls.some((call) => call[2].content != null),
		).toBe(false);
	});
});

describe("undo/redo routing", () => {
	function makeCommands(
		session: { undo: () => boolean; redo: () => boolean } | null,
	) {
		const providerUndo = vi.fn();
		const providerRedo = vi.fn();
		const commands = new PaplicoCommands({
			store: {
				document: { layers: [], objects: {} },
			} as unknown as RendererState,
			yjsProvider: {
				undo: providerUndo,
				redo: providerRedo,
			} as unknown as YjsProvider,
			spatial: {} as unknown as SpatialIndex,
			isReadonly: () => false,
			getSessionHistory: () => session,
		});
		return { commands, providerUndo, providerRedo };
	}

	it("should undo the document when no editing session is open", () => {
		const { commands, providerUndo } = makeCommands(null);

		commands.undo();

		expect(providerUndo).toHaveBeenCalledTimes(1);
	});

	it("should undo the session, not the document, while one is open", () => {
		// A session's edits carry an origin the main UndoManager does not track,
		// so sending undo to the document would skip past them and revert an
		// unrelated earlier edit instead.
		const session = { undo: vi.fn(() => true), redo: vi.fn(() => true) };
		const { commands, providerUndo } = makeCommands(session);

		commands.undo();

		expect(session.undo).toHaveBeenCalledTimes(1);
		expect(providerUndo).not.toHaveBeenCalled();
	});

	it("should redo the session, not the document, while one is open", () => {
		const session = { undo: vi.fn(() => true), redo: vi.fn(() => true) };
		const { commands, providerRedo } = makeCommands(session);

		commands.redo();

		expect(session.redo).toHaveBeenCalledTimes(1);
		expect(providerRedo).not.toHaveBeenCalled();
	});
});

describe("deleteSelectedGradientStop", () => {
	it("deletes a linear-gradient stop at the selected index", () => {
		const filter = createLinearGradientFilter([
			{
				offset: 0,
				color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 0.5,
				color: toRGBColor({ r: 0, g: 1, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 1,
				color: toRGBColor({ r: 0, g: 0, b: 1, a: 1 }),
				midpoint: 0.5,
			},
		]);
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: null,
			gradientSelectedStopIndex: 1,
		} as ToolSettings);

		const result = commands.deleteSelectedGradientStop();

		expect(result).toBe(true);
		expect(updateElement).toHaveBeenCalledTimes(1);
		const [, , patch] = updateElement.mock.calls[0];
		const updatedFilter = (patch as { filters: FillAppearance[] }).filters[0];
		const updatedFill = updatedFilter.paramData.params.fill as LinearGradient;
		expect(updatedFill.stops.map((s) => s.offset)).toEqual([0, 1]);
	});

	it("refuses to delete a linear-gradient stop when only two remain", () => {
		const filter = createLinearGradientFilter([
			{
				offset: 0,
				color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 1,
				color: toRGBColor({ r: 0, g: 0, b: 1, a: 1 }),
				midpoint: 0.5,
			},
		]);
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: null,
			gradientSelectedStopIndex: 0,
		} as ToolSettings);

		const result = commands.deleteSelectedGradientStop();

		expect(result).toBe(false);
		expect(updateElement).not.toHaveBeenCalled();
	});

	it("refuses to delete when no gradient stop is selected", () => {
		const filter = createLinearGradientFilter([
			{
				offset: 0,
				color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 0.5,
				color: toRGBColor({ r: 0, g: 1, b: 0, a: 1 }),
				midpoint: 0.5,
			},
			{
				offset: 1,
				color: toRGBColor({ r: 0, g: 0, b: 1, a: 1 }),
				midpoint: 0.5,
			},
		]);
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: null,
			gradientSelectedStopIndex: null,
		} as ToolSettings);

		const result = commands.deleteSelectedGradientStop();

		expect(result).toBe(false);
		expect(updateElement).not.toHaveBeenCalled();
	});

	it("deletes a radial-gradient stop at the selected index", () => {
		const filter: FillAppearance = {
			uid: "fill-app",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "radial",
						cx: 0.5,
						cy: 0.5,
						radiusX: 0.5,
						radiusY: 0.5,
						rotation: 0,
						stops: [
							{
								offset: 0,
								color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
								midpoint: 0.5,
							},
							{
								offset: 0.5,
								color: toRGBColor({ r: 0, g: 1, b: 0, a: 1 }),
								midpoint: 0.5,
							},
							{
								offset: 1,
								color: toRGBColor({ r: 0, g: 0, b: 1, a: 1 }),
								midpoint: 0.5,
							},
						],
					} satisfies RadialGradient,
				},
			},
		};
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: null,
			gradientSelectedStopIndex: 1,
		} as ToolSettings);

		const result = commands.deleteSelectedGradientStop();

		expect(result).toBe(true);
		const [, , patch] = updateElement.mock.calls[0];
		const updatedFilter = (patch as { filters: FillAppearance[] }).filters[0];
		const updatedFill = updatedFilter.paramData.params.fill as RadialGradient;
		expect(updatedFill.stops.map((s) => s.offset)).toEqual([0, 1]);
	});

	it("refuses to delete an implicit mesh-gradient vertex", () => {
		const fill = {
			type: "mesh",
			vertices: [
				{
					x: 0,
					y: 0,
					color: toRGBColor({ r: 1, g: 0, b: 0, a: 1 }),
					colorMode: "explicit",
					handles: {},
				},
				{
					x: 1,
					y: 0,
					color: toRGBColor({ r: 0, g: 1, b: 0, a: 1 }),
					colorMode: "explicit",
					handles: {},
				},
				{
					x: 1,
					y: 1,
					color: toRGBColor({ r: 0, g: 0, b: 1, a: 1 }),
					colorMode: "explicit",
					handles: {},
				},
				{
					x: 0,
					y: 1,
					color: toRGBColor({ r: 1, g: 1, b: 1, a: 1 }),
					colorMode: "explicit",
					handles: {},
				},
				{
					x: 0.5,
					y: 0,
					color: toRGBColor({ r: 0.5, g: 0.5, b: 0, a: 1 }),
					colorMode: "derived",
					colorSource: { kind: "edge", edgeVerts: [0, 1], t: 0.5 },
					positionSource: { edgeVerts: [0, 1], t: 0.5 },
					meshSource: { edgeVerts: [0, 1], t: 0.5 },
					handles: {},
				},
			],
			faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
		} satisfies MeshGradient;
		const filter: FillAppearance = {
			uid: "fill-app",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		};
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: "mesh-vertex:4",
			gradientSelectedStopIndex: null,
		} as ToolSettings);

		expect(commands.deleteSelectedGradientStop()).toBe(false);
		expect(updateElement).not.toHaveBeenCalled();
	});

	it("deletes an added mesh-gradient stop even when a later subdivision exists", () => {
		const color = toRGBColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
		const fill = {
			type: "mesh",
			vertices: [
				{ x: 0, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 1, color, colorMode: "explicit", handles: {} },
				{ x: 0, y: 1, color, colorMode: "explicit", handles: {} },
				{
					x: 0.5,
					y: 0.5,
					color,
					colorMode: "explicit",
					handles: {},
					subdivisionId: 1,
					subdivisionSource: {
						id: 1,
						vertexCount: 4,
						faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
					},
				},
				{
					x: 0.5,
					y: 0,
					color,
					colorMode: "derived",
					handles: {},
					splitLineId: 1,
					subdivisionId: 2,
				},
				{
					x: 1,
					y: 0.5,
					color,
					colorMode: "derived",
					handles: {},
					splitLineId: 2,
				},
				{
					x: 0.5,
					y: 1,
					color,
					colorMode: "derived",
					handles: {},
					splitLineId: 1,
				},
				{
					x: 0,
					y: 0.5,
					color,
					colorMode: "derived",
					handles: {},
					splitLineId: 2,
				},
			],
			faces: [
				{ type: "quad", verts: [0, 5, 4, 8] },
				{ type: "quad", verts: [5, 1, 6, 4] },
				{ type: "quad", verts: [4, 6, 2, 7] },
				{ type: "quad", verts: [8, 4, 7, 3] },
			],
		} satisfies MeshGradient;
		const filter: FillAppearance = {
			uid: "fill-app",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		};
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: "mesh-vertex:4",
			gradientSelectedStopIndex: null,
		} as ToolSettings);

		expect(commands.deleteSelectedGradientStop()).toBe(true);
		expect(updateElement).toHaveBeenCalledOnce();
		const [, , patch] = updateElement.mock.calls[0];
		const updatedFilter = (patch as { filters: FillAppearance[] }).filters[0];
		const updatedFill = updatedFilter.paramData.params.fill as MeshGradient;
		expect(
			updatedFill.vertices.filter((vertex) => vertex.colorMode === "explicit"),
		).toHaveLength(4);
		expect(updatedFill.faces.length).toBeGreaterThan(0);
	});

	it("deletes the whole split line when deleting a derived mesh vertex", () => {
		const color = toRGBColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
		const fill = {
			type: "mesh",
			vertices: [
				{ x: 0, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 1, color, colorMode: "explicit", handles: {} },
				{ x: 0, y: 1, color, colorMode: "explicit", handles: {} },
				// One inserted cut: a derived vertex on the bottom edge and its
				// sibling on the top edge, sharing the split line.
				{
					x: 0.5,
					y: 0,
					color,
					colorMode: "derived",
					positionSource: { edgeVerts: [0, 1], t: 0.5 },
					handles: {},
					splitLineId: 1,
					subdivisionId: 1,
				},
				{
					x: 0.5,
					y: 1,
					color,
					colorMode: "derived",
					positionSource: { edgeVerts: [3, 2], t: 0.5 },
					handles: {},
					splitLineId: 1,
					subdivisionId: 1,
				},
			],
			faces: [
				{ type: "quad", verts: [0, 4, 5, 3] },
				{ type: "quad", verts: [4, 1, 2, 5] },
			],
		} satisfies MeshGradient;
		const filter: FillAppearance = {
			uid: "fill-app",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		};
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: "mesh-vertex:4",
			gradientSelectedStopIndex: null,
		} as ToolSettings);

		expect(commands.deleteSelectedGradientStop()).toBe(true);
		const [, , patch] = updateElement.mock.calls[0];
		const updatedFilter = (patch as { filters: FillAppearance[] }).filters[0];
		const updatedFill = updatedFilter.paramData.params.fill as MeshGradient;
		// Both line vertices go, and the two faces merge back into one quad.
		expect(updatedFill.vertices).toHaveLength(4);
		expect(updatedFill.faces).toHaveLength(1);
		expect(updatedFill.faces[0].type).toBe("quad");
	});

	it("returns a color-promoted mesh-gradient vertex to derived instead of removing it", () => {
		const color = toRGBColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 });
		const fill = {
			type: "mesh",
			vertices: [
				{ x: 0, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 0, color, colorMode: "explicit", handles: {} },
				{ x: 1, y: 1, color, colorMode: "explicit", handles: {} },
				{ x: 0, y: 1, color, colorMode: "explicit", handles: {} },
				// Cut on the bottom edge, then given a color of its own.
				{
					x: 0.5,
					y: 0,
					color,
					colorMode: "explicit",
					handles: {},
					subdivisionId: 1,
				},
				{
					x: 0.5,
					y: 1,
					color,
					colorMode: "derived",
					handles: {},
					splitLineId: 1,
				},
			],
			faces: [
				{ type: "quad", verts: [0, 4, 5, 3] },
				{ type: "quad", verts: [4, 1, 2, 5] },
			],
		} satisfies MeshGradient;
		const filter: FillAppearance = {
			uid: "fill-app",
			processor: "fill",
			opacity: 1,
			blendMode: "normal",
			paramData: { version: "1", params: { fill } },
		};
		const { commands, updateElement } = createFilterCommands(filter, {
			gradientSelectedStopId: "mesh-vertex:4",
			gradientSelectedStopIndex: null,
		} as ToolSettings);

		expect(commands.deleteSelectedGradientStop()).toBe(true);
		const [, , patch] = updateElement.mock.calls[0];
		const updatedFilter = (patch as { filters: FillAppearance[] }).filters[0];
		const updatedFill = updatedFilter.paramData.params.fill as MeshGradient;
		// The vertex stays, bound to the bottom edge again.
		expect(updatedFill.vertices).toHaveLength(6);
		expect(updatedFill.faces).toHaveLength(2);
		expect(updatedFill.vertices[4].colorMode).toBe("derived");
		expect(updatedFill.vertices[4].positionSource?.edgeVerts).toEqual([0, 1]);
	});
});

describe("computePerspectiveWarpUpdates (vertex bake)", () => {
	// A 100×100 quad in TL, TR, BR, BL order.
	const SOURCE: [Vec2, Vec2, Vec2, Vec2] = [
		[0, 100],
		[100, 100],
		[100, 0],
		[0, 0],
	];
	// Pull the TR corner outward — a genuine projective (non-affine) warp.
	const TARGET: [Vec2, Vec2, Vec2, Vec2] = [
		[0, 100],
		[150, 150],
		[100, 0],
		[0, 0],
	];

	it("should bake projected segments into a path and keep its transform resolved", () => {
		const path = createPathAt("path-1", 0, 0, 100, 100);
		const layer = createLayer("layer-1", [path.id]);
		const { commands } = createCommands(layer, { [path.id]: path }, [path.id]);

		const updates = commands.computePerspectiveWarpUpdates(
			[path.id],
			TARGET,
			SOURCE,
		);

		expect(updates).toHaveLength(1);
		const patch = updates[0].updates as Partial<Path>;
		expect(patch.segments).toBeDefined();
		if (!patch.segments) return;
		// The anchor that sat on the source TR corner (100, 100) lands on the
		// dragged target corner. Adaptive subdivision may add segments, so
		// search all anchors.
		const anchors: Array<{ x: number; y: number }> = [];
		for (const seg of patch.segments) {
			if (seg.start) anchors.push(seg.start);
			anchors.push(seg.end);
		}
		expect(
			anchors.some(
				(a) => Math.abs(a.x - 150) < 1e-4 && Math.abs(a.y - 150) < 1e-4,
			),
		).toBe(true);
		// Control-point re-fitting keeps the vertex count sane: a warped
		// 4-segment rectangle must not explode into subdivision leaves.
		expect(patch.segments.length).toBeLessThanOrEqual(8);
		// Identity-transform element: the re-resolved transform stays identity.
		expect(patch.transform?.x).toBeCloseTo(0, 6);
		expect(patch.transform?.y).toBeCloseTo(0, 6);
	});

	it("should scale stroke widths by the warp's uniform area scale", () => {
		// 2x uniform enlargement of the source quad: area ratio 4, width scale 2.
		const scaled2x: [Vec2, Vec2, Vec2, Vec2] = [
			[0, 200],
			[200, 200],
			[200, 0],
			[0, 0],
		];
		const path = {
			...createPathAt("path-1", 0, 0, 100, 100),
			filters: [existingStrokeAppearance()],
		};
		const layer = createLayer("layer-1", [path.id]);
		const { commands } = createCommands(layer, { [path.id]: path }, [path.id]);

		const updates = commands.computePerspectiveWarpUpdates(
			[path.id],
			scaled2x,
			SOURCE,
		);

		const stroke = (updates[0].updates as Partial<Path>)
			.filters?.[0] as StrokeAppearance;
		expect(
			readStoredBrushSize(stroke.paramData.params.brushSettings),
		).toBeCloseTo(createDefaultBrushSettings().size * 2, 6);
	});

	it("should keep stroke widths under an area-preserving shear", () => {
		// Horizontal shear of the top edge: a parallelogram with unchanged area.
		const sheared: [Vec2, Vec2, Vec2, Vec2] = [
			[50, 100],
			[150, 100],
			[100, 0],
			[0, 0],
		];
		const path = {
			...createPathAt("path-1", 0, 0, 100, 100),
			filters: [existingStrokeAppearance()],
		};
		const layer = createLayer("layer-1", [path.id]);
		const { commands } = createCommands(layer, { [path.id]: path }, [path.id]);

		const updates = commands.computePerspectiveWarpUpdates(
			[path.id],
			sheared,
			SOURCE,
		);

		const stroke = (updates[0].updates as Partial<Path>)
			.filters?.[0] as StrokeAppearance;
		expect(
			readStoredBrushSize(stroke.paramData.params.brushSettings),
		).toBeCloseTo(createDefaultBrushSettings().size, 6);
	});

	it("should bake warped corner vertices into an image", () => {
		const image = {
			type: "image",
			id: "img-1",
			fileUid: "file-1",
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		} as unknown as ReturnType<typeof createPath>;
		const layer = createLayer("layer-1", ["img-1"]);
		const { commands } = createCommands(layer, { "img-1": image }, ["img-1"]);

		const updates = commands.computePerspectiveWarpUpdates(
			["img-1"],
			TARGET,
			SOURCE,
		);

		expect(updates).toHaveLength(1);
		const corners = (
			updates[0].updates as { corners: [Vec2, Vec2, Vec2, Vec2] }
		).corners;
		expect(corners[1][0]).toBeCloseTo(150, 4);
		expect(corners[1][1]).toBeCloseTo(150, 4);
		expect(corners[3][0]).toBeCloseTo(0, 4);
		expect(corners[3][1]).toBeCloseTo(0, 4);
	});

	it("should compose a re-warp on an image's existing corners", () => {
		const image = {
			type: "image",
			id: "img-1",
			fileUid: "file-1",
			x: 50,
			y: 50,
			width: 100,
			height: 100,
			// Previously baked warp equal to the source quad: a re-warp maps the
			// stored corners exactly onto the new target quad.
			corners: SOURCE,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		} as unknown as ReturnType<typeof createPath>;
		const layer = createLayer("layer-1", ["img-1"]);
		const { commands } = createCommands(layer, { "img-1": image }, ["img-1"]);

		const updates = commands.computePerspectiveWarpUpdates(
			["img-1"],
			TARGET,
			SOURCE,
		);

		const corners = (
			updates[0].updates as { corners: [Vec2, Vec2, Vec2, Vec2] }
		).corners;
		for (let i = 0; i < 4; i++) {
			expect(corners[i][0]).toBeCloseTo(TARGET[i][0], 4);
			expect(corners[i][1]).toBeCloseTo(TARGET[i][1], 4);
		}
	});

	it("should warp a mesh cage's vertices and handles while leaving src alone", () => {
		const mesh = {
			type: "mesh",
			id: "mesh-1",
			childIds: [],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			vertices: [
				{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
				{
					x: 100,
					y: 0,
					src: { x: 100, y: 0 },
					handles: { 2: { x: 100, y: 33 } },
				},
				{ x: 100, y: 100, src: { x: 100, y: 100 }, handles: {} },
				{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
			],
			faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
		} as unknown as ReturnType<typeof createPath>;
		const layer = createLayer("layer-1", ["mesh-1"]);
		const { commands } = createCommands(layer, { "mesh-1": mesh }, ["mesh-1"]);

		const updates = commands.computePerspectiveWarpUpdates(
			["mesh-1"],
			TARGET,
			SOURCE,
		);

		expect(updates).toHaveLength(1);
		const patch = updates[0].updates as {
			vertices: Array<{
				x: number;
				y: number;
				src: { x: number; y: number };
				handles: Record<number, { x: number; y: number }>;
			}>;
			width?: number;
			height?: number;
		};
		// The dragged TR corner carries the cage vertex that sat on it.
		expect(patch.vertices[2].x).toBeCloseTo(150, 4);
		expect(patch.vertices[2].y).toBeCloseTo(150, 4);
		// Handles ride along...
		expect(patch.vertices[1].handles[2].x).toBeGreaterThan(100);
		// ...but the immutable source parametrization never moves — the
		// children's warp is measured against it.
		for (let i = 0; i < 4; i++) {
			expect(patch.vertices[i].src).toEqual(
				(mesh as unknown as { vertices: Array<{ src: unknown }> }).vertices[i]
					.src,
			);
		}
		// The container model has no width/height; writing them would go
		// straight past Yjs serialization and desync collaborators.
		expect("width" in patch).toBe(false);
		expect("height" in patch).toBe(false);
	});

	it("should skip text elements (the tool outlines them first)", () => {
		const text = {
			type: "text",
			id: "text-1",
			x: 0,
			y: 0,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		} as unknown as ReturnType<typeof createPath>;
		const layer = createLayer("layer-1", ["text-1"]);
		const { commands } = createCommands(layer, { "text-1": text }, ["text-1"]);

		const updates = commands.computePerspectiveWarpUpdates(
			["text-1"],
			TARGET,
			SOURCE,
		);

		expect(updates).toHaveLength(0);
	});
});

function createLinearGradientFilter(
	stops: LinearGradient["stops"],
): FillAppearance {
	return {
		uid: "fill-app",
		processor: "fill",
		opacity: 1,
		blendMode: "normal",
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "linear",
					x1: 0,
					y1: 0.5,
					x2: 1,
					y2: 0.5,
					stops,
				} satisfies LinearGradient,
			},
		},
	};
}

function createPathAt(
	id: string,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): Path {
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x: x1, y: y1 },
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x2, y: y1 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x2, y: y2 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x1, y: y2 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
			{
				cp1: { x: 0, y: 0 },
				cp2: { x: 0, y: 0 },
				end: { x: x1, y: y1 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
				isClosed: true,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function createRotateCommands(
	layer: Layer,
	objects: Record<string, AnyArtObject>,
) {
	const updateElement = vi.fn(
		(_layerId: string, elementId: string, updates: Partial<AnyArtObject>) => {
			const obj = store.document.objects[elementId];
			if (obj) Object.assign(obj, { ...obj, ...updates });
		},
	);
	const batchUpdateElements = vi.fn(
		(
			elementUpdates: Array<{
				elementId: string;
				updates: Partial<AnyArtObject>;
			}>,
		) => {
			for (const { elementId, updates } of elementUpdates) {
				const obj = store.document.objects[elementId];
				if (obj) Object.assign(obj, { ...obj, ...updates });
			}
		},
	);

	const store = {
		currentLayerId: layer.id,
		selectedElementIds: Object.keys(objects),
		editingScopeStack: [],
		animationMode: false,
		document: {
			layers: [layer],
			objects: { ...objects },
		},
	} as unknown as RendererState;

	const commands = new PaplicoCommands({
		store,
		yjsProvider: {
			updateElement,
			batchUpdateElements,
			transact: vi.fn((fn: () => void) => fn()),
			isAnimationUndoMode: vi.fn(() => false),
		} as unknown as YjsProvider,
		spatial: {
			invalidateBounds: vi.fn(),
			isElementLocked: () => false,
			insertElement: vi.fn(),
			removeElement: vi.fn(),
			getBounds: vi.fn(() => null),
			getAncestorTransform: vi.fn(() => null),
			getParentGroupId: vi.fn(() => null),
		} as unknown as SpatialIndex,
		isReadonly: () => false,
	});

	return { commands, store, updateElement, batchUpdateElements };
}

function createPath(id: string): Path {
	return {
		type: "path",
		id,
		segments: [
			{
				start: { x: 0, y: 0 },
				cp1: { x: 10, y: 5 },
				cp2: { x: -8, y: -4 },
				end: { x: 100, y: 0 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: true,
			},
			{
				cp1: { x: 20, y: 12 },
				cp2: { x: -15, y: 8 },
				end: { x: 150, y: 40 },
				startTiltX: 0,
				startTiltY: 0,
				endTiltX: 0,
				endTiltY: 0,
				startDeltaTime: 0,
				endDeltaTime: 0,
				isMoved: false,
			},
		],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function createGroup(id: string, childIds: string[]): Group {
	return {
		type: "group",
		id,
		childIds,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	} as Group;
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

function createCommands(
	layer: Layer,
	objects: Record<string, ReturnType<typeof createPath>>,
	selectedIds: string[],
) {
	const addElement = vi.fn();
	const reorderElements = vi.fn();
	const insertElement = vi.fn();

	const store = {
		currentLayerId: layer.id,
		selectedElementIds: [...selectedIds],
		editingScopeStack: [],
		animationMode: false,
		document: {
			layers: [layer],
			objects,
		},
	} as unknown as RendererState;

	const commands = new PaplicoCommands({
		store,
		yjsProvider: {
			addElement,
			reorderElements,
			transact: vi.fn((fn: () => void) => fn()),
			isAnimationUndoMode: vi.fn(() => false),
		} as unknown as YjsProvider,
		spatial: {
			insertElement,
			isElementLocked: () => false,
			getAncestorTransform: () => null,
		} as unknown as SpatialIndex,
		isReadonly: () => false,
	});

	return { commands, store, addElement, reorderElements, insertElement };
}

function createFilterCommands(filter: Filter, toolSettings?: ToolSettings) {
	const path = { ...createPath("path-1"), filters: [filter] };
	const layer = createLayer("layer-1", [path.id]);
	const updateElement = vi.fn<YjsProvider["updateElement"]>();

	const commands = new PaplicoCommands({
		store: {
			currentLayerId: layer.id,
			selectedElementIds: [path.id],
			editingScopeStack: [],
			animationMode: false,
			document: {
				layers: [layer],
				objects: { [path.id]: path },
			},
		} as unknown as RendererState,
		yjsProvider: {
			updateElement,
			transact: vi.fn((fn: () => void) => fn()),
			isAnimationUndoMode: vi.fn(() => false),
		} as unknown as YjsProvider,
		spatial: {
			isElementLocked: () => false,
		} as unknown as SpatialIndex,
		isReadonly: () => false,
		toolSettings,
	});

	return { commands, updateElement };
}

function createMaskCommands(
	options: {
		mask?: ObjectMask;
		/** Ids to materialise as mask content paths. */
		maskContent?: string[];
		ownerTransform?: Path["transform"];
		contentTransform?: Path["transform"];
	} = {},
) {
	const owner = {
		...createPath("owner"),
		mask: options.mask,
		...(options.ownerTransform ? { transform: options.ownerTransform } : {}),
	};
	const objects: Record<string, AnyArtObject> = { [owner.id]: owner };
	for (const id of options.maskContent ?? []) {
		objects[id] = {
			...createPath(id),
			...(options.contentTransform
				? { transform: options.contentTransform }
				: {}),
		};
	}
	// "under" gives the owner a non-zero index, so a promotion landing above it
	// is distinguishable from one landing at the top of the layer.
	objects.under = createPath("under");
	const layer = createLayer("layer-1", ["under", owner.id]);

	const updateElement = vi.fn<YjsProvider["updateElement"]>();
	const addElement = vi.fn<YjsProvider["addElement"]>();

	const commands = new PaplicoCommands({
		store: {
			currentLayerId: layer.id,
			selectedElementIds: [owner.id],
			editingScopeStack: [],
			animationMode: false,
			document: { layers: [layer], objects },
		} as unknown as RendererState,
		yjsProvider: {
			updateElement,
			addElement,
			addElementToGroup: vi.fn(),
			transact: vi.fn((fn: () => void) => fn()),
			isAnimationUndoMode: vi.fn(() => false),
		} as unknown as YjsProvider,
		spatial: {
			isElementLocked: () => false,
			getAncestorTransform: () => null,
		} as unknown as SpatialIndex,
		isReadonly: () => false,
	});

	return { commands, updateElement, addElement };
}

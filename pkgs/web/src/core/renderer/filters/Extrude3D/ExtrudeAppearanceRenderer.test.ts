import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AnyArtObject,
	BezierPoint,
	CubicBezierSegment,
	ElementTransform,
	Filter,
	Path,
} from "../../../schema";
import type { WorldBBox } from "../../../utils/geometry/bounds";
import { computeSubPathSignedArea } from "../../../utils/geometry/segmentOps";
import {
	AppearanceCache,
	type AppearanceCacheEntry,
} from "../../canvas/caches/AppearanceCache";
import type { CompoundPathCache } from "../../canvas/caches/CompoundPathCache";
import type { BackdropEffectCoordinator } from "../../canvas/pipeline/BackdropEffectCoordinator";
import type {
	FilterGeometryContext,
	FilterProcessorContext,
	FilterRenderer,
	UnderlayProcessorContext,
	UnderlayResult,
} from "../../canvas/pipeline/FilterRenderer";
import type { MeshPassRenderer } from "../../canvas/pipeline/MeshPassRenderer";
import {
	createBorrowedTextureRef,
	createFrameTextureRef,
	createRenderSurface,
	type RasterizedRenderSurface,
} from "../../canvas/pipeline/RenderSurface";
import type { TexturePool } from "../../canvas/pipeline/TexturePool";
import { Extrude3DFilterHandler } from "../Extrude3DFilterHandler";
import { PathUnionFilterHandler } from "../PathUnionFilterProcessor";
import {
	buildExtrudeOutline,
	buildTextGlyphOutline,
	collectGroupExtrudeOutline,
	ExtrudeAppearanceRenderer,
	type ExtrudeFrameEntry,
	hasEnabledSolidAppearance,
	resolveFillAppearance,
	resolveFillBaseColor,
} from "./ExtrudeAppearanceRenderer";
import type { ExtrudeMeshBaker } from "./ExtrudeMeshBaker";
import { RefractionCompositor } from "./RefractionCompositor";

// WebGPU bit-flag globals are absent in happy-dom.
vi.stubGlobal("GPUBufferUsage", {
	COPY_DST: 8,
	INDEX: 16,
	VERTEX: 32,
	UNIFORM: 64,
});
vi.stubGlobal("GPUTextureUsage", {
	COPY_SRC: 1,
	COPY_DST: 2,
	TEXTURE_BINDING: 4,
	RENDER_ATTACHMENT: 16,
});
vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });

describe("ExtrudeMeshBaker", () => {
	let device: ReturnType<typeof createFakeDevice>;
	let appearanceCache: AppearanceCache;
	let parentGroupMap: Map<string, string>;
	let released: unknown[];
	let renderElementToTexture: ReturnType<typeof createBakeMock>;
	let texturePool: ReturnType<typeof createFakeTexturePool>;
	let handler: Extrude3DFilterHandler;
	let meshPass: MeshPassRenderer;
	let baker: ExtrudeMeshBaker;
	let frameTextures: GPUTexture[];
	let entries: Map<string, ExtrudeFrameEntry>;

	beforeEach(async () => {
		device = createFakeDevice();
		appearanceCache = new AppearanceCache();
		parentGroupMap = new Map();
		released = [];
		renderElementToTexture = createBakeMock();
		texturePool = createFakeTexturePool();
		frameTextures = [];
		entries = new Map();

		handler = new Extrude3DFilterHandler();
		const filterRenderer = {
			getHandler: (type: string) =>
				type === "extrude3d" ? handler : undefined,
		} as unknown as FilterRenderer;
		handler.setFilterRenderer(filterRenderer);
		await handler.initialize(device as unknown as GPUDevice, "bgra8unorm");
		// biome-ignore lint/style/noNonNullAssertion: initialized above.
		const drivers = handler.getGeometryPassDrivers()!;
		meshPass = drivers.meshPass;
		baker = drivers.baker;
	});

	// Drive the baker over an elements map exactly as the prepare pre-pass does.
	const bake = (
		map: Map<string, AnyArtObject>,
		zoom: number,
		geomOverrides: Partial<FilterGeometryContext> = {},
	): void => {
		for (const el of map.values()) {
			if (el.visible === false || !hasEnabledSolidAppearance(el, "extrude3d")) {
				continue;
			}
			const geom = {
				element: el,
				elementsMap: map,
				compoundPathCache: {} as unknown as CompoundPathCache,
				getParentGroupMap: () => parentGroupMap,
				resolvePatternTexture: () => null,
				renderElementToTexture,
				texturePool: texturePool as unknown as TexturePool,
				resolveTextOutline: () => null,
				requestTextOutline: () => {},
				...geomOverrides,
			} as unknown as FilterGeometryContext;
			const outline = baker.buildOutline(geom);
			if (!outline) continue;
			const cache = {
				get: (uid: string) => appearanceCache.get(el.id, uid),
				set: (uid: string, entry: AppearanceCacheEntry) =>
					appearanceCache.set(el.id, uid, entry),
			};
			for (const app of (el.filters ?? []).filter(
				(f) => f.processor === "extrude3d" && f.enabled !== false,
			)) {
				const entry = baker.bakeAppearance(
					createFakeEncoder(),
					meshPass,
					app,
					outline,
					geom,
					cache,
					zoom,
					frameTextures,
				);
				if (entry) {
					// enableRenderCache is false in this helper (opaque-path shape) —
					// bakeAppearance never pushes colorTexture itself in that case (the
					// real opaque caller's colorTexture is released via CanvasLayer's
					// filteredTextures pipeline instead), so this helper pushes it,
					// mirroring that contract.
					frameTextures.push(entry.texture.texture);
					entries.set(`${el.id}::${app.uid}`, entry);
				}
			}
		}
	};
	const getEntry = (id: string, uid: string): ExtrudeFrameEntry | null =>
		entries.get(`${id}::${uid}`) ?? null;
	const releaseFrame = (release: (tex: GPUTexture) => void): void => {
		for (const tex of frameTextures) release(tex);
		frameTextures.length = 0;
		entries.clear();
	};

	it("should render an extrude appearance into a frame-local entry", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);

		const entry = getEntry("path-1", "app-1");
		expect(entry).not.toBe(null);
		expect(entry!.bounds.width).toBeGreaterThan(0);
		expect(entry!.quad).toBeUndefined();
		expect(meshBufferCount(device)).toBe(1);
	});

	it.each([
		"bgra8unorm",
		"rgba16float",
	] as const)("should configure the mesh color pipeline for %s", async (format) => {
		const testDevice = createFakeDevice();
		const testHandler = new Extrude3DFilterHandler();
		testHandler.setFilterRenderer({
			getHandler: () => testHandler,
		} as unknown as FilterRenderer);

		await testHandler.initialize(testDevice as unknown as GPUDevice, format);

		const pipelineCall = testDevice.createRenderPipeline.mock.calls.find(
			([descriptor]) => descriptor.label === "Mesh Pass Pipeline",
		);
		const targets = [...(pipelineCall?.[0].fragment?.targets ?? [])];
		expect(targets[0]?.format).toBe(format);
	});

	it("should make the frame-owned bake copy usable as a copy source", () => {
		const path = pathWithExtrude(20, 0);
		const elementsMap = toMap(path);
		const geometry = {
			element: path,
			elementsMap,
			compoundPathCache: {} as CompoundPathCache,
			getParentGroupMap: () => parentGroupMap,
			resolvePatternTexture: () => null,
			renderElementToTexture,
			texturePool: texturePool as unknown as TexturePool,
			resolveTextOutline: () => null,
			requestTextOutline: () => {},
			isImageReady: () => true,
		} satisfies FilterGeometryContext;

		handler.postProcess(
			{
				device: device as unknown as GPUDevice,
				sourceTexture: {} as GPUTexture,
				targetTexture: {} as GPUTexture,
				commandEncoder: createFakeEncoder(),
				sceneInfo: { textureSize: { width: 1, height: 1 }, dpiScale: 1 },
				geometry,
				appearanceCache: {
					get: (uid) => appearanceCache.get(path.id, uid),
					set: (uid, entry) => appearanceCache.set(path.id, uid, entry),
					pruneInstances: (baseUid, liveCount) =>
						appearanceCache.pruneInstances(path.id, baseUid, liveCount),
				},
			},
			path.filters![0],
		);

		const frameCopyCall = texturePool.acquire.mock.calls.find(
			([, , , , , label]) => label === "Extrude Bake Frame Copy",
		);
		expect(frameCopyCall).toBeDefined();
		if (!frameCopyCall) throw new Error("Frame copy texture was not acquired");
		expect(frameCopyCall[2]).toBe("bgra8unorm");
		expect((frameCopyCall[4] ?? 0) & GPUTextureUsage.COPY_SRC).toBe(
			GPUTextureUsage.COPY_SRC,
		);
	});

	it("should reuse the cached mesh for identical geometry", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);
		releaseFrame(() => {});
		bake(toMap(pathWithExtrude(20, 0)), 1);

		expect(meshBufferCount(device)).toBe(1);
		expect(getEntry("path-1", "app-1")).not.toBe(null);
	});

	it("should NOT rebuild the mesh when only yaw changes", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);
		releaseFrame(() => {});
		bake(toMap(pathWithExtrude(20, 45)), 1);

		expect(meshBufferCount(device)).toBe(1);
	});

	it("should rebuild the mesh when depth changes", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);
		releaseFrame(() => {});
		bake(toMap(pathWithExtrude(40, 0)), 1);

		expect(meshBufferCount(device)).toBe(2);
	});

	it("should rebuild the mesh when the bevel changes", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);
		releaseFrame(() => {});
		const bevelled = pathWithExtrude(20, 0, {
			bevel: { size: 2, segments: 4 },
		});
		bake(toMap(bevelled), 1);

		expect(meshBufferCount(device)).toBe(2);
	});

	describe("element transform following", () => {
		it("should NOT rebuild the mesh when only the transform changes", () => {
			bake(toMap(pathWithExtrude(20, 0)), 1);
			releaseFrame(() => {});
			const moved = pathWithExtrude(20, 0);
			moved.transform = { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
			bake(toMap(moved), 1);

			expect(meshBufferCount(device)).toBe(1);
		});

		it("should shift the blit quad when the element transform moves", () => {
			bake(toMap(pathWithExtrude(20, 0)), 1);
			const restBounds = getEntry("path-1", "app-1")!.bounds;
			releaseFrame(() => {});

			const moved = pathWithExtrude(20, 0);
			moved.transform = { x: 100, y: -30, rotation: 0, scaleX: 1, scaleY: 1 };
			bake(toMap(moved), 1);

			const entry = getEntry("path-1", "app-1")!;
			expect(entry.quad).toBeDefined();
			// BL corner = (minX, minY) translated by the element transform.
			expect(entry.quad![3].x).toBeCloseTo(restBounds.minX + 100);
			expect(entry.quad![3].y).toBeCloseTo(restBounds.minY - 30);
			// TR corner = (maxX, maxY) translated likewise.
			expect(entry.quad![1].x).toBeCloseTo(restBounds.maxX + 100);
			expect(entry.quad![1].y).toBeCloseTo(restBounds.maxY - 30);
		});

		it("should follow ancestor group transforms", () => {
			bake(toMap(pathWithExtrude(20, 0)), 1);
			const restBounds = getEntry("path-1", "app-1")!.bounds;
			releaseFrame(() => {});

			const child = pathWithExtrude(20, 0);
			child.transform = { x: 100, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
			const group = {
				id: "group-1",
				type: "group",
				transform: { x: 50, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
				childIds: ["path-1"],
			} as unknown as AnyArtObject;
			parentGroupMap.set("path-1", "group-1");
			const elementsMap = new Map<string, AnyArtObject>([
				[child.id, child],
				[group.id, group],
			]);
			bake(elementsMap, 1);

			const entry = getEntry("path-1", "app-1")!;
			expect(entry.quad).toBeDefined();
			expect(entry.quad![3].x).toBeCloseTo(restBounds.minX + 150);
			expect(entry.quad![3].y).toBeCloseTo(restBounds.minY + 20);
		});
	});

	it("should skip invisible elements and disabled appearances", () => {
		const invisible = { ...pathWithExtrude(20, 0), visible: false };
		bake(toMap(invisible), 1);
		expect(getEntry("path-1", "app-1")).toBe(null);

		const disabled = pathWithExtrude(20, 0);
		disabled.filters![0] = { ...disabled.filters![0], enabled: false };
		bake(toMap(disabled), 1);
		expect(getEntry("path-1", "app-1")).toBe(null);
		expect(meshBufferCount(device)).toBe(0);
	});

	it("should return frame textures to the pool on releaseFrame", () => {
		bake(toMap(pathWithExtrude(20, 0)), 1);
		releaseFrame((tex) => released.push(tex));

		// Color texture for the single appearance (depth is MeshPassRenderer's
		// own internal MSAA scratch now, never exposed to the caller).
		expect(released).toHaveLength(1);
		expect(getEntry("path-1", "app-1")).toBe(null);
	});

	describe("group extrusion", () => {
		it("should extrude the combined silhouette of the group's children", () => {
			const child = childFillPath("child-1");
			const group = groupWithExtrude(["child-1"]);
			bake(toMap(group, child), 1);

			const entry = getEntry("group-1", "app-1");
			expect(entry).not.toBe(null);
			expect(entry!.bounds.width).toBeGreaterThan(0);
			expect(meshBufferCount(device)).toBe(1);
		});

		it("should bake the children's flat look via a filterless temp group", () => {
			const child = childFillPath("child-1");
			const group = groupWithExtrude(["child-1"]);
			bake(toMap(group, child), 1);

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1];
			expect(tempEl.type).toBe("group");
			expect(tempEl.id).toBe("group-1");
			// No filters on the temp group — the bake renders plain flat children
			// (and never re-enters the extrude replacement).
			expect(tempEl.filters).toBeUndefined();
			expect((tempEl as unknown as { childIds: string[] }).childIds).toEqual([
				"child-1",
			]);
			// The baked texture joins the frame textures released after the frame
			// (color + baked; depth is MeshPassRenderer's own internal scratch).
			releaseFrame((tex) => released.push(tex));
			expect(released).toHaveLength(2);
		});

		it("should extrude a group carrying its own fill/pre-filter appearances (compound object) and bake that combined surface", () => {
			const child = childFillPath("child-1");
			// A group-level fill appearance makes this a "compound object" whose
			// painted shape comes from the group's own appearances, not the raw
			// children.
			const group = groupWithExtrude(["child-1"]);
			(group as unknown as { filters: Filter[] }).filters.unshift(
				solidFillAppearance(),
			);
			bake(toMap(group, child), 1);

			expect(getEntry("group-1", "app-1")).not.toBe(null);
			expect(meshBufferCount(device)).toBe(1);
			// The albedo bakes the group WITH its own appearances (not the old
			// filterless temp group), so the compound surface is drawn.
			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as AnyArtObject;
			expect(tempEl.type).toBe("group");
			expect((tempEl.filters ?? []).some((f) => f.processor === "fill")).toBe(
				true,
			);
			expect(
				(tempEl.filters ?? []).some((f) => f.processor === "extrude3d"),
			).toBe(false);
		});

		it("should preserve the source group's id and transform when baking group-level appearances", () => {
			const child = childFillPath("child-1");
			const group = {
				...groupWithExtrude(["child-1"]),
				transform: { x: 24, y: -12, rotation: 15, scaleX: 1.5, scaleY: 0.75 },
			} as AnyArtObject;
			(group as unknown as { filters: Filter[] }).filters.unshift(
				solidFillAppearance(),
			);
			bake(toMap(group, child), 1);

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as AnyArtObject;
			expect(tempEl.id).toBe("group-1");
			expect(tempEl.transform).toEqual(group.transform);
			expect(
				(tempEl.filters ?? []).some((f) => f.processor === "extrude3d"),
			).toBe(false);
		});

		it("should apply group-level pre-filters to a combined extrude outline even without group fill/stroke", () => {
			const child = childFillPath("child-1");
			const group = groupWithExtrude(["child-1"]);
			(group as unknown as { filters: Filter[] }).filters.unshift(
				appearance("path-offset"),
			);
			const filterRenderer = {
				getHandler: (processor: string) =>
					processor === "path-offset"
						? {
								preProcess: (segments: CubicBezierSegment[]) =>
									translateSegments(segments, 10, 0),
							}
						: undefined,
			} as unknown as FilterRenderer;

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				toMap(group, child),
				{} as unknown as CompoundPathCache,
				{ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				filterRenderer,
				() => null,
				() => {},
			);

			const xs = outline.flatMap((seg) => [
				...(seg.start ? [seg.start.x] : []),
				seg.end.x,
			]);
			expect(Math.min(...xs)).toBeCloseTo(10);
		});

		it("should extrude a group of stroke-only lines into a frame", () => {
			const line = childStrokeLine("child-1");
			const group = groupWithExtrude(["child-1"]);
			bake(toMap(group, line), 1);

			// A group of lines still extrudes — the strokes are swept into faces.
			expect(getEntry("group-1", "app-1")).not.toBe(null);
			expect(meshBufferCount(device)).toBe(1);
		});

		it("should skip a group whose children have no outline", () => {
			const group = groupWithExtrude([]);
			bake(toMap(group), 1);

			expect(getEntry("group-1", "app-1")).toBe(null);
			expect(meshBufferCount(device)).toBe(0);
		});

		it("should apply a child path's own corner-radius fillet to the group's extrude outline", () => {
			const sharpChild = childFillPath("child-1");
			const filletedChild = {
				...sharpChild,
				segments: squareSegments().map((s) => ({ ...s, cornerRadius: 15 })),
			} as unknown as AnyArtObject;
			const elementsMap = toMap(filletedChild);
			const filterRenderer = {
				getHandler: () => undefined,
			} as unknown as FilterRenderer;

			const sharpOutline = collectGroupExtrudeOutline(
				groupWithExtrude(["child-1"]) as unknown as Parameters<
					typeof collectGroupExtrudeOutline
				>[0],
				toMap(sharpChild),
				{} as unknown as CompoundPathCache,
				{ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				filterRenderer,
				() => null,
				() => {},
			);
			const filletedOutline = collectGroupExtrudeOutline(
				groupWithExtrude(["child-1"]) as unknown as Parameters<
					typeof collectGroupExtrudeOutline
				>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				{ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				filterRenderer,
				() => null,
				() => {},
			);

			// A fillet has strictly more (small, curved) segments than a sharp
			// corner, and it cuts area off every corner — the outline must
			// reflect that, not the raw sharp square (the pre-fix behavior).
			expect(filletedOutline.length).toBeGreaterThan(sharpOutline.length);
			const sharpArea = Math.abs(computeSubPathSignedArea(sharpOutline));
			const filletedArea = Math.abs(computeSubPathSignedArea(filletedOutline));
			expect(filletedArea).toBeLessThan(sharpArea);
		});
	});

	describe("Blend/Text children of an extrude group", () => {
		const identity = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
		const noOpFilterRenderer = {
			getHandler: () => undefined,
		} as unknown as FilterRenderer;

		function keyPath(
			id: string,
			offsetX: number,
			offsetY: number,
		): AnyArtObject {
			return {
				...childFillPath(id),
				segments: squareSegments().map((s) => ({
					...s,
					start: s.start
						? { ...s.start, x: s.start.x + offsetX, y: s.start.y + offsetY }
						: undefined,
					end: { ...s.end, x: s.end.x + offsetX, y: s.end.y + offsetY },
				})),
			} as unknown as AnyArtObject;
		}

		function blendChild(id: string, objectIds: string[]): AnyArtObject {
			return {
				id,
				type: "blend",
				transform: identity,
				opacity: 1,
				blendMode: "normal",
				objectIds,
				spacing: { type: "steps", count: 1 },
			} as unknown as AnyArtObject;
		}

		it("should contribute a blend child's keys AND its interpolated intermediates to the group's extrude outline", () => {
			const keyA = keyPath("key-a", 0, 0);
			const keyB = keyPath("key-b", 200, 200);
			const blend = blendChild("blend-1", ["key-a", "key-b"]);
			const group = groupWithExtrude(["blend-1"]);
			const elementsMap = toMap(group, blend, keyA, keyB);

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				identity,
				noOpFilterRenderer,
				() => null,
				() => {},
			);

			// A blend that were skipped entirely (the pre-fix behavior — Blend
			// matched none of isPath/isCompoundPath/isGroup) would return [].
			expect(outline.length).toBeGreaterThan(0);
			// 2 keys + 1 intermediate (spacing: steps, count 1) = 3 sub-paths.
			expect(splitByIsMoved(outline)).toHaveLength(3);
		});

		it("should skip a blend with fewer than two resolvable keys", () => {
			const keyA = keyPath("key-a", 0, 0);
			const blend = blendChild("blend-1", ["key-a", "missing-key"]);
			const group = groupWithExtrude(["blend-1"]);
			const elementsMap = toMap(group, blend, keyA);

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				identity,
				noOpFilterRenderer,
				() => null,
				() => {},
			);

			expect(outline).toEqual([]);
		});

		function textChild(id: string, x: number, y: number): AnyArtObject {
			return {
				id,
				type: "text",
				transform: identity,
				x,
				y,
				opacity: 1,
				blendMode: "normal",
			} as unknown as AnyArtObject;
		}

		it("should contribute a text child's cached glyph outline, offset by its x/y, to the group's extrude outline", () => {
			const text = textChild("text-1", 10, 20);
			const group = groupWithExtrude(["text-1"]);
			const elementsMap = toMap(group, text);
			const glyphPath = {
				id: "glyph-1",
				type: "path",
				transform: identity,
				opacity: 1,
				blendMode: "normal",
				segments: squareSegments(),
			} as unknown as Path;
			const resolveTextOutline = vi.fn(() => ({
				paths: [glyphPath],
				localBounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
			}));
			const requestTextOutline = vi.fn();

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				identity,
				noOpFilterRenderer,
				resolveTextOutline as unknown as Parameters<
					typeof collectGroupExtrudeOutline
				>[5],
				requestTextOutline,
			);

			expect(outline.length).toBeGreaterThan(0);
			expect(requestTextOutline).not.toHaveBeenCalled();
			// The glyph's local 0..40 square lands at 10..50 once offset by (x, y).
			const anchors = outline.flatMap((s) =>
				s.start ? [s.start, s.end] : [s.end],
			);
			expect(Math.min(...anchors.map((p) => p.x))).toBeCloseTo(10);
			expect(Math.min(...anchors.map((p) => p.y))).toBeCloseTo(20);
		});

		it("should contribute nothing (yet) for a text child on a cache miss, and warm the cache", () => {
			const text = textChild("text-1", 10, 20);
			const group = groupWithExtrude(["text-1"]);
			const elementsMap = toMap(group, text);
			const requestTextOutline = vi.fn();

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				identity,
				noOpFilterRenderer,
				() => null,
				requestTextOutline,
			);

			expect(outline).toEqual([]);
			expect(requestTextOutline).toHaveBeenCalledTimes(1);
			expect(requestTextOutline.mock.calls[0][0].id).toBe("text-1");
		});

		it("should contribute an image child's rectangular plane to the group's extrude outline", () => {
			const image = {
				id: "image-1",
				type: "image",
				transform: identity,
				fileUid: "file-1",
				x: 0,
				y: 0,
				width: 40,
				height: 40,
			} as unknown as AnyArtObject;
			const group = groupWithExtrude(["image-1"]);
			const elementsMap = toMap(group, image);

			const outline = collectGroupExtrudeOutline(
				group as unknown as Parameters<typeof collectGroupExtrudeOutline>[0],
				elementsMap,
				{} as unknown as CompoundPathCache,
				identity,
				noOpFilterRenderer,
				() => null,
				() => {},
			);

			expect(outline.length).toBeGreaterThan(0);
			const anchors = outline.flatMap((s) =>
				s.start ? [s.start, s.end] : [s.end],
			);
			expect(Math.min(...anchors.map((p) => p.x))).toBeCloseTo(-20);
			expect(Math.max(...anchors.map((p) => p.x))).toBeCloseTo(20);
		});
	});

	describe("standalone Text/Blend elements carrying their own extrude3d filter", () => {
		it("should bake a Text element's own extrude3d filter (not just a group child's)", () => {
			const text = textWithExtrude("text-1", 10, 20);
			const glyphPath = {
				id: "glyph-1",
				type: "path",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				opacity: 1,
				blendMode: "normal",
				segments: squareSegments(),
			} as unknown as Path;

			bake(toMap(text), 1, {
				resolveTextOutline: () => ({
					paths: [glyphPath],
					localBounds: {
						minX: 0,
						minY: 0,
						maxX: 40,
						maxY: 40,
						width: 40,
						height: 40,
					},
				}),
			});

			expect(getEntry("text-1", "app-1")).not.toBe(null);
		});

		it("should contribute nothing (yet) for a Text element's own extrude3d on a cache miss, and warm the cache", () => {
			const text = textWithExtrude("text-1", 10, 20);
			const requestTextOutline = vi.fn();

			bake(toMap(text), 1, {
				resolveTextOutline: () => null,
				requestTextOutline,
			});

			expect(getEntry("text-1", "app-1")).toBe(null);
			expect(requestTextOutline).toHaveBeenCalledTimes(1);
		});

		it("should bake a Blend element's own extrude3d filter (not just a group child's)", () => {
			const keyA = childFillPath("key-a");
			const keyB = {
				...childFillPath("key-b"),
				segments: squareSegments().map((s) => ({
					...s,
					start: s.start
						? { ...s.start, x: s.start.x + 200, y: s.start.y + 200 }
						: undefined,
					end: { ...s.end, x: s.end.x + 200, y: s.end.y + 200 },
				})),
			} as unknown as AnyArtObject;
			const blend = blendWithExtrude("blend-1", ["key-a", "key-b"]);

			bake(toMap(blend, keyA, keyB), 1);

			expect(getEntry("blend-1", "app-1")).not.toBe(null);
		});

		it("should bake a Blend's flat look (its keys' colors) as the surface, not fall back to black", () => {
			const keyA = childFillPath("key-a");
			const keyB = {
				...childFillPath("key-b"),
				segments: squareSegments().map((s) => ({
					...s,
					start: s.start
						? { ...s.start, x: s.start.x + 200, y: s.start.y + 200 }
						: undefined,
					end: { ...s.end, x: s.end.x + 200, y: s.end.y + 200 },
				})),
			} as unknown as AnyArtObject;
			const blend = blendWithExtrude("blend-1", ["key-a", "key-b"]);

			bake(toMap(blend, keyA, keyB), 1);

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as AnyArtObject;
			expect(tempEl.type).toBe("blend");
			// The temp blend must not re-run the extrude filter on itself.
			expect(
				(tempEl.filters ?? []).some((f) => f.processor === "extrude3d"),
			).toBe(false);
		});

		it("should bake each blend instance (keys + intermediates) at its own interpolated depth via postProcess", () => {
			const extrudeFilter = (depth: number) => ({
				uid: "app-1",
				processor: "extrude3d" as const,
				enabled: true,
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: {
						depth,
						rotationDeg: [0, 0, 0] as [number, number, number],
						perspective: 0,
						material: {
							shading: "lambert" as const,
							lightDir: [0, 0, 1] as [number, number, number],
						},
					},
				},
			});
			const keyA = {
				...childFillPath("key-a"),
				filters: [solidFillAppearance(), extrudeFilter(10)],
			} as unknown as AnyArtObject;
			const keyB = {
				...childFillPath("key-b"),
				segments: squareSegments().map((s) => ({
					...s,
					start: s.start
						? { ...s.start, x: s.start.x + 200, y: s.start.y + 200 }
						: undefined,
					end: { ...s.end, x: s.end.x + 200, y: s.end.y + 200 },
				})),
				filters: [solidFillAppearance(), extrudeFilter(50)],
			} as unknown as AnyArtObject;
			// The hoisted filter mirrors whichever key hoistBlendInstanceAppearances
			// picked (key A here) — postProcess re-derives each instance's own
			// depth from the keys, not from this hoisted copy.
			const blend = blendWithExtrude("blend-1", ["key-a", "key-b"]);
			const elementsMap = toMap(blend, keyA, keyB);

			const bakeSpy = vi.spyOn(baker, "bakeAppearance");
			const geometry: FilterGeometryContext = {
				element: blend,
				elementsMap,
				compoundPathCache: {} as unknown as CompoundPathCache,
				getParentGroupMap: () => parentGroupMap,
				resolvePatternTexture: () => null,
				renderElementToTexture,
				texturePool: texturePool as unknown as TexturePool,
				resolveTextOutline: () => null,
				requestTextOutline: () => {},
				isImageReady: () => true,
			};
			const ctx: FilterProcessorContext = {
				device: device as unknown as GPUDevice,
				sourceTexture: {} as unknown as GPUTexture,
				targetTexture: {} as unknown as GPUTexture,
				commandEncoder: createFakeEncoder(),
				sceneInfo: { textureSize: { width: 1, height: 1 }, dpiScale: 1 },
				geometry,
			};

			const result = handler.postProcess(ctx, blend.filters![0] as Filter);

			expect(Array.isArray(result)).toBe(true);
			const results = result as unknown[];
			// 2 keys + 1 intermediate (spacing: steps, count 1).
			expect(results).toHaveLength(3);
			expect(bakeSpy).toHaveBeenCalledTimes(3);
			const depths = bakeSpy.mock.calls
				.map(
					(call) => (call[2] as Filter).paramData.params as { depth: number },
				)
				.map((p) => p.depth)
				.sort((a, b) => a - b);
			expect(depths[0]).toBeCloseTo(10);
			expect(depths[1]).toBeCloseTo(30);
			expect(depths[2]).toBeCloseTo(50);
		});

		it("should order blend instances by renderOrder (each cell = key + its trailing intermediates), matching the flat blend paint order", () => {
			const extrudeFilter = (depth: number) => ({
				uid: "app-1",
				processor: "extrude3d" as const,
				enabled: true,
				opacity: 1,
				blendMode: "normal" as const,
				paramData: {
					version: "1",
					params: {
						depth,
						rotationDeg: [0, 0, 0] as [number, number, number],
						perspective: 0,
						material: {
							shading: "lambert" as const,
							lightDir: [0, 0, 1] as [number, number, number],
						},
					},
				},
			});
			const keyA = {
				...childFillPath("key-a"),
				filters: [solidFillAppearance(), extrudeFilter(10)],
			} as unknown as AnyArtObject;
			const keyB = {
				...childFillPath("key-b"),
				segments: squareSegments().map((s) => ({
					...s,
					start: s.start
						? { ...s.start, x: s.start.x + 200, y: s.start.y + 200 }
						: undefined,
					end: { ...s.end, x: s.end.x + 200, y: s.end.y + 200 },
				})),
				filters: [solidFillAppearance(), extrudeFilter(50)],
			} as unknown as AnyArtObject;
			const blend = blendWithExtrude("blend-1", ["key-a", "key-b"]);
			// Reverse paint order: key-b's cell must be baked (blitted) before
			// key-a's, so key-a ends up on top — matching the flat blend, which
			// paints renderOrder front-to-back.
			(blend as unknown as { renderOrder: string[] }).renderOrder = [
				"key-b",
				"key-a",
			];
			const elementsMap = toMap(blend, keyA, keyB);

			const bakeSpy = vi.spyOn(baker, "bakeAppearance");
			const geometry: FilterGeometryContext = {
				element: blend,
				elementsMap,
				compoundPathCache: {} as unknown as CompoundPathCache,
				getParentGroupMap: () => parentGroupMap,
				resolvePatternTexture: () => null,
				renderElementToTexture,
				texturePool: texturePool as unknown as TexturePool,
				resolveTextOutline: () => null,
				requestTextOutline: () => {},
				isImageReady: () => true,
			};
			const ctx: FilterProcessorContext = {
				device: device as unknown as GPUDevice,
				sourceTexture: {} as unknown as GPUTexture,
				targetTexture: {} as unknown as GPUTexture,
				commandEncoder: createFakeEncoder(),
				sceneInfo: { textureSize: { width: 1, height: 1 }, dpiScale: 1 },
				geometry,
			};

			handler.postProcess(ctx, blend.filters![0] as Filter);

			// Bake order is the blit z-order (later = on top). renderOrder
			// ["key-b","key-a"] → key-b cell first (depth 50, no trailing
			// intermediate), then key-a cell (depth 10, then its intermediate
			// depth 30). Without the fix it would be [10, 50, 30] (objectIds
			// order, all keys then all intermediates).
			const depths = bakeSpy.mock.calls.map(
				(call) =>
					((call[2] as Filter).paramData.params as { depth: number }).depth,
			);
			expect(depths).toHaveLength(3);
			expect(depths[0]).toBeCloseTo(50);
			expect(depths[1]).toBeCloseTo(10);
			expect(depths[2]).toBeCloseTo(30);
		});

		it("should bake an Image element's own extrude3d filter as a rectangular plane", () => {
			const image = {
				id: "image-1",
				type: "image",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				fileUid: "file-1",
				x: 0,
				y: 0,
				width: 40,
				height: 40,
				filters: [
					{
						uid: "app-1",
						processor: "extrude3d",
						enabled: true,
						opacity: 1,
						blendMode: "normal",
						paramData: {
							version: "1",
							params: {
								depth: 20,
								rotationDeg: [0, 0, 0],
								perspective: 0,
								material: { shading: "lambert", lightDir: [0, 0, 1] },
							},
						},
					},
				],
			} as unknown as AnyArtObject;

			bake(toMap(image), 1);

			expect(getEntry("image-1", "app-1")).not.toBe(null);
		});
	});

	describe("standalone compound-path extrude", () => {
		const fakeCompoundCache = {
			resolve: () => squareSegments(),
		} as unknown as CompoundPathCache;

		it("should extrude a compound-path by boolean-combining its sources", () => {
			const srcA = childFillPath("src-a");
			const srcB = childFillPath("src-b");
			const compound = compoundWithExtrude("cp-1", ["src-a", "src-b"]);

			bake(toMap(compound, srcA, srcB), 1, {
				compoundPathCache: fakeCompoundCache,
			});

			expect(getEntry("cp-1", "app-1")).not.toBe(null);
		});

		it("should bake a compound-path's non-solid fill across the combined shape", () => {
			const srcA = childFillPath("src-a");
			const compound = compoundWithExtrude("cp-1", ["src-a"]);
			(compound as unknown as { filters: Filter[] }).filters.unshift(
				gradientFillAppearance(),
			);

			bake(toMap(compound, srcA), 1, { compoundPathCache: fakeCompoundCache });

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as Path;
			expect(tempEl.type).toBe("path");
			expect(tempEl.filters!.map((f) => f.processor)).toContain("fill");
		});
	});

	describe("gradient fill baking", () => {
		it("should bake a non-solid fill into a texture for the surface", () => {
			const path = pathWithExtrude(20, 0);
			path.filters!.unshift(gradientFillAppearance());
			bake(toMap(path), 1);

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			// The baked element is a fill-only temp path over the same outline.
			const tempEl = renderElementToTexture.mock.calls[0][1] as Path;
			expect(tempEl.type).toBe("path");
			expect(tempEl.filters).toHaveLength(1);
			expect(tempEl.filters![0].processor).toBe("fill");
			// The baked texture is released with the color texture (depth is
			// MeshPassRenderer's own internal scratch).
			releaseFrame((tex) => released.push(tex));
			expect(released).toHaveLength(2);
		});

		it("should NOT bake a solid fill", () => {
			const path = pathWithExtrude(20, 0);
			path.filters!.unshift(solidFillAppearance());
			bake(toMap(path), 1);

			expect(renderElementToTexture).not.toHaveBeenCalled();
		});

		it("should bake a text element's non-solid fill across the glyphs (not collapse to the first stop)", () => {
			const text = textWithExtrude("text-1", 10, 20);
			(text as unknown as { filters: Filter[] }).filters.unshift(
				gradientFillAppearance(),
			);
			const glyphPath = {
				id: "glyph-1",
				type: "path",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				opacity: 1,
				blendMode: "normal",
				segments: squareSegments(),
			} as unknown as Path;

			bake(toMap(text), 1, {
				resolveTextOutline: () => ({
					paths: [glyphPath],
					localBounds: {
						minX: 0,
						minY: 0,
						maxX: 40,
						maxY: 40,
						width: 40,
						height: 40,
					},
				}),
			});

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as Path;
			expect(tempEl.type).toBe("path");
			expect(tempEl.filters!.map((f) => f.processor)).toContain("fill");
		});
	});

	describe("stroked paths", () => {
		it("should extrude a stroked open path (line) into a frame entry", () => {
			const path = pathWithExtrude(20, 0);
			path.segments = [lineSeg({ x: 0, y: 0 }, { x: 40, y: 0 }, true)];
			path.filters!.unshift(strokeAppearance(10));
			bake(toMap(path), 1);

			expect(getEntry("path-1", "app-1")).not.toBe(null);
			expect(meshBufferCount(device)).toBe(1);
		});

		it("should bake the flat look including the stroke appearance", () => {
			const path = pathWithExtrude(20, 0);
			path.filters!.unshift(solidFillAppearance(), strokeAppearance(10));
			bake(toMap(path), 1);

			expect(renderElementToTexture).toHaveBeenCalledTimes(1);
			const tempEl = renderElementToTexture.mock.calls[0][1] as Path;
			expect(tempEl.filters!.map((f) => f.processor)).toEqual([
				"fill",
				"stroke",
			]);
		});
	});
});

describe("ExtrudeAppearanceRenderer.prepare (glass-only)", () => {
	describe("per-instance glass blend", () => {
		async function makeRenderer(
			processor = "extrude3d",
		): Promise<ExtrudeAppearanceRenderer> {
			const device = createFakeDevice();
			const handler = new Extrude3DFilterHandler();
			const filterRenderer = {
				getHandler: (t: string) => (t === "extrude3d" ? handler : undefined),
			} as unknown as FilterRenderer;
			handler.setFilterRenderer(filterRenderer);
			await handler.initialize(device as unknown as GPUDevice);
			// biome-ignore lint/style/noNonNullAssertion: initialized above.
			const drivers = handler.getGeometryPassDrivers()!;
			return new ExtrudeAppearanceRenderer({
				device: device as unknown as GPUDevice,
				texturePool: createFakeTexturePool() as unknown as TexturePool,
				appearanceCache: new AppearanceCache(),
				filterRenderer,
				processor,
				getParentGroupMap: () => new Map(),
				compoundPathCache: {} as unknown as CompoundPathCache,
				renderElementToTexture: createBakeMock(),
				resolvePatternTexture: () => null,
				resolveTextOutline: () => null,
				requestTextOutline: () => {},
				isImageReady: () => true,
				meshPass: drivers.meshPass,
				baker: drivers.baker,
				refractionCompositor: new RefractionCompositor(
					device as unknown as GPUDevice,
				),
				backdropEffectCoordinator: createFakeBackdropCoordinator(),
				deferDestroy: () => {},
			});
		}

		it("should ignore elements of another 3D solid processor entirely", async () => {
			// A driver serving "revolve3d" must not bake extrude3d appearances —
			// each handler's driver is scoped to its own processor.
			const renderer = await makeRenderer("revolve3d");
			const keyA = glassKey("key-a", 0, 0, 1.5);
			const keyB = glassKey("key-b", 200, 200, 1.5);
			const blend = blendOf(["key-a", "key-b"], glassExtrude(1.5));

			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(blend, keyA, keyB),
				1,
				1,
			);

			expect(renderer.getFrameEntries("blend-1")).toHaveLength(0);
			expect(renderer.getFrameEntries("key-a")).toHaveLength(0);
		});

		function glassExtrude(refraction: number): Filter {
			return {
				uid: "glass-app",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: { shading: "lambert", lightDir: [0, 0, 1], refraction },
					},
				},
			} as unknown as Filter;
		}

		function glassKey(id: string, dx: number, dy: number, refraction: number) {
			return {
				id,
				type: "path",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				segments: translateSegments(squareSegments(), dx, dy),
				filters: [glassExtrude(refraction)],
			} as unknown as AnyArtObject;
		}

		function blendOf(keyIds: string[], hoisted: Filter): AnyArtObject {
			return {
				id: "blend-1",
				type: "blend",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				opacity: 1,
				blendMode: "normal",
				objectIds: keyIds,
				spacing: { type: "steps", count: 1 },
				filters: [hoisted],
			} as unknown as AnyArtObject;
		}

		it("should bake one glass solid per interpolated instance when every key is glass", async () => {
			const renderer = await makeRenderer();
			const keyA = glassKey("key-a", 0, 0, 1.5);
			const keyB = glassKey("key-b", 200, 200, 1.5);
			const blend = blendOf(["key-a", "key-b"], glassExtrude(1.5));

			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(blend, keyA, keyB),
				1,
				1,
			);

			// Per-instance: keys + interpolated intermediate(s), more than the single
			// combined solid the pre-fix glass path produced.
			const entries = renderer.getFrameEntries("blend-1");
			expect(entries.length).toBeGreaterThan(1);
			expect(entries.every((e) => e.refraction != null)).toBe(true);
			// Absorbed keys must NOT be baked standalone (no double-stacked glass).
			expect(renderer.getFrameEntries("key-a")).toHaveLength(0);
			expect(renderer.getFrameEntries("key-b")).toHaveLength(0);
		});

		it("should bake a mixed glass/opaque blend per-instance, with zero-warp refraction on the opaque end", async () => {
			const renderer = await makeRenderer();
			const keyA = glassKey("key-a", 0, 0, 1.5); // glass
			const keyB = glassKey("key-b", 200, 200, 1); // opaque (refraction 1)
			const blend = blendOf(["key-a", "key-b"], glassExtrude(1.5));

			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(blend, keyA, keyB),
				1,
				1,
			);

			// Every instance (2 keys + 1 intermediate) bakes as its own solid, all
			// carrying a refraction entry so the backdrop path composites them in
			// paint order — the opaque end's refraction is just a zero-warp draw.
			const entries = renderer.getFrameEntries("blend-1");
			expect(entries).toHaveLength(3);
			expect(entries.every((e) => e.refraction != null)).toBe(true);
			const scales = entries.map((e) => e.refraction!.refractScale);
			expect(Math.max(...scales)).toBeGreaterThan(0); // glass end warps
			expect(Math.min(...scales)).toBe(0); // opaque end does not
		});
	});

	describe("cross-frame render cache (enableRenderCache)", () => {
		function glassPath(
			depth: number,
			rotateYDeg: number,
			extraMaterial: Record<string, unknown> = {},
		): AnyArtObject {
			return pathWithExtrude(depth, rotateYDeg, {
				material: {
					shading: "lambert",
					lightDir: [0, 0, 1],
					refraction: 1.5,
					...extraMaterial,
				},
			}) as unknown as AnyArtObject;
		}

		function setup(underlayHandler?: {
			postProcess: () => void;
			postProcessUnderlay: ReturnType<typeof vi.fn>;
		}) {
			const device = createFakeDevice();
			const handler = new Extrude3DFilterHandler();
			const filterRenderer = {
				getHandler: (t: string) => {
					if (t === "extrude3d") return handler;
					if (t === "drop-shadow") return underlayHandler;
					return undefined;
				},
				calculateExpansion: () => 0,
			} as unknown as FilterRenderer;
			handler.setFilterRenderer(filterRenderer);
			return handler.initialize(device as unknown as GPUDevice).then(() => {
				// biome-ignore lint/style/noNonNullAssertion: initialized above.
				const drivers = handler.getGeometryPassDrivers()!;
				const texturePool = createFakeTexturePool();
				const appearanceCache = new AppearanceCache();
				const renderElementToTexture = createBakeMock();
				const renderer = new ExtrudeAppearanceRenderer({
					device: device as unknown as GPUDevice,
					texturePool: texturePool as unknown as TexturePool,
					appearanceCache,
					filterRenderer,
					processor: "extrude3d",
					getParentGroupMap: () => new Map(),
					compoundPathCache: {} as unknown as CompoundPathCache,
					renderElementToTexture,
					resolvePatternTexture: () => null,
					resolveTextOutline: () => null,
					requestTextOutline: () => {},
					isImageReady: () => true,
					meshPass: drivers.meshPass,
					baker: drivers.baker,
					refractionCompositor: new RefractionCompositor(
						device as unknown as GPUDevice,
					),
					backdropEffectCoordinator: createFakeBackdropCoordinator(),
					deferDestroy: () => {},
				});
				const encodePassSpy = vi.spyOn(drivers.meshPass, "encodePass");
				const released: unknown[] = [];
				const releaseFrame = () =>
					renderer.releaseFrame((tex) => {
						released.push(tex);
						(texturePool as unknown as TexturePool).release(tex);
					});
				return {
					renderer,
					texturePool,
					appearanceCache,
					renderElementToTexture,
					encodePassSpy,
					released,
					releaseFrame,
				};
			});
		}

		it("should reuse the cached bake across frames when nothing changed (steady state)", async () => {
			const { renderer, texturePool, encodePassSpy, released, releaseFrame } =
				await setup();
			const glass = glassPath(20, 0);

			renderer.prepareFrame(createFakeEncoder(), toMap(glass), 1, 1);
			const entry1 = renderer.getFrameEntries("path-1")[0] ?? null;
			releaseFrame();

			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(20, 0)), 1, 1);
			const entry2 = renderer.getFrameEntries("path-1")[0] ?? null;
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(1);
			expect(texturePool.acquire).toHaveBeenCalledTimes(2); // color + normal, once
			expect(entry1).not.toBeNull();
			expect(entry1!.texture.texture).toBe(entry2!.texture.texture);
			expect(released).toHaveLength(0);
		});

		it("should rebake when rotation changes", async () => {
			const { renderer, encodePassSpy, releaseFrame } = await setup();

			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(20, 0)), 1, 1);
			releaseFrame();
			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(glassPath(20, 45)),
				1,
				1,
			);
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(2);
		});

		it("should rebake when material changes", async () => {
			const { renderer, encodePassSpy, releaseFrame } = await setup();

			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(20, 0)), 1, 1);
			releaseFrame();
			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(glassPath(20, 0, { roughness: 0.9 })),
				1,
				1,
			);
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(2);
		});

		it("should release the outgoing texture via releaseFrame on a render-hash-only change (mesh unchanged)", async () => {
			const { renderer, texturePool, releaseFrame } = await setup();

			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(20, 0)), 1, 1);
			const entry1 = renderer.getFrameEntries("path-1")[0] ?? null;
			releaseFrame();

			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(glassPath(20, 45)),
				1,
				1,
			);
			releaseFrame();

			expect(texturePool.release).toHaveBeenCalledWith(entry1!.texture.texture);
		});

		it("should release the outgoing texture via flushPendingDestroy (not releaseFrame) on a mesh-hash change", async () => {
			const { renderer, texturePool, appearanceCache, releaseFrame } =
				await setup();

			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(20, 0)), 1, 1);
			const entry1 = renderer.getFrameEntries("path-1")[0] ?? null;
			releaseFrame();
			vi.mocked(texturePool.release).mockClear();

			// depth change → getOrBuildMesh builds a NEW ExtrudeMeshCacheEntry;
			// the old one is evicted via AppearanceCache.set's deferDestroy, not
			// released through this frame's sink/releaseFrame.
			renderer.prepareFrame(createFakeEncoder(), toMap(glassPath(40, 0)), 1, 1);
			releaseFrame();
			expect(texturePool.release).not.toHaveBeenCalledWith(entry1!.texture);

			appearanceCache.flushPendingDestroy();
			expect(texturePool.release).toHaveBeenCalledWith(entry1!.texture.texture);
		});

		it("should rebake a group when a child's fill color changes (recursive paint hash)", async () => {
			const { renderer, encodePassSpy, releaseFrame } = await setup();
			const group = {
				...groupWithExtrude(["child-1"]),
				filters: [
					{
						...groupWithExtrude(["child-1"]).filters![0],
						paramData: {
							version: "1",
							params: {
								depth: 20,
								rotationDeg: [0, 0, 0],
								perspective: 0,
								material: {
									shading: "lambert",
									lightDir: [0, 0, 1],
									refraction: 1.5,
								},
							},
						},
					},
				],
			} as unknown as AnyArtObject;
			const child1 = childFillPath("child-1");
			const child2 = {
				...childFillPath("child-1"),
				filters: [
					{
						...(childFillPath("child-1").filters![0] as Filter),
						paramData: {
							version: "1",
							params: {
								fill: {
									type: "solid",
									color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
								},
							},
						},
					},
				],
			} as unknown as AnyArtObject;

			renderer.prepareFrame(createFakeEncoder(), toMap(group, child1), 1, 1);
			releaseFrame();
			renderer.prepareFrame(createFakeEncoder(), toMap(group, child2), 1, 1);
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(2);
		});

		it("should keep the cache hit when a compound-object group's non-contributing child attribute changes", async () => {
			const { renderer, encodePassSpy, releaseFrame } = await setup();
			const group = {
				...groupWithExtrude(["child-1"]),
				filters: [
					solidFillAppearance(),
					{
						...groupWithExtrude(["child-1"]).filters![0],
						paramData: {
							version: "1",
							params: {
								depth: 20,
								rotationDeg: [0, 0, 0],
								perspective: 0,
								material: {
									shading: "lambert",
									lightDir: [0, 0, 1],
									refraction: 1.5,
								},
							},
						},
					},
				],
			} as unknown as AnyArtObject;
			const child1 = childFillPath("child-1");
			// A compound-object group's cache key is its OWN filters only — the
			// child's fill color does not feed the combined shape, so this must
			// NOT invalidate the cache (unlike the plain-group test above).
			const child2 = {
				...childFillPath("child-1"),
				opacity: 0.5,
			} as unknown as AnyArtObject;

			renderer.prepareFrame(createFakeEncoder(), toMap(group, child1), 1, 1);
			releaseFrame();
			renderer.prepareFrame(createFakeEncoder(), toMap(group, child2), 1, 1);
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(1);
		});

		it("should rebake a group when an image child's readiness changes", async () => {
			const device = createFakeDevice();
			const handler = new Extrude3DFilterHandler();
			const filterRenderer = {
				getHandler: (t: string) => (t === "extrude3d" ? handler : undefined),
			} as unknown as FilterRenderer;
			handler.setFilterRenderer(filterRenderer);
			await handler.initialize(device as unknown as GPUDevice);
			// biome-ignore lint/style/noNonNullAssertion: initialized above.
			const drivers = handler.getGeometryPassDrivers()!;
			let imageReady = false;
			const renderer = new ExtrudeAppearanceRenderer({
				device: device as unknown as GPUDevice,
				texturePool: createFakeTexturePool() as unknown as TexturePool,
				appearanceCache: new AppearanceCache(),
				filterRenderer,
				processor: "extrude3d",
				getParentGroupMap: () => new Map(),
				compoundPathCache: {} as unknown as CompoundPathCache,
				renderElementToTexture: createBakeMock(),
				resolvePatternTexture: () => null,
				resolveTextOutline: () => null,
				requestTextOutline: () => {},
				isImageReady: () => imageReady,
				meshPass: drivers.meshPass,
				baker: drivers.baker,
				refractionCompositor: new RefractionCompositor(
					device as unknown as GPUDevice,
				),
				backdropEffectCoordinator: createFakeBackdropCoordinator(),
				deferDestroy: () => {},
			});
			const encodePassSpy = vi.spyOn(drivers.meshPass, "encodePass");
			const group = {
				...groupWithExtrude(["child-1"]),
				filters: [
					{
						...groupWithExtrude(["child-1"]).filters![0],
						paramData: {
							version: "1",
							params: {
								depth: 20,
								rotationDeg: [0, 0, 0],
								perspective: 0,
								material: {
									shading: "lambert",
									lightDir: [0, 0, 1],
									refraction: 1.5,
								},
							},
						},
					},
				],
			} as unknown as AnyArtObject;
			const image = {
				id: "child-1",
				type: "image",
				fileUid: "file-1",
				x: 0,
				y: 0,
				width: 40,
				height: 40,
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			} as unknown as AnyArtObject;

			renderer.prepareFrame(createFakeEncoder(), toMap(group, image), 1, 1);
			renderer.releaseFrame(() => {});
			imageReady = true;
			renderer.prepareFrame(createFakeEncoder(), toMap(group, image), 1, 1);
			renderer.releaseFrame(() => {});

			expect(encodePassSpy).toHaveBeenCalledTimes(2);
		});

		it("should rebake a group when its clip path assignment changes", async () => {
			const { renderer, encodePassSpy, releaseFrame } = await setup();
			const baseGroup = groupWithExtrude(["child-1", "clip-a", "clip-b"]);
			const group1 = {
				...baseGroup,
				clipPathId: "clip-a",
				filters: [
					{
						...baseGroup.filters![0],
						paramData: {
							version: "1",
							params: {
								depth: 20,
								rotationDeg: [0, 0, 0],
								perspective: 0,
								material: {
									shading: "lambert",
									lightDir: [0, 0, 1],
									refraction: 1.5,
								},
							},
						},
					},
				],
			} as unknown as AnyArtObject;
			const group2 = {
				...group1,
				clipPathId: "clip-b",
			} as unknown as AnyArtObject;
			const child1 = childFillPath("child-1");
			const clipA = childFillPath("clip-a");
			const clipB = childFillPath("clip-b");

			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(group1, child1, clipA, clipB),
				1,
				1,
			);
			releaseFrame();
			renderer.prepareFrame(
				createFakeEncoder(),
				toMap(group2, child1, clipA, clipB),
				1,
				1,
			);
			releaseFrame();

			expect(encodePassSpy).toHaveBeenCalledTimes(2);
		});

		describe("coverage-driven downstream underlays", () => {
			/**
			 * Stands in for DropShadowFilterProcessor.postProcessUnderlay: it
			 * writes a cache entry under the uid it is handed, exactly like the
			 * real one, so the driver's release bookkeeping is observable through
			 * the entries' destroy().
			 */
			function underlaySpy() {
				const destroyed: string[] = [];
				return {
					destroyed,
					postProcess: () => {},
					postProcessUnderlay: vi.fn(
						(
							ctx: UnderlayProcessorContext,
							filter: Filter,
						): UnderlayResult | null => {
							ctx.appearanceCache?.set(filter.uid, {
								hash: "underlay",
								destroy: () => destroyed.push(filter.uid),
							});
							return {
								texture: createBorrowedTextureRef(
									{} as GPUTexture,
									"appearance-cache",
								),
								bounds: {
									minX: 0,
									minY: 0,
									maxX: 1,
									maxY: 1,
									width: 1,
									height: 1,
								},
								uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
							};
						},
					),
				};
			}

			function glassWithShadow(): AnyArtObject {
				const path = pathWithExtrude(20, 0, {
					material: {
						shading: "lambert",
						lightDir: [0, 0, 1],
						refraction: 1.5,
					},
				}) as unknown as AnyArtObject;
				return {
					...path,
					filters: [...(path.filters ?? []), appearance("drop-shadow")],
				} as AnyArtObject;
			}

			it("should hand the solid's coverage mask to a downstream underlay filter", async () => {
				const shadow = underlaySpy();
				const { renderer, releaseFrame } = await setup(shadow);

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				const entry = renderer.getFrameEntries("path-1")[0];
				releaseFrame();

				expect(shadow.postProcessUnderlay).toHaveBeenCalledTimes(1);
				const [ctx] = shadow.postProcessUnderlay.mock.calls[0];
				// The normal MRT's alpha is the backdrop-independent coverage.
				expect(ctx.coverage.texture).toBe(
					entry.refraction?.normalTexture.texture,
				);
				expect(ctx.coverage.quad).toHaveLength(4);
				// The document rasterization scale, never the viewport zoom.
				expect(ctx.rasterScale).toBe(3);
				expect(ctx.coverageHash).toBe(entry.contentHash);
			});

			it("should route only the first of two stacked shadows through the underlay", async () => {
				// The chain is sequential: the second shadow is cast by the alpha of
				// "solid over the first shadow", not by the solid again. Only the
				// leading one may be rebuilt from coverage; the rest stay in the
				// post-composite chain, which reads the glass with shadow #1 in it.
				const shadow = underlaySpy();
				const path = glassWithShadow() as Path;
				const stacked = {
					...path,
					filters: [
						...(path.filters ?? []),
						{ ...appearance("drop-shadow"), uid: "drop-shadow-2" },
					],
				} as unknown as AnyArtObject;
				const { renderer, releaseFrame } = await setup(shadow);

				renderer.prepareFrame(createFakeEncoder(), toMap(stacked), 3, 1);
				releaseFrame();

				expect(shadow.postProcessUnderlay).toHaveBeenCalledTimes(1);
				const [, usedFilter] = shadow.postProcessUnderlay.mock.calls[0];
				expect(usedFilter.uid).toBe("app-drop-shadow");
			});

			it("should release the cached shadow when the drop shadow is removed", async () => {
				const shadow = underlaySpy();
				const { renderer, appearanceCache, releaseFrame } = await setup(shadow);
				const glassOnly = pathWithExtrude(20, 0, {
					material: {
						shading: "lambert",
						lightDir: [0, 0, 1],
						refraction: 1.5,
					},
				}) as unknown as AnyArtObject;

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				releaseFrame();
				expect(appearanceCache.get("path-1", "app-drop-shadow")).toBeDefined();

				renderer.prepareFrame(createFakeEncoder(), toMap(glassOnly), 3, 1);
				releaseFrame();
				appearanceCache.flushPendingDestroy();

				expect(
					appearanceCache.get("path-1", "app-drop-shadow"),
				).toBeUndefined();
				expect(shadow.destroyed).toEqual(["app-drop-shadow"]);
			});

			it("should release the cached shadow when the glass turns opaque", async () => {
				// The element still carries its 3D appearance and its shadow, but
				// the glass driver stops baking it — the shadow now comes from the
				// ordinary in-place chain, so the cached one is unreachable.
				const shadow = underlaySpy();
				const { renderer, appearanceCache, releaseFrame } = await setup(shadow);
				const opaque = pathWithExtrude(20, 0, {
					material: { shading: "lambert", lightDir: [0, 0, 1] },
				}) as unknown as AnyArtObject;
				const opaqueWithShadow = {
					...opaque,
					filters: [...(opaque.filters ?? []), appearance("drop-shadow")],
				} as AnyArtObject;

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				releaseFrame();

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(opaqueWithShadow),
					3,
					1,
				);
				releaseFrame();
				appearanceCache.flushPendingDestroy();

				expect(
					appearanceCache.get("path-1", "app-drop-shadow"),
				).toBeUndefined();
				expect(shadow.destroyed).toEqual(["app-drop-shadow"]);
			});

			it("should release the cached shadow when the 3D appearance itself is gone", async () => {
				// The element leaves the driver's sight entirely, so no per-element
				// pass can reach it — the end-of-frame sweep has to.
				const shadow = underlaySpy();
				const { renderer, appearanceCache, releaseFrame } = await setup(shadow);
				const flat = {
					...(pathWithExtrude(20, 0) as unknown as Path),
					filters: [appearance("drop-shadow")],
				} as unknown as AnyArtObject;

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				releaseFrame();

				renderer.prepareFrame(createFakeEncoder(), toMap(flat), 3, 1);
				releaseFrame();
				appearanceCache.flushPendingDestroy();

				expect(
					appearanceCache.get("path-1", "app-drop-shadow"),
				).toBeUndefined();
				expect(shadow.destroyed).toEqual(["app-drop-shadow"]);
			});

			it("should keep the cached shadow across an export that filters the element out", async () => {
				// An export renders a subset; the elements it leaves out are still
				// on the live canvas, so their shadows must survive it.
				const shadow = underlaySpy();
				const { renderer, appearanceCache, releaseFrame } = await setup(shadow);

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				releaseFrame();

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
					null,
					new Set(["some-other-element"]),
				);
				releaseFrame();
				appearanceCache.flushPendingDestroy();

				expect(appearanceCache.get("path-1", "app-drop-shadow")).toBeDefined();
				expect(shadow.destroyed).toEqual([]);
			});

			it("should keep the underlay's cache key stable while only the viewport moves", async () => {
				// prepareFrame takes no backdrop and no viewport position, so two
				// identical frames hand the underlay the same hash — the filter's own
				// cache then serves the second one without rendering.
				const shadow = underlaySpy();
				const { renderer, releaseFrame } = await setup(shadow);

				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					1,
				);
				releaseFrame();
				// A different backdrop scale stands in for a zoom step.
				renderer.prepareFrame(
					createFakeEncoder(),
					toMap(glassWithShadow()),
					3,
					4,
				);
				releaseFrame();

				const [first] = shadow.postProcessUnderlay.mock.calls[0];
				const [second] = shadow.postProcessUnderlay.mock.calls[1];
				expect(second.coverageHash).toBe(first.coverageHash);
			});

			it("should scale the glass blur request by the backdrop capture scale", async () => {
				// material.blur is authored in world px; the request the coordinator
				// plans against must be in capture texels.
				const planFrame = vi.fn();
				const { renderer } = await setup();
				(
					renderer as unknown as {
						deps: { backdropEffectCoordinator: { planFrame: unknown } };
					}
				).deps.backdropEffectCoordinator.planFrame = planFrame;
				const blurred = pathWithExtrude(20, 0, {
					material: {
						shading: "lambert",
						lightDir: [0, 0, 1],
						refraction: 1.5,
						blur: 5,
					},
				}) as unknown as AnyArtObject;

				renderer.prepareFrame(createFakeEncoder(), toMap(blurred), 1, 3);

				expect(planFrame).toHaveBeenCalledTimes(1);
				const [requests] = planFrame.mock.calls[0] as [{ blurSigma: number }[]];
				expect(requests[0].blurSigma).toBeCloseTo(15, 6);
			});
		});
	});
});

describe("buildExtrudeOutline", () => {
	it("should return the segments as-is without a stroke appearance", () => {
		const segments = squareSegments();
		expect(buildExtrudeOutline([appearance("fill")], segments)).toBe(segments);
	});

	it("should sweep an open path into a closed slab outline", () => {
		const line = [lineSeg({ x: 0, y: 0 }, { x: 40, y: 0 }, true)];
		const outline = buildExtrudeOutline([strokeAppearance(10)], line);

		const subs = splitByIsMoved(outline);
		expect(subs).toHaveLength(1);
		// The sweep spans ±half the stroke width around the line.
		const ys = subs[0].flatMap((s) => [
			...(s.start ? [s.start.y] : []),
			s.end.y,
		]);
		expect(Math.min(...ys)).toBeCloseTo(-5, 0);
		expect(Math.max(...ys)).toBeCloseTo(5, 0);
	});

	it("should build an outer ring and a counter-wound hole for a stroke-only closed path", () => {
		const outline = buildExtrudeOutline(
			[strokeAppearance(10)],
			squareSegments(),
		);

		const areas = splitByIsMoved(outline).map(computeSubPathSignedArea);
		expect(areas).toHaveLength(2);
		// Outer expansion is CCW-positive, the hole counter-wound and smaller.
		expect(areas[0]).toBeGreaterThan(40 * 40);
		expect(areas[1]).toBeLessThan(0);
		expect(Math.abs(areas[1])).toBeLessThan(areas[0]);
	});

	it("should merge fill and stroke into one solid with no hole", () => {
		const outline = buildExtrudeOutline(
			[solidFillAppearance(), strokeAppearance(10)],
			squareSegments(),
		);

		const areas = splitByIsMoved(outline).map(computeSubPathSignedArea);
		// The fill covers the middle, so the union has no interior hole — one
		// solid, the outward-swept boundary (larger than the 40×40 fill).
		expect(areas).toHaveLength(1);
		expect(areas[0]).toBeGreaterThan(40 * 40);
	});

	it("should collapse the hole when the stroke is wider than the shape", () => {
		// A 40×40 square with a 120-wide stroke is fully painted — no frame hole.
		const outline = buildExtrudeOutline(
			[strokeAppearance(120)],
			squareSegments(),
		);

		const areas = splitByIsMoved(outline).map(computeSubPathSignedArea);
		expect(areas).toHaveLength(1);
		expect(areas[0]).toBeGreaterThan(0);
	});
});

describe("hasEnabledSolidAppearance", () => {
	it("should detect an enabled appearance of the given processor", () => {
		expect(hasEnabledSolidAppearance(pathWithExtrude(20, 0), "extrude3d")).toBe(
			true,
		);
	});

	it("should ignore a disabled appearance, another processor, or none", () => {
		const disabled = pathWithExtrude(20, 0);
		disabled.filters![0] = { ...disabled.filters![0], enabled: false };
		expect(hasEnabledSolidAppearance(disabled, "extrude3d")).toBe(false);
		expect(hasEnabledSolidAppearance(pathWithExtrude(20, 0), "revolve3d")).toBe(
			false,
		);
		expect(
			hasEnabledSolidAppearance(
				{ filters: [appearance("fill")] } as AnyArtObject,
				"extrude3d",
			),
		).toBe(false);
	});
});

describe("resolveFillAppearance", () => {
	it("should return the enabled fill appearance carrying a fill", () => {
		const fill = gradientFillAppearance();
		expect(resolveFillAppearance([appearance("stroke"), fill])).toBe(fill);
	});

	it("should return null without a usable fill appearance", () => {
		expect(resolveFillAppearance([appearance("stroke")])).toBe(null);
		expect(resolveFillAppearance(undefined)).toBe(null);
	});
});

describe("resolveFillBaseColor", () => {
	it("should return the solid fill color", () => {
		const color = { type: "rgb", r: 0, g: 1, b: 0, a: 1 };
		const fill = {
			...appearance("fill"),
			paramData: { version: "1", params: { fill: { type: "solid", color } } },
		} as unknown as Filter;
		expect(resolveFillBaseColor([fill])).toEqual(color);
	});

	it("should return the first gradient stop color", () => {
		const color = { type: "rgb", r: 0, g: 0, b: 1, a: 1 };
		const fill = {
			...appearance("fill"),
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "linear",
						x1: 0,
						y1: 0,
						x2: 1,
						y2: 1,
						stops: [
							{ offset: 0, color },
							{ offset: 1, color: { type: "rgb", r: 1, g: 1, b: 1, a: 1 } },
						],
					},
				},
			},
		} as unknown as Filter;
		expect(resolveFillBaseColor([fill])).toEqual(color);
	});

	it("should return null without an enabled fill appearance", () => {
		expect(resolveFillBaseColor(undefined)).toBe(null);
		expect(resolveFillBaseColor([appearance("stroke")])).toBe(null);
		const disabledFill = {
			...appearance("fill"),
			enabled: false,
			paramData: {
				version: "1",
				params: {
					fill: {
						type: "solid",
						color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
					},
				},
			},
		} as unknown as Filter;
		expect(resolveFillBaseColor([disabledFill])).toBe(null);
	});
});

describe("buildTextGlyphOutline", () => {
	it("should run an element geometry filter once over the whole text", () => {
		const cached = {
			paths: [
				{ id: "glyph-0", segments: squareSegments() },
				{ id: "glyph-1", segments: translateSegments(squareSegments(), 20, 0) },
			] as unknown as Path[],
		};
		const receivedSegmentCounts: number[] = [];
		const filterRenderer = {
			getHandler: (processor: string) =>
				processor === "path-union"
					? {
							preProcess: (segments: CubicBezierSegment[]) => {
								receivedSegmentCounts.push(segments.length);
								return segments;
							},
						}
					: undefined,
		} as unknown as FilterRenderer;

		const outline = buildTextGlyphOutline(
			cached,
			{ x: 0, y: 0, filters: [appearance("path-union")] },
			filterRenderer,
		);

		// Both glyphs arrive in a single call. A per-glyph unit would instead show
		// two calls of four segments each, which is what lets path-union merge a
		// glyph's own counters while leaving overlapping neighbours separate.
		expect(receivedSegmentCounts).toEqual([8]);
		expect(splitByIsMoved(outline.flatSegments)).toHaveLength(2);
	});

	it("should run the geometry filter before the stroke sweep, as the path branch does", () => {
		const cached = {
			paths: [
				{ id: "glyph-0", segments: squareSegments() },
			] as unknown as Path[],
		};
		const receivedSegmentCounts: number[] = [];
		const filterRenderer = {
			getHandler: (processor: string) =>
				processor === "path-union"
					? {
							preProcess: (segments: CubicBezierSegment[]) => {
								receivedSegmentCounts.push(segments.length);
								return segments;
							},
						}
					: undefined,
		} as unknown as FilterRenderer;

		const outline = buildTextGlyphOutline(
			cached,
			{
				x: 0,
				y: 0,
				filters: [appearance("path-union"), strokeAppearance(4)],
			},
			filterRenderer,
		);

		// The filter sees the raw four-segment fill outline, not the swept
		// polygon — the sweep normalizes winding, so a boolean filter running
		// after it would hand buildExtrudeMesh unnormalized contours.
		expect(receivedSegmentCounts).toEqual([4]);
		expect(outline.segments.length).toBeGreaterThan(
			outline.flatSegments.length,
		);
	});

	it("should keep glyph counters as holes when path-union runs over the whole text", () => {
		const handler = new PathUnionFilterHandler();
		const filterRenderer = {
			getHandler: (processor: string) =>
				processor === "path-union" ? handler : undefined,
		} as unknown as FilterRenderer;
		const counter = (dx: number) =>
			reverseSubPath(translateSegments(squareSegments(20), dx + 10, 10));
		const cached = {
			paths: [
				{
					id: "glyph-0",
					segments: [...squareSegments(), ...counter(0)],
				},
				{
					id: "glyph-1",
					segments: [
						...translateSegments(squareSegments(), 60, 0),
						...counter(60),
					],
				},
			] as unknown as Path[],
		};

		const outline = buildTextGlyphOutline(
			cached,
			{ x: 0, y: 0, filters: [appearance("path-union")] },
			filterRenderer,
		);

		const areas = splitByIsMoved(outline.flatSegments).map(
			computeSubPathSignedArea,
		);
		// Two outers and two counters survive, and the counters are wound against
		// the outers so buildExtrudeMesh's dominant-winding rule cuts them out.
		expect(areas).toHaveLength(4);
		expect(areas.filter((a) => a > 0)).toHaveLength(2);
		expect(areas.filter((a) => a < 0)).toHaveLength(2);

		// The mesh silhouette is what actually gets triangulated, so the counters
		// have to survive the stroke sweep too, not just the boolean.
		const meshAreas = splitByIsMoved(outline.segments).map(
			computeSubPathSignedArea,
		);
		expect(meshAreas.filter((a) => a > 0)).toHaveLength(2);
		expect(meshAreas.filter((a) => a < 0)).toHaveLength(2);
	});

	it("should keep glyph counters as holes through the stroke sweep", () => {
		const handler = new PathUnionFilterHandler();
		const filterRenderer = {
			getHandler: (processor: string) =>
				processor === "path-union" ? handler : undefined,
		} as unknown as FilterRenderer;
		const counter = (dx: number) =>
			reverseSubPath(translateSegments(squareSegments(20), dx + 10, 10));
		const cached = {
			paths: [
				{ id: "glyph-0", segments: [...squareSegments(), ...counter(0)] },
				{
					id: "glyph-1",
					segments: [
						...translateSegments(squareSegments(), 60, 0),
						...counter(60),
					],
				},
			] as unknown as Path[],
		};

		const outline = buildTextGlyphOutline(
			cached,
			{
				x: 0,
				y: 0,
				filters: [
					appearance("path-union"),
					solidFillAppearance(),
					strokeAppearance(4),
				],
			},
			filterRenderer,
		);

		const meshAreas = splitByIsMoved(outline.segments).map(
			computeSubPathSignedArea,
		);
		// The sweep widens the outers and narrows the counters, but a counter that
		// the stroke does not close over stays a hole.
		expect(meshAreas.filter((a) => a > 0)).toHaveLength(2);
		expect(meshAreas.filter((a) => a < 0)).toHaveLength(2);
	});

	it("should leave the glyph outlines untouched when no geometry filter is enabled", () => {
		const cached = {
			paths: [
				{ id: "glyph-0", segments: squareSegments() },
			] as unknown as Path[],
		};
		const filterRenderer = {
			getHandler: () => undefined,
		} as unknown as FilterRenderer;

		const outline = buildTextGlyphOutline(
			cached,
			{ x: 5, y: 7, filters: [appearance("path-union")] },
			filterRenderer,
		);

		expect(outline.flatSegments).toHaveLength(4);
		expect(outline.flatSegments[0].start).toEqual({ x: 5, y: 7 });
	});
});

// Helpers

function createFakeDevice() {
	const createBuffer = vi.fn((desc: { label?: string }) => ({
		label: desc.label,
		destroy: vi.fn(),
	}));
	return {
		createBuffer,
		createShaderModule: vi.fn(() => ({
			getCompilationInfo: () => Promise.resolve({ messages: [] }),
		})),
		createBindGroupLayout: vi.fn(() => ({})),
		createPipelineLayout: vi.fn(() => ({})),
		createRenderPipeline: vi.fn(
			(_descriptor: GPURenderPipelineDescriptor) => ({}),
		),
		createBindGroup: vi.fn(() => ({})),
		createSampler: vi.fn(() => ({})),
		createTexture: vi.fn(() => ({
			createView: vi.fn(() => ({})),
			destroy: vi.fn(),
		})),
		queue: { writeBuffer: vi.fn() },
	};
}

/** Count mesh vertex-buffer allocations (excludes uniform pool buffers). */
function meshBufferCount(device: ReturnType<typeof createFakeDevice>) {
	return device.createBuffer.mock.calls.filter(
		([desc]) => desc.label === "Extrude Mesh Vertices",
	).length;
}

function createFakeTexturePool() {
	return {
		acquire: vi.fn(
			(
				width: number,
				height: number,
				format: string,
				_sampleCount = 1,
				_usage?: number,
				_label?: string,
			) => ({
				width: Math.ceil(width / 64) * 64,
				height: Math.ceil(height / 64) * 64,
				format,
				createView: vi.fn(() => ({})),
			}),
		),
		release: vi.fn(() => true),
	};
}

/** Fake backdrop coordinator — prepareFrame only registers requests. */
function createFakeBackdropCoordinator(): BackdropEffectCoordinator {
	return {
		planFrame: vi.fn(),
		noteDraw: vi.fn(),
		acquireSample: vi.fn(() => null),
	} as unknown as BackdropEffectCoordinator;
}

/** Fake fill-bake dep returning a texture + full uv rect, or null when off. */
function createBakeMock() {
	return vi.fn(
		(
			_encoder: GPUCommandEncoder,
			_element: AnyArtObject,
			bounds: WorldBBox,
			_elementsMap: Map<string, AnyArtObject> | undefined,
			_rasterScale: number,
		): RasterizedRenderSurface | null => ({
			...createRenderSurface(
				createFrameTextureRef(
					{ createView: () => ({}) } as unknown as GPUTexture,
					() => {},
				),
				{
					kind: "world-aabb",
					bounds,
					uvRect: { minU: 0, minV: 0, maxU: 1, maxV: 1 },
				},
				{
					role: "color",
					alphaMode: "premultiplied",
					opacityState: "intrinsic",
				},
			),
			effectiveZoom: 1,
		}),
	);
}

function createFakeEncoder(): GPUCommandEncoder {
	return {
		copyTextureToTexture: vi.fn(),
		beginRenderPass: vi.fn(() => ({
			setViewport: vi.fn(),
			setPipeline: vi.fn(),
			setBindGroup: vi.fn(),
			setVertexBuffer: vi.fn(),
			setIndexBuffer: vi.fn(),
			drawIndexed: vi.fn(),
			end: vi.fn(),
		})),
	} as unknown as GPUCommandEncoder;
}

function toMap(...elements: AnyArtObject[]): Map<string, AnyArtObject> {
	return new Map(elements.map((el) => [el.id, el]));
}

function appearance(processor: string): Filter {
	return {
		uid: `app-${processor}`,
		processor,
		enabled: true,
		opacity: 1,
		blendMode: "normal",
		paramData: { version: "1", params: {} },
	} as unknown as Filter;
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

function pathWithExtrude(
	depth: number,
	rotateYDeg: number,
	extraParams: Record<string, unknown> = {},
): Path & { transform?: ElementTransform } {
	return {
		id: "path-1",
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: squareSegments(),
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth,
						rotationDeg: [0, rotateYDeg, 0],
						perspective: 0,
						material: {
							shading: "lambert",
							lightDir: [0, 0, 1],
						},
						...extraParams,
					},
				},
			},
		],
	} as unknown as Path & { transform?: ElementTransform };
}

/** A closed square outline, 40×40 by default (isClosed set on the last segment). */
function squareSegments(size = 40): CubicBezierSegment[] {
	const points: BezierPoint[] = [
		{ x: 0, y: 0 },
		{ x: size, y: 0 },
		{ x: size, y: size },
		{ x: 0, y: size },
	];
	return points.map((p, i) => ({
		...lineSeg(p, points[(i + 1) % points.length], i === 0),
		isClosed: i === points.length - 1,
	}));
}

/** Reverse a closed sub-path's direction so it winds against its container. */
function reverseSubPath(segments: CubicBezierSegment[]): CubicBezierSegment[] {
	const points: BezierPoint[] = [];
	let cursor = segments[0].start ?? { x: 0, y: 0 };
	for (const seg of segments) {
		points.push({ x: cursor.x, y: cursor.y });
		cursor = seg.end;
	}
	points.reverse();
	return points.map((p, i) => ({
		...lineSeg(p, points[(i + 1) % points.length], i === 0),
		isClosed: i === points.length - 1,
	}));
}

function translateSegments(
	segments: CubicBezierSegment[],
	x: number,
	y: number,
): CubicBezierSegment[] {
	return segments.map((seg) => ({
		...seg,
		...(seg.start && { start: { x: seg.start.x + x, y: seg.start.y + y } }),
		end: { x: seg.end.x + x, y: seg.end.y + y },
	}));
}

/** A group carrying an enabled extrude3d appearance (identity transform). */
function groupWithExtrude(childIds: string[]): AnyArtObject {
	return {
		id: "group-1",
		type: "group",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		childIds,
		opacity: 1,
		blendMode: "normal",
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: { shading: "lambert", lightDir: [0, 0, 1] },
					},
				},
			},
		],
	} as unknown as AnyArtObject;
}

/** A Text element carrying an enabled extrude3d appearance directly. */
function textWithExtrude(id: string, x: number, y: number): AnyArtObject {
	return {
		id,
		type: "text",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		x,
		y,
		opacity: 1,
		blendMode: "normal",
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: { shading: "lambert", lightDir: [0, 0, 1] },
					},
				},
			},
		],
	} as unknown as AnyArtObject;
}

/** A Blend element carrying an enabled extrude3d appearance directly. */
function blendWithExtrude(id: string, objectIds: string[]): AnyArtObject {
	return {
		id,
		type: "blend",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		opacity: 1,
		blendMode: "normal",
		objectIds,
		spacing: { type: "steps", count: 1 },
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: { shading: "lambert", lightDir: [0, 0, 1] },
					},
				},
			},
		],
	} as unknown as AnyArtObject;
}

/** A CompoundPath element carrying an enabled extrude3d appearance directly. */
function compoundWithExtrude(id: string, sourceIds: string[]): AnyArtObject {
	return {
		id,
		type: "compound-path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		opacity: 1,
		blendMode: "normal",
		sources: sourceIds.map((sid, i) => ({
			id: sid,
			op: i === 0 ? "add" : "subtract",
		})),
		filters: [
			{
				uid: "app-1",
				processor: "extrude3d",
				enabled: true,
				opacity: 1,
				blendMode: "normal",
				paramData: {
					version: "1",
					params: {
						depth: 20,
						rotationDeg: [0, 0, 0],
						perspective: 0,
						material: { shading: "lambert", lightDir: [0, 0, 1] },
					},
				},
			},
		],
	} as unknown as AnyArtObject;
}

/** A filled square path (has an outline area) usable as a group child. */
function childFillPath(id: string): AnyArtObject {
	return {
		id,
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: squareSegments(),
		filters: [solidFillAppearance()],
	} as unknown as AnyArtObject;
}

/** A stroke-only open line (no fill area) usable as a group child. */
function childStrokeLine(id: string): AnyArtObject {
	return {
		id,
		type: "path",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		segments: [lineSeg({ x: 0, y: 0 }, { x: 40, y: 0 }, true)],
		filters: [strokeAppearance(10)],
	} as unknown as AnyArtObject;
}

function gradientFillAppearance(): Filter {
	return {
		...appearance("fill"),
		paramData: {
			version: "1",
			params: {
				fill: {
					type: "linear",
					x1: 0,
					y1: 0,
					x2: 1,
					y2: 1,
					stops: [
						{ offset: 0, color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 } },
						{ offset: 1, color: { type: "rgb", r: 0, g: 0, b: 1, a: 1 } },
					],
				},
			},
		},
	} as unknown as Filter;
}

function solidFillAppearance(): Filter {
	return {
		...appearance("fill"),
		paramData: {
			version: "1",
			params: {
				fill: { type: "solid", color: { type: "rgb", r: 0, g: 1, b: 0, a: 1 } },
			},
		},
	} as unknown as Filter;
}

function strokeAppearance(size: number): Filter {
	return {
		...appearance("stroke"),
		paramData: {
			version: "1",
			params: {
				strokeColor: {
					type: "solid",
					color: { type: "rgb", r: 1, g: 0, b: 0, a: 1 },
				},
				brushSettings: {
					version: 2,
					engine: "geometric",
					strokeOpacity: 1,
					paintMode: "buildup",
					properties: { size: { base: size } },
					randomSeed: 0,
				},
			},
		},
	} as unknown as Filter;
}

/** Split segments into sub-paths at isMoved boundaries. */
function splitByIsMoved(
	segments: CubicBezierSegment[],
): CubicBezierSegment[][] {
	const subs: CubicBezierSegment[][] = [];
	let current: CubicBezierSegment[] = [];
	for (const seg of segments) {
		if (seg.isMoved && current.length > 0) {
			subs.push(current);
			current = [];
		}
		current.push(seg);
	}
	if (current.length > 0) subs.push(current);
	return subs;
}

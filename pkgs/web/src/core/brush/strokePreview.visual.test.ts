import { describe, expect, it } from "vitest";
import { airBrush } from "../assets";
import { createStrokeBrushSettings } from "../document/factory";
import type { RenderCacheManager } from "../renderer/canvas/caches/RenderCacheManager";
import type { BrushSettings, EmbeddedFile, PathSegment } from "../schema";
import { BUILTIN_BRUSH_IDS } from "../schema";
import { createTestRenderer } from "../testUtils/visualRegression";
import { createBrushStrokePreviewScene } from "./strokePreview";

describe("brushStrokePreview", () => {
	it("should render a non-empty preview for a builtin texture brush", async () => {
		const { renderer } = await createTestRenderer();
		try {
			const builtinFile = await createBitmapPreviewFile();
			const scene = createBrushStrokePreviewScene({
				brushSettings: imageTipBrush(builtinFile.uid),
				textureFile: builtinFile,
				segments: createTestSegments(),
				width: 96,
				height: 40,
			});

			const imageData = await renderer.renderElementsToImageData(
				[scene.pathId],
				scene.document,
				scene.bounds,
				scene.scale,
				scene.backgroundColor,
			);

			expect(imageData).not.toBeNull();
			if (!imageData) throw new Error("Expected bitmap brush preview image");
			expect(countVisiblePixels(imageData)).toBeGreaterThan(0);
		} finally {
			renderer.destroy();
		}
	});

	it("should render a non-empty preview for a geometric brush", async () => {
		const { renderer } = await createTestRenderer();
		try {
			const scene = createBrushStrokePreviewScene({
				brushSettings: createStrokeBrushSettings(14),
				textureFile: null,
				segments: createTestSegments(),
				width: 96,
				height: 40,
			});

			const imageData = await renderer.renderElementsToImageData(
				[scene.pathId],
				scene.document,
				scene.bounds,
				scene.scale,
				scene.backgroundColor,
			);

			expect(imageData).not.toBeNull();
			if (!imageData) throw new Error("Expected geometric brush preview image");
			expect(countVisiblePixels(imageData)).toBeGreaterThan(0);
		} finally {
			renderer.destroy();
		}
	});

	it("should render a non-empty wet ink preview through the simulation pipeline", async () => {
		const { renderer } = await createTestRenderer();
		try {
			const builtinFile = await createBitmapPreviewFile();
			const drySettings: BrushSettings = {
				...imageTipBrush(builtinFile.uid),
				properties: {
					size: { base: 24 },
					spacing: { base: 0.08 },
					flow: { base: 1 },
				},
			};
			const wetSettings: BrushSettings = {
				...drySettings,
				paintMode: "wash",
				wet: {
					enabled: true,
					bleedRadius: 0.65,
					pigmentLoad: 0.85,
					grainScale: 1.2,
				},
			};
			const dryScene = createBrushStrokePreviewScene({
				brushSettings: drySettings,
				textureFile: builtinFile,
				segments: createTestSegments(),
				width: 128,
				height: 56,
			});
			const wetScene = createBrushStrokePreviewScene({
				brushSettings: wetSettings,
				textureFile: builtinFile,
				segments: createTestSegments(),
				width: 128,
				height: 56,
			});

			const [dryImage, wetImage] = await Promise.all([
				renderer.renderElementsToImageData(
					[dryScene.pathId],
					dryScene.document,
					dryScene.bounds,
					dryScene.scale,
					dryScene.backgroundColor,
				),
				renderer.renderElementsToImageData(
					[wetScene.pathId],
					wetScene.document,
					wetScene.bounds,
					wetScene.scale,
					wetScene.backgroundColor,
				),
			]);

			expect(wetImage).not.toBeNull();
			if (!dryImage || !wetImage) {
				throw new Error("Expected dry and wet brush preview images");
			}
			expect(countVisiblePixels(wetImage)).toBeGreaterThan(0);
			expect(countDifferentPixels(dryImage, wetImage)).toBeGreaterThan(0);
		} finally {
			renderer.destroy();
		}
	});

	it("should produce a different preview when brush dynamics change", async () => {
		const { renderer } = await createTestRenderer();
		try {
			const builtinFile = await createBitmapPreviewFile();
			const baseSettings: BrushSettings = {
				...imageTipBrush(builtinFile.uid),
				properties: {
					size: { base: 24 },
					spacing: { base: 0.06 },
					flow: { base: 1 },
				},
			};
			// Wider spacing plus a speed-driven size falloff: the same stroke has
			// to come out visibly different from the flat one above.
			const dynamicSettings: BrushSettings = {
				...baseSettings,
				properties: {
					size: {
						base: 24,
						curves: [{ input: "speedFine", points: [[1, -0.5]] }],
					},
					spacing: { base: 0.2 },
					flow: { base: 1 },
				},
			};
			const baseScene = createBrushStrokePreviewScene({
				brushSettings: baseSettings,
				textureFile: builtinFile,
				segments: createTestSegments(),
				width: 96,
				height: 40,
			});
			const dynamicScene = createBrushStrokePreviewScene({
				brushSettings: dynamicSettings,
				textureFile: builtinFile,
				segments: createTestSegments(),
				width: 96,
				height: 40,
			});

			const [baseImage, dynamicImage] = await Promise.all([
				renderer.renderElementsToImageData(
					[baseScene.pathId],
					baseScene.document,
					baseScene.bounds,
					baseScene.scale,
					baseScene.backgroundColor,
				),
				renderer.renderElementsToImageData(
					[dynamicScene.pathId],
					dynamicScene.document,
					dynamicScene.bounds,
					dynamicScene.scale,
					dynamicScene.backgroundColor,
				),
			]);

			expect(baseImage).not.toBeNull();
			expect(dynamicImage).not.toBeNull();
			if (!baseImage || !dynamicImage) {
				throw new Error("Expected both brush preview images");
			}
			expect(countDifferentPixels(baseImage, dynamicImage)).toBeGreaterThan(0);
		} finally {
			renderer.destroy();
		}
	});

	it("should keep another document's cache scope intact across a preview render", async () => {
		// Regression: preview renders run strategy "full" over a throwaway
		// document through the shared cache manager; before per-document
		// scoping, that pruned every entry of the user's document.
		const { renderer } = await createTestRenderer();
		try {
			const scene = createBrushStrokePreviewScene({
				brushSettings: createStrokeBrushSettings(14),
				textureFile: null,
				segments: createTestSegments(),
				width: 96,
				height: 40,
			});
			// The same content re-housed under a different document id stands in
			// for the user's main document.
			const mainDocument = { ...scene.document, id: "main-doc" };
			await renderer.renderElementsToImageData(
				[scene.pathId],
				mainDocument,
				scene.bounds,
				scene.scale,
				scene.backgroundColor,
			);

			const cacheManager = cacheManagerOf(renderer);
			cacheManager.setActiveDocument("main-doc");
			const entriesBefore = countScopeEntries(cacheManager);
			expect(entriesBefore).toBeGreaterThan(0);

			await renderer.renderElementsToImageData(
				[scene.pathId],
				scene.document,
				scene.bounds,
				scene.scale,
				scene.backgroundColor,
			);

			cacheManager.setActiveDocument("main-doc");
			expect(countScopeEntries(cacheManager)).toBe(entriesBefore);
		} finally {
			renderer.destroy();
		}
	});
});

/** Total entries in the ACTIVE scope across the caches a stroke render can
 *  populate (stroke-only paths have no geometry entries, texture brushes go
 *  to the stamp cache — sum them so the check is route-agnostic). */
function countScopeEntries(cacheManager: RenderCacheManager): number {
	return (
		[...cacheManager.geometry.keys()].length +
		[...cacheManager.stroke.keys()].length +
		[...cacheManager.stamp.keys()].length
	);
}

/** Reach the primary target's cache manager. Test-only introspection — the
 *  engine deliberately exposes no public cache accessor. */
function cacheManagerOf(renderer: unknown): RenderCacheManager {
	const targets = (
		renderer as { targets: Map<string, { cacheManager: RenderCacheManager }> }
	).targets;
	const first = targets.values().next().value;
	if (!first) throw new Error("Test renderer has no canvas target");
	return first.cacheManager;
}

function countVisiblePixels(imageData: ImageData): number {
	let count = 0;

	for (let i = 0; i < imageData.data.length; i += 4) {
		if (imageData.data[i + 3] > 0) {
			count += 1;
		}
	}

	return count;
}

function countDifferentPixels(left: ImageData, right: ImageData): number {
	let count = 0;
	const length = Math.min(left.data.length, right.data.length);

	for (let i = 0; i < length; i += 4) {
		if (
			left.data[i] !== right.data[i] ||
			left.data[i + 1] !== right.data[i + 1] ||
			left.data[i + 2] !== right.data[i + 2] ||
			left.data[i + 3] !== right.data[i + 3]
		) {
			count += 1;
		}
	}

	return count;
}

function createTestSegments(): PathSegment[] {
	return [
		{
			start: { x: -100, y: 0 },
			cp1: { x: 20, y: 0 },
			cp2: { x: -20, y: 0 },
			end: { x: 0, y: 0 },
			isMoved: true,
			startPressure: 0,
			endPressure: 1,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 16,
		},
		{
			cp1: { x: 20, y: 0 },
			cp2: { x: -20, y: 0 },
			end: { x: 100, y: 0 },
			isMoved: false,
			startPressure: 1,
			endPressure: 0,
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 16,
		},
	];
}

async function createBitmapPreviewFile(): Promise<EmbeddedFile> {
	const bin = base64ToUint8Array(airBrush);
	const hashInput = new ArrayBuffer(bin.byteLength);
	new Uint8Array(hashInput).set(bin);
	const hashBuffer = await crypto.subtle.digest("SHA-256", hashInput);
	const hash = Array.from(new Uint8Array(hashBuffer), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

	return {
		uid: BUILTIN_BRUSH_IDS.airbrush,
		name: "Airbrush",
		type: "image/png",
		hash,
		bin,
	};
}

function base64ToUint8Array(base64: string): Uint8Array {
	const binary = atob(base64);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function imageTipBrush(fileUid: string): BrushSettings {
	return {
		version: 2,
		engine: "dab",
		strokeOpacity: 1,
		paintMode: "buildup",
		properties: { size: { base: 24 }, flow: { base: 1 } },
		tip: {
			kind: "image",
			sources: [{ kind: "file", fileUid }],
			selection: "random",
			angleMode: "fixed",
		},
		randomSeed: 0,
	};
}

import { describe, expect, it } from "vitest";
import type { WetInkSettings } from "../../../../schema";
import { buildWetInkSimCacheKey } from "./WetInkPass";

const TEST_SETTINGS: WetInkSettings = {
	enabled: true,
	bleedWidth: 0.3,
	edgeDarkening: 0.2,
	edgeRoughness: 0.25,
	paperGrain: 0.15,
	paperScale: 24,
	wetness: 0.6,
	speedInfluence: 0.1,
	accelInfluence: 0.1,
	diffusion: 0.2,
	directionality: 0.05,
	pigmentLoad: 0.85,
	absorption: 0.35,
	granulation: 0.25,
	pickupUnderlyingColor: false,
	pickupStrength: 0.35,
};

describe("buildWetInkSimCacheKey", () => {
	it("changes when wet settings change", () => {
		const a = buildWetInkSimCacheKey({
			pathKey: "p1:segments",
			settings: TEST_SETTINGS,
			randomSeed: 7,
			brushSize: 24,
			domainWorldOrigin: { x: 10, y: 20 },
			domainWorldSize: { width: 64, height: 32 },
			domainTextureSize: { width: 64, height: 32 },
			domainWorldPerPixel: 1,
		});
		const b = buildWetInkSimCacheKey({
			pathKey: "p1:segments",
			settings: {
				...TEST_SETTINGS,
				directionality: 0.7,
			},
			randomSeed: 7,
			brushSize: 24,
			domainWorldOrigin: { x: 10, y: 20 },
			domainWorldSize: { width: 64, height: 32 },
			domainTextureSize: { width: 64, height: 32 },
			domainWorldPerPixel: 1,
		});

		expect(a).not.toBe(b);
	});

	it("changes when render-buffer pickup input changes", () => {
		const a = buildWetInkSimCacheKey({
			pathKey: "p1:segments",
			settings: TEST_SETTINGS,
			randomSeed: 7,
			brushSize: 24,
			domainWorldOrigin: { x: 10, y: 20 },
			domainWorldSize: { width: 64, height: 32 },
			domainTextureSize: { width: 64, height: 32 },
			domainWorldPerPixel: 1,
			renderBufferKey: "backdrop-a",
		});
		const b = buildWetInkSimCacheKey({
			pathKey: "p1:segments",
			settings: TEST_SETTINGS,
			randomSeed: 7,
			brushSize: 24,
			domainWorldOrigin: { x: 10, y: 20 },
			domainWorldSize: { width: 64, height: 32 },
			domainTextureSize: { width: 64, height: 32 },
			domainWorldPerPixel: 1,
			renderBufferKey: "backdrop-b",
		});

		expect(a).not.toBe(b);
	});
});

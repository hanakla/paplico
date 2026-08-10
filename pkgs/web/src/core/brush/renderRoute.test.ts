import { resolveBrushRenderRoute } from "./renderRoute";

describe("resolveBrushRenderRoute", () => {
	const scatterV1 = {
		type: "scatter",
		size: 10,
		sizeByPressure: 0,
		opacity: 1,
		opacityByPressure: 0,
		randomSeed: 0,
		source: { kind: "file", fileUid: "tex-1" },
		spacing: 0.1,
		flow: 1,
		stampRotation: "none",
		rotationByTilt: 0,
		aspectRatioByTilt: 0,
		sizeBySpeed: 0,
		pooling: 0,
		poolingSizeRatio: 0.5,
	};

	it("should route plain scatter strokes to the v2 dab pipeline", () => {
		const route = resolveBrushRenderRoute(scatterV1);
		expect(route.kind).toBe("dab");
		if (route.kind !== "dab") throw new Error("unreachable");
		expect(route.settings.version).toBe(2);
		expect(route.settings.engine).toBe("dab");
	});

	it("should route calligraphy strokes to the v2 dab pipeline", () => {
		const route = resolveBrushRenderRoute({
			type: "calligraphy",
			size: 10,
			sizeByPressure: 0,
			opacity: 1,
			opacityByPressure: 0,
			randomSeed: 0,
			nibAngle: 45,
			roundness: 0.5,
			angleMode: "fixed",
			flow: 1,
			sizeBySpeed: 0,
			pooling: 0,
			poolingSizeRatio: 0.5,
		});
		expect(route.kind).toBe("dab");
	});

	it("should route a migrated wet brush onto the dab engine", () => {
		// A pre-v2 wet brush becomes a v2 wet layer, which only the dab engine
		// draws.
		const route = resolveBrushRenderRoute({
			...scatterV1,
			wetInk: {
				enabled: true,
				bleedWidth: 0.5,
				edgeDarkening: 0.4,
				edgeRoughness: 0.3,
				paperGrain: 0.2,
				paperScale: 1,
				directionality: 0.4,
				speedInfluence: 0.5,
				accelInfluence: 0.3,
				wetness: 0.7,
				pigmentLoad: 0.85,
				absorption: 0.35,
				granulation: 0.25,
				pickupUnderlyingColor: false,
				pickupStrength: 0,
			},
		});

		expect(route.kind).toBe("dab");
		expect(route.settings.wet?.enabled).toBe(true);
	});

	it("should treat disabled wet ink as a plain v2 dab stroke", () => {
		const route = resolveBrushRenderRoute({
			...scatterV1,
			wetInk: {
				enabled: false,
				bleedWidth: 0.5,
				edgeDarkening: 0.4,
				edgeRoughness: 0.3,
				paperGrain: 0.2,
				paperScale: 1,
				directionality: 0.4,
				speedInfluence: 0.5,
				accelInfluence: 0.3,
				wetness: 0.7,
				pigmentLoad: 0.85,
				absorption: 0.35,
				granulation: 0.25,
				pickupUnderlyingColor: false,
				pickupStrength: 0.35,
			},
		});
		expect(route.kind).toBe("dab");
	});

	it("should route ribbon and geometric engines to their legacy paths", () => {
		expect(
			resolveBrushRenderRoute({
				type: "art",
				size: 10,
				sizeByPressure: 0,
				opacity: 1,
				opacityByPressure: 0,
				randomSeed: 0,
				source: { kind: "file", fileUid: "a" },
				flow: 1,
			}).kind,
		).toBe("ribbon");
		expect(
			resolveBrushRenderRoute({
				type: "stroke",
				size: 10,
				sizeByPressure: 0,
				opacity: 1,
				opacityByPressure: 0,
				randomSeed: 0,
			}).kind,
		).toBe("geometric");
	});
});

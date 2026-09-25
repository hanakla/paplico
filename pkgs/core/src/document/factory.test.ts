import { describe, expect, it } from "vitest";
import { isReference3D } from "../schema";
import {
	createDefaultLineart3DParams,
	createReference3DElement,
} from "./factory";

describe("createReference3DElement", () => {
	const rect = { sceneId: "scene-1", x: 0, y: 0, width: 400, height: 300 };

	it("should create a lineart element with the default oblique camera", () => {
		const element = createReference3DElement(rect);

		expect(element.type).toBe("reference3d");
		expect(element.id).toMatch(/^reference3d-/);
		expect(element.sceneId).toBe("scene-1");
		expect(element.opacity).toBe(1);
		expect(element.blendMode).toBe("normal");
		expect(element.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
			skewY: 0,
		});
		expect(element.displayMode).toBe("lineart");
		expect(element.camera).toEqual({
			projection: "perspective",
			position: [4, 3, 6],
			target: [0, 1, 0],
			fovDeg: 50,
		});
		expect(element.lineart).toEqual(createDefaultLineart3DParams());
	});

	it("should provide the tuned lineart starting values", () => {
		expect(createDefaultLineart3DParams()).toEqual({
			lineWidthPx: 1.5,
			depthEdgeThreshold: 0.02,
			normalEdgeThreshold: 0.4,
			creaseAngleDeg: 40,
			color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		});
	});

	it("should mint a unique id per element", () => {
		expect(createReference3DElement(rect).id).not.toBe(
			createReference3DElement(rect).id,
		);
	});

	it("should accept overrides for camera and displayMode", () => {
		const element = createReference3DElement({
			...rect,
			displayMode: "flat",
			camera: {
				projection: "orthographic",
				position: [0, 10, 0],
				target: [0, 0, 0],
				fovDeg: 50,
				orthoHeight: 5,
			},
		});

		expect(element.displayMode).toBe("flat");
		expect(element.camera.projection).toBe("orthographic");
		expect(element.camera.orthoHeight).toBe(5);
	});

	it("should be recognized by the isReference3D type guard", () => {
		const element = createReference3DElement(rect);
		expect(isReference3D(element)).toBe(true);
		expect(
			isReference3D({
				id: "p1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: element.transform,
				segments: [],
			}),
		).toBe(false);
	});
});

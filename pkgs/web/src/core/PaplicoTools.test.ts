import { normalizeBrushSettingsV2 } from "./brush/migrate";
import { PaplicoTools } from "./PaplicoTools";
import type { BrushSettingsV2 } from "./schema";
import { createToolSettings } from "./tools/toolSettings";

describe("PaplicoTools.setBrushSettings", () => {
	function makeTools() {
		const store = createToolSettings();
		const tools = new PaplicoTools(store, { getCurrentTool: () => null });
		tools.setStrokeColor({
			type: "solid",
			color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
		});
		return { store, tools };
	}

	function storedSettings(store: ReturnType<typeof createToolSettings>) {
		return store.strokeAppearance?.paramData.params
			.brushSettings as unknown as BrushSettingsV2;
	}

	it("should store BrushSettingsV2 after a flat patch", () => {
		const { store, tools } = makeTools();
		tools.setBrushSettings({ type: "scatter", size: 24 } as Parameters<
			typeof tools.setBrushSettings
		>[0]);

		const stored = storedSettings(store);
		expect(stored.version).toBe(2);
		expect(stored.properties.size?.base).toBe(24);
	});

	it("should keep the legacy view getter working on stored v2", () => {
		const { tools } = makeTools();
		tools.setBrushSettings({ size: 24 });
		expect(tools.brushSettings.size).toBe(24);
	});

	it("should preserve curve-editor curves across an unrelated flat patch", () => {
		const { store, tools } = makeTools();
		const withCurve = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				size: { base: 20 },
				flow: {
					base: 0.5,
					curves: [
						{
							input: "strokeT",
							points: [
								[0, 0.4],
								[0.5, -0.2],
								[1, 0.4],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			randomSeed: 0,
		});
		if (!store.strokeAppearance) throw new Error("unreachable");
		store.strokeAppearance.paramData.params.brushSettings = withCurve;

		tools.setBrushSettings({ size: 42 });

		const stored = storedSettings(store);
		expect(stored.version).toBe(2);
		expect(stored.properties.size?.base).toBe(42);
		const strokeTCurve = stored.properties.flow?.curves?.find(
			(c) => c.input === "strokeT",
		);
		expect(strokeTCurve?.points.length).toBe(3);
	});

	it("should fully replace stored settings when given a complete v2 value", () => {
		const { store, tools } = makeTools();
		const withCurve = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: {
				flow: {
					base: 0.5,
					curves: [
						{
							input: "strokeT",
							points: [
								[0, 0.4],
								[1, 0.4],
							],
						},
					],
				},
			},
			tip: { kind: "procedural", hardness: 1, angleMode: "fixed" },
			randomSeed: 0,
		});
		if (!store.strokeAppearance) throw new Error("unreachable");
		store.strokeAppearance.paramData.params.brushSettings = withCurve;

		const preset = normalizeBrushSettingsV2({
			version: 2,
			engine: "dab",
			strokeOpacity: 1,
			paintMode: "buildup",
			properties: { size: { base: 8 }, flow: { base: 1 } },
			tip: { kind: "procedural", hardness: 0.5, angleMode: "fixed" },
			randomSeed: 0,
		});
		tools.setBrushSettings(preset);

		const stored = storedSettings(store);
		expect(stored.properties.size?.base).toBe(8);
		expect(stored.properties.flow?.curves).toBeUndefined();
	});
});

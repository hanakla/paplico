import type { BrushSettings, Document, Viewport } from "../../schema";
import { migBrushV2 } from "../migrations/20260803_mig_brush_v2";
import { applyMigration } from "../migrations/index";
import { openPapf } from "./reader";
import { serializeDocument } from "./writer";

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function makeV1BrushDoc(): Document {
	return {
		id: "brush-v2-roundtrip",
		objects: {
			p1: {
				id: "p1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				segments: [],
				filters: [
					{
						enabled: true,
						processor: "stroke",
						opacity: 1,
						blendMode: "normal",
						paramData: {
							params: {
								strokeColor: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
								brushSettings: {
									type: "scatter",
									size: 20,
									sizeByPressure: 0.5,
									opacity: 0.8,
									opacityByPressure: 0.3,
									randomSeed: 7,
									source: { kind: "file", fileUid: "tex-1" },
									spacing: 0.12,
									flow: 0.6,
									stampRotation: "random",
									rotationByTilt: 0.5,
									aspectRatioByTilt: 0.6,
									sizeBySpeed: 0.4,
									pooling: 0.8,
									poolingSizeRatio: 0.25,
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
										pickupUnderlyingColor: true,
										pickupStrength: 0.35,
									},
								},
							},
						},
					},
				],
			},
		} as unknown as Document["objects"],
		layers: [],
		viewport: defaultViewport,
		files: [],
		artboards: [],
		brushPresets: [
			{
				uid: "preset-1",
				name: "Preset 1",
				settings: {
					type: "stroke",
					size: 4,
					sizeByPressure: 0,
					opacity: 1,
					opacityByPressure: 0,
					randomSeed: 0,
				} as unknown as BrushSettings,
			},
		],
	};
}

function getStrokeBrushSettings(doc: Document): Record<string, any> {
	const path = doc.objects.p1 as any;
	return path.filters[0].paramData.params.brushSettings;
}

describe("brush v2 papf roundtrip", () => {
	it("should migrate a stored v1 papf and survive a save/reload cycle unchanged", async () => {
		const original = makeV1BrushDoc();

		// Load the old-format file and migrate.
		const oldBlob = await serializeDocument(original);
		const loaded = await (await openPapf(oldBlob)).toDocument();
		applyMigration(loaded, migBrushV2);

		const migrated = getStrokeBrushSettings(loaded);
		expect(migrated.version).toBe(2);
		expect(migrated.engine).toBe("dab");
		expect(migrated.wet?.enabled).toBe(true);
		expect((loaded.brushPresets?.[0]?.settings as any).version).toBe(2);

		// Save the migrated document, reload it and migrate again (papf never
		// persists schemaVersion, so the migration reruns on every load).
		const newBlob = await serializeDocument(loaded);
		const reloaded = await (await openPapf(newBlob)).toDocument();
		applyMigration(reloaded, migBrushV2);

		expect(getStrokeBrushSettings(reloaded)).toEqual(migrated);
		expect(reloaded.brushPresets).toEqual(loaded.brushPresets);
	});
});

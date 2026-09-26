import { describe, expect, it } from "vitest";
import { extractDocumentFromYDoc } from "./collaboration/extractDocumentFromYDoc";
import {
	YjsProvider,
	type YjsProviderCallbacks,
} from "./collaboration/YjsProvider";
import { createIdentityTransform } from "./document/factory";
import { createRendererState } from "./document/rendererState";
import { SpatialIndex } from "./document/SpatialIndex";
import { PaplicoCommands } from "./PaplicoCommands";
import type { BoundingBox, Layer, Path } from "./schema";
import { rectPath } from "./testUtils/svgFixtures";

const COMBINED_PATH_IDS = ["a", "b"];

describe("PaplicoCommands.resizeElements", () => {
	describe("resizing a group that holds a rotated compound path", () => {
		it("should scale the compound path in place with its siblings", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() =>
				f.commands.createCompoundPathFromSelection("union"),
			);

			expectScaledInPlace(f, groupId);
		});
	});

	describe("resizing a group that holds a rotated blend", () => {
		it("should scale the blend in place with its siblings", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() => {
				const result = f.commands.createBlendFromSelection();
				return result.ok ? result.blendId : null;
			});

			expectScaledInPlace(f, groupId);
		});

		it("should scale a rotated compound path key in place", () => {
			const f = createFixture();
			const groupId = f.createGroupWithRotated(() => {
				const compoundId = f.commands.createCompoundPathFromSelection("union");
				if (!compoundId) return null;
				f.rotate(compoundId, 0.4);
				f.addPath(rectPath("d", { x: 150, y: -20 }, 30, 30, []));
				f.select([compoundId, "d"]);
				const result = f.commands.createBlendFromSelection();
				return result.ok ? result.blendId : null;
			});

			expectScaledInPlace(f, groupId);
		});
	});
});

function createFixture() {
	const store = createRendererState();
	const callbacks: YjsProviderCallbacks = {
		onDocumentUpdate: (doc) => {
			store.document = doc;
		},
		onObjectsChange: () => sync(),
		onLayersUpdate: () => {},
		getCurrentLayerId: () => store.currentLayerId,
		setCurrentLayerId: (id) => {
			store.currentLayerId = id;
		},
	};
	const provider = new YjsProvider({ callbacks });
	const spatial = new SpatialIndex(store);
	const sync = (): void => {
		store.document = extractDocumentFromYDoc(provider.ydoc);
		spatial.rebuildAllIndices();
		spatial.rebuildParentGroupMap();
	};
	const commands = new PaplicoCommands({
		store,
		yjsProvider: provider,
		spatial,
		isReadonly: () => false,
	});
	const layer: Layer = {
		id: "layer",
		name: "layer",
		visible: true,
		locked: false,
		opacity: 1,
		elementIds: [],
	};
	provider.addLayer(layer);
	store.currentLayerId = "layer";
	sync();

	return {
		commands,
		addPath(path: Path): void {
			provider.addElement("layer", path);
			sync();
		},
		select(ids: string[]): void {
			store.selectedElementIds = ids;
		},
		rotate(id: string, rotation: number): void {
			provider.updateElement("layer", id, {
				transform: { ...createIdentityTransform(), rotation },
			});
			sync();
		},
		worldBounds(id: string): BoundingBox {
			const bounds = spatial.getWorldGeometryBounds(id);
			if (!bounds) throw new Error(`no bounds for ${id}`);
			return bounds;
		},
		/**
		 * A translated group holding a rotated combination of two paths that
		 * differ in size, so the combination's own centre moves as they scale.
		 */
		createGroupWithRotated(combine: () => string | null): string {
			provider.addElement("layer", rectPath("a", { x: 0, y: 0 }, 20, 20, []));
			provider.addElement("layer", rectPath("b", { x: 60, y: 30 }, 80, 40, []));
			sync();
			store.selectedElementIds = [...COMBINED_PATH_IDS];
			const targetId = combine();
			if (!targetId) throw new Error("combination should be created");
			provider.updateElement("layer", targetId, {
				transform: {
					...createIdentityTransform(),
					x: 100,
					y: -50,
					rotation: -0.3,
				},
			});
			provider.addElement("layer", rectPath("c", { x: -40, y: 0 }, 10, 10, []));
			const groupId = provider.groupElements("layer", [targetId, "c"]);
			if (!groupId) throw new Error("group should be created");
			provider.updateElement("layer", groupId, {
				transform: { ...createIdentityTransform(), x: 40, y: 70 },
			});
			sync();
			return groupId;
		},
	};
}

/**
 * Resize the group by 1.5 and expect the combined paths to follow it exactly.
 * They are measured one by one because a rotated combination's own bounds
 * are a loose box that tightens once its rotation is baked away.
 */
function expectScaledInPlace(
	f: ReturnType<typeof createFixture>,
	groupId: string,
): void {
	const original = f.worldBounds(groupId);
	const before = COMBINED_PATH_IDS.map((id) => f.worldBounds(id));
	const scale = 1.5;

	f.commands.resizeElements(
		[groupId],
		original,
		scaleFromMinCorner(original, original, scale),
	);

	COMBINED_PATH_IDS.forEach((id, i) => {
		const after = f.worldBounds(id);
		const expected = scaleFromMinCorner(before[i], original, scale);
		for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
			expect(after[key]).toBeCloseTo(expected[key], 6);
		}
	});
}

/** Map `box` by the resize that scales `frame` about its min corner. */
function scaleFromMinCorner(
	box: BoundingBox,
	frame: BoundingBox,
	scale: number,
): BoundingBox {
	const minX = frame.minX + (box.minX - frame.minX) * scale;
	const minY = frame.minY + (box.minY - frame.minY) * scale;
	const width = box.width * scale;
	const height = box.height * scale;
	return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

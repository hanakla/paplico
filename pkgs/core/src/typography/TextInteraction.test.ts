import { createIdentityTransform } from "../document/factory";
import type { SpatialIndex } from "../document/SpatialIndex";
import { TextDependencyIndex } from "../document/TextDependencyIndex";
import type { AnyArtObject, Document, Group } from "../schema";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import type { WorldBBox } from "../utils/geometry/bounds";
import { TextInteraction } from "./TextInteraction";
import type { TextRenderer } from "./TextRenderer";

describe("TextInteraction", () => {
	describe("findTextAtPoint", () => {
		it("should reach a text inside the group under the pointer", () => {
			const text = createTestTextElement("hi", { id: "t1" });
			const group = createGroup("g1", [text.id]);
			const { interaction } = createInteraction([group, text], {
				findElementAtPoint: () => group,
				worldBounds: { [text.id]: bbox(0, 0, 100, 20) },
			});

			expect(interaction.findTextAtPoint(50, 10)?.id).toBe(text.id);
		});
	});

	describe("hitTestCharacter", () => {
		it("should hit the flow-chain region under the pointer in its own layout space", async () => {
			const head = createTestTextElement("hello", {
				id: "head",
				flow: { nextTextElementId: "next" },
			});
			const next = createTestTextElement("", { id: "next", x: 200, y: 0 });
			const { interaction, textRenderer } = createInteraction([head, next], {
				worldBounds: {
					[head.id]: bbox(0, 0, 100, 50),
					[next.id]: bbox(200, 0, 300, 50),
				},
			});

			await interaction.hitTestCharacter(head, 230, 10);

			const [region, localX, localY] = vi.mocked(textRenderer.hitTestCharacter)
				.mock.calls[0];
			expect(region.id).toBe(next.id);
			expect(localX).toBeCloseTo(30);
			expect(localY).toBeCloseTo(10);
		});
	});

	describe("selectionRects", () => {
		it("should scale the rects of a scaled text into world space", async () => {
			const text = {
				...createTestTextElement("hello", { id: "t1", x: 10, y: 0 }),
				transform: { ...createIdentityTransform(), scaleX: 2, scaleY: 3 },
			};
			const { interaction } = createInteraction([text], {
				selectionRects: [{ x: 5, y: 0, width: 20, height: 10 }],
			});

			const rects = await interaction.selectionRects(text, 0, 2);

			expect(rects).toEqual([{ x: 30, y: 0, width: 40, height: 30 }]);
		});

		it("should return no rects for an empty range", async () => {
			const text = createTestTextElement("hello", { id: "t1" });
			const { interaction, textRenderer } = createInteraction([text]);

			expect(await interaction.selectionRects(text, 2, 2)).toEqual([]);
			expect(textRenderer.getSelectionRects).not.toHaveBeenCalled();
		});
	});
});

function createInteraction(
	elements: AnyArtObject[],
	opts: {
		findElementAtPoint?: () => AnyArtObject | null;
		worldBounds?: Record<string, WorldBBox>;
		selectionRects?: Array<{
			x: number;
			y: number;
			width: number;
			height: number;
		}>;
	} = {},
) {
	const document = {
		layers: [{ id: "layer", elementIds: [elements[0].id] }],
		objects: Object.fromEntries(elements.map((e) => [e.id, e])),
	} as unknown as Document;
	const textDepIndex = new TextDependencyIndex();
	textDepIndex.rebuild(document);

	const textRenderer = {
		hitTestCharacter: vi.fn(async () => 0),
		getSelectionRects: vi.fn(async () => opts.selectionRects ?? []),
		hitTestBoundTextSync: vi.fn(() => null),
	} as unknown as TextRenderer;
	const spatialIndex = {
		getAncestorTransform: () => null,
		getWorldBounds: (id: string) => opts.worldBounds?.[id] ?? null,
		findElementAtPoint: opts.findElementAtPoint ?? (() => null),
	} as unknown as SpatialIndex;

	const interaction = new TextInteraction({
		getDocument: () => document,
		getSpatialIndex: () => spatialIndex,
		textDepIndex,
		getTextRenderer: () => textRenderer,
		getHitTolerance: () => 1,
	});
	return { interaction, textRenderer };
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

function bbox(minX: number, minY: number, maxX: number, maxY: number) {
	return {
		minX,
		minY,
		maxX,
		maxY,
		width: maxX - minX,
		height: maxY - minY,
	} as WorldBBox;
}

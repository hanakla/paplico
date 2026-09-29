import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type { Document, Group, Path, TextElement } from "../../schema";
import {
	createMockFontManager,
	createTestTextElement,
} from "../../testUtils/typographyFixtures";
import { prepareMigrationContext } from "./context";

const TURNED = { ...createIdentityTransform(), rotation: 0.4 };

describe("prepareMigrationContext", () => {
	it("should measure a turned text with its fonts", async () => {
		const text = createTestTextElement("Hello", { id: "t", x: 30, y: 10 });
		text.transform = TURNED;

		const { textLayoutBounds } = await prepareMigrationContext(
			makeDoc([text]),
			createMockFontManager(),
		);

		// The mock font advances 10 per character, so five characters span
		// 50 from the element's x.
		const bounds = textLayoutBounds.get("t");
		expect(bounds?.minX).toBe(30);
		expect(bounds?.maxX).toBe(80);
	});

	it("should measure an upright text inside a turned group", async () => {
		const text = createTestTextElement("Hi", { id: "t" });
		const group: Group = {
			type: "group",
			id: "g",
			childIds: ["t"],
			opacity: 1,
			blendMode: "normal",
			transform: TURNED,
		};

		const { textLayoutBounds } = await prepareMigrationContext(
			makeDoc([text, group]),
			createMockFontManager(),
		);

		expect(textLayoutBounds.has("t")).toBe(true);
	});

	it("should leave an upright text and a path-bound text to the estimate", async () => {
		const upright = createTestTextElement("Hi", { id: "upright" });
		const bound = createTestTextElement("Hi", {
			id: "bound",
			axisBinding: {
				pathObjectId: "axis",
				mode: "onPath",
				startOffset: 0,
				alignment: "left",
				offsetDistance: 0,
				orientation: "rotate",
			},
		});
		bound.transform = TURNED;
		const axis: Path = {
			type: "path",
			id: "axis",
			segments: [],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
		};

		const { textLayoutBounds } = await prepareMigrationContext(
			makeDoc([upright, bound, axis]),
			createMockFontManager(),
		);

		expect(textLayoutBounds.size).toBe(0);
	});
});

function makeDoc(elements: (TextElement | Group | Path)[]): Document {
	return {
		id: "doc",
		objects: Object.fromEntries(elements.map((el) => [el.id, el])),
		layers: [
			{
				id: "layer",
				name: "layer",
				visible: true,
				locked: false,
				opacity: 1,
				blendMode: "normal",
				elementIds: elements.map((el) => el.id),
			},
		],
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [],
		brushPresets: [],
		units: "px",
	};
}

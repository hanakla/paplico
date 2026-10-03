import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type { AnyArtObject, MeshArtObject, TextElement } from "../../../schema";
import {
	createMockFontManager,
	createTestTextElement,
} from "../../../testUtils/typographyFixtures";
import { TextLayoutEngine } from "../../../typography/TextLayoutEngine";
import { TextRenderer } from "../../../typography/TextRenderer";
import { DocumentRenderScope } from "../../DocumentScopeRegistry";
import { TextElementRenderer } from "../elements/TextElementRenderer";
import { MeshWarpCache } from "./MeshWarpCache";

describe("MeshWarpCache", () => {
	it("should warp the glyphs of a flow tail again when its head outside the mesh gets back earlier text", async () => {
		const scene = createFlowScene("aaaaaaaa");
		const filled = await scene.drawUntilLaidOut();
		scene.setHeadText("aaaa");
		const emptied = await scene.drawUntilLaidOut();

		scene.setHeadText("aaaaaaaa");
		const restored = scene.draw();

		expect(emptied.transients).toHaveLength(0);
		expect(restored.transients).toEqual(filled.transients);
	});
});

/**
 * A two-region flow chain whose tail sits in a mesh and whose head sits
 * outside it. Each region holds four characters, so the tail draws glyphs
 * only while the head text is longer than four.
 */
function createFlowScene(headText: string) {
	const regionLayout = {
		boxWidth: 40,
		boxHeight: 30,
		wordWrap: true,
		overflow: "hidden",
	} as const;
	const createHead = (text: string) =>
		createTestTextElement(text, {
			id: "head",
			layout: regionLayout,
			flow: { nextTextElementId: "tail" },
		});
	let head = createHead(headText);
	const tail = createTestTextElement("", {
		id: "tail",
		x: 10,
		y: 10,
		layout: regionLayout,
	});
	const mesh = createMeshContainer([tail.id]);

	const textRenderer = new TextRenderer(
		new TextLayoutEngine(createMockFontManager()),
	);
	textRenderer.setDocumentResolver({
		getElementById: (id) =>
			id === head.id ? head : id === tail.id ? tail : null,
		getWorldSegments: () => null,
		getGeometryRevision: () => 0,
		findFlowSource: (textId) => (textId === tail.id ? head : null),
	});
	const textElementRenderer = new TextElementRenderer({
		textState: { ...new DocumentRenderScope().text, renderer: textRenderer },
	} as unknown as ConstructorParameters<typeof TextElementRenderer>[0]);
	const cache = new MeshWarpCache();

	const draw = () =>
		cache.resolve(mesh, {
			elementsMap: new Map<string, AnyArtObject>([
				[mesh.id, mesh],
				[tail.id, tail],
				[head.id, head],
			]),
			getTextGlyphPaths: (element: TextElement) =>
				textElementRenderer.getWarpGlyphPaths(element),
		});

	return {
		draw,
		setHeadText: (text: string) => {
			head = createHead(text);
		},
		/** Draw a frame that requests the tail's layout, then the frame redrawn once it lands. */
		drawUntilLaidOut: async () => {
			draw();
			await textElementRenderer.ensureTextPaths(tail);
			return draw();
		},
	};
}

function createMeshContainer(childIds: string[]): MeshArtObject {
	return {
		id: "mesh-1",
		type: "mesh",
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		childIds,
		vertices: [
			{ x: 0, y: 0, src: { x: 0, y: 0 }, handles: {} },
			{ x: 100, y: 0, src: { x: 100, y: 0 }, handles: {} },
			{ x: 140, y: 150, src: { x: 100, y: 100 }, handles: {} },
			{ x: 0, y: 100, src: { x: 0, y: 100 }, handles: {} },
		],
		faces: [{ type: "quad", verts: [0, 1, 2, 3] }],
	};
}

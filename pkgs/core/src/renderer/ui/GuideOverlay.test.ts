import {
	createDefaultDocument,
	createIdentityTransform,
	createImageObject,
} from "../../document/factory";
import type { ObjectsChangeDelta } from "../../document/objectsChangeDelta";
import type {
	AnyArtObject,
	CompoundPath,
	Document,
	Group,
	Path,
	PathSegment,
	TextElement,
} from "../../schema";
import { closedRectSegments, lineSeg } from "../../testUtils/segmentFactory";
import { createTestTextElement } from "../../testUtils/typographyFixtures";
import { GuideOverlay } from "./GuideOverlay";
import type { BezierPathPrimitive } from "./primitives";
import { OVERLAY_Z, UI_THEME } from "./theme";

describe("GuideOverlay", () => {
	let outlineText: ReturnType<
		typeof vi.fn<(text: TextElement) => Promise<PathSegment[][] | null>>
	>;
	let onTextOutlined: ReturnType<typeof vi.fn<() => void>>;
	let overlay: GuideOverlay;

	beforeEach(() => {
		outlineText = vi.fn(async () => [
			[lineSeg({ x: 5, y: 0 }, { start: { x: 0, y: 0 } })],
		]);
		onTextOutlined = vi.fn();
		overlay = new GuideOverlay({ outlineText, onTextOutlined });
	});

	it("should draw a guide path as a cyan line between the artboards and the UI", () => {
		const doc = documentWith([path("guide", { isGuide: true })]);

		const result = overlay.build(doc);

		expect(result?.zIndex).toBe(OVERLAY_Z.guide);
		expect(OVERLAY_Z.artboard).toBeLessThan(OVERLAY_Z.guide);
		expect(OVERLAY_Z.guide).toBeLessThan(OVERLAY_Z.selection);
		const [primitive] = primitivesOf(result);
		expect(primitive.stroke?.color).toEqual(UI_THEME.colors.guide);
		expect(primitive.segments.at(-1)?.end).toEqual({ x: 0, y: 0 });
	});

	it("should return null when the document has no guide", () => {
		expect(overlay.build(documentWith([path("art")]))).toBeNull();
	});

	it("should skip a hidden guide and the guides of a hidden layer", () => {
		const hidden = documentWith([
			path("guide", { isGuide: true, visible: false }),
		]);
		const hiddenLayer = documentWith([path("guide", { isGuide: true })]);
		hiddenLayer.layers[0].visible = false;

		expect(overlay.build(hidden)).toBeNull();
		expect(overlay.build(hiddenLayer)).toBeNull();
	});

	it("should outline everything inside a guide group where the group places it", () => {
		const group: Group = {
			type: "group",
			id: "group",
			childIds: ["a", "b"],
			opacity: 1,
			blendMode: "normal",
			transform: { ...createIdentityTransform(), x: 100 },
			isGuide: true,
		};
		const doc = documentWith([group], [path("a"), path("b")]);

		const primitives = primitivesOf(overlay.build(doc));

		expect(primitives).toHaveLength(2);
		expect(primitives[0].segments[0].start).toEqual({ x: 100, y: 0 });
	});

	it("should outline a guide compound path by its boolean result", () => {
		const compound: CompoundPath = {
			type: "compound-path",
			id: "compound",
			sources: [
				{ id: "a", op: "union" },
				{ id: "b", op: "subtract" },
			],
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			isGuide: true,
		};
		const cut = path("b", { segments: closedRectSegments(5, 0, 15, 10) });
		const doc = documentWith([compound], [path("a"), cut]);

		const primitives = primitivesOf(overlay.build(doc));

		expect(primitives).toHaveLength(1);
		const xs = primitives[0].segments.map((segment) => segment.end.x);
		expect(Math.min(...xs)).toBeCloseTo(0);
		expect(Math.max(...xs)).toBeCloseTo(5);
	});

	it("should outline a guide image by its rectangle", () => {
		const image = {
			...createImageObject({
				fileUid: "file",
				x: 0,
				y: 0,
				width: 20,
				height: 10,
			}),
			isGuide: true,
		};
		const doc = documentWith([image]);

		const [primitive] = primitivesOf(overlay.build(doc));
		const xs = primitive.segments.map((segment) => segment.end.x);
		expect(Math.min(...xs)).toBe(-10);
		expect(Math.max(...xs)).toBe(10);
	});

	it("should draw a guide text by its glyphs once they are laid out", async () => {
		const text = {
			...createTestTextElement("A"),
			transform: { ...createIdentityTransform(), y: 50 },
			isGuide: true,
		};
		const doc = documentWith([text]);

		expect(overlay.build(doc)).toBeNull();
		await vi.waitFor(() => expect(onTextOutlined).toHaveBeenCalledOnce());

		const [primitive] = primitivesOf(overlay.build(doc));
		expect(primitive.segments[0].end).toEqual({ x: 5, y: 50 });
		expect(outlineText).toHaveBeenCalledOnce();
	});

	it("should ask for glyphs again when they could not be laid out", async () => {
		outlineText.mockResolvedValueOnce(null);
		const doc = documentWith([
			{ ...createTestTextElement("A"), isGuide: true },
		]);

		overlay.build(doc);
		await vi.waitFor(() => expect(outlineText).toHaveBeenCalledOnce());
		await Promise.resolve();
		overlay.build(doc);

		expect(outlineText).toHaveBeenCalledTimes(2);
		expect(onTextOutlined).not.toHaveBeenCalled();
	});

	describe("while tracking a document", () => {
		it("should draw a guide that a delta added to a document without guides", () => {
			const doc = documentWith([path("art")]);
			overlay.trackDocument(doc);
			expect(overlay.build(doc)).toBeNull();

			const guide = path("guide", { isGuide: true });
			doc.objects.guide = guide;
			doc.layers[0].elementIds.push("guide");
			overlay.trackObjectsDelta(delta({ added: [guide] }));

			expect(primitivesOf(overlay.build(doc))).toHaveLength(1);
		});

		it("should draw an element once an update marks it as a guide", () => {
			const doc = documentWith([path("art")]);
			overlay.trackDocument(doc);

			const marked = path("art", { isGuide: true });
			doc.objects.art = marked;
			overlay.trackObjectsDelta(delta({ updated: [marked] }));

			expect(primitivesOf(overlay.build(doc))).toHaveLength(1);
		});

		it("should keep drawing the remaining guide after another one is deleted", () => {
			const doc = documentWith([
				path("first", { isGuide: true }),
				path("second", { isGuide: true }),
			]);
			overlay.trackDocument(doc);

			delete doc.objects.first;
			doc.layers[0].elementIds = ["second"];
			overlay.trackObjectsDelta(delta({ deleted: ["first"] }));

			expect(primitivesOf(overlay.build(doc))).toHaveLength(1);
		});

		it("should draw the guides of the document that replaced the tracked one", () => {
			overlay.trackDocument(documentWith([path("art")]));
			const next = documentWith([path("guide", { isGuide: true })]);

			overlay.trackDocument(next);

			expect(primitivesOf(overlay.build(next))).toHaveLength(1);
		});
	});
});

function path(id: string, fields: Partial<Path> = {}): Path {
	return {
		type: "path",
		id,
		segments: closedRectSegments(0, 0, 10, 10),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
		...fields,
	};
}

/** A document whose only layer holds `top`, with `nested` stored but not listed. */
function documentWith(
	top: AnyArtObject[],
	nested: AnyArtObject[] = [],
): Document {
	const doc = createDefaultDocument("doc");
	for (const element of [...top, ...nested]) doc.objects[element.id] = element;
	doc.layers[0].elementIds = top.map((element) => element.id);
	return doc;
}

function primitivesOf(
	overlay: ReturnType<GuideOverlay["build"]>,
): BezierPathPrimitive[] {
	return (overlay?.primitives ?? []) as BezierPathPrimitive[];
}

function delta(changes: {
	added?: AnyArtObject[];
	updated?: AnyArtObject[];
	deleted?: string[];
}): ObjectsChangeDelta {
	const byId = (elements: AnyArtObject[] = []) =>
		new Map(elements.map((element) => [element.id, element]));
	return {
		added: byId(changes.added),
		updated: byId(changes.updated),
		deleted: new Set(changes.deleted),
	};
}

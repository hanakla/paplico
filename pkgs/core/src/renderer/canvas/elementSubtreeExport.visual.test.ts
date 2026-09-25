import { describe, expect, it } from "vitest";
import { createDefaultDocument } from "../../document/factory";
import type { AnyArtObject, Group } from "../../schema";
import { rectPath, solidFillAppearance } from "../../testUtils/svgFixtures";
import { createTestRenderer } from "../../testUtils/visualRegression";

/**
 * Element-subset exports (clipboard, SVG raster chunks) request a single
 * element by id. When that element sits inside a clip group, the render must
 * still route through the group so the clip applies, and must leave the
 * group's other children out.
 */
describe("renderElementsToImageData for a child of a clip group", () => {
	it("should draw the child clipped by the group and without its siblings", async () => {
		const { renderer } = await createTestRenderer();
		try {
			const doc = createDefaultDocument("doc-subtree-export");
			// Clip: 100×100 square. Target: 200 wide red bar overhanging the clip
			// on both sides. Sibling: blue bar below the target inside the clip,
			// not requested.
			const clip = rectPath("clip", { x: 0, y: 0 }, 100, 100, []);
			const target = rectPath("target", { x: 0, y: 0 }, 200, 40, [
				solidFillAppearance(1, 0, 0),
			]);
			const sibling = rectPath("sibling", { x: 0, y: -35 }, 60, 20, [
				solidFillAppearance(0, 0, 1),
			]);
			const group: Group = {
				type: "group",
				id: "group",
				opacity: 1,
				blendMode: "normal",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				childIds: [clip.id, sibling.id, target.id],
				clipPathId: clip.id,
				filters: [],
			};
			for (const el of [clip, sibling, target, group] as AnyArtObject[]) {
				doc.objects[el.id] = el;
			}
			doc.layers[0].elementIds = [group.id];

			const imageData = await renderer.renderElementsToImageData(
				[target.id],
				doc,
				{ centerX: 0, centerY: 0, width: 200, height: 100 },
				1,
			);

			expect(imageData).not.toBeNull();
			if (!imageData) throw new Error("Expected clipped child image");
			const { width, data } = imageData;
			const pixel = (x: number, y: number) => {
				const i = (y * width + x) * 4;
				return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
			};
			// Inside the clip, on the bar: red.
			expect(pixel(100, 50)).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
			// Outside the clip, still on the bar: clipped away.
			expect(pixel(20, 50).a).toBe(0);
			expect(pixel(180, 50).a).toBe(0);
			// Where the unrequested sibling would draw: nothing.
			expect(pixel(100, 85).a).toBe(0);
		} finally {
			renderer.destroy();
		}
	});
});

import type { Document, EmbeddedFile } from "@paplico/core/schema";
import { countImagesOverSide } from "./exportImageLimit";

describe("countImagesOverSide", () => {
	it("should count an image whose longer side exceeds the limit", async () => {
		const document = makeDocument([
			{ uid: "tall", isDrawn: true },
			{ uid: "small", isDrawn: true },
		]);

		const count = await countImagesOverSide(document, 8192, async (file) =>
			file.uid === "tall"
				? { width: 5375, height: 8950 }
				: { width: 800, height: 600 },
		);

		expect(count).toBe(1);
	});

	it("should not count an image whose longer side equals the limit", async () => {
		const document = makeDocument([{ uid: "edge", isDrawn: true }]);

		const count = await countImagesOverSide(document, 8192, async () => ({
			width: 8192,
			height: 100,
		}));

		expect(count).toBe(0);
	});

	it("should not count a file no image element draws", async () => {
		const document = makeDocument([{ uid: "unused", isDrawn: false }]);

		const count = await countImagesOverSide(document, 8192, async () => ({
			width: 10_000,
			height: 10_000,
		}));

		expect(count).toBe(0);
	});

	it("should count a file once when several elements draw it", async () => {
		const document = makeDocument([{ uid: "tall", isDrawn: true }]);
		document.objects["second"] = {
			...document.objects["element-tall"],
			id: "second",
		};

		const count = await countImagesOverSide(document, 8192, async () => ({
			width: 5375,
			height: 8950,
		}));

		expect(count).toBe(1);
	});

	it("should not count an image whose size cannot be read", async () => {
		const document = makeDocument([{ uid: "broken", isDrawn: true }]);

		const count = await countImagesOverSide(document, 8192, async () => null);

		expect(count).toBe(0);
	});
});

function makeDocument(
	files: { uid: string; isDrawn: boolean }[],
): Pick<Document, "objects" | "files"> {
	return {
		files: files.map(
			({ uid }): EmbeddedFile => ({
				uid,
				name: `${uid}.png`,
				type: "image/png",
				hash: uid,
				bin: new Uint8Array(),
			}),
		),
		objects: Object.fromEntries(
			files
				.filter((file) => file.isDrawn)
				.map(({ uid }) => [
					`element-${uid}`,
					{
						id: `element-${uid}`,
						type: "image",
						fileUid: uid,
						x: 0,
						y: 0,
						width: 100,
						height: 100,
					},
				]),
		) as Document["objects"],
	};
}

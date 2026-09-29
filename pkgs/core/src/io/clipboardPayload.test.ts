import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../document/factory";
import {
	type AnyArtObject,
	type Group,
	getTransform,
	type Path,
} from "../schema";
import {
	decodeElementsPayload,
	encodeElementsPayload,
	LEGACY_PAPLICO_ELEMENTS_MIME,
	PAPLICO_ELEMENTS_MIME,
	readClipboardElements,
} from "./clipboardPayload";
import { LATEST_SCHEMA_VERSION } from "./migrations";

const ROTATED = { ...createIdentityTransform(), rotation: 0.5, scaleX: 1.5 };

describe("clipboard elements payload", () => {
	it("should hand back what was encoded", () => {
		const path = makePath("p");

		const decoded = decodeElementsPayload(
			PAPLICO_ELEMENTS_MIME,
			encodeElementsPayload([path]),
		);

		expect(decoded).toEqual([path]);
	});

	it("should bring a legacy entry up to the latest schema", () => {
		const group = makeGroup("g", ["p"], ROTATED);
		const path = makePath("p");

		const decoded = decodeElementsPayload(
			LEGACY_PAPLICO_ELEMENTS_MIME,
			JSON.stringify([group, path]),
		);

		// The transform origin migration keeps the turned group; its child,
		// whose geometry sits on the origin, stays where it is.
		expect(decoded?.map((obj) => obj.id)).toEqual(["g", "p"]);
		expect(getTransform(decoded![0])).toEqual(ROTATED);
		expect(getTransform(decoded![1])).toEqual(createIdentityTransform());
	});

	it("should refuse an entry written by a newer client", () => {
		const json = JSON.stringify({
			version: LATEST_SCHEMA_VERSION + 1,
			objects: [makePath("p")],
		});

		expect(decodeElementsPayload(PAPLICO_ELEMENTS_MIME, json)).toBeNull();
	});

	describe("readClipboardElements", () => {
		it("should prefer the versioned entry of an item", async () => {
			const item = clipboardItem({
				[LEGACY_PAPLICO_ELEMENTS_MIME]: JSON.stringify([makePath("legacy")]),
				[PAPLICO_ELEMENTS_MIME]: encodeElementsPayload([makePath("current")]),
			});

			const elements = await readClipboardElements([item]);

			expect(elements?.map((obj) => obj.id)).toEqual(["current"]);
		});

		it("should return null when no item carries elements", async () => {
			const item = clipboardItem({ "text/plain": "hello" });

			expect(await readClipboardElements([item])).toBeNull();
		});
	});
});

function clipboardItem(entries: Record<string, string>): ClipboardItem {
	return {
		types: Object.keys(entries),
		getType: async (type: string) => new Blob([entries[type]], { type }),
	} as unknown as ClipboardItem;
}

function makePath(id: string): Path {
	return {
		type: "path",
		id,
		segments: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function makeGroup(
	id: string,
	childIds: string[],
	transform: AnyArtObject["transform"],
): Group {
	return {
		type: "group",
		id,
		childIds,
		opacity: 1,
		blendMode: "normal",
		transform,
	};
}

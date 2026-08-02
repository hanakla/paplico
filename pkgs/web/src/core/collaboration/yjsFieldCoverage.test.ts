import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../document/factory";
import type { AnyArtObject } from "../schema";
import {
	JSON_FIELDS,
	objectToStoredFields,
	SCALAR_FIELDS,
} from "./YjsProvider";

/**
 * `objectToStoredFields` writes an element on creation; `updateElement` writes
 * single fields on mutation, matching each key against SCALAR_FIELDS /
 * JSON_FIELDS and silently dropping anything in neither. The two are
 * hand-maintained lists of the same thing, so a field added to one and not the
 * other saves once and then never updates again — which is how ArtObject.mask
 * shipped as a button that did nothing.
 */
describe("Yjs field coverage", () => {
	const base = {
		id: "el",
		opacity: 1,
		blendMode: "normal",
		visible: true,
		locked: false,
		name: "named",
		transform: createIdentityTransform(),
		mask: { elementIds: ["m1"], enabled: true, inverted: true },
		filters: [],
	} as const;

	const fixtures: AnyArtObject[] = [
		{ ...base, type: "path", segments: [] },
		{ ...base, type: "group", childIds: [], clipPathId: "c", collapsed: true },
		{
			...base,
			type: "image",
			fileUid: "f",
			x: 0,
			y: 0,
			width: 1,
			height: 1,
		},
		{ ...base, type: "compound-path", sources: [] },
		{
			...base,
			type: "repeat",
			sourceIds: ["s1"],
			mode: "grid",
			grid: { width: 10, height: 10, spacingX: 10, spacingY: 10 },
			radial: {
				count: 6,
				radius: 100,
				startAngle: 0,
				sweep: 360,
				rotateInstances: true,
			},
			mirror: { axisAngle: 0, offset: 0 },
		},
	] as unknown as AnyArtObject[];

	for (const element of fixtures) {
		it(`should be able to update every field it stores for ${element.type}`, () => {
			const stored = Object.keys(objectToStoredFields(element));

			// id / type are immutable and skipped by updateElement by design.
			const updatable = stored.filter((key) => key !== "id" && key !== "type");
			const dropped = updatable.filter(
				(key) => !SCALAR_FIELDS.has(key) && !JSON_FIELDS.has(key),
			);

			expect(dropped).toEqual([]);
		});
	}

	it("should carry ArtObject.mask, which every element type can have", () => {
		expect(JSON_FIELDS.has("mask")).toBe(true);
	});
});

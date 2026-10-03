import { describe, expect, it } from "vitest";
import type { AnyArtObject, CubicBezierSegment } from "../../../schema";
import {
	mockCompoundPath,
	mockGroup,
	mockPath,
} from "../../../testUtils/mockElements";
import { closedRectSegments } from "../../../testUtils/segmentFactory";
import { CompoundPathCache } from "./CompoundPathCache";
import { GroupPathCache } from "./GroupPathCache";

describe("GroupPathCache", () => {
	it("should follow an edited source of a compound path inside the group", () => {
		const cache = new GroupPathCache();
		const compoundPathCache = new CompoundPathCache();
		const group = mockGroup("group-1", ["compound-1"]);
		const compound = mockCompoundPath("compound-1", ["source-1"]);
		const elementsAt = (size: number) => {
			const source = mockPath("source-1");
			source.segments = closedRectSegments(-size, -size, size, size);
			return new Map<string, AnyArtObject>([
				[group.id, group],
				[compound.id, compound],
				[source.id, source],
			]);
		};
		cache.resolve(group, elementsAt(50), compoundPathCache);

		const segments = cache.resolve(group, elementsAt(150), compoundPathCache);

		expect(maxAnchorX(segments)).toBeCloseTo(150);
	});
});

function maxAnchorX(segments: CubicBezierSegment[]): number {
	return Math.max(
		...segments.flatMap((seg) => [seg.start?.x ?? -Infinity, seg.end.x]),
	);
}

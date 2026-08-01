import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../../document/factory";
import type { BlendObject, Path, PathSegment } from "../../../schema";
import { BlendCache } from "./BlendCache";

const Z = {
	startTiltX: 0,
	startTiltY: 0,
	endTiltX: 0,
	endTiltY: 0,
	startDeltaTime: 0,
	endDeltaTime: 0,
};

function makePath(id: string, x = 0): Path {
	const segments: PathSegment[] = [
		{
			start: { x, y: 0 },
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: x + 50, y: 0 },
			isMoved: true,
			...Z,
		},
		{
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: x + 50, y: 50 },
			isMoved: false,
			isClosed: true,
			...Z,
		},
	];
	return {
		type: "path",
		id,
		segments,
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function makeBlend(objectIds: string[], count = 2): BlendObject {
	return {
		type: "blend",
		id: "blend-1",
		objectIds,
		spacing: { type: "steps", count },
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

describe("BlendCache", () => {
	it("returns the same reference on a cache hit", () => {
		const cache = new BlendCache();
		const objs = [makePath("a", 0), makePath("b", 100)];
		const blend = makeBlend(["a", "b"]);
		expect(cache.resolve(blend, objs)).toBe(cache.resolve(blend, objs));
	});

	it("invalidates when a source's segments change", () => {
		const cache = new BlendCache();
		const blend = makeBlend(["a", "b"]);
		const first = cache.resolve(blend, [makePath("a", 0), makePath("b", 100)]);
		const second = cache.resolve(blend, [makePath("a", 0), makePath("b", 200)]);
		expect(second).not.toBe(first);
	});

	it("invalidates when spacing changes", () => {
		const cache = new BlendCache();
		const objs = [makePath("a", 0), makePath("b", 100)];
		const first = cache.resolve(makeBlend(["a", "b"], 2), objs);
		const second = cache.resolve(makeBlend(["a", "b"], 5), objs);
		expect(second).not.toBe(first);
		expect(first[0]).toHaveLength(2);
		expect(second[0]).toHaveLength(5);
	});

	it("invalidates when a source transform changes", () => {
		const cache = new BlendCache();
		const blend = makeBlend(["a", "b"]);
		const a = makePath("a", 0);
		const b = makePath("b", 100);
		const first = cache.resolve(blend, [a, b]);
		const aMoved: Path = {
			...a,
			transform: { ...createIdentityTransform(), x: 50 },
		};
		expect(cache.resolve(blend, [aMoved, b])).not.toBe(first);
	});

	it("removes entries via deleteMany and clear", () => {
		const cache = new BlendCache();
		cache.resolve(makeBlend(["a", "b"]), [
			makePath("a", 0),
			makePath("b", 100),
		]);
		expect(cache.size()).toBe(1);
		cache.deleteMany(["blend-1"]);
		expect(cache.size()).toBe(0);

		cache.resolve(makeBlend(["a", "b"]), [
			makePath("a", 0),
			makePath("b", 100),
		]);
		cache.clear();
		expect(cache.size()).toBe(0);
	});
});

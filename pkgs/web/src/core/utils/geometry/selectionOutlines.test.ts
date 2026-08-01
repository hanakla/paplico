import { describe, expect, it } from "vitest";
import { createIdentityTransform } from "../../document/factory";
import type {
	AnyArtObject,
	Group,
	MeshArtObject,
	Path,
	PathSegment,
} from "../../schema";
import { toWorld, type WorldBezierSegment } from "./geometry";
import {
	collectSelectionOutlines,
	shouldDashSelectionBounds,
} from "./selectionOutlines";

describe("collectSelectionOutlines", () => {
	it("returns only the clip path outline for a clip group", () => {
		const clipGroup = makeGroup(
			"clip-group",
			["clip-path", "content"],
			"clip-path",
		);
		const objects: Record<string, AnyArtObject> = {
			"clip-path": makePath("clip-path"),
			content: makePath("content"),
			"clip-group": clipGroup,
		};
		const clipOutline = outlineOf("clip-path");

		const result = collect(clipGroup, objects, {
			"clip-path": clipOutline,
			content: outlineOf("content"),
		});

		expect(result).toEqual([clipOutline]);
	});

	it("returns a nested clip group's clip path outline when a plain group contains it", () => {
		const clipGroup = makeGroup(
			"clip-group",
			["clip-path", "content"],
			"clip-path",
		);
		const outer = makeGroup("outer", ["clip-group", "sibling"]);
		const objects: Record<string, AnyArtObject> = {
			"clip-path": makePath("clip-path"),
			content: makePath("content"),
			"clip-group": clipGroup,
			sibling: makePath("sibling"),
			outer,
		};
		const clipOutline = outlineOf("clip-path");
		const siblingOutline = outlineOf("sibling");

		const result = collect(outer, objects, {
			"clip-path": clipOutline,
			content: outlineOf("content"),
			sibling: siblingOutline,
		});

		expect(result).toEqual([clipOutline, siblingOutline]);
	});

	it("recurses through nested plain groups down to leaf paths", () => {
		const inner = makeGroup("inner", ["leaf"]);
		const outer = makeGroup("outer", ["inner"]);
		const objects: Record<string, AnyArtObject> = {
			leaf: makePath("leaf"),
			inner,
			outer,
		};
		const leafOutline = outlineOf("leaf");

		const result = collect(outer, objects, { leaf: leafOutline });

		expect(result).toEqual([leafOutline]);
	});
});

describe("shouldDashSelectionBounds", () => {
	it("should dash when every selected element is a mesh", () => {
		expect(shouldDashSelectionBounds([makeMesh("m1"), makeMesh("m2")])).toBe(
			true,
		);
	});

	it("should stay solid for mixed or non-mesh selections", () => {
		expect(shouldDashSelectionBounds([makeMesh("m1"), makePath("p1")])).toBe(
			false,
		);
		expect(shouldDashSelectionBounds([makePath("p1")])).toBe(false);
	});

	it("should stay solid for an empty selection", () => {
		expect(shouldDashSelectionBounds([])).toBe(false);
		expect(shouldDashSelectionBounds([undefined])).toBe(false);
	});
});

// ===== Test helpers =====

function collect(
	root: AnyArtObject,
	objects: Record<string, AnyArtObject>,
	worldSegs: Record<string, WorldBezierSegment[]>,
): WorldBezierSegment[][] {
	return collectSelectionOutlines(
		root,
		(id) => objects[id],
		() => null,
		(id) => worldSegs[id] ?? null,
	);
}

function makePath(id: string): Path {
	const seg: PathSegment = {
		start: { x: 0, y: 0 },
		cp1: { x: 0, y: 0 },
		cp2: { x: 0, y: 0 },
		end: { x: 10, y: 0 },
		startTiltX: 0,
		startTiltY: 0,
		endTiltX: 0,
		endTiltY: 0,
		startDeltaTime: 0,
		endDeltaTime: 0,
		isMoved: false,
	};
	return {
		type: "path",
		id,
		segments: [seg],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	} as Path;
}

function makeMesh(id: string): MeshArtObject {
	return {
		type: "mesh",
		id,
		childIds: [],
		vertices: [],
		faces: [],
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

function makeGroup(id: string, childIds: string[], clipPathId?: string): Group {
	return {
		type: "group",
		id,
		childIds,
		...(clipPathId ? { clipPathId } : {}),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

/** A distinct one-segment outline per id so collected outlines are identifiable. */
function outlineOf(id: string): WorldBezierSegment[] {
	return [
		{
			cp1: toWorld(0, 0),
			cp2: toWorld(0, 0),
			end: toWorld(id.length, 0),
		},
	];
}

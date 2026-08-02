import { describe, expect, it } from "vitest";
import type { ObjectsChangeDelta } from "../collaboration/YjsProvider";
import type { Document, Group } from "../schema";
import { DefIndex } from "./DefIndex";
import { createDefaultDocument } from "./factory";

const IDENTITY_TRANSFORM = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function makeDoc(): Document {
	return createDefaultDocument("test");
}

function emptyDelta(): ObjectsChangeDelta {
	return {
		added: new Map(),
		updated: new Map(),
		deleted: new Set(),
	};
}

describe("DefIndex", () => {
	it("starts with revision 0 for unknown defs and null for unknown elements", () => {
		const index = new DefIndex();
		expect(index.getRevision("does-not-exist")).toBe(0);
		expect(index.getDefIdOf("does-not-exist")).toBeNull();
	});

	it("rebuild registers def members and starts revisions at 1", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "vector-brush",
				rootElementIds: ["m1"],
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);

		expect(index.getDefIdOf("m1")).toBe("def-1");
		expect(index.getRevision("def-1")).toBe(1);
	});

	it("rebuild preserves the revision of defs that still exist", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["m1"],
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);
		// Bump via delta so revision is no longer the initial 1.
		const delta = emptyDelta();
		const member = doc.objects.m1;
		if (!member) throw new Error("member should exist");
		delta.updated.set("m1", member);
		index.notifyDelta(delta);
		expect(index.getRevision("def-1")).toBe(2);

		// Rebuild again — revision must persist.
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(2);
	});

	it("getGlobalRevision advances when any def member changes", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": { id: "def-1", kind: "pattern", rootElementIds: ["m1"] },
		};

		const index = new DefIndex();
		index.rebuild(doc);
		const afterBuild = index.getGlobalRevision();

		const delta = emptyDelta();
		const member = doc.objects.m1;
		if (!member) throw new Error("member should exist");
		delta.updated.set("m1", member);
		index.notifyDelta(delta);
		expect(index.getGlobalRevision()).toBeGreaterThan(afterBuild);

		// A delta touching no def member leaves the generation unchanged.
		const stable = index.getGlobalRevision();
		index.notifyDelta(emptyDelta());
		expect(index.getGlobalRevision()).toBe(stable);
	});

	it("rebuild bumps the revision when def roots change", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.objects.m2 = {
			id: "m2",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["m1"],
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(1);

		doc.defs["def-1"].rootElementIds = ["m2"];
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(2);
	});

	it("rebuild bumps the revision when tile metadata changes", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["m1"],
				tile: { width: 64, height: 64 },
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(1);

		doc.defs["def-1"].tile = { width: 96, height: 64 };
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(2);
	});

	it("rebuild walks into Group.childIds so nested edits invalidate the right def", () => {
		const doc = makeDoc();
		const group: Group = {
			id: "g1",
			type: "group",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			childIds: ["c1"],
		};
		doc.objects.g1 = group;
		doc.objects.c1 = {
			id: "c1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "pattern",
				rootElementIds: ["g1"],
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);
		expect(index.getDefIdOf("g1")).toBe("def-1");
		expect(index.getDefIdOf("c1")).toBe("def-1");
	});

	it("notifyDelta bumps revision once per delta even with multiple touched members", () => {
		const doc = makeDoc();
		const objs = {
			m1: {
				id: "m1",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: IDENTITY_TRANSFORM,
				segments: [],
			},
			m2: {
				id: "m2",
				type: "path",
				opacity: 1,
				blendMode: "normal",
				transform: IDENTITY_TRANSFORM,
				segments: [],
			},
		} as const;
		doc.objects.m1 = objs.m1 as any;
		doc.objects.m2 = objs.m2 as any;
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "vector-brush",
				rootElementIds: ["m1", "m2"],
			},
		};

		const index = new DefIndex();
		index.rebuild(doc);
		expect(index.getRevision("def-1")).toBe(1);

		const delta = emptyDelta();
		delta.updated.set("m1", objs.m1 as any);
		delta.updated.set("m2", objs.m2 as any);
		const touched = index.notifyDelta(delta);
		expect(touched).toEqual(new Set(["def-1"]));
		expect(index.getRevision("def-1")).toBe(2);
	});

	it("notifyDelta ignores elements that are not def members", () => {
		const doc = makeDoc();
		const index = new DefIndex();
		index.rebuild(doc);

		const delta = emptyDelta();
		delta.updated.set("unrelated", {} as any);
		const touched = index.notifyDelta(delta);
		expect(touched.size).toBe(0);
	});

	it("clear resets all state", () => {
		const doc = makeDoc();
		doc.objects.m1 = {
			id: "m1",
			type: "path",
			opacity: 1,
			blendMode: "normal",
			transform: IDENTITY_TRANSFORM,
			segments: [],
		};
		doc.defs = {
			"def-1": {
				id: "def-1",
				kind: "vector-brush",
				rootElementIds: ["m1"],
			},
		};
		const index = new DefIndex();
		index.rebuild(doc);
		index.clear();
		expect(index.getDefIdOf("m1")).toBeNull();
		expect(index.getRevision("def-1")).toBe(0);
	});
});

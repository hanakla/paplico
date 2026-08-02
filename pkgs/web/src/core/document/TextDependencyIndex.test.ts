import { describe, expect, it } from "vitest";
import type { ObjectsChangeDelta } from "../collaboration/YjsProvider";
import { createIdentityTransform } from "../document/factory";
import type { Path, TextElement } from "../schema";
import { lineSeg } from "../testUtils/segmentFactory";
import { createTestTextElement } from "../testUtils/typographyFixtures";
import { TextDependencyIndex } from "./TextDependencyIndex";

const pathElement = (id: string): Path => ({
	type: "path",
	id,
	segments: [lineSeg({ x: 10, y: 0 }, { start: { x: 0, y: 0 } })],
	opacity: 1,
	blendMode: "normal",
	transform: createIdentityTransform(),
});

const added = (...texts: TextElement[]): ObjectsChangeDelta => ({
	added: new Map(texts.map((t) => [t.id, t])),
	updated: new Map(),
	deleted: new Set(),
});

const updated = (...texts: TextElement[]): ObjectsChangeDelta => ({
	added: new Map(),
	updated: new Map(texts.map((t) => [t.id, t])),
	deleted: new Set(),
});

const boundText = (id: string, pathObjectId: string): TextElement =>
	createTestTextElement("a", {
		id,
		axisBinding: {
			mode: "onPath",
			pathObjectId,
			startOffset: 0,
			alignment: "left",
			offsetDistance: 0,
			orientation: "rotate",
		},
	});

describe("TextDependencyIndex", () => {
	it("should walk the full chain from any member, head first", () => {
		const index = new TextDependencyIndex();
		index.notifyDelta(
			added(
				createTestTextElement("a", {
					id: "a",
					flow: { nextTextElementId: "b" },
				}),
				createTestTextElement("", {
					id: "b",
					flow: { nextTextElementId: "c" },
				}),
				createTestTextElement("", { id: "c" }),
			),
		);

		expect(index.chainMemberIds("b")).toEqual(["a", "b", "c"]);
		expect(index.chainMemberIds("c")).toEqual(["a", "b", "c"]);
		expect(index.chainMemberIds("solo")).toEqual(["solo"]);
	});

	it("should resolve duplicate inflows deterministically (smallest id wins)", () => {
		const index = new TextDependencyIndex();
		index.notifyDelta(
			added(
				createTestTextElement("b", {
					id: "b",
					flow: { nextTextElementId: "c" },
				}),
				createTestTextElement("a", {
					id: "a",
					flow: { nextTextElementId: "c" },
				}),
				createTestTextElement("", { id: "c" }),
			),
		);

		expect(index.findFlowSourceId("c")).toBe("a");
	});

	it("should terminate on cyclic flow links", () => {
		const index = new TextDependencyIndex();
		index.notifyDelta(
			added(
				createTestTextElement("a", {
					id: "a",
					flow: { nextTextElementId: "b" },
				}),
				createTestTextElement("b", {
					id: "b",
					flow: { nextTextElementId: "a" },
				}),
			),
		);

		const members = index.chainMemberIds("a");
		expect(members.length).toBeLessThanOrEqual(2);
	});

	it("should invalidate bound texts and bump geometry revision on path change", () => {
		const index = new TextDependencyIndex();
		index.notifyDelta(added(boundText("t1", "path-1")));
		expect(index.getGeometryRevision("path-1")).toBe(0);

		const stale = index.notifyDelta({
			added: new Map(),
			updated: new Map([["path-1", pathElement("path-1")]]),
			deleted: new Set(),
		});

		expect(stale.has("t1")).toBe(true);
		expect(index.getGeometryRevision("path-1")).toBe(1);
	});

	it("should invalidate the old chain when a flow link is removed", () => {
		const index = new TextDependencyIndex();
		index.notifyDelta(
			added(
				createTestTextElement("a", {
					id: "a",
					flow: { nextTextElementId: "b" },
				}),
				createTestTextElement("", { id: "b" }),
			),
		);

		const stale = index.notifyDelta(
			updated(createTestTextElement("a", { id: "a" })),
		);

		expect(stale.has("a")).toBe(true);
		expect(stale.has("b")).toBe(true);
		expect(index.chainMemberIds("a")).toEqual(["a"]);
	});
});

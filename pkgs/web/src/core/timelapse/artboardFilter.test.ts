import { describe, expect, it } from "vitest";
import type { Artboard } from "../schema";
import { selectEntriesForArtboard } from "./artboardFilter";
import type { TimelapseIndex } from "./types";

describe("selectEntriesForArtboard", () => {
	// Artboards are center-anchored, so this one spans -50..50 on both axes.
	const artboard: Artboard = {
		id: "artboard-1",
		name: "Artboard 1",
		x: 0,
		y: 0,
		width: 100,
		height: 100,
	};

	it("should select every entry when no index has been built", () => {
		expect(selectEntriesForArtboard(3, undefined, artboard)).toEqual([0, 1, 2]);
	});

	it("should select every entry when no artboard is targeted", () => {
		const index: TimelapseIndex = {
			rects: [
				[500, 500, 600, 600],
				[700, 700, 800, 800],
			],
		};

		expect(selectEntriesForArtboard(2, index, undefined)).toEqual([0, 1]);
	});

	it("should drop entries whose rect lies outside the artboard", () => {
		const index: TimelapseIndex = {
			rects: [
				[-10, -10, 10, 10],
				[500, 500, 600, 600],
				[40, 40, 60, 60],
			],
		};

		expect(selectEntriesForArtboard(3, index, artboard)).toEqual([0, 2]);
	});

	it("should keep entries whose affected area is unknown", () => {
		const index: TimelapseIndex = {
			rects: [null, [500, 500, 600, 600], null],
		};

		expect(selectEntriesForArtboard(3, index, artboard)).toEqual([0, 2]);
	});

	it("should keep an entry that only touches the artboard edge", () => {
		const index: TimelapseIndex = {
			rects: [[50, 0, 150, 10]],
		};

		expect(selectEntriesForArtboard(1, index, artboard)).toEqual([0]);
	});

	it("should keep entries the index does not cover", () => {
		const index: TimelapseIndex = { rects: [[500, 500, 600, 600]] };

		expect(selectEntriesForArtboard(3, index, artboard)).toEqual([1, 2]);
	});

	it("should return nothing when every entry misses the artboard", () => {
		const index: TimelapseIndex = {
			rects: [
				[500, 500, 600, 600],
				[-600, -600, -500, -500],
			],
		};

		expect(selectEntriesForArtboard(2, index, artboard)).toEqual([]);
	});
});

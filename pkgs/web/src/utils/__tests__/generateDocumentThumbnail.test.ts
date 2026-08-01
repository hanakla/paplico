import {
	computeAllElementsBounds,
	computeThumbnailScale,
} from "../generateDocumentThumbnail";

vi.mock("@/core/utils/geometry/bounds", () => ({
	calculateElementBounds: vi.fn((el: any) => ({
		minX: el.x - el.w / 2,
		minY: el.y - el.h / 2,
		maxX: el.x + el.w / 2,
		maxY: el.y + el.h / 2,
		width: el.w,
		height: el.h,
	})),
}));

describe("computeThumbnailScale", () => {
	it("should scale landscape to maxLongEdge on width", () => {
		expect(computeThumbnailScale(1024, 768)).toBe(512 / 1024);
	});

	it("should scale portrait to maxLongEdge on height", () => {
		expect(computeThumbnailScale(768, 1024)).toBe(512 / 1024);
	});

	it("should scale square to maxLongEdge", () => {
		expect(computeThumbnailScale(1000, 1000)).toBe(512 / 1000);
	});

	it("should return 1 when dimensions are zero", () => {
		expect(computeThumbnailScale(0, 0)).toBe(1);
	});

	it("should accept custom maxLongEdge", () => {
		expect(computeThumbnailScale(1000, 500, 256)).toBe(256 / 1000);
	});
});

describe("computeAllElementsBounds", () => {
	it("should return null for empty objects", () => {
		expect(computeAllElementsBounds({})).toBeNull();
	});

	it("should return correct bounds for single element", () => {
		const objects = { a: { x: 10, y: 20, w: 100, h: 50 } };
		const result = computeAllElementsBounds(objects as any);
		expect(result).toEqual({
			centerX: 10,
			centerY: 20,
			width: 100,
			height: 50,
		});
	});

	it("should return combined bounds for multiple elements", () => {
		const objects = {
			a: { x: 0, y: 0, w: 100, h: 100 }, // -50..50, -50..50
			b: { x: 200, y: 200, w: 100, h: 100 }, // 150..250, 150..250
		};
		const result = computeAllElementsBounds(objects as any);
		expect(result).toEqual({
			centerX: 100, // (-50 + 250) / 2
			centerY: 100, // (-50 + 250) / 2
			width: 300, // 250 - (-50)
			height: 300,
		});
	});
});

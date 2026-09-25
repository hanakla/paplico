import { MaskAtlasAllocator } from "./MaskAtlasAllocator";

describe("MaskAtlasAllocator", () => {
	it("packs rectangles without overlap", () => {
		const allocator = new MaskAtlasAllocator(16, 16);
		const first = allocator.allocate(8, 8);
		const second = allocator.allocate(8, 8);
		const third = allocator.allocate(8, 8);

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(third).not.toBeNull();
		if (!first || !second || !third) throw new Error("Allocation failed");
		expect(overlaps(first, second)).toBe(false);
		expect(overlaps(first, third)).toBe(false);
		expect(overlaps(second, third)).toBe(false);
	});

	it("reuses released space", () => {
		const allocator = new MaskAtlasAllocator(16, 16);
		const first = allocator.allocate(8, 16);
		expect(first).not.toBeNull();
		expect(allocator.allocate(8, 16)).not.toBeNull();
		expect(allocator.allocate(1, 1)).toBeNull();

		if (!first) throw new Error("Allocation failed");
		allocator.release(first);
		expect(allocator.allocate(8, 16)).toEqual(first);
	});

	it("rejects invalid and oversized rectangles", () => {
		const allocator = new MaskAtlasAllocator(16, 16);

		expect(allocator.allocate(0, 1)).toBeNull();
		expect(allocator.allocate(17, 1)).toBeNull();
		expect(allocator.allocate(1, 17)).toBeNull();
	});
});

function overlaps(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
): boolean {
	return !(
		a.x + a.width <= b.x ||
		b.x + b.width <= a.x ||
		a.y + a.height <= b.y ||
		b.y + b.height <= a.y
	);
}

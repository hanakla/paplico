import { mipLevelCountFor } from "./wgpu-utils";

describe("mipLevelCountFor", () => {
	it("should return the full mip chain length for the larger dimension", () => {
		expect(mipLevelCountFor(1, 1)).toBe(1);
		expect(mipLevelCountFor(4, 4)).toBe(3);
		expect(mipLevelCountFor(256, 64)).toBe(9);
		expect(mipLevelCountFor(100, 30)).toBe(7);
	});
});

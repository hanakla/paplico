import { isUprightInVertical } from "./verticalOrientation";

describe("isUprightInVertical", () => {
	it("should keep kanji, kana and vertical forms upright", () => {
		expect(["漢", "か", "カ", "︙", "︐"].map(isUprightInVertical)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
	});

	it("should keep symbols East Asian writing sets upright, such as ① and ※", () => {
		expect(["①", "※", "§", "×"].map(isUprightInVertical)).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it("should lay Latin letters and digits on their side", () => {
		expect(["a", "Z", "1", "-"].map(isUprightInVertical)).toEqual([
			false,
			false,
			false,
			false,
		]);
	});

	it("should keep characters beyond the BMP upright when they are ideographs", () => {
		expect(isUprightInVertical("𠮷")).toBe(true);
	});
});

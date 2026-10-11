import {
	computeRingProgress,
	formatAutoSaveCountdown,
	shouldExtendInterval,
} from "../autoSave";

describe("shouldExtendInterval", () => {
	it("should return true when elapsed > threshold", () => {
		expect(shouldExtendInterval(1_500)).toBe(true);
	});

	it("should return false when elapsed <= threshold", () => {
		expect(shouldExtendInterval(500)).toBe(false);
	});

	it("should return false when elapsed equals threshold exactly", () => {
		expect(shouldExtendInterval(1_000)).toBe(false);
	});
});

describe("computeRingProgress", () => {
	it("should return 0 at lastSaveTimestamp", () => {
		expect(computeRingProgress(100, 1_000, 100)).toBe(0);
	});

	it("should return 0.5 at halfway point", () => {
		expect(computeRingProgress(100, 1_000, 600)).toBe(0.5);
	});

	it("should return 1 when interval has fully elapsed", () => {
		expect(computeRingProgress(100, 1_000, 1_100)).toBe(1);
	});

	it("should clamp to 1 when past interval", () => {
		expect(computeRingProgress(100, 1_000, 5_000)).toBe(1);
	});

	it("should return 1 when intervalMs is 0", () => {
		expect(computeRingProgress(100, 0, 100)).toBe(1);
	});

	it("should clamp to 0 when now is before lastSaveTimestamp", () => {
		expect(computeRingProgress(100, 1_000, 50)).toBe(0);
	});
});

describe("formatAutoSaveCountdown", () => {
	it("should format seconds-only as '0:SS'", () => {
		expect(formatAutoSaveCountdown(30_000)).toBe("0:30");
	});

	it("should format minutes and seconds as 'M:SS'", () => {
		expect(formatAutoSaveCountdown(90_000)).toBe("1:30");
	});

	it("should show '0:00' for zero", () => {
		expect(formatAutoSaveCountdown(0)).toBe("0:00");
	});

	it("should show '0:00' for negative values", () => {
		expect(formatAutoSaveCountdown(-5_000)).toBe("0:00");
	});

	it("should ceil partial seconds", () => {
		expect(formatAutoSaveCountdown(1_500)).toBe("0:02");
		expect(formatAutoSaveCountdown(100)).toBe("0:01");
	});
});

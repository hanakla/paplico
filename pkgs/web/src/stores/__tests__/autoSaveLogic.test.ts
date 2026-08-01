import {
	computeRingProgress,
	formatAutoSaveCountdown,
	getRevisionIdsToPrune,
	shouldExtendInterval,
} from "../autoSave";

describe("getRevisionIdsToPrune", () => {
	it("should return empty array when revisions count <= maxCount", () => {
		const revisions = Array.from({ length: 20 }, (_, i) => ({
			id: `rev-${i}`,
			createdAt: i,
		}));
		expect(getRevisionIdsToPrune(revisions)).toEqual([]);
	});

	it("should return oldest revision IDs when exceeding maxCount", () => {
		const revisions = Array.from({ length: 23 }, (_, i) => ({
			id: `rev-${i}`,
			createdAt: i,
		}));
		expect(getRevisionIdsToPrune(revisions)).toEqual([
			"rev-0",
			"rev-1",
			"rev-2",
		]);
	});

	it("should preserve the newest maxCount revisions", () => {
		const revisions = Array.from({ length: 22 }, (_, i) => ({
			id: `rev-${i}`,
			createdAt: i,
		}));
		const pruned = getRevisionIdsToPrune(revisions);
		const remaining = revisions.filter((r) => !pruned.includes(r.id));
		expect(remaining).toHaveLength(20);
		expect(remaining[0].id).toBe("rev-2");
		expect(remaining.at(-1)!.id).toBe("rev-21");
	});

	it("should handle custom maxCount", () => {
		const revisions = Array.from({ length: 5 }, (_, i) => ({
			id: `rev-${i}`,
			createdAt: i,
		}));
		expect(getRevisionIdsToPrune(revisions, 3)).toEqual(["rev-0", "rev-1"]);
		expect(getRevisionIdsToPrune(revisions, 5)).toEqual([]);
	});
});

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

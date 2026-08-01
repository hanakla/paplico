import { describe, expect, it } from "vitest";
import { HDR_EDR_HEADROOM, HDR_MAX_NITS } from "../renderer/types";
import { pqEotf, pqOetf, srgbEotf, srgbOetf } from "./color";

describe("srgbEotf", () => {
	it("should return 0 for input 0", () => {
		expect(srgbEotf(0)).toBe(0);
	});

	it("should return 1 for input 1", () => {
		expect(srgbEotf(1)).toBeCloseTo(1, 10);
	});

	it("should linearize the low segment via /12.92", () => {
		expect(srgbEotf(0.04045)).toBeCloseTo(0.04045 / 12.92, 10);
	});

	it("should linearize mid-gray (0.5) to ~0.214", () => {
		expect(srgbEotf(0.5)).toBeCloseTo(0.214, 2);
	});

	it("should handle values > 1.0 for HDR extrapolation", () => {
		const result = srgbEotf(2.0);
		expect(result).toBeGreaterThan(1.0);
	});
});

describe("srgbOetf", () => {
	it("should return 0 for input 0", () => {
		expect(srgbOetf(0)).toBe(0);
	});

	it("should return 1 for input 1", () => {
		expect(srgbOetf(1)).toBeCloseTo(1, 10);
	});

	it("should be the inverse of srgbEotf", () => {
		for (const v of [0.0, 0.01, 0.1, 0.5, 0.8, 1.0, 1.5, 2.0]) {
			expect(srgbOetf(srgbEotf(v))).toBeCloseTo(v, 6);
		}
	});
});

describe("pqOetf", () => {
	it("should return ~0 for 0 nits", () => {
		expect(pqOetf(0)).toBeCloseTo(0, 4);
	});

	it("should return 1 for 10000 nits", () => {
		expect(pqOetf(10000)).toBeCloseTo(1, 6);
	});

	it("should return ~0.58 for BT.2408 reference white (203 nits)", () => {
		expect(pqOetf(203)).toBeCloseTo(0.5807, 3);
	});

	it("should clamp negative input to 0", () => {
		expect(pqOetf(-100)).toBeCloseTo(pqOetf(0), 10);
	});
});

describe("pqEotf", () => {
	it("should return ~0 for PQ signal 0", () => {
		expect(pqEotf(0)).toBeCloseTo(0, 4);
	});

	it("should return 10000 for PQ signal 1", () => {
		expect(pqEotf(1)).toBeCloseTo(10000, 0);
	});

	it("should be the inverse of pqOetf", () => {
		for (const nits of [0, 10, 100, 203, 500, 1000, 1600, 5000, 10000]) {
			expect(pqEotf(pqOetf(nits))).toBeCloseTo(nits, 2);
		}
	});
});

describe("PQ 10-bit quantize roundtrip", () => {
	it("should preserve SDR white within 0.1% after 10-bit quantization", () => {
		const linear = 1.0;
		const pq = pqOetf(linear * HDR_MAX_NITS);
		const quantized = Math.round(pq * 1023) / 1023;
		const decoded = pqEotf(quantized) / HDR_MAX_NITS;
		expect(decoded).toBeCloseTo(linear, 2);
	});

	it("should preserve values across the SDR range", () => {
		for (const linear of [0.01, 0.1, 0.25, 0.5, 0.75, 1.0]) {
			const pq = pqOetf(linear * HDR_MAX_NITS);
			const quantized = Math.round(pq * 1023) / 1023;
			const decoded = pqEotf(quantized) / HDR_MAX_NITS;
			expect(decoded).toBeCloseTo(linear, 1);
		}
	});

	it("should preserve HDR values up to edrHeadroom", () => {
		for (const linear of [1.5, 2.0, 3.0, HDR_EDR_HEADROOM]) {
			const clamped = Math.min(linear, HDR_EDR_HEADROOM);
			const pq = pqOetf(clamped * HDR_MAX_NITS);
			const quantized = Math.round(pq * 1023) / 1023;
			const decoded = pqEotf(quantized) / HDR_MAX_NITS;
			expect(decoded).toBeCloseTo(clamped, 1);
		}
	});
});

describe("Canvas↔AVIF pipeline consistency", () => {
	it("should produce matching PQ values from shader and exporter paths", () => {
		// Simulate the shader path: gamma → srgbEotf → exposure → PQ roundtrip → srgbOetf
		// Then exporter path: srgbEotf → pqOetf
		// Both should yield the same PQ signal.
		const gammaValue = 0.8;
		const exposure = 1; // EV stop
		const scale = 2 ** exposure;

		// Shader path
		const linear = srgbEotf(gammaValue);
		const exposed = linear * scale;
		const clamped = Math.min(exposed, HDR_EDR_HEADROOM);
		const pqEncoded = pqOetf(clamped * HDR_MAX_NITS);
		const quantized = Math.round(pqEncoded * 1023) / 1023;
		const decoded = pqEotf(quantized) / HDR_MAX_NITS;
		const shaderOutput = srgbOetf(decoded);

		// Exporter path (reads shader output, linearizes, PQ encodes)
		const exporterLinear = srgbEotf(shaderOutput);
		const exporterPq = pqOetf(
			Math.min(exporterLinear, HDR_EDR_HEADROOM) * HDR_MAX_NITS,
		);
		const exporterQuantized = Math.round(exporterPq * 1023);

		// Should match the shader's quantized value
		expect(exporterQuantized).toBe(Math.round(quantized * 1023));
	});

	it("should produce matching values at exposure=0", () => {
		// exposure=0 → scale=1, but HDR pass still runs
		for (const gammaValue of [0.1, 0.3, 0.5, 0.7, 1.0]) {
			const linear = srgbEotf(gammaValue);
			const clamped = Math.min(linear, HDR_EDR_HEADROOM);
			const pq = pqOetf(clamped * HDR_MAX_NITS);
			const quantized = Math.round(pq * 1023) / 1023;
			const decoded = pqEotf(quantized) / HDR_MAX_NITS;
			const shaderOutput = srgbOetf(decoded);

			// Exporter round-trip
			const exporterLinear = srgbEotf(shaderOutput);
			const exporterPq = pqOetf(
				Math.min(exporterLinear, HDR_EDR_HEADROOM) * HDR_MAX_NITS,
			);
			const exporterQ = Math.round(exporterPq * 1023);

			expect(exporterQ).toBe(Math.round(quantized * 1023));
		}
	});
});

describe("HDR constants", () => {
	it("HDR_MAX_NITS should be BT.2408 reference white (203)", () => {
		expect(HDR_MAX_NITS).toBe(203);
	});

	it("HDR_EDR_HEADROOM should cover MacBook XDR peak", () => {
		expect(HDR_EDR_HEADROOM).toBeCloseTo(1600 / 203, 2);
		expect(HDR_EDR_HEADROOM * HDR_MAX_NITS).toBeCloseTo(1600, 0);
	});
});

import { describe, expect, it } from "vitest";
import type { WetInkSettings } from "../schema";
import {
	applyWetInkMacro,
	readWetInkMacro,
	type WetInkMacroKey,
} from "./wetInkMacros";

const MACRO_KEYS: readonly WetInkMacroKey[] = ["bleed", "dryness", "paper"];

/** Raw parameters written by each macro (representative first). */
const MACRO_PARAMS: Record<
	WetInkMacroKey,
	ReadonlyArray<keyof WetInkSettings>
> = {
	bleed: ["bleedWidth", "diffusion", "directionality"],
	dryness: ["wetness", "speedInfluence", "absorption"],
	paper: ["paperGrain", "granulation", "edgeRoughness"],
};

/** Parameters no macro is allowed to touch. */
const UNTOUCHED_PARAMS: ReadonlyArray<keyof WetInkSettings> = [
	"enabled",
	"edgeDarkening",
	"paperScale",
	"accelInfluence",
	"pigmentLoad",
	"pickupUnderlyingColor",
	"pickupStrength",
	"pickupDecay",
	"pickupBlendMode",
];

describe("wetInkMacros", () => {
	describe("round-trip", () => {
		it("should read back the applied macro value within 1e-6", () => {
			for (const key of MACRO_KEYS) {
				for (const v of [0, 0.3, 1]) {
					const applied = applyWetInkMacro(baseWetInk(), key, v);
					expect(readWetInkMacro(applied, key)).toBeCloseTo(v, 6);
				}
			}
		});
	});

	describe("disjointness", () => {
		it("should leave the other macros' raw params identical", () => {
			for (const key of MACRO_KEYS) {
				const base = baseWetInk();
				const applied = applyWetInkMacro(base, key, 0.9);
				for (const other of MACRO_KEYS.filter((k) => k !== key)) {
					for (const param of MACRO_PARAMS[other]) {
						expect(applied[param]).toBe(base[param]);
					}
				}
			}
		});

		it("should leave the untouched-by-macros params identical", () => {
			for (const key of MACRO_KEYS) {
				const base = baseWetInk();
				const applied = applyWetInkMacro(base, key, 0.9);
				for (const param of UNTOUCHED_PARAMS) {
					expect(applied[param]).toBe(base[param]);
				}
			}
		});
	});

	describe("input clamping", () => {
		it("should clamp values below 0 to 0", () => {
			for (const key of MACRO_KEYS) {
				const applied = applyWetInkMacro(baseWetInk(), key, -1);
				expect(readWetInkMacro(applied, key)).toBe(0);
			}
		});

		it("should clamp values above 1 to 1", () => {
			for (const key of MACRO_KEYS) {
				const applied = applyWetInkMacro(baseWetInk(), key, 2);
				expect(readWetInkMacro(applied, key)).toBe(1);
			}
		});
	});
});

function baseWetInk(): WetInkSettings {
	return {
		enabled: true,
		bleedWidth: 0.5,
		edgeDarkening: 0.4,
		edgeRoughness: 0.3,
		paperGrain: 0.2,
		paperScale: 1,
		directionality: 0.4,
		speedInfluence: 0.5,
		accelInfluence: 0.3,
		wetness: 0.7,
		diffusion: 0.35,
		pigmentLoad: 0.85,
		absorption: 0.35,
		granulation: 0.25,
		pickupUnderlyingColor: false,
		pickupStrength: 0.35,
		pickupDecay: 1,
		pickupBlendMode: 0,
	};
}

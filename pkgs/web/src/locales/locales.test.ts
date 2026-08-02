import { describe, expect, it } from "vitest";
import { en } from "./en";
import { ja } from "./ja";

function collectKeys(obj: Record<string, unknown>, prefix = ""): string[] {
	const keys: string[] = [];
	for (const key of Object.keys(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		const value = obj[key];
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			keys.push(...collectKeys(value as Record<string, unknown>, fullKey));
		} else {
			keys.push(fullKey);
		}
	}
	return keys.sort();
}

describe("Translation key symmetry", () => {
	const enKeys = collectKeys(en);
	const jaKeys = collectKeys(ja);

	it("ja should have all keys defined in en", () => {
		const missing = enKeys.filter((k) => !jaKeys.includes(k));
		expect(missing).toEqual([]);
	});

	it("ja should not have extra keys not in en", () => {
		const extra = jaKeys.filter((k) => !enKeys.includes(k));
		expect(extra).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import { parsePersistedConfig } from "./appConfig";

describe("parsePersistedConfig", () => {
	it("should fall back invalid field to undefined while keeping valid fields", () => {
		const result = parsePersistedConfig({ theme: 123, language: "ja" });
		expect(result.theme).toBeUndefined();
		expect(result.language).toBe("ja");
	});
});

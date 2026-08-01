import { describe, expect, it } from "vitest";
import { createScriptHost } from "./ScriptHost";

describe("top-level return", () => {
	it("should stop a script without requiring a main function", async () => {
		const lines: string[] = [];
		const host = createScriptHost({ stdout: (line) => lines.push(line) });
		const output = await host.compile(`
			let value: String? = nil
			guard let unwrapped = value else { return }
			print(unwrapped)
		`);

		expect(output.diagnostics).toEqual([]);
		expect(output.code).not.toBeNull();
		await host.run(output.code as string);
		expect(lines).toEqual([]);
	});

	it("should reject a top-level return value in a script", async () => {
		const host = createScriptHost();
		const output = await host.compile("return 1");

		expect(output.code).toBeNull();
		expect(
			output.diagnostics.map((diagnostic) => diagnostic.message),
		).toContain("'return' outside of a function");
	});

	it("should reject a top-level bare return in a module", async () => {
		const host = createScriptHost();

		await expect(host.loadModule("return")).rejects.toThrow(
			"'return' outside of a function",
		);
	});
});

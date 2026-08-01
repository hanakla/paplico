import { describe, expect, it } from "vitest";
import { createScriptHost, type ScriptHost } from "../src/host/ScriptHost";
import { createMockPaplicoRuntime, PAPLICO_DECLARATIONS } from "./paplicoMock";
import { BRUSHES_MODULE_SOURCE, SAMPLES } from "./samples";

function makeHost(): { host: ScriptHost; lines: string[] } {
	const lines: string[] = [];
	const host = createScriptHost({ stdout: (text) => lines.push(text) });
	host.registerPackage({
		name: "paplico",
		declarations: PAPLICO_DECLARATIONS,
		runtime: createMockPaplicoRuntime((text) => lines.push(text)),
	});
	host.setModuleResolver((specifier) =>
		specifier === "brushes" ? BRUSHES_MODULE_SOURCE : null,
	);
	return { host, lines };
}

describe("playground samples", () => {
	describe.each(SAMPLES)("sample '$id'", (sample) => {
		it("should compile without error diagnostics", async () => {
			const { host } = makeHost();
			const { code, diagnostics } = await host.compile(sample.source);
			expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
			expect(code).not.toBeNull();
		});

		it("should run without throwing and produce output", async () => {
			const { host, lines } = makeHost();
			const { code } = await host.compile(sample.source);
			if (code === null) throw new Error("Sample failed to compile");
			await host.run(code);
			expect(lines.length).toBeGreaterThan(0);
		});
	});
});

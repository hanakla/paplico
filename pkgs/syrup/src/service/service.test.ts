import { describe, expect, it } from "vitest";
import { createScriptHost } from "../host/ScriptHost";
import { LanguageService } from "./LanguageService";

function makeService(): LanguageService {
	const host = createScriptHost({ stdout: () => {} });
	host.registerPackage({
		name: "paplico",
		declarations: `
			declare type Layer {
				let name: String
				var opacity: Number
				fn addChild(child: Layer) -> Void
			}
			declare fn addLayer(name: String) -> Layer
		`,
		runtime: { addLayer: () => ({}) },
	});
	return new LanguageService(host);
}

function makeModuleService(specifiers: string[]): LanguageService {
	const host = createScriptHost({ stdout: () => {} });
	host.setModuleResolver(() => null, { knownSpecifiers: specifiers });
	return new LanguageService(host);
}

describe("LanguageService", () => {
	describe("diagnostics", () => {
		it("should report type errors with spans", async () => {
			const service = makeService();
			const source = 'let x: Number = "no"';
			const diagnostics = await service.update(source);
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].message).toContain("not assignable");
			expect(source.slice(diagnostics[0].span.start)).toBe('"no"');
		});

		it("should return no diagnostics for a valid program", async () => {
			const service = makeService();
			expect(
				await service.update('let layer = paplico.addLayer(name: "bg")'),
			).toEqual([]);
		});
	});

	describe("hover", () => {
		it("should show inferred binding types", async () => {
			const service = makeService();
			const source = "let count = 42";
			await service.update(source);
			const hover = service.hoverAt(source.indexOf("count") + 1);
			expect(hover?.text).toBe("let count: Number");
		});

		it("should show host member types", async () => {
			const service = makeService();
			const source = 'let layer = paplico.addLayer(name: "bg")';
			await service.update(source);
			const hover = service.hoverAt(source.indexOf("addLayer") + 1);
			expect(hover?.text).toContain("(name: String) -> Layer");
		});
	});

	describe("completion", () => {
		it("should complete scope members and keywords", async () => {
			const service = makeService();
			const source = "let width = 800\n";
			await service.update(source);
			const labels = service.completionsAt(source.length).map((i) => i.label);
			expect(labels).toContain("width");
			expect(labels).toContain("print");
			expect(labels).toContain("paplico");
			expect(labels).toContain("fn");
		});

		it("should insert argument labels when completing a callable", async () => {
			const service = makeService();
			const source = "paplico.";
			await service.update(source);
			const item = service
				.completionsAt(source.length)
				.find((i) => i.label === "addLayer");
			expect(item?.insertText).toBe("addLayer(name: ${1:String})");
			expect(item?.insertTextIsSnippet).toBe(true);
		});

		it("should leave omittable arguments out of the inserted labels", async () => {
			const host = createScriptHost({ stdout: () => {} });
			host.registerPackage({
				name: "ask",
				declarations: `
					declare fn prompt(message: String, defaultValue?: String) -> String
				`,
				runtime: { prompt: () => "" },
			});
			const service = new LanguageService(host);
			const source = "ask.";
			await service.update(source);
			const item = service
				.completionsAt(source.length)
				.find((i) => i.label === "prompt");
			expect(item?.insertText).toBe("prompt(message: ${1:String})");
		});

		it("should complete labels of arguments the call has not bound yet", async () => {
			const host = createScriptHost({ stdout: () => {} });
			host.registerPackage({
				name: "ask",
				declarations: `
					declare fn prompt(message: String, defaultValue?: String) -> String
				`,
				runtime: { prompt: () => "" },
			});
			const service = new LanguageService(host);
			const source = 'let answer = ask.prompt("msg", )';
			await service.update(source);
			const items = service.completionsAt(source.indexOf(", ") + 2);
			const item = items.find((i) => i.label === "defaultValue:");
			expect(item?.detail).toBe("String");
			expect(item?.insertText).toBe("defaultValue: ");
			expect(item?.sortText).toBe("!0");
			expect(items.some((i) => i.label === "message:")).toBe(false);
		});

		it("should complete attribute names after '@'", async () => {
			const service = makeService();
			const source = "@";
			await service.update(source);
			const items = service.completionsAt(source.length);
			expect(items).toEqual([
				{ label: "test", kind: "keyword", detail: "attribute" },
			]);
		});

		it("should complete Expectation matchers after expect(...)", async () => {
			const service = makeService();
			const source = "expect(1).";
			await service.update(source);
			const labels = service.completionsAt(source.length).map((i) => i.label);
			expect(labels).toContain("toEqual");
			expect(labels).toContain("toBeNil");
		});

		it("should complete known modules after 'use'", async () => {
			const service = makeModuleService(["brushes", "pkgs/geo"]);
			const source = "use ";
			await service.update(source);
			const items = service.completionsAt(source.length);
			expect(items.map((i) => i.label)).toEqual(["brushes", "pkgs/geo"]);
			expect(items[0].insertText).toBe('brushes from "brushes"');
			expect(items[1].insertText).toBe('geo from "pkgs/geo"');
			expect(items[0].kind).toBe("package");
		});

		it("should complete specifiers inside from strings", async () => {
			const service = makeModuleService(["brushes", "pkgs/geo"]);
			const source = 'use geo from "pk';
			await service.update(source);
			const items = service.moduleCompletionsAt(source.length);
			expect(items?.map((i) => i.label)).toEqual(["brushes", "pkgs/geo"]);
		});

		it("should complete a module's exports inside use braces", async () => {
			const host = createScriptHost({ stdout: () => {} });
			host.setModuleResolver(
				(specifier) =>
					specifier === "brushes"
						? [
								"export let baseSize = 12",
								"export fn double(n: Number) -> Number { return n * 2 }",
								"export struct Brush { var size: Number }",
							].join("\n")
						: null,
				{ knownSpecifiers: ["brushes"] },
			);
			const service = new LanguageService(host);
			const source = 'use { baseSize, } from "brushes"';
			await service.update(source);
			const offset = source.indexOf(", }") + 2;
			const items = service.moduleCompletionsAt(offset);
			// baseSize is already listed; the rest of the exports remain.
			expect(items?.map((i) => i.label).sort()).toEqual(["Brush", "double"]);
			const double = items?.find((i) => i.label === "double");
			expect(double?.kind).toBe("function");
		});

		it("should not offer module completions outside use statements", async () => {
			const service = makeModuleService(["brushes"]);
			const source = 'let s = "pk';
			await service.update(source);
			expect(service.moduleCompletionsAt(source.length)).toBeNull();
			expect(service.moduleCompletionsAt(4)).toBeNull();
		});

		it("should complete host type members after a dot", async () => {
			const service = makeService();
			const source = 'let layer = paplico.addLayer(name: "bg")\nlayer.';
			await service.update(source);
			const items = service.completionsAt(source.length);
			const labels = items.map((i) => i.label);
			expect(labels).toEqual(
				expect.arrayContaining(["name", "opacity", "addChild"]),
			);
		});

		it("should complete package members after a dot", async () => {
			const service = makeService();
			const source = "paplico.";
			await service.update(source);
			const labels = service.completionsAt(source.length).map((i) => i.label);
			expect(labels).toEqual(["addLayer"]);
		});

		it("should complete enum cases after the type name", async () => {
			const service = makeService();
			const source =
				"enum Shape { case circle(radius: Number); case dot }\nShape.";
			await service.update(source);
			const items = service.completionsAt(source.length);
			expect(items.map((i) => i.label)).toEqual(["circle", "dot"]);
			expect(items[0].kind).toBe("case");
		});

		it("should complete array members", async () => {
			const service = makeService();
			const source = "let xs = [1, 2]\nxs.";
			await service.update(source);
			const labels = service.completionsAt(source.length).map((i) => i.label);
			expect(labels).toEqual(
				expect.arrayContaining(["count", "map", "append"]),
			);
		});

		it("should complete struct fields in broken text", async () => {
			const service = makeService();
			const source =
				"struct Point { var x: Number; var y: Number }\nlet p = Point(x: 1, y: 2)\np.";
			await service.update(source);
			const labels = service.completionsAt(source.length).map((i) => i.label);
			expect(labels).toEqual(["x", "y"]);
		});
	});
});

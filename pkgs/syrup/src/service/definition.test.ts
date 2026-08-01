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
			}
			declare fn addLayer(name: String) -> Layer
		`,
		runtime: { addLayer: () => ({}) },
	});
	return new LanguageService(host);
}

function sliceSpan(
	source: string,
	span: { start: number; end: number } | undefined,
) {
	return span === undefined ? null : source.slice(span.start, span.end);
}

describe("LanguageService go-to-definition", () => {
	describe("bindings", () => {
		it("should jump from a usage to its let declaration", async () => {
			const service = makeService();
			const source = "let width = 800\nprint(width)";
			await service.update(source);
			const def = service.definitionAt(source.indexOf("width)") + 1);
			expect(def).not.toBeNull();
			expect(def?.target.start).toBe(source.indexOf("width"));
			expect(sliceSpan(source, def?.target)).toBe("width");
			expect(def?.origin.start).toBe(source.indexOf("width)"));
		});

		it("should resolve the innermost shadowing declaration", async () => {
			const service = makeService();
			const source = [
				"let value = 1",
				"if true {",
				"	let value = 2",
				"	print(value)",
				"}",
				"print(value)",
			].join("\n");
			await service.update(source);
			const inner = service.definitionAt(
				source.indexOf("print(value") + "print(".length,
			);
			expect(inner?.target.start).toBe(source.indexOf("value = 2"));
			const outer = service.definitionAt(source.lastIndexOf("value"));
			expect(outer?.target.start).toBe(source.indexOf("value = 1"));
		});

		it("should jump from a loop body usage to the for binding", async () => {
			const service = makeService();
			const source = "for i in 0..<3 {\n\tprint(i)\n}";
			await service.update(source);
			const def = service.definitionAt(
				source.indexOf("print(i") + "print(".length,
			);
			expect(def?.target.start).toBe(source.indexOf("i in"));
			expect(sliceSpan(source, def?.target)).toBe("i");
		});
	});

	describe("functions", () => {
		const source = [
			"fn move(to x: Number) -> Number {",
			"	return x",
			"}",
			"let n = move(to: 3)",
		].join("\n");

		it("should jump from a call to the fn declaration name", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(source.indexOf("move(to: 3") + 1);
			expect(def?.target.start).toBe(source.indexOf("move"));
			expect(sliceSpan(source, def?.target)).toBe("move");
		});

		it("should jump from a body usage to the parameter", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(
				source.indexOf("return x") + "return ".length,
			);
			expect(def?.target.start).toBe(source.indexOf("to x") + "to ".length);
			expect(sliceSpan(source, def?.target)).toBe("x");
		});
	});

	describe("structs", () => {
		const source =
			"struct Point { var x: Number; var y: Number }\nlet p = Point(x: 1, y: 2)\nprint(p.x)";

		it("should jump from an initializer call to the struct name", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(source.indexOf("Point(x") + 1);
			expect(def?.target.start).toBe(source.indexOf("Point"));
			expect(sliceSpan(source, def?.target)).toBe("Point");
		});

		it("should jump from a member access to the field declaration", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(source.indexOf("p.x") + 2);
			expect(def?.target.start).toBe(source.indexOf("var x") + "var ".length);
			expect(sliceSpan(source, def?.target)).toBe("x");
		});
	});

	describe("enums", () => {
		const source =
			"enum Shape { case circle(radius: Number); case dot }\nlet s = Shape.circle(radius: 5)";

		it("should jump from a case constructor to the case declaration", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(source.indexOf(".circle") + 1);
			expect(def?.target.start).toBe(source.indexOf("circle"));
			expect(sliceSpan(source, def?.target)).toBe("circle");
		});

		it("should jump from the type name usage to the enum declaration", async () => {
			const service = makeService();
			await service.update(source);
			const def = service.definitionAt(source.indexOf("Shape.circle") + 1);
			expect(def?.target.start).toBe(source.indexOf("Shape"));
			expect(sliceSpan(source, def?.target)).toBe("Shape");
		});
	});

	describe("references without a local declaration", () => {
		it("should return null for package members, globals, and keywords", async () => {
			const service = makeService();
			const source = 'let layer = paplico.addLayer(name: "bg")\nprint(layer)';
			await service.update(source);
			expect(service.definitionAt(source.indexOf("addLayer") + 1)).toBeNull();
			expect(service.definitionAt(source.indexOf("paplico") + 1)).toBeNull();
			expect(service.definitionAt(source.indexOf("print") + 1)).toBeNull();
			expect(service.definitionAt(0)).toBeNull();
		});
	});
});

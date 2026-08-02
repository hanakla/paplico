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

describe("LanguageService signature help", () => {
	describe("user-defined functions", () => {
		const source = [
			"fn move(to x: Number, speed: Number = 10) -> Number {",
			"	return x * speed",
			"}",
			"let n = move(to: 3, speed: 2)",
		].join("\n");

		it("should show labels, defaults, and the return type", async () => {
			const service = makeService();
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("to: 3") + 1);
			expect(help?.label).toBe("(to: Number, speed: Number = …) -> Number");
			expect(help?.parameters.map((p) => p.label)).toEqual([
				"to: Number",
				"speed: Number = …",
			]);
			expect(help?.activeParameter).toBe(0);
		});

		it("should activate the first parameter right after the open paren", async () => {
			const service = makeService();
			await service.update(source);
			const offset = source.indexOf("move(to: 3") + "move(".length;
			expect(service.signatureHelpAt(offset)?.activeParameter).toBe(0);
		});

		it("should activate the second parameter right after the comma", async () => {
			const service = makeService();
			await service.update(source);
			const offset = source.indexOf(", speed: 2") + 1;
			expect(service.signatureHelpAt(offset)?.activeParameter).toBe(1);
		});

		it("should activate the second parameter inside its argument", async () => {
			const service = makeService();
			await service.update(source);
			const offset = source.indexOf("speed: 2") + 1;
			expect(service.signatureHelpAt(offset)?.activeParameter).toBe(1);
		});
	});

	describe("host package functions", () => {
		it("should show the signature of paplico.addLayer", async () => {
			const service = makeService();
			const source = 'let layer = paplico.addLayer(name: "bg")';
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf('"bg"') + 1);
			expect(help?.label).toBe("(name: String) -> Layer");
			expect(help?.parameters.map((p) => p.label)).toEqual(["name: String"]);
			expect(help?.activeParameter).toBe(0);
		});
	});

	describe("struct initializers", () => {
		const source =
			"struct Point { var x: Number; var y: Number }\nlet p = Point(x: 1, y: 2)";

		it("should list fields as parameters", async () => {
			const service = makeService();
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("x: 1") + 1);
			expect(help?.label).toBe("Point(x: Number, y: Number)");
			expect(help?.parameters.map((p) => p.label)).toEqual([
				"x: Number",
				"y: Number",
			]);
			expect(help?.activeParameter).toBe(0);
		});

		it("should activate the second field inside its argument", async () => {
			const service = makeService();
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("y: 2") + 1);
			expect(help?.activeParameter).toBe(1);
		});
	});

	describe("enum case constructors", () => {
		it("should show associated values of the case", async () => {
			const service = makeService();
			const source =
				"enum Shape { case circle(radius: Number); case dot }\nlet s = Shape.circle(radius: 5)";
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("radius: 5") + 1);
			expect(help?.label).toBe("Shape.circle(radius: Number)");
			expect(help?.parameters.map((p) => p.label)).toEqual(["radius: Number"]);
			expect(help?.activeParameter).toBe(0);
		});
	});

	describe("nested calls", () => {
		const source = [
			"fn outer(first: Number, second: Number) -> Number {",
			"	return first + second",
			"}",
			"fn inner(value: Number) -> Number {",
			"	return value",
			"}",
			"let n = outer(first: inner(value: 1), second: 2)",
		].join("\n");

		it("should pick the innermost call around the cursor", async () => {
			const service = makeService();
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("value: 1") + 1);
			expect(help?.label).toBe("(value: Number) -> Number");
			expect(help?.activeParameter).toBe(0);
		});

		it("should pick the outer call between its own arguments", async () => {
			const service = makeService();
			await service.update(source);
			const help = service.signatureHelpAt(source.indexOf("second: 2") + 1);
			expect(help?.label).toBe("(first: Number, second: Number) -> Number");
			expect(help?.activeParameter).toBe(1);
		});
	});

	describe("outside calls", () => {
		it("should return null when the cursor is not in an argument list", async () => {
			const service = makeService();
			const source = 'let layer = paplico.addLayer(name: "bg")';
			await service.update(source);
			expect(service.signatureHelpAt(0)).toBeNull();
			expect(
				service.signatureHelpAt(source.indexOf("addLayer") + 1),
			).toBeNull();
			expect(service.signatureHelpAt(source.length)).toBeNull();
		});
	});
});

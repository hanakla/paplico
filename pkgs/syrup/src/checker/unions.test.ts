import { describe, expect, it } from "vitest";
import { parseProgram } from "../syntax/cstToAst";
import { checkProgram } from "./check";

function errors(source: string): string[] {
	const { ast, diagnostics } = parseProgram(source);
	expect(diagnostics).toEqual([]);
	return checkProgram(ast).diagnostics.map((d) => d.message);
}

describe("union and literal type rules", () => {
	describe("union soundness", () => {
		it("should reject unions that cannot be discriminated at runtime", () => {
			expect(
				errors(`
					struct A { var v: Number }
					struct B { var v: Number }
					fn f(x: A | B) -> Number { return 0 }
				`),
			).toEqual([
				"Union members 'A' and 'B' cannot be distinguished at runtime",
			]);
		});

		it("should reject optional union members", () => {
			expect(
				errors("fn f(x: Number? | String) -> Number { return 0 }"),
			).toEqual([
				"Optional cannot be a union member; make the whole union optional instead",
			]);
		});

		it("should reject values outside a literal union", () => {
			expect(errors('let align: "left" | "right" = "top"')).toEqual([
				"Type 'String' is not assignable to '\"left\" | \"right\"'",
			]);
		});
	});

	describe("is checks", () => {
		it("should reject is on non-union values", () => {
			expect(errors("let n = 1\nlet b = n is String")).toEqual([
				"'is' requires a union-typed value, got 'Number'",
			]);
		});

		it("should reject literal targets", () => {
			expect(errors('let v: "a" | Number = 1\nlet b = v is "a"')).toEqual([
				"Use '==' to compare against a literal value",
			]);
		});

		it("should reject non-member targets", () => {
			expect(errors("let v: String | Number = 1\nlet b = v is Bool")).toEqual([
				"'Bool' is not a member of 'String | Number'",
			]);
		});
	});

	describe("switch over unions", () => {
		it("should require covering every member", () => {
			expect(
				errors(`
					let v: String | Number = 1
					switch v {
					case is String:
						let x = 1
					}
				`),
			).toEqual(["Switch is not exhaustive; missing: Number"]);
		});

		it("should require literal-union members to be covered", () => {
			expect(
				errors(`
					let v: "a" | "b" = "a"
					switch v {
					case "a":
						let x = 1
					}
				`),
			).toEqual(['Switch is not exhaustive; missing: "b"']);
		});
	});

	describe("exhaustive-key dictionaries", () => {
		it("should require every key at construction", () => {
			expect(errors('let d: ["a" | "b": Number] = [a: 1]')).toEqual([
				"Exhaustive-key dictionary is missing: 'b'",
			]);
		});

		it("should reject computed keys", () => {
			expect(
				errors(`
					let k: "a" | "b" = "a"
					let d: ["a" | "b": Number] = [[k]: 1, b: 2]
				`),
			).toEqual([
				"Exhaustive-key dictionaries require literal keys",
				// A computed key cannot prove coverage, so 'a' stays missing.
				"Exhaustive-key dictionary is missing: 'a'",
			]);
		});

		it("should reject keys outside the union", () => {
			expect(
				errors('let d: ["a" | "b": Number] = [a: 1, b: 2, c: 3]').length,
			).toBeGreaterThan(0);
		});

		it("should reject removeValue", () => {
			expect(
				errors(`
					var d: ["a" | "b": Number] = [a: 1, b: 2]
					let x = d.removeValue(forKey: "a")
				`),
			).toEqual([
				"'removeValue' is not available on exhaustive-key dictionaries",
			]);
		});

		it("should reject empty literals", () => {
			expect(errors('let d: ["a" | "b": Number] = [:]')).toEqual([
				"Exhaustive-key dictionaries cannot be empty; provide every key",
			]);
		});
	});
});

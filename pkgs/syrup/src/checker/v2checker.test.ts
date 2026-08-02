import { describe, expect, it } from "vitest";
import { parseProgram } from "../syntax/cstToAst";
import { checkDeclarations, checkProgram, type PackageEnv } from "./check";

function errors(source: string, packages: PackageEnv[] = []): string[] {
	const { ast, diagnostics } = parseProgram(source);
	expect(diagnostics).toEqual([]);
	return checkProgram(ast, packages).diagnostics.map((d) => d.message);
}

function asyncPkg(): PackageEnv {
	const { ast, diagnostics } = parseProgram(
		"declare async fn load(key: String) -> Number",
	);
	expect(diagnostics).toEqual([]);
	const result = checkDeclarations(ast, "io");
	expect(result.diagnostics).toEqual([]);
	return { name: "io", expose: "namespace", members: result.members };
}

describe("v2 checker rules", () => {
	describe("guard", () => {
		it("should require the else body to exit", () => {
			expect(
				errors(`
					fn f(v: Number?) -> Number {
						guard let x = v else { let y = 1 }
						return x
					}
				`),
			).toEqual(["'guard' else body must exit (return, break, or continue)"]);
		});
	});

	describe("async", () => {
		it("should reject await inside sync functions", () => {
			expect(
				errors(
					`
						fn f() -> Number {
							return await io.load("a")
						}
					`,
					[asyncPkg()],
				),
			).toEqual([
				"'await' is only allowed at the top level or inside async functions",
			]);
		});

		it("should require await on async calls", () => {
			expect(errors('let n = io.load("a")', [asyncPkg()])).toEqual([
				"Call to an async function must be marked with 'await'",
			]);
		});

		it("should reject await with no async operations", () => {
			expect(errors("let n = await 1")).toEqual([
				"'await' has no async operations",
			]);
		});
	});

	describe("dictionaries", () => {
		it("should reject non-String keys in annotations", () => {
			expect(errors("let d: [Number: String] = [:]").length).toBeGreaterThan(0);
		});

		it("should require tuple bindings when iterating dictionaries", () => {
			expect(
				errors(`
					let d = [a: 1]
					for entry in d { let x = entry }
				`),
			).toEqual(["Iterating a dictionary requires 'for (key, value) in ...'"]);
		});

		it("should reject tuple bindings over arrays", () => {
			expect(
				errors(`
					for (a, b) in [1, 2] { let x = a }
				`),
			).toEqual(["'for (key, value)' requires a dictionary source"]);
		});

		it("should reject mutating a dictionary through let", () => {
			expect(
				errors(`
					let d = [a: 1]
					d["b"] = 2
				`),
			).toEqual(["Cannot mutate 'd' because it is a 'let' constant"]);
		});
	});

	describe("generics", () => {
		it("should reject wrong type-argument arity", () => {
			expect(
				errors(`
					struct Pair<A, B> { var first: A; var second: B }
					let p: Pair<Number> = Pair(first: 1, second: 2)
				`),
			).toEqual(["'Pair' requires 2 type argument(s)"]);
		});

		it("should require annotations when enum args cannot be inferred", () => {
			expect(
				errors(`
					enum Maybe<T> { case none; case some(value: T) }
					let m = Maybe.none
				`),
			).toEqual([
				"Cannot infer generic arguments for 'Maybe'; add a type annotation",
			]);
		});
	});

	describe("modules", () => {
		it("should accept declare generic host types", () => {
			const { ast } = parseProgram(
				"declare type Box<T> { let value: T }\ndeclare fn box<T>(value: T) -> Box<T>",
			);
			const result = checkDeclarations(ast, "pkg");
			expect(result.diagnostics).toEqual([]);
			const box = result.members.get("Box");
			expect(box?.kind).toBe("type");
			if (box?.kind === "type" && box.type.kind === "host") {
				expect(box.type.info.typeParams).toHaveLength(1);
			}
		});
	});
});

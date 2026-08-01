import { describe, expect, it } from "vitest";
import type { Expr, Stmt } from "./ast";
import { parseProgram } from "./cstToAst";

function parseOk(source: string): Stmt[] {
	const { ast, diagnostics } = parseProgram(source);
	expect(diagnostics).toEqual([]);
	return ast;
}

function firstExpr(source: string): Expr {
	const ast = parseOk(source);
	const stmt = ast[0];
	if (stmt.kind !== "expr")
		throw new Error(`expected expr stmt, got ${stmt.kind}`);
	return stmt.expr;
}

describe("parseProgram", () => {
	describe("bindings", () => {
		it("should parse let with inferred type", () => {
			const ast = parseOk("let width = 800");
			expect(ast[0]).toMatchObject({
				kind: "binding",
				mutable: false,
				name: "width",
				init: { kind: "number", value: 800 },
			});
		});

		it("should parse var with type annotation", () => {
			const ast = parseOk("var offset: Number = 0");
			expect(ast[0]).toMatchObject({
				kind: "binding",
				mutable: true,
				type: { kind: "named", name: "Number" },
			});
		});

		it("should parse numeric separators", () => {
			const ast = parseOk("let n = 1_000_000");
			expect(ast[0]).toMatchObject({ init: { value: 1_000_000 } });
		});
	});

	describe("functions", () => {
		it("should parse labeled params and defaults", () => {
			const ast = parseOk(
				"fn move(to point: Number, speed: Number, flag: Bool = true) -> Bool { return flag }",
			);
			const fn = ast[0];
			if (fn.kind !== "func") throw new Error("expected func");
			expect(fn.sig.params[0]).toMatchObject({ label: "to", name: "point" });
			expect(fn.sig.params[1]).toMatchObject({ label: "speed", name: "speed" });
			expect(fn.sig.params[2]).toMatchObject({ label: "flag", name: "flag" });
			expect(fn.sig.params[2].defaultValue).toMatchObject({ kind: "bool" });
			expect(fn.sig.retType).toMatchObject({ kind: "named", name: "Bool" });
		});

		it("should reject the removed '_ name' label form", () => {
			const { diagnostics } = parseProgram(
				"fn move(_ speed: Number) -> Number { return speed }",
			);
			expect(diagnostics.map((d) => d.message)).toEqual([
				"'_' parameter labels are no longer needed; write the parameter name only",
			]);
		});

		it("should parse a throws function", () => {
			const ast = parseOk("fn parse(s: String) throws -> Number { return 1 }");
			const fn = ast[0];
			if (fn.kind !== "func") throw new Error("expected func");
			expect(fn.sig.throws).toBe(true);
			expect(fn.sig.retType).toMatchObject({ kind: "named", name: "Number" });
		});

		it("should parse generic type params", () => {
			const ast = parseOk(
				"fn firstOr<T>(items: Array<T>, fallback: T) -> T { return fallback }",
			);
			const fn = ast[0];
			if (fn.kind !== "func") throw new Error("expected func");
			expect(fn.sig.typeParams).toMatchObject([{ name: "T" }]);
			expect(fn.sig.typeParams[0].constraint).toBeUndefined();
			expect(fn.sig.params[0].type).toMatchObject({
				kind: "named",
				name: "Array",
				args: [{ kind: "named", name: "T" }],
			});
		});

		it("should parse generic constraints", () => {
			const ast = parseOk("fn render<T: Drawable, U>(item: T, extra: U) {}");
			const fn = ast[0];
			if (fn.kind !== "func") throw new Error("expected func");
			expect(fn.sig.typeParams).toMatchObject([
				{ name: "T", constraint: { kind: "named", name: "Drawable" } },
				{ name: "U" },
			]);
			expect(fn.sig.typeParams[1].constraint).toBeUndefined();
		});

		it("should parse constraints on type declarations", () => {
			const ast = parseOk("struct Pen<T: Drawable> { let item: T }");
			expect(ast[0]).toMatchObject({
				kind: "struct",
				typeParams: [
					{ name: "T", constraint: { kind: "named", name: "Drawable" } },
				],
			});
		});
	});

	describe("error handling", () => {
		it("should parse throw statements", () => {
			const ast = parseOk("throw failure");
			expect(ast[0]).toMatchObject({
				kind: "throw",
				expr: { kind: "ident", name: "failure" },
			});
		});

		it("should parse do-catch statements", () => {
			const ast = parseOk('do { print("a") } catch { print(error) }');
			expect(ast[0]).toMatchObject({
				kind: "doCatch",
				body: [{ kind: "expr" }],
				catchBody: [{ kind: "expr" }],
			});
		});

		it("should parse try as a prefix expression", () => {
			const expr = firstExpr("try parse(input)");
			expect(expr).toMatchObject({
				kind: "try",
				operand: { kind: "call" },
			});
		});

		it("should nest try over await", () => {
			const expr = firstExpr("try await fetch()");
			expect(expr).toMatchObject({
				kind: "try",
				operand: { kind: "await", operand: { kind: "call" } },
			});
		});

		it("should parse do expressions with an optional catch", () => {
			const ast = parseOk("let a = do { 1 } catch { 0 }");
			expect(ast[0]).toMatchObject({
				kind: "binding",
				init: {
					kind: "doExpr",
					body: [{ kind: "expr" }],
					catchBody: [{ kind: "expr" }],
				},
			});
			const bare = parseOk("let b = do { return 2 }");
			expect(bare[0]).toMatchObject({
				kind: "binding",
				init: { kind: "doExpr", catchBody: undefined },
			});
		});

		it("should keep statement-position do as the do-catch statement", () => {
			const ast = parseOk('do { print("a") } catch { print("b") }');
			expect(ast[0]).toMatchObject({ kind: "doCatch" });
		});
	});

	describe("struct and enum", () => {
		it("should parse struct fields", () => {
			const ast = parseOk("struct Point { var x: Number; var y: Number }");
			expect(ast[0]).toMatchObject({
				kind: "struct",
				name: "Point",
				fields: [
					{ mutable: true, name: "x" },
					{ mutable: true, name: "y" },
				],
			});
		});

		it("should parse enum cases with associated values", () => {
			const ast = parseOk(
				"enum Shape { case circle(radius: Number); case rect(w: Number, h: Number) }",
			);
			const decl = ast[0];
			if (decl.kind !== "enum") throw new Error("expected enum");
			expect(decl.cases[0].name).toBe("circle");
			expect(decl.cases[0].assoc[0].label).toBe("radius");
			expect(decl.cases[1].assoc.map((a) => a.label)).toEqual(["w", "h"]);
		});
	});

	describe("control flow", () => {
		it("should parse if let with else", () => {
			const ast = parseOk("if let x = maybe { print(x) } else { print(0) }");
			expect(ast[0]).toMatchObject({
				kind: "if",
				conds: [{ kind: "optionalBinding", name: "x" }],
			});
		});

		it("should parse a comma-separated condition list", () => {
			const ast = parseOk("if let x = maybe, x > 0 { print(x) }");
			expect(ast[0]).toMatchObject({
				kind: "if",
				conds: [
					{ kind: "optionalBinding", name: "x" },
					{ kind: "expr", expr: { kind: "binary", op: ">" } },
				],
			});
		});

		it("should not treat the if block as a trailing closure", () => {
			const ast = parseOk("if ready { run() }");
			expect(ast[0]).toMatchObject({
				kind: "if",
				conds: [{ kind: "expr", expr: { kind: "ident", name: "ready" } }],
			});
		});

		it("should parse for over an exclusive range", () => {
			const ast = parseOk("for i in 0..<10 { print(i) }");
			expect(ast[0]).toMatchObject({
				kind: "for",
				binding: { kind: "single", name: "i" },
				source: { kind: "range", inclusive: false },
			});
		});

		it("should parse for over an array expression", () => {
			const ast = parseOk("for item in items { print(item) }");
			expect(ast[0]).toMatchObject({
				kind: "for",
				source: { kind: "iterable", expr: { kind: "ident", name: "items" } },
			});
		});

		it("should parse switch with enum patterns and default", () => {
			const ast = parseOk(`
				switch shape {
				case .circle(let r):
					print(r)
				case .rect(let w, let h):
					print(w + h)
				default:
					print(0)
				}
			`);
			const stmt = ast[0];
			if (stmt.kind !== "switch") throw new Error("expected switch");
			expect(stmt.cases).toHaveLength(3);
			expect(stmt.cases[0].pattern).toMatchObject({
				kind: "case",
				name: "circle",
				bindings: [{ name: "r" }],
			});
			expect(stmt.cases[2].pattern).toBe("default");
		});
	});

	describe("closures", () => {
		it("should parse trailing closure with $0 shorthand", () => {
			const expr = firstExpr("xs.map { $0 * 2 }");
			expect(expr).toMatchObject({
				kind: "call",
				callee: { kind: "member", name: "map" },
				args: [{ trailing: true, expr: { kind: "closure", hasHeader: false } }],
			});
		});

		it("should parse trailing closure after call parens", () => {
			const expr = firstExpr("animate(duration: 1) { finish() }");
			if (expr.kind !== "call") throw new Error("expected call");
			expect(expr.args).toHaveLength(2);
			expect(expr.args[0].label).toBe("duration");
			expect(expr.args[1].trailing).toBe(true);
		});

		it("should parse closure with typed parameter clause", () => {
			const expr = firstExpr("{ (x: Number) -> Number in return x }");
			expect(expr).toMatchObject({
				kind: "closure",
				hasHeader: true,
				params: [{ name: "x", type: { kind: "named", name: "Number" } }],
				retType: { kind: "named", name: "Number" },
			});
		});

		it("should parse shorthand identifier closure header", () => {
			const expr = firstExpr("xs.map { x in x + 1 }");
			const arg = expr.kind === "call" ? expr.args[0].expr : null;
			expect(arg).toMatchObject({
				kind: "closure",
				hasHeader: true,
				params: [{ name: "x" }],
			});
		});
	});

	describe("string interpolation", () => {
		it("should split text and expression parts", () => {
			const expr = firstExpr('"count: $(n + 1) items"');
			if (expr.kind !== "string") throw new Error("expected string");
			expect(expr.parts[0]).toMatchObject({ kind: "text", value: "count: " });
			expect(expr.parts[1]).toMatchObject({
				kind: "expr",
				expr: { kind: "binary", op: "+" },
			});
			expect(expr.parts[2]).toMatchObject({ kind: "text", value: " items" });
		});

		it("should keep spans of interpolated expressions absolute", () => {
			const source = 'let s = "v: $(value)"';
			const ast = parseOk(source);
			const stmt = ast[0];
			if (stmt.kind !== "binding" || stmt.init.kind !== "string") {
				throw new Error("expected string binding");
			}
			const part = stmt.init.parts.find((p) => p.kind === "expr");
			if (!part || part.kind !== "expr") throw new Error("expected expr part");
			expect(source.slice(part.expr.span.start, part.expr.span.end)).toBe(
				"value",
			);
		});

		it("should handle nested strings inside interpolation", () => {
			const expr = firstExpr('"a$(f("b"))c"');
			if (expr.kind !== "string") throw new Error("expected string");
			expect(expr.parts).toHaveLength(3);
			expect(expr.parts[1]).toMatchObject({
				kind: "expr",
				expr: { kind: "call" },
			});
		});

		it("should report unterminated string", () => {
			const { diagnostics } = parseProgram('let s = "oops');
			expect(diagnostics.some((d) => d.message.includes("Unterminated"))).toBe(
				true,
			);
		});

		it("should treat escaped \\$ as a literal dollar", () => {
			const expr = firstExpr('"price: \\$(10)"');
			if (expr.kind !== "string") throw new Error("expected string");
			expect(expr.parts).toEqual([
				expect.objectContaining({ kind: "text", value: "price: $(10)" }),
			]);
		});

		it("should keep a bare dollar without paren as text", () => {
			const expr = firstExpr('"cost: 5$ total"');
			if (expr.kind !== "string") throw new Error("expected string");
			expect(expr.parts).toEqual([
				expect.objectContaining({ kind: "text", value: "cost: 5$ total" }),
			]);
		});
	});

	describe("dictionary literals", () => {
		it("should parse Swift-style entries", () => {
			const expr = firstExpr('[alice: 3, "bob-x": 5]');
			expect(expr).toMatchObject({
				kind: "dict",
				entries: [
					{ computed: false, value: { kind: "number", value: 3 } },
					{ computed: false, value: { kind: "number", value: 5 } },
				],
			});
		});

		it("should parse the empty dictionary [:]", () => {
			expect(firstExpr("[:]")).toMatchObject({ kind: "dict", entries: [] });
		});

		it("should keep plain brackets as array literals", () => {
			expect(firstExpr("[1, 2]")).toMatchObject({ kind: "array" });
			expect(firstExpr("[]")).toMatchObject({ kind: "array", elements: [] });
		});

		it("should parse computed keys inside brackets", () => {
			const expr = firstExpr("[[key]: 1, base: 2]");
			expect(expr).toMatchObject({
				kind: "dict",
				entries: [
					{ computed: true, key: { kind: "ident", name: "key" } },
					{ computed: false },
				],
			});
		});

		it("should parse [K: V] type annotations", () => {
			const ast = parseOk("let d: [String: Number] = [:]");
			expect(ast[0]).toMatchObject({
				kind: "binding",
				type: {
					kind: "named",
					name: "Dictionary",
					args: [
						{ kind: "named", name: "String" },
						{ kind: "named", name: "Number" },
					],
				},
			});
		});

		it("should keep [T] as the Array sugar", () => {
			const ast = parseOk("let xs: [Number] = []");
			expect(ast[0]).toMatchObject({
				kind: "binding",
				type: { kind: "named", name: "Array" },
			});
		});
	});

	describe("attributes", () => {
		it("should parse @test on a function declaration", () => {
			const ast = parseOk("@test\nfn works() {}");
			expect(ast[0]).toMatchObject({
				kind: "func",
				sig: { name: "works", attributes: [{ name: "test" }] },
			});
		});

		it("should parse multiple attributes with async", () => {
			const ast = parseOk("@test @slow\nasync fn works() {}");
			expect(ast[0]).toMatchObject({
				kind: "func",
				sig: {
					isAsync: true,
					attributes: [{ name: "test" }, { name: "slow" }],
				},
			});
		});
	});

	describe("optionals and operators", () => {
		it("should parse optional chaining, force unwrap, and nil coalescing", () => {
			const expr = firstExpr("a?.b!.c ?? fallback");
			expect(expr).toMatchObject({
				kind: "binary",
				op: "??",
				left: { kind: "member", name: "c" },
				right: { kind: "ident", name: "fallback" },
			});
		});

		it("should give ?? lower precedence than ||", () => {
			const expr = firstExpr("a || b ?? c");
			expect(expr).toMatchObject({ kind: "binary", op: "??" });
		});

		it("should parse ternary", () => {
			const expr = firstExpr("flag ? 1 : 2");
			expect(expr).toMatchObject({ kind: "ternary" });
		});

		it("should parse subscript and member chains", () => {
			const expr = firstExpr("grid[i].value");
			expect(expr).toMatchObject({
				kind: "member",
				name: "value",
				object: { kind: "subscript" },
			});
		});
	});

	describe("types", () => {
		it("should parse optional and function types", () => {
			const ast = parseOk("fn f(cb: (Number) -> String?) -> Void { }");
			const fn = ast[0];
			if (fn.kind !== "func") throw new Error("expected func");
			expect(fn.sig.params[0].type).toMatchObject({
				kind: "func",
				ret: { kind: "optional", inner: { kind: "named", name: "String" } },
			});
		});
	});

	describe("declare declarations", () => {
		it("should parse declare fn / let / type", () => {
			const ast = parseOk(`
				declare fn addLayer(name: String) -> Layer
				declare let version: String
				declare type Layer {
					let name: String
					var opacity: Number
					fn addChild(child: Layer) -> Void
				}
			`);
			expect(ast[0]).toMatchObject({ kind: "declareFunc" });
			expect(ast[1]).toMatchObject({ kind: "declareLet", name: "version" });
			const typeDecl = ast[2];
			if (typeDecl.kind !== "declareType") throw new Error("expected type");
			expect(typeDecl.members).toHaveLength(3);
			expect(typeDecl.members[2]).toMatchObject({
				kind: "method",
				sig: { name: "addChild" },
			});
		});
	});

	describe("assignments", () => {
		it("should parse compound assignment to member", () => {
			const ast = parseOk("p.x += 5");
			expect(ast[0]).toMatchObject({
				kind: "assign",
				op: "+=",
				target: { kind: "member", name: "x" },
			});
		});
	});

	describe("errors", () => {
		it("should report a diagnostic with position on syntax error", () => {
			const { diagnostics } = parseProgram("let = 5");
			expect(diagnostics.length).toBeGreaterThan(0);
			expect(diagnostics[0].span.start).toBeGreaterThanOrEqual(0);
		});
	});
});

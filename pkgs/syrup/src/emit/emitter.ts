import type { CallPlan, CheckResult } from "../checker/check";
import { isSuperInitStmt } from "../checker/check";
import type { Coercion } from "../checker/coercions";
import type { EnumInfo, StructInfo, Type } from "../checker/types";
import {
	boxedRepr,
	hasValueSemantics,
	stringLiteralMembers,
} from "../checker/types";
import { buildSubst, substitute } from "../checker/unify";
import type {
	Condition,
	Expr,
	FuncSig,
	MethodDecl,
	Program,
	Stmt,
	SwitchCase,
	TypeNode,
} from "../syntax/ast";
import { analyzeBundle, type EffectInfo } from "./effects";
import { RUNTIME_HELPER_SOURCES } from "./runtime";

/**
 * One compilation unit of a bundle: modules first (in dependency order),
 * then the entry (`moduleName: null`).
 */
export interface EmitUnit {
	moduleName: string | null;
	ast: Program;
	check: CheckResult;
}

export interface EmitOptions {
	/**
	 * "run" (default) drops `@test` functions from the output. "test" keeps
	 * them and appends a harness that runs each test and reports the outcome
	 * through `__host.call("__syrupTest", "report", [name, passed, error])`.
	 */
	mode?: "run" | "test";
}

/**
 * Emit the compiled JS for checked, error-free units. The result is the body
 * of an `async (__host) => { ... }` function (constructed via AsyncFunction).
 *
 * Host operations go through the injected `__host` ops, which may return
 * promises (worker RPC) or plain values (in-process execution). The effect
 * analysis (effects.ts) decides which functions are emitted `async` and
 * which calls are awaited.
 */
export function emitBundle(
	units: EmitUnit[],
	options: EmitOptions = {},
): string {
	return new Emitter(options.mode ?? "run").emitAll(units);
}

/** JS reserved words / globals that are not Syrup keywords. */
const JS_RESERVED = new Set([
	"arguments",
	"catch",
	"class",
	"const",
	"debugger",
	"delete",
	"do",
	"eval",
	"extends",
	"finally",
	"function",
	"globalThis",
	"implements",
	"Infinity",
	"instanceof",
	"interface",
	"NaN",
	"new",
	"null",
	"package",
	"packages",
	"private",
	"protected",
	"public",
	"static",
	"super",
	"this",
	"throw",
	"try",
	"typeof",
	"undefined",
	"void",
	"with",
	"yield",
	// Not a reserved word, but a struct/class method or binding with this
	// name would collide with the JS class member.
	"constructor",
]);

function jsName(name: string): string {
	if (JS_RESERVED.has(name) || name.startsWith("__")) return `${name}_$`;
	return name;
}

/** JS-safe binding name for a module specifier (deterministic). */
export function moduleJsName(specifier: string): string {
	if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(specifier)) return `__mod_${specifier}`;
	let hash = 5381;
	for (let i = 0; i < specifier.length; i++) {
		hash = ((hash << 5) + hash + specifier.charCodeAt(i)) >>> 0;
	}
	const cleaned = specifier.replace(/[^A-Za-z0-9_$]/g, "_");
	return `__mod_${cleaned}_${hash.toString(36)}`;
}

function moduleRef(moduleName: string, memberName: string): string {
	return `${moduleJsName(moduleName)}[${JSON.stringify(memberName)}]`;
}

/** Type declarations are hoisted, mirroring the checker's type hoisting. */
function hoistTypeDecls(ast: Program): Program {
	const isTypeDecl = (stmt: Stmt): boolean =>
		stmt.kind === "struct" || stmt.kind === "enum" || stmt.kind === "class";
	return [...ast.filter(isTypeDecl), ...ast.filter((s) => !isTypeDecl(s))];
}

/**
 * Tag-only structs (no fields, no methods) that are never used as values —
 * not constructed, not exported, not targeted by a runtime type test, and
 * not a union member — exist purely at the type level (phantom type tags).
 * Their class declarations are dropped from the output; type annotations
 * referencing them are erased anyway.
 */
function droppablePhantomStructs(ast: Program): Set<string> {
	const candidates = new Set<string>();
	for (const stmt of ast) {
		if (
			stmt.kind === "struct" &&
			stmt.fields.length === 0 &&
			stmt.methods.length === 0 &&
			stmt.exported !== true
		) {
			candidates.add(stmt.name);
		}
	}
	if (candidates.size === 0) return candidates;
	const used = new Set<string>();
	// `is` targets and union members are discriminated with `instanceof`,
	// so they need the class at runtime; plain annotations do not.
	const typeNames = (node: TypeNode, discriminated: boolean): void => {
		switch (node.kind) {
			case "named":
				if (discriminated) used.add(node.name);
				for (const arg of node.args) typeNames(arg, false);
				break;
			case "union":
				for (const member of node.members) typeNames(member, true);
				break;
			case "optional":
				typeNames(node.inner, discriminated);
				break;
			case "func":
				for (const param of node.params) typeNames(param, false);
				typeNames(node.ret, false);
				break;
			default:
				break;
		}
	};
	const walkExpr = (expr: Expr): void => {
		switch (expr.kind) {
			case "ident":
				used.add(expr.name);
				break;
			case "is":
				walkExpr(expr.operand);
				typeNames(expr.type, true);
				break;
			case "string":
				for (const part of expr.parts) {
					if (part.kind === "expr") walkExpr(part.expr);
				}
				break;
			case "array":
				for (const element of expr.elements) walkExpr(element);
				break;
			case "dict":
				for (const entry of expr.entries) {
					walkExpr(entry.key);
					walkExpr(entry.value);
				}
				break;
			case "await":
			case "try":
			case "force":
				walkExpr(expr.operand);
				break;
			case "unary":
				walkExpr(expr.operand);
				break;
			case "closure":
				for (const param of expr.params) {
					if (param.type) typeNames(param.type, false);
				}
				if (expr.retType) typeNames(expr.retType, false);
				walkStmts(expr.body);
				break;
			case "doExpr":
				walkStmts(expr.body);
				if (expr.catchBody) walkStmts(expr.catchBody);
				break;
			case "call":
				walkExpr(expr.callee);
				for (const arg of expr.args) walkExpr(arg.expr);
				break;
			case "member":
				walkExpr(expr.object);
				break;
			case "subscript":
				walkExpr(expr.object);
				walkExpr(expr.index);
				break;
			case "binary":
				walkExpr(expr.left);
				walkExpr(expr.right);
				break;
			case "ternary":
				walkExpr(expr.cond);
				walkExpr(expr.thenExpr);
				walkExpr(expr.elseExpr);
				break;
			default:
				break;
		}
	};
	const walkSig = (sig: FuncSig): void => {
		for (const param of sig.params) {
			typeNames(param.type, false);
			if (param.defaultValue) walkExpr(param.defaultValue);
		}
		if (sig.retType) typeNames(sig.retType, false);
	};
	const walkMethods = (methods: MethodDecl[]): void => {
		for (const method of methods) {
			walkSig(method.sig);
			walkStmts(method.body);
		}
	};
	const walkStmts = (stmts: Stmt[]): void => {
		for (const stmt of stmts) {
			switch (stmt.kind) {
				case "binding":
					if (stmt.type) typeNames(stmt.type, false);
					walkExpr(stmt.init);
					break;
				case "func":
					walkSig(stmt.sig);
					walkStmts(stmt.body);
					break;
				case "struct":
					for (const field of stmt.fields) {
						typeNames(field.type, false);
						if (field.defaultValue) walkExpr(field.defaultValue);
					}
					walkMethods(stmt.methods);
					break;
				case "enum":
					for (const caseDecl of stmt.cases) {
						for (const assoc of caseDecl.assoc) typeNames(assoc.type, false);
					}
					walkMethods(stmt.methods);
					break;
				case "class":
					for (const heritage of stmt.heritage) typeNames(heritage, false);
					for (const field of stmt.fields) {
						typeNames(field.type, false);
						if (field.defaultValue) walkExpr(field.defaultValue);
					}
					for (const init of stmt.inits) {
						for (const param of init.params) {
							typeNames(param.type, false);
							if (param.defaultValue) walkExpr(param.defaultValue);
						}
						walkStmts(init.body);
					}
					walkMethods(stmt.methods);
					break;
				case "protocol":
					for (const prop of stmt.props) typeNames(prop.type, false);
					for (const sig of stmt.methods) walkSig(sig);
					break;
				case "if":
					for (const cond of stmt.conds) walkExpr(cond.expr);
					walkStmts(stmt.thenBody);
					if (stmt.elseBody) walkStmts(stmt.elseBody);
					break;
				case "guard":
					for (const cond of stmt.conds) walkExpr(cond.expr);
					walkStmts(stmt.elseBody);
					break;
				case "for":
					if (stmt.source.kind === "range") {
						walkExpr(stmt.source.from);
						walkExpr(stmt.source.to);
					} else {
						walkExpr(stmt.source.expr);
					}
					walkStmts(stmt.body);
					break;
				case "while":
					walkExpr(stmt.cond);
					walkStmts(stmt.body);
					break;
				case "switch":
					walkExpr(stmt.subject);
					for (const switchCase of stmt.cases) {
						if (
							switchCase.pattern !== "default" &&
							switchCase.pattern.kind === "typePattern"
						) {
							typeNames(switchCase.pattern.type, true);
						}
						walkStmts(switchCase.body);
					}
					break;
				case "return":
					if (stmt.value) walkExpr(stmt.value);
					break;
				case "throw":
					walkExpr(stmt.expr);
					break;
				case "doCatch":
					walkStmts(stmt.body);
					walkStmts(stmt.catchBody);
					break;
				case "assign":
					walkExpr(stmt.target);
					walkExpr(stmt.value);
					break;
				case "expr":
					walkExpr(stmt.expr);
					break;
				default:
					break;
			}
		}
	};
	walkStmts(ast);
	return new Set([...candidates].filter((name) => !used.has(name)));
}

function isTestFn(stmt: Stmt): boolean {
	return (
		stmt.kind === "func" &&
		stmt.sig.attributes.some((attr) => attr.name === "test")
	);
}

/** Runs after the top-level statements; reports through `__syrupTest`. */
function testHarness(testNames: string[]): string {
	const entries = testNames
		.map((name) => `\t{ name: ${JSON.stringify(name)}, fn: ${jsName(name)} },`)
		.join("\n");
	return [
		`const __tests = [`,
		entries,
		`];`,
		`for (const __t of __tests) {`,
		`\ttry {`,
		`\t\tawait __t.fn();`,
		`\t\tawait __host.call("__syrupTest", "report", [__t.name, true, null]);`,
		`\t} catch (__error) {`,
		`\t\tawait __host.call("__syrupTest", "report", [__t.name, false, __error instanceof Error ? __error.message : String(__error)]);`,
		`\t}`,
		`}`,
	].join("\n");
}

class Emitter {
	public constructor(private mode: "run" | "test") {}

	private tempId = 0;
	private usedHelpers = new Set<string>();
	private currentModule: string | null = null;
	/** Emitting a native-constructor derived init: super.init → super(). */
	private nativeSuperInit = false;
	private check!: CheckResult;
	private effects!: EffectInfo;
	// Copy functions are instantiated per generic instantiation, lazily.
	private copyFnNames = new Map<string, string>();
	private copyFnCodes: string[] = [];
	private infoIds = new Map<StructInfo | EnumInfo, number>();
	private nextInfoId = 0;
	private nextCopyId = 0;

	public emitAll(units: EmitUnit[]): string {
		// Bundle-wide effect analysis (method-slot joins need every unit).
		this.effects = analyzeBundle(units);
		const unitCodes = units.map((unit) => {
			this.check = unit.check;
			this.currentModule = unit.moduleName;
			const phantoms = droppablePhantomStructs(unit.ast);
			const liveAst =
				phantoms.size === 0
					? unit.ast
					: unit.ast.filter(
							(stmt) => !(stmt.kind === "struct" && phantoms.has(stmt.name)),
						);
			// Syrup hoists type declarations; emitted JS classes have a TDZ, so
			// mirror the hoisting to keep pre-declaration construction legal.
			const ast = hoistTypeDecls(liveAst);
			if (unit.moduleName === null) {
				if (this.mode === "run") {
					return this.stmts(
						ast.filter((stmt) => !isTestFn(stmt)),
						"",
					);
				}
				const code = this.stmts(ast, "");
				const testNames = ast
					.filter(isTestFn)
					.map((stmt) => (stmt as Stmt & { kind: "func" }).sig.name);
				return testNames.length === 0
					? code
					: `${code}\n${testHarness(testNames)}`;
			}
			const body = this.stmts(ast, "\t");
			const exports = unit.check.exportedValueNames.map(
				(name) => `${JSON.stringify(name)}: ${jsName(name)}`,
			);
			// Exported enum methods travel with the module (they are statically
			// dispatched free functions; struct methods live on the class).
			for (const member of unit.check.moduleExports.values()) {
				if (member.kind !== "type") continue;
				if (member.type.kind !== "enum") continue;
				for (const methodName of member.type.info.methods.keys()) {
					const fn = `__sm_${member.type.info.name}_${methodName}`;
					exports.push(`${JSON.stringify(fn)}: ${fn}`);
				}
			}
			return [
				`const ${moduleJsName(unit.moduleName)} = await (async () => {`,
				body,
				`\treturn { ${exports.join(", ")} };`,
				`})();`,
			].join("\n");
		});
		// Only helpers actually referenced during emission are included.
		const helperCodes = Object.entries(RUNTIME_HELPER_SOURCES)
			.filter(([name]) => this.usedHelpers.has(name))
			.map(([, code]) => code);
		return [...helperCodes, ...this.copyFnCodes, ...unitCodes].join("\n");
	}

	private helper(name: string): string {
		this.usedHelpers.add(name);
		return name;
	}

	// ---- do expressions ----

	/** A do-expression body: a lone expression statement yields its value. */
	private doBody(body: Stmt[], indent: string): string {
		const single = body.length === 1 ? body[0] : undefined;
		if (single?.kind === "expr") {
			return `${indent}return ${this.expr(single.expr)};`;
		}
		return this.stmts(body, indent);
	}

	/**
	 * Whether a do-expression body contains an awaited call, so its IIFE
	 * must be `async` and awaited. Closure bodies are separate functions
	 * and do not count; nested do expressions do (their awaited IIFE
	 * appears in this body).
	 */
	private doExprAwaits(node: Expr & { kind: "doExpr" }): boolean {
		return (
			this.stmtsHaveAwaitedCall(node.body) ||
			(node.catchBody !== undefined &&
				this.stmtsHaveAwaitedCall(node.catchBody))
		);
	}

	private stmtsHaveAwaitedCall(stmts: Stmt[]): boolean {
		return stmts.some((stmt) => this.stmtHasAwaitedCall(stmt));
	}

	private stmtHasAwaitedCall(stmt: Stmt): boolean {
		switch (stmt.kind) {
			case "binding":
				return this.exprHasAwaitedCall(stmt.init);
			case "if":
				return (
					stmt.conds.some((cond) => this.exprHasAwaitedCall(cond.expr)) ||
					this.stmtsHaveAwaitedCall(stmt.thenBody) ||
					(stmt.elseBody !== undefined &&
						this.stmtsHaveAwaitedCall(stmt.elseBody))
				);
			case "guard":
				return (
					stmt.conds.some((cond) => this.exprHasAwaitedCall(cond.expr)) ||
					this.stmtsHaveAwaitedCall(stmt.elseBody)
				);
			case "for":
				return (
					(stmt.source.kind === "range"
						? this.exprHasAwaitedCall(stmt.source.from) ||
							this.exprHasAwaitedCall(stmt.source.to)
						: this.exprHasAwaitedCall(stmt.source.expr)) ||
					this.stmtsHaveAwaitedCall(stmt.body)
				);
			case "while":
				return (
					this.exprHasAwaitedCall(stmt.cond) ||
					this.stmtsHaveAwaitedCall(stmt.body)
				);
			case "switch":
				return (
					this.exprHasAwaitedCall(stmt.subject) ||
					stmt.cases.some((c) => this.stmtsHaveAwaitedCall(c.body))
				);
			case "return":
				return stmt.value !== undefined && this.exprHasAwaitedCall(stmt.value);
			case "throw":
				return this.exprHasAwaitedCall(stmt.expr);
			case "doCatch":
				return (
					this.stmtsHaveAwaitedCall(stmt.body) ||
					this.stmtsHaveAwaitedCall(stmt.catchBody)
				);
			case "assign":
				return (
					this.exprHasAwaitedCall(stmt.target) ||
					this.exprHasAwaitedCall(stmt.value)
				);
			case "expr":
				return this.exprHasAwaitedCall(stmt.expr);
			default:
				return false;
		}
	}

	/**
	 * Whether emitting `expr` produces an `await` (awaited calls and host
	 * member/binding reads). Closure bodies are separate functions and do
	 * not count.
	 */
	private exprHasAwaitedCall(expr: Expr): boolean {
		switch (expr.kind) {
			case "string":
				return expr.parts.some(
					(p) => p.kind === "expr" && this.exprHasAwaitedCall(p.expr),
				);
			case "array":
				return expr.elements.some((e) => this.exprHasAwaitedCall(e));
			case "dict":
				return expr.entries.some(
					(e) =>
						this.exprHasAwaitedCall(e.key) || this.exprHasAwaitedCall(e.value),
				);
			case "await":
			case "try":
			case "force":
			case "is":
			case "unary":
				return this.exprHasAwaitedCall(expr.operand);
			case "binary":
				return (
					this.exprHasAwaitedCall(expr.left) ||
					this.exprHasAwaitedCall(expr.right)
				);
			case "ternary":
				return (
					this.exprHasAwaitedCall(expr.cond) ||
					this.exprHasAwaitedCall(expr.thenExpr) ||
					this.exprHasAwaitedCall(expr.elseExpr)
				);
			case "subscript":
				return (
					this.exprHasAwaitedCall(expr.object) ||
					this.exprHasAwaitedCall(expr.index)
				);
			case "ident": {
				const resolution = this.check.resolutions.get(expr);
				return resolution?.kind === "packageMember";
			}
			case "member": {
				const resolution = this.check.resolutions.get(expr);
				if (resolution?.kind === "packageMember") return true;
				const objType = this.check.types.get(expr.object);
				if (
					objType?.kind === "host" ||
					(objType?.kind === "optional" && objType.inner.kind === "host")
				) {
					return true;
				}
				return this.exprHasAwaitedCall(expr.object);
			}
			case "call":
				return (
					this.effects.isCallAwaited(expr) ||
					this.exprHasAwaitedCall(expr.callee) ||
					expr.args.some((a) => this.exprHasAwaitedCall(a.expr))
				);
			case "doExpr":
				return (
					this.stmtsHaveAwaitedCall(expr.body) ||
					(expr.catchBody !== undefined &&
						this.stmtsHaveAwaitedCall(expr.catchBody))
				);
			default:
				return false;
		}
	}

	// ---- Value-semantics copy functions (per generic instantiation) ----

	private infoId(info: StructInfo | EnumInfo): number {
		let id = this.infoIds.get(info);
		if (id === undefined) {
			id = this.nextInfoId++;
			this.infoIds.set(info, id);
		}
		return id;
	}

	private typeKey(type: Type): string {
		switch (type.kind) {
			case "struct":
			case "enum":
				return `${type.kind}#${this.infoId(type.info)}<${type.typeArgs
					.map((a) => this.typeKey(a))
					.join(",")}>`;
			case "optional":
				return `${this.typeKey(type.inner)}?`;
			case "array":
				return `[${this.typeKey(type.element)}]`;
			case "dictionary":
				return `[${this.typeKey(type.key)}:${this.typeKey(type.value)}]`;
			case "literal":
				return `lit:${type.base}:${String(type.value)}`;
			case "union":
				return `(${type.members.map((m) => this.typeKey(m)).join("|")})`;
			default:
				return type.kind;
		}
	}

	/** Runtime discrimination predicate for `is` checks and union copies. */
	private isPredicate(target: Type, ref: string): string {
		switch (target.kind) {
			case "number":
				return `typeof ${ref} === "number"`;
			case "string":
				return `typeof ${ref} === "string"`;
			case "bool":
				return `typeof ${ref} === "boolean"`;
			case "literal":
				return `${ref} === ${JSON.stringify(target.value)}`;
			case "array":
				return `Array.isArray(${ref})`;
			case "dictionary":
				return `${ref} instanceof Map`;
			case "func":
				return `typeof ${ref} === "function"`;
			case "enum":
				return `(typeof ${ref} === "object" && ${ref} !== null && "$case" in ${ref})`;
			case "class":
				return `${ref} instanceof ${this.ownedRef(
					jsName(target.info.name),
					target.info.name,
					target.info.moduleName,
				)}`;
			case "struct":
				return `${ref} instanceof ${this.ownedRef(
					jsName(target.info.name),
					target.info.name,
					target.info.moduleName,
				)}`;
			case "host":
				return `(typeof ${ref} === "object" && ${ref} !== null && !Array.isArray(${ref}) && !(${ref} instanceof Map) && !("$case" in ${ref}) && !${this.helper("__isStructInst")}(${ref}))`;
			case "union":
				return `(${target.members
					.map((m) => this.isPredicate(m, ref))
					.join(" || ")})`;
			default:
				return "false";
		}
	}

	private copyFnFor(type: Type & { kind: "struct" | "enum" }): string {
		const key = this.typeKey(type);
		const existing = this.copyFnNames.get(key);
		if (existing !== undefined) return existing;
		const name = `__copy_${type.info.name}_${this.nextCopyId++}`;
		this.copyFnNames.set(key, name);
		this.copyFnCodes.push(this.generateCopyFn(name, type));
		return name;
	}

	private generateCopyFn(
		name: string,
		type: Type & { kind: "struct" | "enum" },
	): string {
		const subst = buildSubst(type.info.typeParams, type.typeArgs);
		if (type.kind === "struct") {
			const overrides = type.info.fields.flatMap((field) => {
				const fieldType = substitute(field.type, subst);
				if (!hasValueSemantics(fieldType)) return [];
				return [
					`${field.name}: ${this.copyCall(`v.${field.name}`, fieldType)}`,
				];
			});
			// Copies keep the instance's prototype without naming the class, so
			// copy functions stay scope-independent (they live at bundle top).
			return `const ${name} = (v) => ${this.helper("__structCopy")}(v, { ${overrides.join(", ")} });`;
		}
		const arms = type.info.cases.flatMap((c) => {
			const overrides = c.assoc.flatMap((a) => {
				const assocType = substitute(a.type, subst);
				if (!hasValueSemantics(assocType)) return [];
				return [`${a.label}: ${this.copyCall(`v.${a.label}`, assocType)}`];
			});
			if (overrides.length === 0) return [];
			return [
				`case ${JSON.stringify(c.name)}: return { ...v, ${overrides.join(", ")} };`,
			];
		});
		if (arms.length === 0) return `const ${name} = (v) => ({ ...v });`;
		return `const ${name} = (v) => { switch (v.$case) { ${arms.join(" ")} default: return { ...v }; } };`;
	}

	private copyFnRef(type: Type): string {
		switch (type.kind) {
			case "struct":
			case "enum":
				return this.copyFnFor(type);
			case "optional": {
				const helper = this.helper(
					boxedRepr(type) ? "__copyOptN" : "__copyOpt",
				);
				return `(v) => ${helper}(v, ${this.copyFnRef(type.inner)})`;
			}
			case "union": {
				const arms = type.members
					.filter((m) => hasValueSemantics(m))
					.map(
						(m) => `${this.copyPredicate(m, "v")} ? ${this.copyFnRef(m)}(v) : `,
					)
					.join("");
				return `(v) => (${arms}v)`;
			}
			default:
				throw new Error(`No copy function for ${type.kind}`);
		}
	}

	/**
	 * Discrimination predicate usable inside hoisted copy functions: struct
	 * checks use the generic instance marker instead of `instanceof`, since
	 * class names are not in scope at the bundle top.
	 */
	private copyPredicate(target: Type, ref: string): string {
		if (target.kind === "struct") {
			return `${this.helper("__isStructInst")}(${ref})`;
		}
		return this.isPredicate(target, ref);
	}

	private copyCall(code: string, type: Type): string {
		if (type.kind === "optional") {
			const helper = this.helper(boxedRepr(type) ? "__copyOptN" : "__copyOpt");
			return `${helper}(${code}, ${this.copyFnRef(type.inner)})`;
		}
		if (type.kind === "union") {
			return `(${this.copyFnRef(type)})(${code})`;
		}
		return `${this.copyFnRef(type)}(${code})`;
	}

	// ---- Statements ----

	private stmts(list: Stmt[], indent: string): string {
		return list
			.map((stmt) => this.stmt(stmt, indent))
			.filter((code) => code !== "")
			.join("\n");
	}

	private stmt(stmt: Stmt, indent: string): string {
		switch (stmt.kind) {
			case "binding":
				return `${indent}${stmt.mutable ? "let" : "const"} ${jsName(stmt.name)} = ${this.expr(stmt.init)};`;
			case "func": {
				const params = stmt.sig.params.map((p) => jsName(p.name));
				const defaults = stmt.sig.params
					.filter((p) => p.defaultValue !== undefined)
					.map(
						(p) =>
							`${indent}\tif (${jsName(p.name)} === void 0) ${jsName(p.name)} = ${this.expr(p.defaultValue as Expr)};`,
					);
				const fnKeyword = this.effects.isFnAsync(stmt)
					? "async function"
					: "function";
				return [
					`${indent}${fnKeyword} ${jsName(stmt.sig.name)}(${params.join(", ")}) {`,
					...defaults,
					this.stmts(stmt.body, `${indent}\t`),
					`${indent}}`,
				].join("\n");
			}
			case "struct":
			case "enum":
				return this.valueTypeStmt(stmt, indent);
			case "class":
				return this.classStmt(stmt, indent);
			case "protocol":
			case "use":
			case "declareFunc":
			case "declareLet":
			case "declareType":
				return "";
			case "if":
				return this.ifChain(stmt, stmt.conds, indent);
			case "guard": {
				const elseCode = this.stmts(stmt.elseBody, `${indent}\t`);
				return stmt.conds
					.map((cond) => {
						if (cond.kind === "expr") {
							return `${indent}if (!(${this.expr(cond.expr)})) {\n${elseCode}\n${indent}}`;
						}
						const tmp = `__t${this.tempId++}`;
						return [
							`${indent}const ${tmp} = ${this.expr(cond.expr)};`,
							`${indent}if (${tmp} === null || ${tmp} === undefined) {`,
							elseCode,
							`${indent}}`,
							`${indent}const ${jsName(cond.name)} = ${this.optionalBind(cond.expr, tmp)};`,
						].join("\n");
					})
					.join("\n");
			}
			case "for": {
				const body = this.stmts(stmt.body, `${indent}\t`);
				if (stmt.source.kind === "range") {
					const name =
						stmt.binding.kind === "single"
							? jsName(stmt.binding.name)
							: jsName(stmt.binding.key.name);
					const end = `__end${this.tempId++}`;
					const cmp = stmt.source.inclusive ? "<=" : "<";
					return `${indent}for (let ${name} = ${this.expr(stmt.source.from)}, ${end} = ${this.expr(stmt.source.to)}; ${name} ${cmp} ${end}; ${name}++) {\n${body}\n${indent}}`;
				}
				const source = this.expr(stmt.source.expr);
				if (stmt.binding.kind === "tuple") {
					return `${indent}for (const [${jsName(stmt.binding.key.name)}, ${jsName(stmt.binding.value.name)}] of ${source}) {\n${body}\n${indent}}`;
				}
				return `${indent}for (const ${jsName(stmt.binding.name)} of ${source}) {\n${body}\n${indent}}`;
			}
			case "while":
				return `${indent}while (${this.expr(stmt.cond)}) {\n${this.stmts(stmt.body, `${indent}\t`)}\n${indent}}`;
			case "switch":
				return this.switchStmt(stmt, indent);
			case "return":
				return stmt.value
					? `${indent}return ${this.expr(stmt.value)};`
					: `${indent}return;`;
			case "throw":
				this.helper("__thrownTag");
				return `${indent}throw ${this.helper("__throwVal")}(${this.expr(stmt.expr)});`;
			case "doCatch": {
				const tag = this.helper("__thrownTag");
				return [
					`${indent}try {`,
					this.stmts(stmt.body, `${indent}\t`),
					`${indent}} catch (__err) {`,
					`${indent}\tif (!(__err instanceof Error && ${tag} in __err)) throw __err;`,
					`${indent}\tconst ${jsName("error")} = __err[${tag}];`,
					this.stmts(stmt.catchBody, `${indent}\t`),
					`${indent}}`,
				].join("\n");
			}
			case "break":
				return `${indent}break;`;
			case "continue":
				return `${indent}continue;`;
			case "assign":
				return this.assignStmt(stmt, indent);
			case "expr":
				return `${indent}(${this.expr(stmt.expr)});`;
		}
	}

	/** The unwrapped value bound by `if let` / `guard let` for a non-nil test. */
	/**
	 * Nests one JS `if` per condition. The else body is repeated at every
	 * level because any failing condition must reach it.
	 */
	private ifChain(
		stmt: Stmt & { kind: "if" },
		conds: Condition[],
		indent: string,
	): string {
		const [cond, ...rest] = conds;
		const elseSuffix = (at: string) =>
			stmt.elseBody !== undefined
				? ` else {\n${this.stmts(stmt.elseBody, `${at}\t`)}\n${at}}`
				: "";
		const body = (at: string) =>
			rest.length === 0
				? this.stmts(stmt.thenBody, at)
				: this.ifChain(stmt, rest, at);

		if (cond.kind === "expr") {
			return `${indent}if (${this.expr(cond.expr)}) {\n${body(`${indent}\t`)}\n${indent}}${elseSuffix(indent)}`;
		}
		const tmp = `__t${this.tempId++}`;
		return [
			`${indent}{`,
			`${indent}\tconst ${tmp} = ${this.expr(cond.expr)};`,
			`${indent}\tif (${tmp} !== null && ${tmp} !== undefined) {`,
			`${indent}\t\tconst ${jsName(cond.name)} = ${this.optionalBind(cond.expr, tmp)};`,
			body(`${indent}\t\t`),
			`${indent}\t}${elseSuffix(`${indent}\t`)}`,
			`${indent}}`,
		].join("\n");
	}

	private optionalBind(cond: Expr, tmp: string): string {
		const type = this.check.types.get(cond);
		return type !== undefined && boxedRepr(type) ? `${tmp}.$some` : tmp;
	}

	/** A local or cross-module reference to a class / method function. */
	private ownedRef(
		localJsName: string,
		exportKey: string,
		moduleName: string | null,
	): string {
		if (moduleName === null || moduleName === this.currentModule) {
			return localJsName;
		}
		return moduleRef(moduleName, exportKey);
	}

	private methodParamPrologue(
		method: { sig: { params: { name: string; defaultValue?: Expr }[] } },
		indent: string,
	): string[] {
		return method.sig.params
			.filter((p) => p.defaultValue !== undefined)
			.map(
				(p) =>
					`${indent}if (${jsName(p.name)} === void 0) ${jsName(p.name)} = ${this.expr(p.defaultValue as Expr)};`,
			);
	}

	/** Structs compile to JS classes; enum methods are free functions. */
	private valueTypeStmt(
		stmt: Stmt & { kind: "struct" | "enum" },
		indent: string,
	): string {
		if (stmt.kind === "struct") return this.structStmt(stmt, indent);
		return stmt.methods
			.map((method: MethodDecl) => {
				const params = [
					"self",
					...method.sig.params.map((p) => jsName(p.name)),
				];
				const asyncPrefix = this.effects.isValueMethodAsync(method)
					? "async "
					: "";
				return [
					`${indent}const __sm_${stmt.name}_${method.sig.name} = ${asyncPrefix}(${params.join(", ")}) => {`,
					...this.methodParamPrologue(method, `${indent}\t`),
					this.stmts(method.body, `${indent}\t`),
					`${indent}};`,
				]
					.filter((line) => line !== "")
					.join("\n");
			})
			.join("\n");
	}

	/**
	 * A struct is a JS class with a positional memberwise constructor. The
	 * symbol-keyed `[__syrupStruct]` marker (the AsyncFunction parameter
	 * carrying the symbol from emit/runtime.ts) lets the runtime tell struct
	 * instances (value data, may cross the worker boundary) from reference
	 * class instances.
	 */
	private structStmt(stmt: Stmt & { kind: "struct" }, indent: string): string {
		const params = stmt.fields.map((f) => jsName(f.name));
		const lines = [
			`${indent}class ${jsName(stmt.name)} {`,
			`${indent}\tstatic [__syrupStruct] = true;`,
			`${indent}\tconstructor(${params.join(", ")}) {`,
		];
		for (const field of stmt.fields) {
			if (field.defaultValue) {
				lines.push(
					`${indent}\t\tif (${jsName(field.name)} === void 0) ${jsName(field.name)} = ${this.expr(field.defaultValue)};`,
				);
			}
			lines.push(
				`${indent}\t\tthis[${JSON.stringify(field.name)}] = ${jsName(field.name)};`,
			);
		}
		lines.push(`${indent}\t}`);
		for (const method of stmt.methods) {
			const methodParams = method.sig.params
				.map((p) => jsName(p.name))
				.join(", ");
			const prefix = this.effects.isValueMethodAsync(method) ? "async " : "";
			lines.push(
				`${indent}\t${prefix}${jsName(method.sig.name)}(${methodParams}) {`,
				`${indent}\t\tconst self = this;`,
			);
			lines.push(...this.methodParamPrologue(method, `${indent}\t\t`));
			const body = this.stmts(method.body, `${indent}\t\t`);
			if (body !== "") lines.push(body);
			lines.push(`${indent}\t}`);
		}
		lines.push(`${indent}}`);
		return lines.join("\n");
	}

	private classStmt(stmt: Stmt & { kind: "class" }, indent: string): string {
		const info = this.check.classInfos.get(stmt);
		if (!info) throw new Error(`Unresolved class '${stmt.name}'`);
		const ext = info.superclass
			? ` extends ${this.ownedRef(
					jsName(info.superclass.info.name),
					info.superclass.info.name,
					info.superclass.info.moduleName,
				)}`
			: "";
		const lines = [`${indent}class ${jsName(stmt.name)}${ext} {`];
		const init = stmt.inits[0];
		const native = this.effects.usesNativeConstructor(info);
		const initAsync = init ? this.effects.isInitAsync(init) : false;
		const initParams = (init?.params ?? []).map((p) => jsName(p.name));
		const initDefaults = (init?.params ?? [])
			.filter((p) => p.defaultValue !== undefined)
			.map(
				(p) =>
					`${indent}\t\tif (${jsName(p.name)} === void 0) ${jsName(p.name)} = ${this.expr(p.defaultValue as Expr)};`,
			);
		const fieldDefaults = stmt.fields
			.filter((f) => f.defaultValue !== undefined)
			.map(
				(f) =>
					`${indent}\t\tself.${f.name} = ${this.expr(f.defaultValue as Expr)};`,
			);
		if (native) {
			lines.push(`${indent}\tconstructor(${initParams.join(", ")}) {`);
			if (info.superclass && init) {
				// JS requires super() before any `this` access; the checker
				// guarantees no `self`/`super` use before `super.init(...)`.
				const superIndex = init.body.findIndex(isSuperInitStmt);
				const savedNative = this.nativeSuperInit;
				this.nativeSuperInit = true;
				const preSuper = this.stmts(
					init.body.slice(0, superIndex + 1),
					`${indent}\t\t`,
				);
				this.nativeSuperInit = savedNative;
				lines.push(...initDefaults);
				if (preSuper !== "") lines.push(preSuper);
				lines.push(`${indent}\t\tconst self = this;`, ...fieldDefaults);
				const rest = this.stmts(
					init.body.slice(superIndex + 1),
					`${indent}\t\t`,
				);
				if (rest !== "") lines.push(rest);
			} else {
				lines.push(`${indent}\t\tconst self = this;`);
				lines.push(...initDefaults, ...fieldDefaults);
				if (init) {
					const body = this.stmts(init.body, `${indent}\t\t`);
					if (body !== "") lines.push(body);
				}
			}
			lines.push(`${indent}\t}`);
		} else {
			lines.push(
				`${indent}\t${initAsync ? "async " : ""}__init(${initParams.join(", ")}) {`,
				`${indent}\t\tconst self = this;`,
			);
			lines.push(...initDefaults, ...fieldDefaults);
			if (init) {
				const body = this.stmts(init.body, `${indent}\t\t`);
				if (body !== "") lines.push(body);
			}
			lines.push(`${indent}\t}`);
		}
		for (const method of stmt.methods) {
			const params = method.sig.params.map((p) => jsName(p.name)).join(", ");
			const prefix = this.effects.isClassMethodAsync(method) ? "async " : "";
			lines.push(
				`${indent}\t${prefix}${jsName(method.sig.name)}(${params}) {`,
				`${indent}\t\tconst self = this;`,
			);
			lines.push(...this.methodParamPrologue(method, `${indent}\t\t`));
			const body = this.stmts(method.body, `${indent}\t\t`);
			if (body !== "") lines.push(body);
			lines.push(`${indent}\t}`);
		}
		if (!native) {
			lines.push(
				`${indent}\tstatic ${initAsync ? "async " : ""}__create(...__args) {`,
				`${indent}\t\tconst __inst = new this();`,
				`${indent}\t\t${initAsync ? "await " : ""}__inst.__init(...__args);`,
				`${indent}\t\treturn __inst;`,
				`${indent}\t}`,
			);
		}
		lines.push(`${indent}}`);
		return lines.join("\n");
	}

	private assignStmt(stmt: Stmt & { kind: "assign" }, indent: string): string {
		const value = this.expr(stmt.value);
		if (stmt.target.kind === "subscript") {
			const objType = this.check.types.get(stmt.target.object);
			const obj = this.expr(stmt.target.object);
			const index = this.expr(stmt.target.index);
			if (objType?.kind === "dictionary") {
				return `${indent}${obj}.set(${index}, ${value});`;
			}
			if (stmt.op === "=") {
				return `${indent}${this.helper("__idxSet")}(${obj}, ${index}, ${value});`;
			}
			const arr = `__a${this.tempId++}`;
			const idx = `__i${this.tempId++}`;
			const op = stmt.op.slice(0, 1);
			return `${indent}{ const ${arr} = ${obj}; const ${idx} = ${index}; ${this.helper("__idxSet")}(${arr}, ${idx}, ${this.helper("__idx")}(${arr}, ${idx}) ${op} ${value}); }`;
		}
		if (stmt.target.kind === "member") {
			const objType = this.check.types.get(stmt.target.object);
			if (objType?.kind === "host") {
				const obj = this.expr(stmt.target.object);
				const propName = JSON.stringify(stmt.target.name);
				if (stmt.op === "=") {
					return `${indent}await __host.setProp(${obj}, ${propName}, ${value});`;
				}
				const tmp = `__o${this.tempId++}`;
				const op = stmt.op.slice(0, 1);
				return `${indent}{ const ${tmp} = ${obj}; await __host.setProp(${tmp}, ${propName}, (await __host.prop(${tmp}, ${propName})) ${op} ${value}); }`;
			}
		}
		return `${indent}${this.expr(stmt.target)} ${stmt.op} ${value};`;
	}

	/**
	 * Switches are emitted as if/else chains: JS `switch` would capture
	 * Syrup `break` statements that target an enclosing loop.
	 */
	private switchStmt(stmt: Stmt & { kind: "switch" }, indent: string): string {
		const subjectType = this.check.types.get(stmt.subject);
		const tmp = `__t${this.tempId++}`;
		const lines = [
			`${indent}{`,
			`${indent}\tconst ${tmp} = ${this.expr(stmt.subject)};`,
		];
		let defaultCase: SwitchCase | null = null;
		const branches: { cond: string; prelude: string[]; body: string }[] = [];
		for (const switchCase of stmt.cases) {
			if (switchCase.pattern === "default") {
				defaultCase = switchCase;
				continue;
			}
			const prelude: string[] = [];
			let cond: string;
			if (switchCase.pattern.kind === "case") {
				cond = `${tmp}.$case === ${JSON.stringify(switchCase.pattern.name)}`;
				if (subjectType?.kind === "enum") {
					const patternName = switchCase.pattern.name;
					const caseInfo = subjectType.info.cases.find(
						(c) => c.name === patternName,
					);
					const bindCoercions = this.check.patternBindCoercions.get(
						switchCase.pattern,
					);
					for (const [i, binding] of switchCase.pattern.bindings.entries()) {
						const label = caseInfo?.assoc[i]?.label;
						if (label !== undefined) {
							const co = bindCoercions?.[i] ?? null;
							const value =
								co === null
									? `${tmp}.${label}`
									: this.coerce(`${tmp}.${label}`, co);
							prelude.push(`const ${jsName(binding.name)} = ${value};`);
						}
					}
				}
			} else if (switchCase.pattern.kind === "typePattern") {
				const target = this.check.patternTypes.get(switchCase.pattern);
				cond = target ? this.isPredicate(target, tmp) : "false";
			} else {
				cond = `${tmp} === ${JSON.stringify(switchCase.pattern.value)}`;
			}
			branches.push({
				cond,
				prelude,
				body: this.stmts(switchCase.body, `${indent}\t\t`),
			});
		}
		for (const [i, branch] of branches.entries()) {
			lines.push(
				`${indent}\t${i === 0 ? "if" : "} else if"} (${branch.cond}) {`,
			);
			for (const line of branch.prelude) lines.push(`${indent}\t\t${line}`);
			if (branch.body !== "") lines.push(branch.body);
		}
		if (defaultCase) {
			lines.push(branches.length > 0 ? `${indent}\t} else {` : `${indent}\t{`);
			const body = this.stmts(defaultCase.body, `${indent}\t\t`);
			if (body !== "") lines.push(body);
		}
		if (branches.length > 0 || defaultCase) {
			lines.push(`${indent}\t}`);
		}
		lines.push(`${indent}}`);
		return lines.join("\n");
	}

	// ---- Expressions ----

	private expr(node: Expr): string {
		let code = this.rawExpr(node);
		const mark = this.check.coercions.get(node);
		if (mark?.pre) code = this.coerce(code, mark.pre);
		if (this.check.copies.has(node)) {
			const type = this.check.types.get(node);
			if (type !== undefined) code = this.copyCall(code, type);
		}
		if (mark?.post) code = this.coerce(code, mark.post);
		return code;
	}

	// ---- Nested-optional representation coercions ----

	private coerce(code: string, co: Coercion): string {
		if (co.kind === "wrap") {
			let out = code;
			for (let i = 0; i < co.count; i++) out = `({ $some: ${out} })`;
			return out;
		}
		if (co.kind === "seq") {
			return co.list.reduce((acc, c) => this.coerce(acc, c), code);
		}
		return `(${this.coercionFn(co)})(${code})`;
	}

	/** An arrow-function expression applying the coercion to its argument. */
	private coercionFn(co: Coercion): string {
		switch (co.kind) {
			case "wrap": {
				let out = "__v";
				for (let i = 0; i < co.count; i++) out = `({ $some: ${out} })`;
				return `(__v) => ${out}`;
			}
			case "box": {
				const inner = co.inner ? `(${this.coercionFn(co.inner)})(__v)` : "__v";
				return `(__v) => __v == null ? null : ({ $some: ${inner} })`;
			}
			case "unbox": {
				const inner = co.inner
					? `(${this.coercionFn(co.inner)})(__v.$some)`
					: "__v.$some";
				return `(__v) => __v == null ? null : ${inner}`;
			}
			case "opt": {
				return co.boxed
					? `(__v) => __v == null ? null : ({ $some: (${this.coercionFn(co.inner)})(__v.$some) })`
					: `(__v) => __v == null ? null : (${this.coercionFn(co.inner)})(__v)`;
			}
			case "func": {
				const params = co.params.map((_, i) => `__p${i}`);
				const argExprs = co.params.map((p, i) =>
					p ? `(${this.coercionFn(p)})(__p${i})` : `__p${i}`,
				);
				const call = `__f(${argExprs.join(", ")})`;
				const body = co.ret ? `(${this.coercionFn(co.ret)})(${call})` : call;
				return `(__f) => (${params.join(", ")}) => ${body}`;
			}
			case "seq": {
				const applied = co.list.reduce(
					(acc, c) => `(${this.coercionFn(c)})(${acc})`,
					"__v",
				);
				return `(__v) => ${applied}`;
			}
		}
	}

	private isChained(node: Expr): boolean {
		return (
			(node.kind === "member" && node.optional) ||
			this.check.chainOptional.has(node)
		);
	}

	private rawExpr(node: Expr): string {
		switch (node.kind) {
			case "number":
				return String(node.value);
			case "bool":
				return String(node.value);
			case "nil":
				return "null";
			case "string": {
				const body = node.parts
					.map((part) => {
						if (part.kind === "text") {
							return part.value
								.replaceAll("\\", "\\\\")
								.replaceAll("`", "\\`")
								.replaceAll("${", "\\${");
						}
						const partType = this.check.types.get(part.expr);
						const code =
							partType !== undefined && boxedRepr(partType)
								? `${this.helper("__optStr")}(${this.expr(part.expr)})`
								: this.expr(part.expr);
						return `\${${code}}`;
					})
					.join("");
				return `\`${body}\``;
			}
			case "ident": {
				const resolution = this.check.resolutions.get(node);
				if (resolution?.kind === "packageMember") {
					return `(await __host.get(${JSON.stringify(resolution.packageName)}, ${JSON.stringify(resolution.memberName)}))`;
				}
				if (resolution?.kind === "moduleMember") {
					return moduleRef(resolution.moduleName, resolution.memberName);
				}
				return jsName(node.name);
			}
			case "dollar":
				return `$${node.index}`;
			case "array":
				return `[${node.elements.map((e) => this.expr(e)).join(", ")}]`;
			case "dict": {
				const entries = node.entries
					.map((e) => `[${this.expr(e.key)}, ${this.expr(e.value)}]`)
					.join(", ");
				return `new Map([${entries}])`;
			}
			case "await":
				// The surface keyword is a checked marker; actual awaits are
				// emitted at every async boundary (calls). The operand goes
				// through expr() so its copy/coercion marks apply.
				return this.expr(node.operand);
			case "try":
				// Checked marker only: throwing calls need no wrapper in JS.
				return this.expr(node.operand);
			case "superRef":
				throw new Error("Unexpected bare 'super'");
			case "is": {
				const resolution = this.check.resolutions.get(node);
				if (resolution?.kind !== "isCheck") {
					throw new Error("Unresolved is-check");
				}
				return `((__c) => ${this.isPredicate(resolution.target, "__c")})(${this.expr(node.operand)})`;
			}
			case "doExpr": {
				// The body runs inline via an IIFE; it is async (and awaited)
				// when any call inside is awaited per the effect analysis.
				const needsAwait = this.doExprAwaits(node);
				const awaitPrefix = needsAwait ? "await " : "";
				const asyncPrefix = needsAwait ? "async " : "";
				if (node.catchBody === undefined) {
					return `(${awaitPrefix}(${asyncPrefix}() => {\n${this.doBody(node.body, "\t")}\n})())`;
				}
				const tag = this.helper("__thrownTag");
				return [
					`(${awaitPrefix}(${asyncPrefix}() => {`,
					`\ttry {`,
					this.doBody(node.body, "\t\t"),
					`\t} catch (__err) {`,
					`\t\tif (!(__err instanceof Error && ${tag} in __err)) throw __err;`,
					`\t\tconst ${jsName("error")} = __err[${tag}];`,
					this.doBody(node.catchBody, "\t\t"),
					`\t}`,
					`})())`,
				].join("\n");
			}
			case "closure": {
				const resolution = this.check.resolutions.get(node);
				if (resolution?.kind !== "closure") {
					throw new Error("Unresolved closure");
				}
				const asyncPrefix = this.effects.isClosureAsync(node) ? "async " : "";
				const params = resolution.paramNames.map(jsName).join(", ");
				const single = node.body.length === 1 ? node.body[0] : undefined;
				if (resolution.implicitReturn && single?.kind === "expr") {
					return `(${asyncPrefix}(${params}) => (${this.expr(single.expr)}))`;
				}
				return `(${asyncPrefix}(${params}) => {\n${this.stmts(node.body, "\t")}\n})`;
			}
			case "call":
				return this.call(node);
			case "member":
				return this.member(node);
			case "subscript": {
				const objType = this.check.types.get(node.object);
				const dictType =
					objType?.kind === "dictionary"
						? objType
						: objType?.kind === "optional" &&
								objType.inner.kind === "dictionary"
							? objType.inner
							: null;
				const index = this.expr(node.index);
				const mapped = (ref: string): string => {
					if (dictType === null)
						return `${this.helper("__idx")}(${ref}, ${index})`;
					// Exhaustive-key dictionaries always contain every key.
					if (stringLiteralMembers(dictType.key) !== null) {
						return `${ref}.get(${index})`;
					}
					// Optional values need the boxed read: a stored nil must stay
					// distinct from a missing key.
					const nested =
						dictType.value.kind === "optional" ||
						dictType.value.kind === "typeParam";
					return nested
						? `${this.helper("__dictGetN")}(${ref}, ${index})`
						: `(${ref}.get(${index}) ?? null)`;
				};
				if (this.isChained(node)) {
					return `${this.helper("__chain")}(${this.expr(node.object)}, (v) => ${mapped("v")})`;
				}
				return mapped(this.expr(node.object));
			}
			case "force": {
				const operandType = this.check.types.get(node.operand);
				const forceHelper =
					operandType !== undefined && boxedRepr(operandType)
						? "__forceN"
						: "__force";
				return `${this.helper(forceHelper)}(${this.expr(node.operand)})`;
			}
			case "unary":
				return `(${node.op}${this.expr(node.operand)})`;
			case "binary": {
				if (node.op === "??") {
					const leftType = this.check.types.get(node.left);
					if (leftType !== undefined && boxedRepr(leftType)) {
						// The right side stays lazy inside the arrow; when it
						// contains awaited calls the arrow itself is awaited.
						const isAsync = this.exprHasAwaitedCall(node.right);
						const arrow = `(${isAsync ? "async " : ""}(__v) => __v == null ? ${this.expr(node.right)} : __v.$some)(${this.expr(node.left)})`;
						return isAsync ? `(await ${arrow})` : `(${arrow})`;
					}
				}
				const op =
					node.op === "==" ? "===" : node.op === "!=" ? "!==" : node.op;
				return `(${this.expr(node.left)} ${op} ${this.expr(node.right)})`;
			}
			case "ternary":
				return `(${this.expr(node.cond)} ? ${this.expr(node.thenExpr)} : ${this.expr(node.elseExpr)})`;
		}
	}

	private member(node: Expr & { kind: "member" }): string {
		const resolution = this.check.resolutions.get(node);
		if (resolution?.kind === "packageMember") {
			return `(await __host.get(${JSON.stringify(resolution.packageName)}, ${JSON.stringify(resolution.memberName)}))`;
		}
		if (resolution?.kind === "moduleMember") {
			return moduleRef(resolution.moduleName, resolution.memberName);
		}
		if (resolution?.kind === "enumCase") {
			return `({ $case: ${JSON.stringify(resolution.caseName)} })`;
		}
		const chained = this.isChained(node);
		if (resolution?.kind === "builtinProp") {
			const nodeType = this.check.types.get(node);
			const nested = nodeType !== undefined && boxedRepr(nodeType);
			const mapped = (ref: string): string =>
				this.builtinProp(resolution.receiver, resolution.name, ref, nested);
			if (chained) {
				return `${this.helper("__chain")}(${this.expr(node.object)}, (v) => ${mapped("v")})`;
			}
			return mapped(this.expr(node.object));
		}
		const objType = this.check.types.get(node.object);
		const baseIsHost =
			objType?.kind === "host" ||
			(objType?.kind === "optional" && objType.inner.kind === "host");
		if (baseIsHost) {
			// __host.prop propagates null targets, covering `?.` chains.
			return `(await __host.prop(${this.expr(node.object)}, ${JSON.stringify(node.name)}))`;
		}
		return `${this.expr(node.object)}${chained ? "?." : "."}${node.name}`;
	}

	private builtinProp(
		receiver: "array" | "string" | "dictionary",
		name: string,
		ref: string,
		nested: boolean,
	): string {
		if (receiver === "dictionary") {
			switch (name) {
				case "count":
					return `${ref}.size`;
				case "isEmpty":
					return `(${ref}.size === 0)`;
				case "keys":
					return `[...${ref}.keys()]`;
				case "values":
					return `[...${ref}.values()]`;
				default:
					throw new Error(`Unknown dictionary prop '${name}'`);
			}
		}
		switch (name) {
			case "count":
				return `${ref}.length`;
			case "isEmpty":
				return `(${ref}.length === 0)`;
			case "first":
				return `${this.helper(nested ? "__firstN" : "__first")}(${ref})`;
			case "last":
				return `${this.helper(nested ? "__lastN" : "__last")}(${ref})`;
			default:
				throw new Error(`Unknown builtin prop '${name}'`);
		}
	}

	private call(node: Expr & { kind: "call" }): string {
		const callee = node.callee;
		const plan = this.check.callPlans.get(node);
		const argCodes = this.plannedArgs(node, plan);
		const calleeResolution = this.check.resolutions.get(callee);
		if (calleeResolution?.kind === "structInit") {
			const info = calleeResolution.info;
			const ref = this.ownedRef(jsName(info.name), info.name, info.moduleName);
			return `(new ${ref}(${argCodes.join(", ")}))`;
		}
		if (calleeResolution?.kind === "enumCase" && callee.kind === "member") {
			const caseInfo = calleeResolution.info.cases.find(
				(c) => c.name === calleeResolution.caseName,
			);
			const fields = [
				`$case: ${JSON.stringify(calleeResolution.caseName)}`,
				...(caseInfo?.assoc.map(
					(a, i) => `[${JSON.stringify(a.label)}]: ${argCodes[i] ?? "void 0"}`,
				) ?? []),
			];
			return `({ ${fields.join(", ")} })`;
		}
		if (
			calleeResolution?.kind === "builtinMethod" &&
			callee.kind === "member"
		) {
			const hofSync = this.effects.isHofSync(node);
			const nodeType = this.check.types.get(node);
			const nested = nodeType !== undefined && boxedRepr(nodeType);
			// Helpers never embed `await`; this wrapper decides it once, so
			// chained calls stay valid inside the sync `__chain` arrow.
			const mapped = (ref: string): string =>
				this.builtinMethodCall(
					calleeResolution.receiver,
					calleeResolution.name,
					ref,
					argCodes,
					hofSync,
					nested,
				);
			const code = this.isChained(callee)
				? `${this.helper("__chain")}(${this.expr(callee.object)}, (v) => ${mapped("v")})`
				: mapped(this.expr(callee.object));
			return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
		}
		if (calleeResolution?.kind === "classInit") {
			const info = calleeResolution.info;
			const ref = this.ownedRef(jsName(info.name), info.name, info.moduleName);
			const code = this.effects.usesNativeConstructor(info)
				? `new ${ref}(${argCodes.join(", ")})`
				: `${ref}.__create(${argCodes.join(", ")})`;
			return this.effects.isCallAwaited(node) ? `(await ${code})` : `(${code})`;
		}
		if (calleeResolution?.kind === "classMethod" && callee.kind === "member") {
			const chain = this.isChained(callee) ? "?." : ".";
			const code = `${this.expr(callee.object)}${chain}${jsName(calleeResolution.name)}(${argCodes.join(", ")})`;
			return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
		}
		if (calleeResolution?.kind === "valueMethod" && callee.kind === "member") {
			let receiver = this.check.types.get(callee.object);
			if (receiver?.kind === "optional") receiver = receiver.inner;
			if (receiver?.kind === "struct") {
				const chain = this.isChained(callee) ? "?." : ".";
				const code = `${this.expr(callee.object)}${chain}${jsName(calleeResolution.name)}(${argCodes.join(", ")})`;
				return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
			}
			const fnName = `__sm_${calleeResolution.ownerName}_${calleeResolution.name}`;
			const ref = this.ownedRef(fnName, fnName, calleeResolution.moduleName);
			const args = [this.expr(callee.object), ...argCodes];
			const code = `${ref}(${args.join(", ")})`;
			return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
		}
		if (calleeResolution?.kind === "superInit") {
			if (this.nativeSuperInit) return `super(${argCodes.join(", ")})`;
			const code = `super.__init(${argCodes.join(", ")})`;
			return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
		}
		if (calleeResolution?.kind === "superMethod") {
			const code = `super.${jsName(calleeResolution.name)}(${argCodes.join(", ")})`;
			return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
		}
		if (calleeResolution?.kind === "hostMethod" && callee.kind === "member") {
			const obj = this.expr(callee.object);
			const code = `(await __host.method(${obj}, ${JSON.stringify(callee.name)}, [${argCodes.join(", ")}]))`;
			return this.normalizeHostResult(node, code);
		}
		if (calleeResolution?.kind === "packageMember") {
			const code = `(await __host.call(${JSON.stringify(calleeResolution.packageName)}, ${JSON.stringify(calleeResolution.memberName)}, [${argCodes.join(", ")}]))`;
			return this.normalizeHostResult(node, code);
		}
		const code = `${this.expr(callee)}(${argCodes.join(", ")})`;
		return this.effects.isCallAwaited(node) ? `(await ${code})` : code;
	}

	/** Host functions may return undefined for nil; normalize optionals to null. */
	private normalizeHostResult(node: Expr, code: string): string {
		const type = this.check.types.get(node);
		if (type?.kind === "optional") return `((${code}) ?? null)`;
		return code;
	}

	private builtinMethodCall(
		receiver: "array" | "string" | "dictionary",
		name: string,
		ref: string,
		args: string[],
		hofSync: boolean,
		nested: boolean,
	): string {
		if (receiver === "dictionary") {
			if (name === "removeValue")
				return `${this.helper(nested ? "__dictRemoveN" : "__dictRemove")}(${ref}, ${args[0]})`;
			throw new Error(`Unknown dictionary method '${name}'`);
		}
		switch (name) {
			case "append":
				return `(void ${ref}.push(${args[0]}))`;
			case "insert":
				return `(void ${ref}.splice(${args[1]}, 0, ${args[0]}))`;
			case "remove":
				return `${ref}.splice(${args[0]}, 1)[0]`;
			case "contains":
				return `${ref}.includes(${args[0]})`;
			case "map":
				return `${this.helper(hofSync ? "__arrMapS" : "__arrMap")}(${ref}, ${args[0]})`;
			case "filter":
				return `${this.helper(hofSync ? "__arrFilterS" : "__arrFilter")}(${ref}, ${args[0]})`;
			case "reduce":
				return `${this.helper(hofSync ? "__arrReduceS" : "__arrReduce")}(${ref}, ${args[0]}, ${args[1]})`;
			case "sorted":
				return `${this.helper(hofSync ? "__sortedS" : "__sorted")}(${ref}, ${args[0]})`;
			case "uppercased":
				return `${ref}.toUpperCase()`;
			case "lowercased":
				return `${ref}.toLowerCase()`;
			case "hasPrefix":
				return `${ref}.startsWith(${args[0]})`;
			case "hasSuffix":
				return `${ref}.endsWith(${args[0]})`;
			case "split":
				return `${ref}.split(${args[0]})`;
			default:
				throw new Error(`Unknown builtin method '${name}'`);
		}
	}

	private plannedArgs(
		node: Expr & { kind: "call" },
		plan: CallPlan | undefined,
	): string[] {
		if (!plan) {
			return node.args.map((arg) => this.expr(arg.expr));
		}
		const codes = plan.ordered.map((entry) =>
			entry.kind === "arg"
				? this.expr(node.args[entry.argIndex].expr)
				: "void 0",
		);
		while (codes.length > 0 && codes.at(-1) === "void 0") codes.pop();
		return codes;
	}
}

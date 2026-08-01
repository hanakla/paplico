import type {
	Condition,
	Diagnostic,
	Expr,
	ForBinding,
	FuncSig,
	InitDecl,
	MethodDecl,
	Pattern,
	Program,
	Span,
	Stmt,
	TypeNode,
	TypeParamDecl,
} from "../syntax/ast";
import {
	getArrayMember,
	getDictionaryMember,
	getStringMember,
} from "./builtins";
import {
	type Coercion,
	type CoercionMark,
	type CoercionResult,
	genericCoercion,
	hostCoercion,
	seqCoercion,
} from "./coercions";
import { Scope, type TypeSymbol, type ValueSymbol } from "./scope";
import {
	arrayOf,
	BOOL,
	boxedRepr,
	type ClassInfo,
	dictionaryOf,
	type EnumInfo,
	ERROR,
	type FuncType,
	type HostTypeInfo,
	hasValueSemantics,
	literalBase,
	literalOf,
	NUMBER,
	optionalDepth,
	optionalOf,
	type ProtocolInfo,
	STRING,
	type StructInfo,
	stringLiteralMembers,
	type Type,
	type TypeParamInfo,
	typeEquals,
	typeToString,
	type UnionType,
	unionOf,
	VOID,
} from "./types";
import {
	buildSubst,
	instantiatedSuperclass,
	type Substitution,
	substitute,
	typeConforms,
	unify,
	unsolvedParams,
} from "./unify";

export type Resolution =
	| { kind: "local" }
	| { kind: "packageRef"; packageName: string }
	| { kind: "packageMember"; packageName: string; memberName: string }
	| { kind: "moduleMember"; moduleName: string; memberName: string }
	| { kind: "structInit"; info: StructInfo }
	| { kind: "enumCase"; info: EnumInfo; caseName: string }
	| {
			kind: "builtinMethod";
			receiver: "array" | "string" | "dictionary";
			name: string;
	  }
	| {
			kind: "builtinProp";
			receiver: "array" | "string" | "dictionary";
			name: string;
	  }
	| { kind: "hostMethod"; name: string }
	| { kind: "closure"; paramNames: string[]; implicitReturn: boolean }
	| { kind: "typeRef" }
	| { kind: "isCheck"; target: Type }
	| { kind: "classInit"; info: ClassInfo }
	| { kind: "classMethod"; name: string }
	| {
			kind: "valueMethod";
			ownerName: string;
			moduleName: string | null;
			name: string;
	  }
	| { kind: "superInit" }
	| { kind: "superMethod"; name: string };

export interface CallPlan {
	ordered: ({ kind: "arg"; argIndex: number } | { kind: "omitted" })[];
}

/**
 * The declared (pre-substitution) signature behind a call, for boundary
 * coercions. `baseSubst` carries receiver type arguments applied before
 * per-call solving; the convention picks the callee-side representation.
 */
interface CallBoundary {
	declared: FuncType;
	baseSubst: Substitution;
	convention: "uniform" | "host";
}

const EMPTY_SUBST: Substitution = new Map();

export interface PackageEnv {
	name: string;
	expose: "namespace" | "global";
	members: Map<string, ValueSymbol | TypeSymbol>;
}

/** Exports of a compiled Syrup module, consumable by importers. */
export interface ModuleExports {
	name: string;
	members: Map<string, ValueSymbol | TypeSymbol>;
}

export interface CheckOptions {
	mode?: "script" | "module";
	moduleName?: string;
	/** Exports of every module this program may import (resolved by the host). */
	imports?: ModuleExports[];
}

export interface HoverEntry {
	span: Span;
	text: string;
}

export interface ScopeRecord {
	span: Span;
	scope: Scope;
}

export interface CheckResult {
	diagnostics: Diagnostic[];
	types: Map<Expr, Type>;
	resolutions: Map<Expr, Resolution>;
	callPlans: Map<Expr, CallPlan>;
	copies: Set<Expr>;
	/** Nested-optional representation conversions per expression. */
	coercions: Map<Expr, CoercionMark>;
	/** Per-binding conversions for enum case pattern bindings. */
	patternBindCoercions: Map<Pattern, (Coercion | null)[]>;
	/** Nodes whose optionality comes from `?.` chaining (emit null-safe ops). */
	chainOptional: Set<Expr>;
	/** Resolved target types of `case is T` patterns (for the emitter). */
	patternTypes: Map<Pattern, Type>;
	/** Class declaration statements resolved to their infos (for the emitter). */
	classInfos: Map<Stmt, ClassInfo>;
	hovers: HoverEntry[];
	scopeRecords: ScopeRecord[];
	/** Exported members (module mode only; empty for scripts). */
	moduleExports: Map<string, ValueSymbol | TypeSymbol>;
	/** Names of exported values, in declaration order (for the emitter). */
	exportedValueNames: string[];
}

export function checkProgram(
	ast: Program,
	packages: PackageEnv[] = [],
	options: CheckOptions = {},
): CheckResult {
	return new Checker(packages, options).run(ast);
}

/**
 * Check a `declare`-only program (host package declarations) and produce its
 * exported symbol table. `externalTypes` are type symbols visible from other
 * already-registered packages.
 */
export function checkDeclarations(
	ast: Program,
	packageName: string,
	externalTypes: Map<string, TypeSymbol> = new Map(),
): {
	members: Map<string, ValueSymbol | TypeSymbol>;
	diagnostics: Diagnostic[];
} {
	return new Checker([], {}).runDeclarations(ast, packageName, externalTypes);
}

type FuncContext = {
	ret: Type | "infer";
	inferred?: Type;
};

class Checker {
	private diagnostics: Diagnostic[] = [];
	private types = new Map<Expr, Type>();
	private resolutions = new Map<Expr, Resolution>();
	private callPlans = new Map<Expr, CallPlan>();
	private copies = new Set<Expr>();
	private coercions = new Map<Expr, CoercionMark>();
	private patternBindCoercions = new Map<Pattern, (Coercion | null)[]>();
	private hovers: HoverEntry[] = [];
	private scopeRecords: ScopeRecord[] = [];
	private moduleExportsMap = new Map<string, ValueSymbol | TypeSymbol>();
	private exportedValueNames: string[] = [];

	private scope: Scope;
	private typeParamsStack: TypeParamInfo[][] = [];
	private funcStack: FuncContext[] = [];
	private dollarStack: (Type[] | null)[] = [];
	/** await permission per function nesting level (top level allows await). */
	private asyncAllowedStack: boolean[] = [true];
	/**
	 * Whether a throwing action (throw / try call) is handled here: inside a
	 * `do` body or a `throws` function. Top-level code may throw (aborts).
	 */
	private throwsAllowedStack: boolean[] = [true];
	private tryDepth = 0;
	private throwingCallsSeen = 0;
	private awaitDepth = 0;
	private asyncCallsSeen = 0;
	private loopDepth = 0;
	private nextParamId = 1;
	/** Nodes whose optionality came from `?.` chaining (JS auto-propagates). */
	private chainOptional = new Set<Expr>();
	private patternTypes = new Map<Pattern, Type>();
	private classInfos = new Map<Stmt, ClassInfo>();
	/** Innermost class whose init/method body is being checked. */
	private classCtx: {
		instance: Type & { kind: "class" };
		inInit: boolean;
	}[] = [];

	public constructor(
		packages: PackageEnv[],
		private options: CheckOptions,
	) {
		// Packages live in an outer scope so script top-level declarations
		// can shadow them (see "Global namespace and scoping" in the spec).
		const packageScope = new Scope(null, "global");
		for (const pkg of packages) {
			// Type names are always global (type annotations have no dotted form).
			for (const member of pkg.members.values()) {
				if (member.kind === "type") packageScope.declare(member);
			}
			if (pkg.expose === "global") {
				for (const member of pkg.members.values()) {
					if (member.kind === "value") packageScope.declare(member);
				}
			} else {
				packageScope.declare({
					kind: "package",
					name: pkg.name,
					runtime: "package",
					members: pkg.members,
				});
			}
		}
		this.scope = new Scope(packageScope, "global");
	}

	public run(ast: Program): CheckResult {
		const programSpan = spanOfStmts(ast) ?? { start: 0, end: 0 };
		this.scopeRecords.push({ span: programSpan, scope: this.scope });
		this.declareImports(ast);
		this.hoistTypes(ast);
		this.hoistFuncs(ast);
		for (const stmt of ast) this.checkStmt(stmt);
		if (this.options.mode === "module") this.collectExports(ast);
		return this.result();
	}

	private declareImports(ast: Program): void {
		const provided = new Map(
			(this.options.imports ?? []).map((m) => [m.name, m]),
		);
		for (const stmt of ast) {
			if (stmt.kind !== "use") continue;
			const moduleExports = provided.get(stmt.specifier);
			if (!moduleExports) {
				this.error(
					stmt.specifierSpan,
					`Cannot resolve module '${stmt.specifier}'`,
				);
				continue;
			}
			if (stmt.binding !== null) {
				if (
					!this.scope.declare({
						kind: "package",
						name: stmt.binding.name,
						runtime: "module",
						moduleName: stmt.specifier,
						members: moduleExports.members,
					})
				) {
					this.error(
						stmt.binding.span,
						`Duplicate declaration '${stmt.binding.name}'`,
					);
					continue;
				}
				// Exported types become visible unqualified in the importer
				// (annotations have no dotted form), like package types.
				for (const member of moduleExports.members.values()) {
					if (member.kind === "type" && !this.scope.declare(member)) {
						this.error(
							stmt.specifierSpan,
							`Imported type '${member.name}' conflicts with an existing declaration`,
						);
					}
				}
				continue;
			}
			if (stmt.named !== null && stmt.named.length === 0) {
				this.error(stmt.span, "'use { }' must list at least one export");
				continue;
			}
			for (const requested of stmt.named ?? []) {
				const member = moduleExports.members.get(requested.name);
				if (!member) {
					this.error(
						requested.span,
						`Module '${stmt.specifier}' has no export '${requested.name}'`,
					);
					continue;
				}
				if (!this.scope.declare(member)) {
					this.error(
						requested.span,
						`Duplicate declaration '${requested.name}'`,
					);
				}
			}
		}
	}

	private collectExports(ast: Program): void {
		const moduleName = this.options.moduleName ?? "";
		for (const stmt of ast) {
			if (!("exported" in stmt) || stmt.exported !== true) continue;
			if (stmt.kind === "binding" || stmt.kind === "func") {
				const name = stmt.kind === "binding" ? stmt.name : stmt.sig.name;
				const sym = this.scope.lookupOwn(name);
				if (sym?.kind !== "value") continue;
				this.moduleExportsMap.set(name, {
					kind: "value",
					name,
					type: sym.type,
					mutable: false,
					origin: "moduleMember",
					packageName: moduleName,
				});
				this.exportedValueNames.push(name);
			} else if (
				stmt.kind === "struct" ||
				stmt.kind === "enum" ||
				stmt.kind === "class" ||
				stmt.kind === "protocol"
			) {
				const sym = this.scope.lookupOwn(stmt.name);
				if (sym?.kind === "type") this.moduleExportsMap.set(stmt.name, sym);
				// Class and struct constructors are also runtime values (for
				// cross-module construction and instanceof checks).
				if (stmt.kind === "class" || stmt.kind === "struct") {
					this.exportedValueNames.push(stmt.name);
				}
			}
		}
	}

	public runDeclarations(
		ast: Program,
		packageName: string,
		externalTypes: Map<string, TypeSymbol>,
	): {
		members: Map<string, ValueSymbol | TypeSymbol>;
		diagnostics: Diagnostic[];
	} {
		for (const sym of externalTypes.values()) this.scope.declare(sym);
		const members = new Map<string, ValueSymbol | TypeSymbol>();
		// Pass 1: declare host type shells so members can reference each other.
		for (const stmt of ast) {
			if (stmt.kind === "declareType") {
				const info: HostTypeInfo = {
					name: stmt.name,
					typeParams: this.freshTypeParams(stmt.typeParams),
					props: new Map(),
					methods: new Map(),
				};
				const sym: TypeSymbol = {
					kind: "type",
					name: stmt.name,
					type: {
						kind: "host",
						info,
						typeArgs: info.typeParams.map((p) => ({
							kind: "typeParam",
							info: p,
						})),
					},
				};
				if (!this.scope.declare(sym) || members.has(stmt.name)) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
				} else {
					members.set(stmt.name, sym);
				}
			} else if (stmt.kind === "protocol") {
				const info: ProtocolInfo = {
					name: stmt.name,
					typeParams: this.freshTypeParams(stmt.typeParams),
					props: new Map(),
					methods: new Map(),
				};
				const sym: TypeSymbol = {
					kind: "type",
					name: stmt.name,
					type: canonicalProtocol(info),
				};
				if (!this.scope.declare(sym) || members.has(stmt.name)) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
				} else {
					members.set(stmt.name, sym);
				}
			}
		}
		// Pass 2: resolve member/function/let types.
		for (const stmt of ast) {
			switch (stmt.kind) {
				case "declareType": {
					const sym = members.get(stmt.name);
					if (sym?.kind !== "type" || sym.type.kind !== "host") break;
					const info = sym.type.info;
					this.typeParamsStack.push(info.typeParams);
					this.resolveTypeParamConstraints(stmt.typeParams, info.typeParams);
					for (const member of stmt.members) {
						if (member.kind === "prop") {
							info.props.set(member.name, {
								type: this.resolveType(member.type),
								mutable: member.mutable,
							});
						} else {
							if (member.sig.params.some((p) => p.defaultValue)) {
								this.error(
									member.sig.nameSpan,
									"Default parameter values are not allowed in declare",
								);
							}
							info.methods.set(
								member.sig.name,
								this.sigToType(member.sig, [], { allowOmittable: true }),
							);
						}
					}
					this.typeParamsStack.pop();
					break;
				}
				case "declareFunc": {
					if (stmt.sig.params.some((p) => p.defaultValue)) {
						this.error(
							stmt.sig.nameSpan,
							"Default parameter values are not allowed in declare",
						);
					}
					const typeParams = this.freshTypeParams(stmt.sig.typeParams);
					this.typeParamsStack.push(typeParams);
					this.resolveTypeParamConstraints(stmt.sig.typeParams, typeParams);
					const type = this.sigToType(stmt.sig, typeParams, {
						allowOmittable: true,
					});
					this.typeParamsStack.pop();
					this.declareMember(
						members,
						{
							kind: "value",
							name: stmt.sig.name,
							type,
							mutable: false,
							origin: "packageMember",
							packageName,
						},
						stmt.sig.nameSpan,
					);
					break;
				}
				case "declareLet": {
					this.declareMember(
						members,
						{
							kind: "value",
							name: stmt.name,
							type: this.resolveType(stmt.type),
							mutable: false,
							origin: "packageMember",
							packageName,
						},
						stmt.nameSpan,
					);
					break;
				}
				case "protocol": {
					const sym = members.get(stmt.name);
					if (sym?.kind !== "type" || sym.type.kind !== "protocol") break;
					this.resolveProtocolMembers(stmt, sym.type.info);
					break;
				}
				default:
					this.error(
						stmt.span,
						"Only declare statements and protocol declarations are allowed in package declarations",
					);
			}
		}
		return { members, diagnostics: this.diagnostics };
	}

	private declareMember(
		members: Map<string, ValueSymbol | TypeSymbol>,
		sym: ValueSymbol,
		span: Span,
	): void {
		if (members.has(sym.name)) {
			this.error(span, `Duplicate declaration '${sym.name}'`);
			return;
		}
		members.set(sym.name, sym);
	}

	// ---- Program-level hoisting ----

	private hoistTypes(ast: Program): void {
		const moduleName = this.options.moduleName ?? null;
		const structDecls: {
			stmt: Stmt & { kind: "struct" };
			info: StructInfo;
		}[] = [];
		const enumDecls: { stmt: Stmt & { kind: "enum" }; info: EnumInfo }[] = [];
		const classDecls: { stmt: Stmt & { kind: "class" }; info: ClassInfo }[] =
			[];
		const protocolDecls: {
			stmt: Stmt & { kind: "protocol" };
			info: ProtocolInfo;
		}[] = [];
		const freshParams = (decls: TypeParamDecl[]): TypeParamInfo[] =>
			this.freshTypeParams(decls);
		// Pass 1: declare shells so all type names can reference each other.
		for (const stmt of ast) {
			if (stmt.kind === "struct") {
				const info: StructInfo = {
					name: stmt.name,
					typeParams: freshParams(stmt.typeParams),
					fields: [],
					methods: new Map(),
					moduleName,
				};
				if (
					!this.scope.declare({
						kind: "type",
						name: stmt.name,
						type: canonicalInstance("struct", info),
					})
				) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
					continue;
				}
				structDecls.push({ stmt, info });
			} else if (stmt.kind === "enum") {
				const info: EnumInfo = {
					name: stmt.name,
					typeParams: freshParams(stmt.typeParams),
					cases: [],
					methods: new Map(),
					moduleName,
				};
				if (
					!this.scope.declare({
						kind: "type",
						name: stmt.name,
						type: canonicalInstance("enum", info),
					})
				) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
					continue;
				}
				enumDecls.push({ stmt, info });
			} else if (stmt.kind === "class") {
				const info: ClassInfo = {
					name: stmt.name,
					typeParams: freshParams(stmt.typeParams),
					superclass: null,
					protocols: [],
					fields: [],
					init: null,
					methods: new Map(),
					moduleName,
				};
				if (
					!this.scope.declare({
						kind: "type",
						name: stmt.name,
						type: canonicalClass(info),
					})
				) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
					continue;
				}
				classDecls.push({ stmt, info });
				this.classInfos.set(stmt, info);
			} else if (stmt.kind === "protocol") {
				const info: ProtocolInfo = {
					name: stmt.name,
					typeParams: freshParams(stmt.typeParams),
					props: new Map(),
					methods: new Map(),
				};
				if (
					!this.scope.declare({
						kind: "type",
						name: stmt.name,
						type: canonicalProtocol(info),
					})
				) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
					continue;
				}
				protocolDecls.push({ stmt, info });
			}
		}
		// Pass 2: resolve members.
		for (const { stmt, info } of structDecls) {
			this.typeParamsStack.push(info.typeParams);
			this.resolveTypeParamConstraints(stmt.typeParams, info.typeParams);
			this.resolveValueFields(stmt.fields, info.fields, {
				allowDefaults: false,
			});
			this.resolveValueMethods(stmt.methods, info.methods, "struct");
			this.typeParamsStack.pop();
		}
		for (const { stmt, info } of enumDecls) {
			this.typeParamsStack.push(info.typeParams);
			this.resolveTypeParamConstraints(stmt.typeParams, info.typeParams);
			const seen = new Set<string>();
			for (const caseDecl of stmt.cases) {
				if (seen.has(caseDecl.name)) {
					this.error(caseDecl.nameSpan, `Duplicate case '${caseDecl.name}'`);
					continue;
				}
				seen.add(caseDecl.name);
				info.cases.push({
					name: caseDecl.name,
					assoc: caseDecl.assoc.map((a) => ({
						label: a.label,
						type: this.resolveType(a.type),
					})),
				});
			}
			this.resolveValueMethods(stmt.methods, info.methods, "enum");
			this.typeParamsStack.pop();
		}
		for (const { stmt, info } of protocolDecls) {
			this.resolveProtocolMembers(stmt, info);
		}
		// Pass 3: class heritage, members, and inits.
		for (const { stmt, info } of classDecls) {
			this.typeParamsStack.push(info.typeParams);
			this.resolveTypeParamConstraints(stmt.typeParams, info.typeParams);
			for (const heritageNode of stmt.heritage) {
				const heritage = this.resolveType(heritageNode);
				if (heritage.kind === "class") {
					if (info.superclass !== null) {
						this.error(heritageNode.span, "Only single inheritance is allowed");
					} else {
						info.superclass = heritage;
					}
				} else if (heritage.kind === "protocol") {
					info.protocols.push(heritage);
				} else if (heritage.kind !== "error") {
					this.error(
						heritageNode.span,
						`'${typeToString(heritage)}' is neither a class nor a protocol`,
					);
				}
			}
			this.resolveValueFields(stmt.fields, info.fields, {
				allowDefaults: true,
			});
			for (const method of stmt.methods) {
				this.rejectMethodAttributes(method.sig);
				if (method.mutating) {
					this.error(
						method.sig.nameSpan,
						"'mutating' is only valid on struct/enum methods",
					);
				}
				if (method.sig.name === "init") {
					this.error(
						method.sig.nameSpan,
						"Use 'init(...)' to declare an initializer",
					);
					continue;
				}
				if (
					info.methods.has(method.sig.name) ||
					info.fields.some((f) => f.name === method.sig.name)
				) {
					this.error(
						method.sig.nameSpan,
						`Duplicate member '${method.sig.name}'`,
					);
					continue;
				}
				const methodParams = freshParams(method.sig.typeParams);
				this.typeParamsStack.push(methodParams);
				this.resolveTypeParamConstraints(method.sig.typeParams, methodParams);
				info.methods.set(method.sig.name, {
					func: this.sigToType(method.sig, methodParams),
					override: method.override,
				});
				this.typeParamsStack.pop();
			}
			if (stmt.inits.length > 1) {
				this.error(stmt.inits[1].span, "Only one 'init' is allowed");
			}
			const init = stmt.inits[0];
			if (init) {
				info.init = {
					kind: "func",
					isAsync: false,
					typeParams: info.typeParams,
					params: init.params.map((p) => {
						if (p.omittable) {
							this.error(
								p.omittableSpan ?? p.nameSpan,
								"Omittable parameters are only allowed in declare; write a default value instead",
							);
						}
						return {
							label: p.label,
							type: this.resolveType(p.type),
							hasDefault: p.defaultValue !== undefined,
						};
					}),
					ret: canonicalClass(info),
				};
			} else {
				this.error(stmt.nameSpan, `Class '${stmt.name}' must declare an init`);
			}
			this.typeParamsStack.pop();
		}
		// Pass 4: inheritance cycles, override rules, and conformance.
		for (const { stmt, info } of classDecls) {
			if (hasInheritanceCycle(info)) {
				this.error(
					stmt.nameSpan,
					`Class '${info.name}' cannot inherit from itself`,
				);
				info.superclass = null;
			}
		}
		for (const { stmt, info } of classDecls) {
			this.checkOverrides(stmt, info);
			this.checkConformance(stmt, canonicalClass(info));
		}
		for (const { stmt, info } of [...structDecls, ...enumDecls]) {
			if (this.hasValueCycle(info, new Set())) {
				this.error(
					stmt.nameSpan,
					`Value type '${info.name}' cannot recursively contain itself`,
				);
			}
		}
	}

	private resolveValueFields(
		fields: (Stmt & { kind: "struct" })["fields"],
		target: StructInfo["fields"] | ClassInfo["fields"],
		options: { allowDefaults: boolean },
	): void {
		const seen = new Set<string>();
		for (const field of fields) {
			if (seen.has(field.name)) {
				this.error(field.nameSpan, `Duplicate field '${field.name}'`);
				continue;
			}
			seen.add(field.name);
			if (field.defaultValue && !options.allowDefaults) {
				this.error(
					field.nameSpan,
					"Field defaults are only supported on classes",
				);
			}
			target.push({
				name: field.name,
				type: this.resolveType(field.type),
				mutable: field.mutable,
				hasDefault: options.allowDefaults && field.defaultValue !== undefined,
			});
		}
	}

	private resolveValueMethods(
		methods: MethodDecl[],
		target: Map<string, { func: FuncType; mutating: boolean }>,
		owner: "struct" | "enum",
	): void {
		for (const method of methods) {
			this.rejectMethodAttributes(method.sig);
			if (method.override) {
				this.error(
					method.sig.nameSpan,
					`'override' is only valid on class methods`,
				);
			}
			if (target.has(method.sig.name)) {
				this.error(
					method.sig.nameSpan,
					`Duplicate member '${method.sig.name}'`,
				);
				continue;
			}
			if (owner === "enum" && method.mutating) {
				this.error(method.sig.nameSpan, "Enum methods cannot be 'mutating'");
			}
			const methodParams = this.freshTypeParams(method.sig.typeParams);
			this.typeParamsStack.push(methodParams);
			this.resolveTypeParamConstraints(method.sig.typeParams, methodParams);
			target.set(method.sig.name, {
				func: this.sigToType(method.sig, methodParams),
				mutating: method.mutating,
			});
			this.typeParamsStack.pop();
		}
	}

	/** Validate `override` markers against the superclass chain. */
	private checkOverrides(
		stmt: Stmt & { kind: "class" },
		info: ClassInfo,
	): void {
		for (const method of stmt.methods) {
			const entry = info.methods.get(method.sig.name);
			if (!entry) continue;
			const inherited = lookupClassMethod(
				instantiatedSuperclass(canonicalClass(info)),
				method.sig.name,
			);
			if (method.override && inherited === null) {
				this.error(
					method.sig.nameSpan,
					`'${method.sig.name}' does not override anything`,
				);
			} else if (!method.override && inherited !== null) {
				this.error(
					method.sig.nameSpan,
					`'${method.sig.name}' overrides an inherited method; add 'override'`,
				);
			} else if (
				inherited !== null &&
				!typeEquals(entry.func, inherited.func)
			) {
				this.error(
					method.sig.nameSpan,
					`Override of '${method.sig.name}' must keep the signature '${typeToString(inherited.func)}'`,
				);
			}
		}
	}

	/** Resolve a protocol declaration's property/method requirements. */
	private resolveProtocolMembers(
		stmt: Stmt & { kind: "protocol" },
		info: ProtocolInfo,
	): void {
		this.typeParamsStack.push(info.typeParams);
		this.resolveTypeParamConstraints(stmt.typeParams, info.typeParams);
		for (const prop of stmt.props) {
			if (info.props.has(prop.name) || info.methods.has(prop.name)) {
				this.error(prop.nameSpan, `Duplicate member '${prop.name}'`);
				continue;
			}
			info.props.set(prop.name, {
				type: this.resolveType(prop.type),
				mutable: prop.mutable,
			});
		}
		for (const sig of stmt.methods) {
			if (info.props.has(sig.name) || info.methods.has(sig.name)) {
				this.error(sig.nameSpan, `Duplicate member '${sig.name}'`);
				continue;
			}
			const methodParams = this.freshTypeParams(sig.typeParams);
			this.typeParamsStack.push(methodParams);
			this.resolveTypeParamConstraints(sig.typeParams, methodParams);
			info.methods.set(sig.name, this.sigToType(sig, methodParams));
			this.typeParamsStack.pop();
		}
		this.typeParamsStack.pop();
	}

	/** Verify that a class provides every member its protocols require. */
	private checkConformance(
		stmt: Stmt & { kind: "class" },
		instance: Type & { kind: "class" },
	): void {
		for (const conformed of instance.info.protocols) {
			const subst = buildSubst(conformed.info.typeParams, conformed.typeArgs);
			for (const [name, required] of conformed.info.props) {
				const field = lookupClassField(instance, name);
				const requiredType = substitute(required.type, subst);
				if (!field || !typeEquals(field.type, requiredType)) {
					this.error(
						stmt.nameSpan,
						`'${stmt.name}' does not satisfy '${conformed.info.name}': missing property '${name}: ${typeToString(requiredType)}'`,
					);
				} else if (required.mutable && !field.mutable) {
					this.error(
						stmt.nameSpan,
						`'${stmt.name}' does not satisfy '${conformed.info.name}': property '${name}' must be 'var'`,
					);
				} else if (
					instance.info.typeParams.length > 0 &&
					hasOptionalTypeParam(field.declared)
				) {
					this.error(
						stmt.nameSpan,
						`'${name}' uses an optional type parameter; protocol conformance on generic classes does not support this yet`,
					);
				}
			}
			for (const [name, required] of conformed.info.methods) {
				const method = lookupClassMethod(instance, name);
				const requiredFunc = substitute(required, subst);
				if (!method || !typeEquals(method.func, requiredFunc)) {
					this.error(
						stmt.nameSpan,
						`'${stmt.name}' does not satisfy '${conformed.info.name}': missing method '${name}${typeToString(requiredFunc)}'`,
					);
				} else if (
					instance.info.typeParams.length > 0 &&
					funcHasOptionalTypeParam(method.declared)
				) {
					// Generic-class members store `T?` uniformly, but protocol
					// dispatch assumes the instantiated repr; the two disagree.
					this.error(
						stmt.nameSpan,
						`'${name}' uses an optional type parameter; protocol conformance on generic classes does not support this yet`,
					);
				}
			}
		}
	}

	private hasValueCycle(
		info: StructInfo | EnumInfo,
		visiting: Set<StructInfo | EnumInfo>,
	): boolean {
		if (visiting.has(info)) return true;
		visiting.add(info);
		const fieldTypes =
			"fields" in info
				? info.fields.map((f) => f.type)
				: info.cases.flatMap((c) => c.assoc.map((a) => a.type));
		for (let type of fieldTypes) {
			while (type.kind === "optional") type = type.inner;
			if (
				(type.kind === "struct" || type.kind === "enum") &&
				this.hasValueCycle(type.info, visiting)
			) {
				return true;
			}
		}
		visiting.delete(info);
		return false;
	}

	private hoistFuncs(ast: Program): void {
		for (const stmt of ast) {
			if (stmt.kind !== "func") continue;
			this.declareFuncSymbol(stmt.sig);
		}
	}

	private freshTypeParams(decls: TypeParamDecl[]): TypeParamInfo[] {
		return decls.map((decl) => ({ name: decl.name, id: this.nextParamId++ }));
	}

	/**
	 * Resolve `<T: C>` upper bounds onto already-created param infos. The
	 * params must be on the typeParamsStack so constraints can reference
	 * sibling parameters (`<A, B: Container<A>>`).
	 */
	private resolveTypeParamConstraints(
		decls: TypeParamDecl[],
		infos: TypeParamInfo[],
	): void {
		for (const [i, decl] of decls.entries()) {
			if (!decl.constraint || infos[i] === undefined) continue;
			const constraint = this.resolveType(decl.constraint);
			if (constraint.kind === "class" || constraint.kind === "protocol") {
				infos[i].constraint = constraint;
			} else if (constraint.kind !== "error") {
				this.error(
					decl.constraint.span,
					"Generic constraints must be class or protocol types",
				);
			}
		}
	}

	private declareFuncSymbol(sig: FuncSig): FuncType {
		const typeParams = this.freshTypeParams(sig.typeParams);
		this.typeParamsStack.push(typeParams);
		this.resolveTypeParamConstraints(sig.typeParams, typeParams);
		const type = this.sigToType(sig, typeParams);
		this.typeParamsStack.pop();
		if (
			!this.scope.declare({
				kind: "value",
				name: sig.name,
				type,
				mutable: false,
				origin: "local",
			})
		) {
			this.error(sig.nameSpan, `Duplicate declaration '${sig.name}'`);
		}
		this.hovers.push({
			span: sig.nameSpan,
			text: `fn ${sig.name}${typeToString(type)}`,
		});
		return type;
	}

	/** Validate declaration attributes on a checked `fn` statement. */
	private checkFuncAttributes(
		sig: FuncSig,
		type: FuncType,
		topLevel: boolean,
	): void {
		const seen = new Set<string>();
		for (const attr of sig.attributes) {
			if (attr.name !== "test") {
				this.error(attr.span, `Unknown attribute '@${attr.name}'`);
				continue;
			}
			if (seen.has(attr.name)) {
				this.error(attr.span, `Duplicate attribute '@${attr.name}'`);
				continue;
			}
			seen.add(attr.name);
			if (!topLevel) {
				this.error(attr.span, "'@test' is only allowed on top-level functions");
				continue;
			}
			if (this.options.mode === "module") {
				this.error(attr.span, "'@test' is not allowed in modules");
				continue;
			}
			if (sig.params.length > 0) {
				this.error(attr.span, "'@test' functions take no parameters");
			}
			if (sig.typeParams.length > 0) {
				this.error(attr.span, "'@test' functions cannot be generic");
			}
			if (type.ret.kind !== "void" && type.ret.kind !== "error") {
				this.error(attr.span, "'@test' functions must not return a value");
			}
		}
	}

	/** Attributes only attach to `fn` statements; reject them on methods. */
	private rejectMethodAttributes(sig: FuncSig): void {
		for (const attr of sig.attributes) {
			this.error(attr.span, `Attributes are not allowed on methods`);
		}
	}

	private sigToType(
		sig: FuncSig,
		typeParams: TypeParamInfo[],
		options: { allowOmittable?: boolean } = {},
	): FuncType {
		if (!options.allowOmittable) {
			for (const param of sig.params) {
				if (!param.omittable) continue;
				this.error(
					param.omittableSpan ?? param.nameSpan,
					"Omittable parameters are only allowed in declare; write a default value instead",
				);
			}
		}
		return {
			kind: "func",
			isAsync: sig.isAsync,
			throws: sig.throws,
			typeParams,
			params: sig.params.map((p) => ({
				label: p.label,
				type: this.resolveType(p.type),
				hasDefault: p.defaultValue !== undefined || p.omittable === true,
			})),
			ret: sig.retType ? this.resolveType(sig.retType) : VOID,
		};
	}

	// ---- Type annotation resolution ----

	private resolveType(node: TypeNode): Type {
		switch (node.kind) {
			case "void":
				return VOID;
			case "literalType":
				return literalOf(node.value);
			case "union":
				return this.resolveUnion(node);
			case "optional":
				return optionalOf(this.resolveType(node.inner));
			case "func":
				return {
					kind: "func",
					isAsync: false,
					typeParams: [],
					params: node.params.map((p) => ({
						label: null,
						type: this.resolveType(p),
						hasDefault: false,
					})),
					ret: this.resolveType(node.ret),
				};
			case "named": {
				for (let i = this.typeParamsStack.length - 1; i >= 0; i--) {
					const found = this.typeParamsStack[i].find(
						(p) => p.name === node.name,
					);
					if (found) {
						this.expectArity(node, 0);
						return { kind: "typeParam", info: found };
					}
				}
				switch (node.name) {
					case "Number":
						this.expectArity(node, 0);
						return NUMBER;
					case "String":
						this.expectArity(node, 0);
						return STRING;
					case "Bool":
						this.expectArity(node, 0);
						return BOOL;
					case "Void":
						this.expectArity(node, 0);
						return VOID;
					case "Array":
						if (node.args.length !== 1) {
							this.error(node.span, "Array requires one type argument");
							return ERROR;
						}
						return arrayOf(this.resolveType(node.args[0]));
					case "Optional":
						if (node.args.length !== 1) {
							this.error(node.span, "Optional requires one type argument");
							return ERROR;
						}
						return optionalOf(this.resolveType(node.args[0]));
					case "Dictionary":
					case "Record": {
						if (node.args.length !== 2) {
							this.error(node.span, `${node.name} requires two type arguments`);
							return ERROR;
						}
						const key = this.resolveType(node.args[0]);
						if (
							key.kind !== "string" &&
							key.kind !== "typeParam" &&
							key.kind !== "error" &&
							stringLiteralMembers(key) === null
						) {
							this.error(
								node.args[0].span,
								"Dictionary keys must be String or a union of string literals",
							);
						}
						return dictionaryOf(key, this.resolveType(node.args[1]));
					}
					default: {
						const sym = this.scope.lookup(node.name);
						if (sym?.kind === "type") {
							return this.resolveUserType(node, sym.type);
						}
						this.error(node.span, `Unknown type '${node.name}'`);
						return ERROR;
					}
				}
			}
		}
	}

	private resolveUnion(node: TypeNode & { kind: "union" }): Type {
		const members: Type[] = [];
		for (const memberNode of node.members) {
			const member = this.resolveType(memberNode);
			if (member.kind === "optional") {
				this.error(
					memberNode.span,
					"Optional cannot be a union member; make the whole union optional instead",
				);
				members.push(member.inner);
				continue;
			}
			if (member.kind === "void") {
				this.error(memberNode.span, "Void cannot be a union member");
				continue;
			}
			if (member.kind === "protocol") {
				this.error(memberNode.span, "Protocol types cannot be union members");
				continue;
			}
			members.push(member);
		}
		// Literals subsumed by their bare base collapse (e.g. "a" | String).
		const collapsed = members.filter(
			(m) =>
				!(
					m.kind === "literal" &&
					members.some((n) => typeEquals(n, literalBase(m)))
				),
		);
		const result = unionOf(collapsed);
		if (result.kind !== "union") return result;
		this.validateUnionDiscriminability(result, node.span);
		return result;
	}

	/** Union members must be pairwise distinguishable at runtime. */
	private validateUnionDiscriminability(union: UnionType, span: Span): void {
		const classMembers: (Type & { kind: "class" })[] = [];
		const byClass = new Map<string, Type[]>();
		for (const member of union.members) {
			if (member.kind === "class") {
				classMembers.push(member);
				continue;
			}
			const cls = discriminationClass(member);
			if (cls === null) continue;
			const list = byClass.get(cls) ?? [];
			list.push(member);
			byClass.set(cls, list);
		}
		const pairError = (a: Type, b: Type): void => {
			this.error(
				span,
				`Union members '${typeToString(a)}' and '${typeToString(b)}' cannot be distinguished at runtime`,
			);
		};
		for (const members of byClass.values()) {
			if (members.length <= 1) continue;
			// Same-base literals are discriminated by value.
			if (members.every((m) => m.kind === "literal")) continue;
			this.error(
				span,
				`Union members ${members
					.map((m) => `'${typeToString(m)}'`)
					.join(" and ")} cannot be distinguished at runtime`,
			);
		}
		const hostMember = byClass.get("host")?.[0];
		const structMember = byClass.get("struct")?.[0];
		if (hostMember && structMember) pairError(structMember, hostMember);
		if (hostMember && classMembers.length > 0) {
			pairError(classMembers[0], hostMember);
		}
		// Classes discriminate via instanceof, so only related classes clash.
		for (let i = 0; i < classMembers.length; i++) {
			for (let j = i + 1; j < classMembers.length; j++) {
				const a = classMembers[i];
				const b = classMembers[j];
				if (typeConforms(a, b) || typeConforms(b, a)) pairError(a, b);
			}
		}
	}

	private resolveUserType(
		node: TypeNode & { kind: "named" },
		type: Type,
	): Type {
		if (
			type.kind === "struct" ||
			type.kind === "enum" ||
			type.kind === "class" ||
			type.kind === "protocol" ||
			type.kind === "host"
		) {
			const expected = type.info.typeParams.length;
			if (node.args.length !== expected) {
				this.error(
					node.span,
					expected === 0
						? `'${node.name}' is not generic`
						: `'${node.name}' requires ${expected} type argument(s)`,
				);
				return expected === 0 ? type : ERROR;
			}
			if (expected === 0) return type;
			const typeArgs = node.args.map((a) => this.resolveType(a));
			this.checkConstraints(
				type.info.typeParams,
				buildSubst(type.info.typeParams, typeArgs),
				node.span,
			);
			switch (type.kind) {
				case "struct":
					return { kind: "struct", info: type.info, typeArgs };
				case "enum":
					return { kind: "enum", info: type.info, typeArgs };
				case "class":
					return { kind: "class", info: type.info, typeArgs };
				case "protocol":
					return { kind: "protocol", info: type.info, typeArgs };
				case "host":
					return { kind: "host", info: type.info, typeArgs };
			}
		}
		this.expectArity(node, 0);
		return type;
	}

	private expectArity(node: TypeNode & { kind: "named" }, arity: number): void {
		if (node.args.length !== arity) {
			this.error(node.span, `'${node.name}' is not generic`);
		}
	}

	// ---- Statements ----

	private checkStmt(stmt: Stmt): void {
		switch (stmt.kind) {
			case "use":
				if (this.scope.kind !== "global") {
					this.error(stmt.span, "'use' must be at the top level");
				}
				return;
			case "binding": {
				const annotated = stmt.type ? this.resolveType(stmt.type) : undefined;
				const init = this.checkExpr(stmt.init, annotated);
				const type = annotated ?? init;
				if (type.kind === "void") {
					this.error(stmt.init.span, "Cannot bind a Void value");
				}
				this.markCopy(stmt.init, type);
				if (
					!this.scope.declare({
						kind: "value",
						name: stmt.name,
						type,
						mutable: stmt.mutable,
						origin: "local",
					})
				) {
					this.error(stmt.nameSpan, `Duplicate declaration '${stmt.name}'`);
				}
				this.hovers.push({
					span: stmt.nameSpan,
					text: `${stmt.mutable ? "var" : "let"} ${stmt.name}: ${typeToString(type)}`,
				});
				return;
			}
			case "func": {
				let type: FuncType;
				if (this.scope.kind === "global") {
					const sym = this.scope.lookupOwn(stmt.sig.name);
					type =
						sym?.kind === "value" && sym.type.kind === "func"
							? sym.type
							: this.declareFuncSymbol(stmt.sig);
				} else {
					type = this.declareFuncSymbol(stmt.sig);
				}
				this.checkFuncAttributes(stmt.sig, type, this.scope.kind === "global");
				this.checkFuncBody(stmt, type);
				return;
			}
			case "struct":
			case "enum": {
				if (this.scope.kind !== "global") {
					this.error(stmt.nameSpan, "Types must be declared at the top level");
					return;
				}
				const sym = this.scope.lookupOwn(stmt.name);
				if (
					sym?.kind === "type" &&
					(sym.type.kind === "struct" || sym.type.kind === "enum")
				) {
					this.checkValueTypeBodies(stmt, sym.type);
				}
				return;
			}
			case "class": {
				if (this.scope.kind !== "global") {
					this.error(stmt.nameSpan, "Types must be declared at the top level");
					return;
				}
				const sym = this.scope.lookupOwn(stmt.name);
				if (sym?.kind === "type" && sym.type.kind === "class") {
					this.checkClassBodies(stmt, sym.type);
				}
				return;
			}
			case "protocol":
				if (this.scope.kind !== "global") {
					this.error(stmt.nameSpan, "Types must be declared at the top level");
				}
				return;
			case "declareFunc":
			case "declareLet":
			case "declareType":
				this.error(
					stmt.span,
					"declare is only allowed in host package declarations",
				);
				return;
			case "if": {
				const bodyScope = new Scope(this.scope, "block");
				const elseScope = new Scope(this.scope, "block");
				// Later conditions see the bindings the earlier ones introduced.
				const outerScope = this.scope;
				this.scope = bodyScope;
				for (const cond of stmt.conds) {
					this.checkCondition(cond, bodyScope);
					if (cond.kind !== "expr") continue;
					const narrowings = this.conditionNarrowings(cond.expr);
					this.applyNarrowings(narrowings, "thenType", bodyScope);
					// Only a lone condition tells us anything about the else branch.
					if (stmt.conds.length > 1) continue;
					this.applyNarrowings(narrowings, "elseType", elseScope);
					// Early-exit then-branch: code after the if sees the else facts.
					if (alwaysLeaves(stmt.thenBody)) {
						this.applyNarrowings(narrowings, "elseType", outerScope);
					}
				}
				this.scope = outerScope;
				this.checkBlock(stmt.thenBody, bodyScope);
				if (stmt.elseBody) {
					this.checkBlock(stmt.elseBody, elseScope);
				}
				return;
			}
			case "guard": {
				const elseScope = new Scope(this.scope, "block");
				for (const cond of stmt.conds) {
					// Bindings land in the CURRENT scope (visible after the guard).
					this.checkCondition(cond, this.scope);
					if (cond.kind !== "expr") continue;
					const narrowings = this.conditionNarrowings(cond.expr);
					// The happy path continues with the narrowed types.
					this.applyNarrowings(narrowings, "thenType", this.scope);
					// Only a lone condition tells us anything about the else branch.
					if (stmt.conds.length === 1) {
						this.applyNarrowings(narrowings, "elseType", elseScope);
					}
				}
				this.checkBlock(stmt.elseBody, elseScope);
				if (!alwaysLeaves(stmt.elseBody)) {
					this.error(
						stmt.span,
						"'guard' else body must exit (return, break, or continue)",
					);
				}
				return;
			}
			case "for": {
				const bodyScope = new Scope(this.scope, "block");
				if (stmt.source.kind === "range") {
					this.checkExpr(stmt.source.from, NUMBER);
					this.checkExpr(stmt.source.to, NUMBER);
					this.declareForBinding(stmt.binding, NUMBER, undefined, bodyScope);
				} else {
					const t = this.checkExpr(stmt.source.expr);
					if (t.kind === "array") {
						this.declareForBinding(
							stmt.binding,
							t.element,
							undefined,
							bodyScope,
						);
					} else if (t.kind === "dictionary") {
						this.declareForBinding(stmt.binding, t.key, t.value, bodyScope);
					} else {
						if (t.kind !== "error") {
							this.error(
								stmt.source.expr.span,
								`Cannot iterate over '${typeToString(t)}'`,
							);
						}
						this.declareForBinding(stmt.binding, ERROR, ERROR, bodyScope);
					}
				}
				this.loopDepth++;
				this.checkBlock(stmt.body, bodyScope);
				this.loopDepth--;
				return;
			}
			case "while":
				this.checkExpr(stmt.cond, BOOL);
				this.loopDepth++;
				this.checkBlock(stmt.body, new Scope(this.scope, "block"));
				this.loopDepth--;
				return;
			case "switch":
				this.checkSwitch(stmt);
				return;
			case "return": {
				const ctx = this.funcStack.at(-1);
				if (!ctx) {
					if (
						!stmt.value &&
						(this.options.mode === undefined || this.options.mode === "script")
					) {
						return;
					}
					this.error(stmt.span, "'return' outside of a function");
					if (stmt.value) this.checkExpr(stmt.value);
					return;
				}
				if (!stmt.value) {
					if (ctx.ret === "infer") {
						ctx.inferred ??= VOID;
					} else if (ctx.ret.kind !== "void") {
						this.error(
							stmt.span,
							`Expected a return value of type '${typeToString(ctx.ret)}'`,
						);
					}
					return;
				}
				if (ctx.ret !== "infer" && ctx.ret.kind === "void") {
					this.error(
						stmt.value.span,
						"Unexpected return value in Void function",
					);
					this.checkExpr(stmt.value);
					return;
				}
				const expected = ctx.ret === "infer" ? ctx.inferred : ctx.ret;
				const t = this.checkExpr(stmt.value, expected);
				if (ctx.ret === "infer") ctx.inferred ??= t;
				this.markCopy(stmt.value, t);
				return;
			}
			case "throw": {
				if (!(this.throwsAllowedStack.at(-1) ?? false)) {
					this.error(
						stmt.span,
						"Errors thrown from here are not handled; use do-catch or mark the enclosing function 'throws'",
					);
				}
				const thrown = this.checkExpr(stmt.expr);
				const errType = this.errorProtocolType();
				if (
					errType !== null &&
					thrown.kind !== "error" &&
					!typeConforms(thrown, errType)
				) {
					this.error(
						stmt.expr.span,
						`Thrown values must conform to 'Error', got '${typeToString(thrown)}'`,
					);
				}
				this.markCopy(stmt.expr, thrown);
				return;
			}
			case "doCatch": {
				this.throwsAllowedStack.push(true);
				this.checkBlock(stmt.body, new Scope(this.scope, "block"));
				this.throwsAllowedStack.pop();
				const catchScope = new Scope(this.scope, "block");
				catchScope.declare({
					kind: "value",
					name: "error",
					type: this.errorProtocolType() ?? ERROR,
					mutable: false,
					origin: "local",
				});
				this.checkBlock(stmt.catchBody, catchScope);
				return;
			}
			case "break":
			case "continue":
				if (this.loopDepth === 0) {
					this.error(stmt.span, `'${stmt.kind}' outside of a loop`);
				}
				return;
			case "assign": {
				const targetType = this.checkExpr(stmt.target);
				// A member READ coercion does not apply to a write target.
				this.coercions.delete(stmt.target);
				this.checkAssignTarget(stmt.target);
				// Dictionary subscript writes take the value type, not `V?`.
				const dictValue = this.dictSubscriptValueType(stmt.target);
				if (dictValue !== undefined) {
					if (stmt.op !== "=") {
						this.error(
							stmt.target.span,
							"Compound assignment is not supported on dictionary subscripts",
						);
					}
					const t = this.checkExpr(stmt.value, dictValue);
					this.markCopy(stmt.value, t);
					return;
				}
				if (stmt.op === "=") {
					this.checkExpr(stmt.value, targetType);
				} else if (stmt.op === "+=") {
					if (
						targetType.kind !== "number" &&
						targetType.kind !== "string" &&
						targetType.kind !== "error"
					) {
						this.error(
							stmt.target.span,
							`'+=' requires Number or String, got '${typeToString(targetType)}'`,
						);
					}
					this.checkExpr(stmt.value, targetType);
				} else {
					if (targetType.kind !== "number" && targetType.kind !== "error") {
						this.error(
							stmt.target.span,
							`'${stmt.op}' requires Number, got '${typeToString(targetType)}'`,
						);
					}
					this.checkExpr(stmt.value, NUMBER);
				}
				this.markCopy(stmt.value, targetType);
				if (stmt.op === "=") this.markMemberWrite(stmt.target, stmt.value);
				return;
			}
			case "expr":
				this.checkExpr(stmt.expr);
				return;
		}
	}

	private dictSubscriptValueType(target: Expr): Type | undefined {
		if (target.kind !== "subscript") return undefined;
		const objType = this.types.get(target.object);
		return objType?.kind === "dictionary" ? objType.value : undefined;
	}

	/**
	 * Flow-narrowing facts derived from a boolean condition:
	 * `x is T`, `!(...)`, `a && b`, and `x ==/!= nil`.
	 */
	private conditionNarrowings(
		cond: Expr,
	): { name: string; thenType: Type | null; elseType: Type | null }[] {
		switch (cond.kind) {
			case "is": {
				if (cond.operand.kind !== "ident") return [];
				const operandType = this.types.get(cond.operand);
				const resolution = this.resolutions.get(cond);
				if (operandType?.kind !== "union" || resolution?.kind !== "isCheck") {
					return [];
				}
				const { matched, rest } = matchUnionMembers(
					operandType,
					resolution.target,
				);
				if (matched.length === 0) return [];
				return [
					{
						name: cond.operand.name,
						thenType: unionOf(matched),
						elseType: rest.length > 0 ? unionOf(rest) : null,
					},
				];
			}
			case "unary": {
				if (cond.op !== "!") return [];
				return this.conditionNarrowings(cond.operand).map((n) => ({
					name: n.name,
					thenType: n.elseType,
					elseType: n.thenType,
				}));
			}
			case "binary": {
				if (cond.op === "&&") {
					return [
						...this.conditionNarrowings(cond.left),
						...this.conditionNarrowings(cond.right),
					].map((n) => ({ ...n, elseType: null }));
				}
				if (cond.op !== "==" && cond.op !== "!=") return [];
				const nilSide =
					cond.left.kind === "nil"
						? cond.left
						: cond.right.kind === "nil"
							? cond.right
							: null;
				if (!nilSide) return [];
				const valueSide = cond.left.kind === "nil" ? cond.right : cond.left;
				if (valueSide.kind !== "ident") return [];
				const t = this.types.get(valueSide);
				if (t?.kind !== "optional") return [];
				// Boxed optionals keep their runtime box after a nil test, so a
				// narrowed static type would lie about the repr; use `if let`.
				if (boxedRepr(t)) return [];
				if (cond.op === "!=") {
					return [{ name: valueSide.name, thenType: t.inner, elseType: null }];
				}
				return [{ name: valueSide.name, thenType: null, elseType: t.inner }];
			}
			default:
				return [];
		}
	}

	private applyNarrowings(
		narrowings: {
			name: string;
			thenType: Type | null;
			elseType: Type | null;
		}[],
		which: "thenType" | "elseType",
		scope: Scope,
	): void {
		for (const narrowing of narrowings) {
			const type = narrowing[which];
			if (type === null) continue;
			const sym = this.scope.lookup(narrowing.name);
			if (sym?.kind !== "value") continue;
			scope.redeclare({ ...sym, type });
		}
	}

	private checkCondition(cond: Condition, bindingScope: Scope): void {
		if (cond.kind === "expr") {
			this.checkExpr(cond.expr, BOOL);
			return;
		}
		const t = this.checkExpr(cond.expr);
		if (t.kind === "optional") {
			if (
				!bindingScope.declare({
					kind: "value",
					name: cond.name,
					type: t.inner,
					mutable: false,
					origin: "local",
				})
			) {
				this.error(cond.nameSpan, `Duplicate declaration '${cond.name}'`);
			}
			this.hovers.push({
				span: cond.nameSpan,
				text: `let ${cond.name}: ${typeToString(t.inner)}`,
			});
		} else if (t.kind !== "error") {
			this.error(
				cond.expr.span,
				`Optional binding requires an optional value, got '${typeToString(t)}'`,
			);
		}
	}

	private declareForBinding(
		binding: ForBinding,
		first: Type,
		second: Type | undefined,
		scope: Scope,
	): void {
		if (binding.kind === "single") {
			if (second !== undefined && second.kind !== "error") {
				this.error(
					binding.nameSpan,
					"Iterating a dictionary requires 'for (key, value) in ...'",
				);
			}
			scope.declare({
				kind: "value",
				name: binding.name,
				type: first,
				mutable: false,
				origin: "local",
			});
			this.hovers.push({
				span: binding.nameSpan,
				text: `let ${binding.name}: ${typeToString(first)}`,
			});
			return;
		}
		if (second === undefined) {
			this.error(
				binding.key.nameSpan,
				"'for (key, value)' requires a dictionary source",
			);
		}
		scope.declare({
			kind: "value",
			name: binding.key.name,
			type: first,
			mutable: false,
			origin: "local",
		});
		scope.declare({
			kind: "value",
			name: binding.value.name,
			type: second ?? ERROR,
			mutable: false,
			origin: "local",
		});
		this.hovers.push({
			span: binding.key.nameSpan,
			text: `let ${binding.key.name}: ${typeToString(first)}`,
		});
		this.hovers.push({
			span: binding.value.nameSpan,
			text: `let ${binding.value.name}: ${typeToString(second ?? ERROR)}`,
		});
	}

	private checkBlock(stmts: Stmt[], scope: Scope): void {
		const span = spanOfStmts(stmts);
		if (span) this.scopeRecords.push({ span, scope });
		const saved = this.scope;
		this.scope = scope;
		for (const stmt of stmts) this.checkStmt(stmt);
		this.scope = saved;
	}

	private checkValueTypeBodies(
		stmt: Stmt & { kind: "struct" | "enum" },
		owner: Type & { kind: "struct" | "enum" },
	): void {
		for (const method of stmt.methods) {
			const entry = owner.info.methods.get(method.sig.name);
			if (!entry) continue;
			this.checkMethodBody(owner, method, entry.func, {
				selfMutable: method.mutating,
				classInstance: null,
				inInit: false,
			});
		}
	}

	private checkClassBodies(
		stmt: Stmt & { kind: "class" },
		instance: Type & { kind: "class" },
	): void {
		const info = instance.info;
		this.typeParamsStack.push(info.typeParams);
		for (const [i, field] of stmt.fields.entries()) {
			const fieldType = info.fields[i]?.type ?? ERROR;
			if (field.defaultValue) {
				this.checkExpr(field.defaultValue, fieldType);
			}
		}
		this.typeParamsStack.pop();
		const init = stmt.inits[0];
		if (init && info.init) {
			this.checkInitBody(instance, init, info.init);
		}
		for (const method of stmt.methods) {
			const entry = info.methods.get(method.sig.name);
			if (!entry) continue;
			this.checkMethodBody(instance, method, entry.func, {
				selfMutable: false,
				classInstance: instance,
				inInit: false,
			});
		}
	}

	private checkMethodBody(
		owner: Type & { kind: "struct" | "enum" | "class" },
		method: MethodDecl,
		funcType: FuncType,
		options: {
			selfMutable: boolean;
			classInstance: (Type & { kind: "class" }) | null;
			inInit: boolean;
		},
	): void {
		this.typeParamsStack.push(owner.info.typeParams);
		this.typeParamsStack.push(funcType.typeParams);
		const scope = new Scope(this.scope, "function");
		scope.declare({
			kind: "value",
			name: "self",
			type: owner,
			mutable: options.selfMutable,
			origin: "local",
		});
		for (const [i, param] of method.sig.params.entries()) {
			const paramType = funcType.params[i]?.type ?? ERROR;
			if (
				!scope.declare({
					kind: "value",
					name: param.name,
					type: paramType,
					mutable: false,
					origin: "local",
				})
			) {
				this.error(param.nameSpan, `Duplicate parameter '${param.name}'`);
			}
			if (param.defaultValue) {
				const saved = this.scope;
				this.scope = scope;
				this.checkExpr(param.defaultValue, paramType);
				this.scope = saved;
			}
		}
		this.funcStack.push({ ret: funcType.ret });
		this.dollarStack.push(null);
		this.asyncAllowedStack.push(funcType.isAsync);
		this.throwsAllowedStack.push(funcType.throws ?? false);
		const savedAwaitDepth = this.awaitDepth;
		this.awaitDepth = 0;
		const savedTryDepth = this.tryDepth;
		this.tryDepth = 0;
		if (options.classInstance) {
			this.classCtx.push({
				instance: options.classInstance,
				inInit: options.inInit,
			});
		}
		this.checkBlock(method.body, scope);
		if (options.classInstance) this.classCtx.pop();
		this.awaitDepth = savedAwaitDepth;
		this.tryDepth = savedTryDepth;
		this.throwsAllowedStack.pop();
		this.asyncAllowedStack.pop();
		this.dollarStack.pop();
		this.funcStack.pop();
		this.typeParamsStack.pop();
		this.typeParamsStack.pop();
		if (funcType.ret.kind !== "void" && !alwaysExits(method.body)) {
			this.error(
				method.sig.nameSpan,
				`Method '${method.sig.name}' is missing a return on some paths`,
			);
		}
	}

	private checkInitBody(
		instance: Type & { kind: "class" },
		init: InitDecl,
		initType: FuncType,
	): void {
		this.typeParamsStack.push(instance.info.typeParams);
		const scope = new Scope(this.scope, "function");
		scope.declare({
			kind: "value",
			name: "self",
			type: instance,
			mutable: false,
			origin: "local",
		});
		for (const [i, param] of init.params.entries()) {
			const paramType = initType.params[i]?.type ?? ERROR;
			if (
				!scope.declare({
					kind: "value",
					name: param.name,
					type: paramType,
					mutable: false,
					origin: "local",
				})
			) {
				this.error(param.nameSpan, `Duplicate parameter '${param.name}'`);
			}
			if (param.defaultValue) {
				const saved = this.scope;
				this.scope = scope;
				this.checkExpr(param.defaultValue, paramType);
				this.scope = saved;
			}
		}
		this.funcStack.push({ ret: VOID });
		this.dollarStack.push(null);
		this.asyncAllowedStack.push(true);
		this.throwsAllowedStack.push(false);
		const savedAwaitDepth = this.awaitDepth;
		this.awaitDepth = 0;
		const savedTryDepth = this.tryDepth;
		this.tryDepth = 0;
		this.classCtx.push({ instance, inInit: true });
		this.checkBlock(init.body, scope);
		this.classCtx.pop();
		this.awaitDepth = savedAwaitDepth;
		this.tryDepth = savedTryDepth;
		this.throwsAllowedStack.pop();
		this.asyncAllowedStack.pop();
		this.dollarStack.pop();
		this.funcStack.pop();
		this.typeParamsStack.pop();

		// Definite initialization: every own field without a default must be
		// assigned via `self.<field> = ...` at the top level of the init body.
		const assigned = new Set<string>();
		let callsSuperInit = false;
		for (const bodyStmt of init.body) {
			if (
				bodyStmt.kind === "assign" &&
				bodyStmt.op === "=" &&
				bodyStmt.target.kind === "member" &&
				bodyStmt.target.object.kind === "ident" &&
				bodyStmt.target.object.name === "self"
			) {
				assigned.add(bodyStmt.target.name);
			}
			if (isSuperInitStmt(bodyStmt)) callsSuperInit = true;
		}
		const missing = instance.info.fields
			.filter((f) => !f.hasDefault && !assigned.has(f.name))
			.map((f) => f.name);
		if (missing.length > 0) {
			this.error(
				init.span,
				`'init' must assign every stored property; missing: ${missing.join(", ")}`,
			);
		}
		if (instance.info.superclass !== null && !callsSuperInit) {
			this.error(init.span, "'init' must call 'super.init(...)'");
		}
		if (instance.info.superclass !== null && callsSuperInit) {
			// Classes compile to native JS constructors, which require
			// super() to run before any `this` access.
			const superIndex = init.body.findIndex(isSuperInitStmt);
			const bad = firstSelfOrSuperUse(init.body.slice(0, superIndex));
			if (bad !== null) {
				this.error(
					bad,
					"'self' and 'super' cannot be used before 'super.init(...)'",
				);
			}
		}
	}

	private checkFuncBody(stmt: Stmt & { kind: "func" }, type: FuncType): void {
		this.typeParamsStack.push(type.typeParams);
		const scope = new Scope(this.scope, "function");
		for (const [i, param] of stmt.sig.params.entries()) {
			const paramType = type.params[i]?.type ?? ERROR;
			if (
				!scope.declare({
					kind: "value",
					name: param.name,
					type: paramType,
					mutable: false,
					origin: "local",
				})
			) {
				this.error(param.nameSpan, `Duplicate parameter '${param.name}'`);
			}
			this.hovers.push({
				span: param.nameSpan,
				text: `${param.name}: ${typeToString(paramType)}`,
			});
			if (param.defaultValue) {
				const saved = this.scope;
				this.scope = scope;
				this.checkExpr(param.defaultValue, paramType);
				this.scope = saved;
			}
		}
		this.funcStack.push({ ret: type.ret });
		this.dollarStack.push(null);
		this.asyncAllowedStack.push(type.isAsync);
		this.throwsAllowedStack.push(type.throws ?? false);
		const savedAwaitDepth = this.awaitDepth;
		this.awaitDepth = 0;
		const savedTryDepth = this.tryDepth;
		this.tryDepth = 0;
		this.checkBlock(stmt.body, scope);
		this.awaitDepth = savedAwaitDepth;
		this.tryDepth = savedTryDepth;
		this.throwsAllowedStack.pop();
		this.asyncAllowedStack.pop();
		this.dollarStack.pop();
		this.funcStack.pop();
		this.typeParamsStack.pop();
		if (type.ret.kind !== "void" && !alwaysExits(stmt.body)) {
			this.error(
				stmt.sig.nameSpan,
				`Function '${stmt.sig.name}' is missing a return on some paths`,
			);
		}
	}

	private checkSwitch(stmt: Stmt & { kind: "switch" }): void {
		const subject = this.checkExpr(stmt.subject);
		const subjectSubst =
			subject.kind === "enum"
				? buildSubst(subject.info.typeParams, subject.typeArgs)
				: new Map<number, Type>();
		let hasDefault = false;
		const coveredCases = new Set<string>();
		const coveredLiterals = new Set<number | string | boolean>();
		// For union subjects, track which members have been covered.
		let remainingMembers =
			subject.kind === "union" ? [...subject.members] : null;
		for (const switchCase of stmt.cases) {
			const caseScope = new Scope(this.scope, "block");
			if (switchCase.pattern === "default") {
				hasDefault = true;
			} else if (switchCase.pattern.kind === "typePattern") {
				const pattern = switchCase.pattern;
				const target = this.resolveType(pattern.type);
				this.patternTypes.set(pattern, target);
				if (subject.kind !== "union") {
					if (subject.kind !== "error") {
						this.error(
							pattern.span,
							"'case is' patterns require a union-typed subject",
						);
					}
				} else {
					const { matched } = matchUnionMembers(subject, target);
					if (matched.length === 0 && target.kind !== "error") {
						this.error(
							pattern.span,
							`'${typeToString(target)}' is not a member of '${typeToString(subject)}'`,
						);
					}
					if (remainingMembers) {
						remainingMembers = remainingMembers.filter(
							(m) => !typeConforms(m, target),
						);
					}
					if (stmt.subject.kind === "ident" && matched.length > 0) {
						const sym = this.scope.lookup(stmt.subject.name);
						if (sym?.kind === "value") {
							caseScope.redeclare({ ...sym, type: unionOf(matched) });
						}
					}
				}
			} else if (switchCase.pattern.kind === "case") {
				const pattern = switchCase.pattern;
				if (subject.kind !== "enum") {
					if (subject.kind !== "error") {
						this.error(
							pattern.nameSpan,
							"Case patterns require an enum subject",
						);
					}
				} else {
					const caseInfo = subject.info.cases.find(
						(c) => c.name === pattern.name,
					);
					if (!caseInfo) {
						this.error(
							pattern.nameSpan,
							`Enum '${subject.info.name}' has no case '${pattern.name}'`,
						);
					} else {
						if (coveredCases.has(pattern.name)) {
							this.error(pattern.nameSpan, `Duplicate case '${pattern.name}'`);
						}
						coveredCases.add(pattern.name);
						if (
							pattern.bindings.length > 0 &&
							pattern.bindings.length !== caseInfo.assoc.length
						) {
							this.error(
								pattern.nameSpan,
								`Case '${pattern.name}' has ${caseInfo.assoc.length} associated value(s)`,
							);
						}
						const bindCoercions: (Coercion | null)[] = [];
						for (const [i, binding] of pattern.bindings.entries()) {
							const declaredAssoc = caseInfo.assoc[i]?.type;
							const assocType = declaredAssoc
								? substitute(declaredAssoc, subjectSubst)
								: ERROR;
							let coercion: Coercion | null = null;
							if (declaredAssoc && subjectSubst.size > 0) {
								const result = genericCoercion(
									declaredAssoc,
									subjectSubst,
									"fromGeneric",
								);
								if (result === "unsupported") {
									this.error(
										binding.nameSpan,
										"Optional type parameters under arrays, dictionaries, or async function types cannot cross this generic boundary yet",
									);
								} else {
									coercion = result;
								}
							}
							bindCoercions.push(coercion);
							caseScope.declare({
								kind: "value",
								name: binding.name,
								type: assocType,
								mutable: false,
								origin: "local",
							});
							this.hovers.push({
								span: binding.nameSpan,
								text: `let ${binding.name}: ${typeToString(assocType)}`,
							});
						}
						if (bindCoercions.some((c) => c !== null)) {
							this.patternBindCoercions.set(pattern, bindCoercions);
						}
					}
				}
			} else {
				const literal = switchCase.pattern;
				const literalType = literalOf(literal.value);
				if (subject.kind === "union" || subject.kind === "literal") {
					if (!typeConforms(literalType, subject)) {
						this.error(
							literal.span,
							`'${typeToString(literalType)}' is not a member of '${typeToString(subject)}'`,
						);
					}
					if (remainingMembers) {
						remainingMembers = remainingMembers.filter(
							(m) => !typeEquals(m, literalType),
						);
					}
				} else if (
					subject.kind !== "error" &&
					!typeEquals(subject, literalBase(literalType))
				) {
					this.error(
						literal.span,
						`Pattern type '${typeToString(literalBase(literalType))}' does not match subject '${typeToString(subject)}'`,
					);
				}
				coveredLiterals.add(literal.value);
			}
			this.checkBlock(switchCase.body, caseScope);
		}
		if (hasDefault || subject.kind === "error") return;
		if (subject.kind === "enum") {
			const missing = subject.info.cases
				.map((c) => c.name)
				.filter((name) => !coveredCases.has(name));
			if (missing.length > 0) {
				this.error(
					stmt.subject.span,
					`Switch is not exhaustive; missing cases: ${missing.join(", ")}`,
				);
			}
			return;
		}
		if (remainingMembers !== null) {
			if (remainingMembers.length > 0) {
				this.error(
					stmt.subject.span,
					`Switch is not exhaustive; missing: ${remainingMembers
						.map((m) => typeToString(m))
						.join(", ")}`,
				);
			}
			return;
		}
		if (
			subject.kind === "bool" &&
			coveredLiterals.has(true) &&
			coveredLiterals.has(false)
		) {
			return;
		}
		this.error(stmt.subject.span, "Switch requires a 'default' case");
	}

	// ---- Assignment targets ----

	private checkAssignTarget(target: Expr): void {
		switch (target.kind) {
			case "ident": {
				const sym = this.scope.lookup(target.name);
				if (sym?.kind === "value") {
					if (!sym.mutable) {
						this.error(
							target.span,
							`Cannot assign to 'let' constant '${target.name}'`,
						);
					} else if (sym.origin !== "local") {
						this.error(target.span, "Cannot assign to a host binding");
					}
				} else if (sym) {
					this.error(target.span, "Invalid assignment target");
				}
				return;
			}
			case "member": {
				const rawObjType = this.types.get(target.object) ?? ERROR;
				// Constrained type params assign through their upper bound.
				const objType =
					rawObjType.kind === "typeParam" && rawObjType.info.constraint
						? rawObjType.info.constraint
						: rawObjType;
				if (target.optional) {
					this.error(target.span, "Cannot assign through '?.'");
					return;
				}
				if (objType.kind === "struct") {
					const field = objType.info.fields.find((f) => f.name === target.name);
					if (field && !field.mutable) {
						this.error(
							target.nameSpan,
							`Cannot assign to 'let' property '${target.name}'`,
						);
					}
					this.requireMutableBase(target.object);
					return;
				}
				if (objType.kind === "host") {
					const prop = objType.info.props.get(target.name);
					if (prop && !prop.mutable) {
						this.error(
							target.nameSpan,
							`Cannot assign to read-only property '${target.name}'`,
						);
					}
					return;
				}
				if (objType.kind === "class") {
					const field = lookupClassField(objType, target.name);
					const ctx = this.classCtx.at(-1);
					// `let` fields may only be assigned via `self.x` inside init,
					// and only for fields the class itself declares.
					const selfInit =
						ctx?.inInit === true &&
						target.object.kind === "ident" &&
						target.object.name === "self" &&
						field?.owner === ctx.instance.info;
					if (field && !field.mutable && !selfInit) {
						this.error(
							target.nameSpan,
							`Cannot assign to 'let' property '${target.name}'`,
						);
					}
					return; // reference type: the binding itself may be `let`
				}
				if (objType.kind === "protocol") {
					const prop = objType.info.props.get(target.name);
					if (prop && !prop.mutable) {
						this.error(
							target.nameSpan,
							`Cannot assign to read-only property '${target.name}'`,
						);
					}
					return;
				}
				if (objType.kind !== "error") {
					this.error(target.span, "Invalid assignment target");
				}
				return;
			}
			case "subscript": {
				const objType = this.types.get(target.object) ?? ERROR;
				if (objType.kind === "array" || objType.kind === "dictionary") {
					this.requireMutableBase(target.object);
				} else if (objType.kind !== "error") {
					this.error(target.span, "Invalid assignment target");
				}
				return;
			}
			default:
				this.error(target.span, "Invalid assignment target");
		}
	}

	/** Swift-style mutability: every hop up to the root binding must be mutable. */
	private requireMutableBase(expr: Expr): void {
		switch (expr.kind) {
			case "ident": {
				const sym = this.scope.lookup(expr.name);
				if (sym?.kind === "value" && !sym.mutable) {
					this.error(
						expr.span,
						`Cannot mutate '${expr.name}' because it is a 'let' constant`,
					);
				}
				return;
			}
			case "member": {
				const objType = this.types.get(expr.object) ?? ERROR;
				if (objType.kind === "struct") {
					const field = objType.info.fields.find((f) => f.name === expr.name);
					if (field && !field.mutable) {
						this.error(
							expr.nameSpan,
							`Cannot mutate through 'let' property '${expr.name}'`,
						);
					}
					this.requireMutableBase(expr.object);
					return;
				}
				if (
					objType.kind === "host" ||
					objType.kind === "class" ||
					objType.kind === "protocol"
				) {
					return; // reference types
				}
				if (objType.kind !== "error") {
					this.error(expr.span, "Cannot mutate this value");
				}
				return;
			}
			case "subscript": {
				const objType = this.types.get(expr.object) ?? ERROR;
				if (objType.kind === "array" || objType.kind === "dictionary") {
					this.requireMutableBase(expr.object);
					return;
				}
				if (objType.kind !== "error") {
					this.error(expr.span, "Cannot mutate this value");
				}
				return;
			}
			default:
				this.error(expr.span, "Cannot mutate this value");
		}
	}

	// ---- Expressions ----

	private checkExpr(expr: Expr, expected?: Type): Type {
		const type = this.computeExpr(expr, expected);
		this.types.set(expr, type);
		this.markInjectionWraps(expr, type, expected);
		return type;
	}

	/**
	 * When a value is injected into extra optional layers (T used where T??
	 * is expected), each added BOXED layer contributes one `{$some: ...}`.
	 * Passthrough markers (`await`/`try`) are skipped: their operand was
	 * checked against the same expectation and already carries the mark.
	 */
	private markInjectionWraps(
		expr: Expr,
		actual: Type,
		expected: Type | undefined,
	): void {
		if (expected === undefined || expected.kind !== "optional") return;
		if (actual.kind === "error") return;
		if (expr.kind === "await" || expr.kind === "try") return;
		const layers = optionalDepth(expected) - optionalDepth(actual);
		if (layers <= 0) return;
		let wraps = 0;
		let cur: Type = expected;
		for (let i = 0; i < layers && cur.kind === "optional"; i++) {
			if (boxedRepr(cur)) wraps++;
			cur = cur.inner;
		}
		if (wraps > 0) {
			this.addCoercion(expr, { kind: "wrap", count: wraps }, "post", expr.span);
		}
	}

	/**
	 * Writing a field declared with an optional type parameter (or a host
	 * property) converts the value into the storage convention: uniform for
	 * struct/class fields, plain for host properties.
	 */
	private markMemberWrite(target: Expr, value: Expr): void {
		if (target.kind !== "member") return;
		const rawObjType = this.types.get(target.object) ?? ERROR;
		const objType =
			rawObjType.kind === "typeParam" && rawObjType.info.constraint
				? rawObjType.info.constraint
				: rawObjType;
		if (objType.kind === "struct") {
			const field = objType.info.fields.find((f) => f.name === target.name);
			if (!field || objType.info.typeParams.length === 0) return;
			const subst = buildSubst(objType.info.typeParams, objType.typeArgs);
			this.addCoercion(
				value,
				genericCoercion(field.type, subst, "toGeneric"),
				"post",
				value.span,
			);
			return;
		}
		if (objType.kind === "class") {
			const field = lookupClassField(objType, target.name);
			if (!field || field.subst.size === 0) return;
			this.addCoercion(
				value,
				genericCoercion(field.declared, field.subst, "toGeneric"),
				"post",
				value.span,
			);
			return;
		}
		if (objType.kind === "host") {
			const prop = objType.info.props.get(target.name);
			if (!prop) return;
			const subst = buildSubst(objType.info.typeParams, objType.typeArgs);
			this.addCoercion(
				value,
				hostCoercion(prop.type, subst, "toHost"),
				"post",
				value.span,
			);
		}
	}

	/** Record a representation conversion on `expr` (composing in order). */
	private addCoercion(
		expr: Expr,
		co: CoercionResult,
		phase: "pre" | "post",
		span: Span,
	): void {
		if (co === null) return;
		if (co === "unsupported") {
			this.error(
				span,
				"Optional type parameters under arrays, dictionaries, or async function types cannot cross this generic boundary yet",
			);
			return;
		}
		const mark = this.coercions.get(expr) ?? {};
		mark[phase] = mark[phase] === undefined ? co : seqCoercion(mark[phase], co);
		this.coercions.set(expr, mark);
	}

	/** Allow T where T? is expected; otherwise types must match exactly. */
	private conforms(actual: Type, expected: Type): boolean {
		return typeConforms(actual, expected);
	}

	private expectType(
		actual: Type,
		expected: Type | undefined,
		span: Span,
	): Type {
		if (expected === undefined || expected.kind === "error") return actual;
		if (actual.kind === "error") return expected;
		if (this.conforms(actual, expected)) return actual;
		this.error(
			span,
			`Type '${typeToString(actual)}' is not assignable to '${typeToString(expected)}'`,
		);
		return expected;
	}

	private computeExpr(expr: Expr, expected?: Type): Type {
		switch (expr.kind) {
			case "number":
				return this.fitPrimitive(NUMBER, expr.value, expected, expr.span);
			case "bool":
				return this.fitPrimitive(BOOL, expr.value, expected, expr.span);
			case "string": {
				for (const part of expr.parts) {
					if (part.kind === "expr") this.checkExpr(part.expr);
				}
				const literalValue = literalTextOf(expr);
				return this.fitPrimitive(STRING, literalValue, expected, expr.span);
			}
			case "nil":
				if (expected === undefined) {
					this.error(expr.span, "Cannot infer the type of 'nil' here");
					return ERROR;
				}
				if (expected.kind === "optional" || expected.kind === "error") {
					return expected;
				}
				this.error(
					expr.span,
					`'nil' requires an optional type, expected '${typeToString(expected)}'`,
				);
				return ERROR;
			case "ident":
				return this.checkIdent(expr, expected);
			case "dollar": {
				const env = this.dollarStack.at(-1);
				if (!env) {
					this.error(
						expr.span,
						`'$${expr.index}' used outside a shorthand closure`,
					);
					return ERROR;
				}
				if (expr.index >= env.length) {
					this.error(
						expr.span,
						`Closure only has ${env.length} parameter(s); '$${expr.index}' is out of range`,
					);
					return ERROR;
				}
				return env[expr.index];
			}
			case "array": {
				const expectedElement =
					expected?.kind === "array" ? expected.element : undefined;
				if (expr.elements.length === 0) {
					if (expected?.kind === "array") return expected;
					if (expected?.kind !== "error") {
						this.error(
							expr.span,
							"Cannot infer the element type of an empty array",
						);
					}
					return expected ?? ERROR;
				}
				let element = expectedElement;
				for (const item of expr.elements) {
					const t = this.checkExpr(item, element);
					element ??= t;
					this.markCopy(item, t);
				}
				return this.expectType(arrayOf(element ?? ERROR), expected, expr.span);
			}
			case "dict": {
				const expectedDict =
					expected?.kind === "dictionary" ? expected : undefined;
				const keyLiterals = expectedDict
					? stringLiteralMembers(expectedDict.key)
					: null;
				if (expr.entries.length === 0) {
					if (expectedDict) {
						if (keyLiterals !== null) {
							this.error(
								expr.span,
								"Exhaustive-key dictionaries cannot be empty; provide every key",
							);
						}
						return expectedDict;
					}
					if (expected?.kind !== "error") {
						this.error(
							expr.span,
							"Cannot infer the value type of an empty dictionary",
						);
					}
					return expected ?? ERROR;
				}
				let value = expectedDict?.value;
				const seenKeys = new Set<string>();
				for (const entry of expr.entries) {
					this.checkExpr(entry.key, expectedDict ? expectedDict.key : STRING);
					if (keyLiterals !== null) {
						const literalKey = entry.computed ? null : literalTextOf(entry.key);
						if (literalKey === null) {
							this.error(
								entry.key.span,
								"Exhaustive-key dictionaries require literal keys",
							);
						} else if (seenKeys.has(literalKey)) {
							this.error(entry.key.span, `Duplicate key '${literalKey}'`);
						} else {
							seenKeys.add(literalKey);
						}
					}
					const t = this.checkExpr(entry.value, value);
					value ??= t;
					this.markCopy(entry.value, t);
				}
				if (keyLiterals !== null) {
					const missing = keyLiterals.filter((k) => !seenKeys.has(k));
					if (missing.length > 0) {
						this.error(
							expr.span,
							`Exhaustive-key dictionary is missing: ${missing
								.map((k) => `'${k}'`)
								.join(", ")}`,
						);
					}
				}
				if (expectedDict) return expectedDict;
				return this.expectType(
					dictionaryOf(STRING, value ?? ERROR),
					expected,
					expr.span,
				);
			}
			case "superRef":
				this.error(
					expr.span,
					"'super' can only be used to call superclass methods or 'super.init'",
				);
				return ERROR;
			case "is": {
				const operand = this.checkExpr(expr.operand);
				const target = this.resolveType(expr.type);
				if (target.kind === "literal") {
					this.error(
						expr.type.span,
						"Use '==' to compare against a literal value",
					);
				} else if (target.kind === "protocol") {
					this.error(
						expr.type.span,
						"Protocol types cannot be tested at runtime",
					);
				} else if (operand.kind === "union") {
					const { matched } = matchUnionMembers(operand, target);
					if (matched.length === 0 && target.kind !== "error") {
						this.error(
							expr.type.span,
							`'${typeToString(target)}' is not a member of '${typeToString(operand)}'`,
						);
					}
				} else if (operand.kind !== "error") {
					this.error(
						expr.operand.span,
						`'is' requires a union-typed value, got '${typeToString(operand)}'`,
					);
				}
				this.resolutions.set(expr, { kind: "isCheck", target });
				return this.expectType(BOOL, expected, expr.span);
			}
			case "await": {
				if (!(this.asyncAllowedStack.at(-1) ?? false)) {
					this.error(
						expr.span,
						"'await' is only allowed at the top level or inside async functions",
					);
				}
				const seenBefore = this.asyncCallsSeen;
				this.awaitDepth++;
				const t = this.checkExpr(expr.operand, expected);
				this.awaitDepth--;
				if (this.asyncCallsSeen === seenBefore && t.kind !== "error") {
					this.error(expr.span, "'await' has no async operations");
				}
				return t;
			}
			case "try": {
				const seenBefore = this.throwingCallsSeen;
				this.tryDepth++;
				const t = this.checkExpr(expr.operand, expected);
				this.tryDepth--;
				if (this.throwingCallsSeen === seenBefore && t.kind !== "error") {
					this.error(expr.span, "'try' has no throwing operations");
				}
				return t;
			}
			case "doExpr":
				return this.checkDoExpr(expr, expected);
			case "closure":
				return this.checkClosure(expr, expected);
			case "call":
				return this.expectType(
					this.checkCall(expr, expected),
					expected,
					expr.span,
				);
			case "member":
				return this.expectType(
					this.checkMember(expr, expected),
					expected,
					expr.span,
				);
			case "subscript": {
				const objType = this.checkExpr(expr.object);
				const { base, chained } = this.unwrapChain(expr.object, objType, expr);
				let result: Type;
				if (base.kind === "array") {
					this.checkExpr(expr.index, NUMBER);
					result = base.element;
				} else if (base.kind === "dictionary") {
					this.checkExpr(expr.index, base.key);
					// Exhaustive-key dictionaries always contain every key.
					result =
						stringLiteralMembers(base.key) !== null
							? base.value
							: optionalOf(base.value);
				} else {
					this.checkExpr(expr.index);
					if (base.kind !== "error") {
						this.error(
							expr.span,
							`Cannot subscript a value of type '${typeToString(base)}'`,
						);
					}
					result = ERROR;
				}
				if (chained) {
					this.chainOptional.add(expr);
					result = result.kind === "optional" ? result : optionalOf(result);
				}
				return this.expectType(result, expected, expr.span);
			}
			case "force": {
				const t = this.checkExpr(expr.operand);
				if (t.kind === "optional") {
					return this.expectType(t.inner, expected, expr.span);
				}
				if (t.kind !== "error") {
					this.error(
						expr.operand.span,
						`Cannot force-unwrap non-optional type '${typeToString(t)}'`,
					);
				}
				return ERROR;
			}
			case "unary": {
				if (expr.op === "!") {
					this.checkExpr(expr.operand, BOOL);
					return this.expectType(BOOL, expected, expr.span);
				}
				this.checkExpr(expr.operand, NUMBER);
				return this.expectType(NUMBER, expected, expr.span);
			}
			case "binary":
				return this.expectType(this.checkBinary(expr), expected, expr.span);
			case "ternary": {
				this.checkExpr(expr.cond, BOOL);
				if (expected !== undefined) {
					this.checkExpr(expr.thenExpr, expected);
					this.checkExpr(expr.elseExpr, expected);
					return expected;
				}
				if (expr.thenExpr.kind === "nil") {
					const elseType = this.checkExpr(expr.elseExpr);
					const result =
						elseType.kind === "optional" ? elseType : optionalOf(elseType);
					this.checkExpr(expr.thenExpr, result);
					return result;
				}
				const thenType = this.checkExpr(expr.thenExpr);
				if (expr.elseExpr.kind === "nil") {
					const result =
						thenType.kind === "optional" ? thenType : optionalOf(thenType);
					this.checkExpr(expr.elseExpr, result);
					return result;
				}
				const elseType = this.checkExpr(expr.elseExpr);
				if (!typeEquals(thenType, elseType)) {
					this.error(
						expr.span,
						`Ternary branches have different types: '${typeToString(thenType)}' and '${typeToString(elseType)}'`,
					);
				}
				return thenType;
			}
		}
	}

	/** Literal expressions narrow to literal types when the context asks. */
	private fitPrimitive(
		base: Type,
		literalValue: number | string | boolean | null,
		expected: Type | undefined,
		span: Span,
	): Type {
		if (
			expected !== undefined &&
			literalValue !== null &&
			(expected.kind === "literal" || expected.kind === "union")
		) {
			const literal = literalOf(literalValue);
			if (typeConforms(literal, expected)) return literal;
		}
		return this.expectType(base, expected, span);
	}

	private checkIdent(expr: Expr & { kind: "ident" }, expected?: Type): Type {
		const sym = this.scope.lookup(expr.name);
		if (!sym) {
			this.error(expr.span, `Unknown identifier '${expr.name}'`);
			return ERROR;
		}
		if (sym.kind === "value") {
			this.resolutions.set(expr, identResolution(sym));
			this.hovers.push({
				span: expr.span,
				text: `${sym.mutable ? "var" : "let"} ${sym.name}: ${typeToString(sym.type)}`,
			});
			return this.expectType(sym.type, expected, expr.span);
		}
		if (sym.kind === "package") {
			this.error(expr.span, `'${expr.name}' cannot be used as a value`);
			return ERROR;
		}
		this.resolutions.set(expr, { kind: "typeRef" });
		this.error(expr.span, `Type '${expr.name}' cannot be used as a value`);
		return ERROR;
	}

	/** Unwrap the object type for `?.` chains (and their JS-style propagation). */
	private unwrapChain(
		object: Expr,
		objType: Type,
		node: Expr,
	): { base: Type; chained: boolean } {
		const isChainLink =
			(node.kind === "member" && node.optional) ||
			(objType.kind === "optional" && this.chainOptional.has(object));
		if (isChainLink) {
			if (objType.kind === "optional") {
				return { base: objType.inner, chained: true };
			}
			if (node.kind === "member" && node.optional && objType.kind !== "error") {
				this.error(
					node.span,
					`'?.' requires an optional value, got '${typeToString(objType)}'`,
				);
			}
			return { base: objType, chained: objType.kind !== "error" };
		}
		if (objType.kind === "optional") {
			this.error(
				object.span,
				`Value of optional type '${typeToString(objType)}' must be unwrapped with '?.', '!', or 'if let'`,
			);
			return { base: objType.inner, chained: false };
		}
		return { base: objType, chained: false };
	}

	private checkMember(expr: Expr & { kind: "member" }, expected?: Type): Type {
		if (expr.object.kind === "superRef") {
			this.error(
				expr.span,
				"'super' can only be used to call superclass methods or 'super.init'",
			);
			return ERROR;
		}
		// Special bases: package/module namespaces and enum type names.
		if (expr.object.kind === "ident") {
			const sym = this.scope.lookup(expr.object.name);
			if (sym?.kind === "package") {
				this.types.set(expr.object, VOID);
				this.resolutions.set(expr.object, {
					kind: "packageRef",
					packageName: sym.name,
				});
				const member = sym.members.get(expr.name);
				if (!member) {
					this.error(
						expr.nameSpan,
						`'${sym.name}' has no member '${expr.name}'`,
					);
					return ERROR;
				}
				if (member.kind === "type") {
					this.error(
						expr.nameSpan,
						`Types are accessed without the namespace prefix: use '${expr.name}'`,
					);
					return ERROR;
				}
				this.resolutions.set(
					expr,
					sym.runtime === "module"
						? {
								kind: "moduleMember",
								moduleName: sym.moduleName ?? sym.name,
								memberName: expr.name,
							}
						: {
								kind: "packageMember",
								packageName: sym.name,
								memberName: expr.name,
							},
				);
				this.hovers.push({
					span: expr.nameSpan,
					text: `${sym.name}.${expr.name}: ${typeToString(member.type)}`,
				});
				return member.type;
			}
			if (sym?.kind === "type" && sym.type.kind === "enum") {
				this.types.set(expr.object, sym.type);
				this.resolutions.set(expr.object, { kind: "typeRef" });
				const info = sym.type.info;
				const caseInfo = info.cases.find((c) => c.name === expr.name);
				if (!caseInfo) {
					this.error(
						expr.nameSpan,
						`Enum '${info.name}' has no case '${expr.name}'`,
					);
					return ERROR;
				}
				this.resolutions.set(expr, {
					kind: "enumCase",
					info,
					caseName: expr.name,
				});
				if (caseInfo.assoc.length > 0) {
					this.error(
						expr.nameSpan,
						`Case '${expr.name}' requires associated values`,
					);
					return ERROR;
				}
				return this.solveEnumInstance(sym.type, expected, expr.span);
			}
			if (sym?.kind === "type") {
				this.types.set(expr.object, sym.type);
				this.resolutions.set(expr.object, { kind: "typeRef" });
				this.error(expr.nameSpan, "Types have no static members");
				return ERROR;
			}
		}
		const objType = this.checkExpr(expr.object);
		const { base, chained } = this.unwrapChain(expr.object, objType, expr);
		const memberType = this.memberTypeOf(base, expr);
		if (chained) {
			this.chainOptional.add(expr);
			return memberType.kind === "optional"
				? memberType
				: optionalOf(memberType);
		}
		return memberType;
	}

	/** Infer type arguments of a generic enum from the expected type. */
	private solveEnumInstance(
		type: Type & { kind: "enum" },
		expected: Type | undefined,
		span: Span,
	): Type {
		if (type.info.typeParams.length === 0) return type;
		const subst: Substitution = new Map();
		if (expected !== undefined) {
			unify(type, expected, subst, type.info.typeParams);
		}
		const open = unsolvedParams(type, subst, type.info.typeParams);
		if (open.length > 0) {
			this.error(
				span,
				`Cannot infer generic arguments for '${type.info.name}'; add a type annotation`,
			);
			for (const info of open) subst.set(info.id, ERROR);
		}
		this.checkConstraints(type.info.typeParams, subst, span);
		return substitute(type, subst);
	}

	private memberTypeOf(base: Type, expr: Expr & { kind: "member" }): Type {
		switch (base.kind) {
			case "struct": {
				const field = base.info.fields.find((f) => f.name === expr.name);
				if (!field) {
					this.error(
						expr.nameSpan,
						`'${base.info.name}' has no property '${expr.name}'`,
					);
					return ERROR;
				}
				const subst = buildSubst(base.info.typeParams, base.typeArgs);
				const fieldType = substitute(field.type, subst);
				if (base.info.typeParams.length > 0) {
					this.addCoercion(
						expr,
						genericCoercion(field.type, subst, "fromGeneric"),
						"pre",
						expr.nameSpan,
					);
				}
				this.hovers.push({
					span: expr.nameSpan,
					text: `${field.mutable ? "var" : "let"} ${expr.name}: ${typeToString(fieldType)}`,
				});
				return fieldType;
			}
			case "host": {
				const prop = base.info.props.get(expr.name);
				if (prop) {
					const subst = buildSubst(base.info.typeParams, base.typeArgs);
					const propType = substitute(prop.type, subst);
					this.addCoercion(
						expr,
						hostCoercion(prop.type, subst, "fromHost"),
						"pre",
						expr.nameSpan,
					);
					this.hovers.push({
						span: expr.nameSpan,
						text: `${prop.mutable ? "var" : "let"} ${expr.name}: ${typeToString(propType)}`,
					});
					return propType;
				}
				if (base.info.methods.has(expr.name)) {
					this.error(expr.nameSpan, `Method '${expr.name}' must be called`);
					return ERROR;
				}
				this.error(
					expr.nameSpan,
					`'${base.info.name}' has no member '${expr.name}'`,
				);
				return ERROR;
			}
			case "class": {
				const field = lookupClassField(base, expr.name);
				if (field) {
					if (field.subst.size > 0) {
						this.addCoercion(
							expr,
							genericCoercion(field.declared, field.subst, "fromGeneric"),
							"pre",
							expr.nameSpan,
						);
					}
					this.hovers.push({
						span: expr.nameSpan,
						text: `${field.mutable ? "var" : "let"} ${expr.name}: ${typeToString(field.type)}`,
					});
					return field.type;
				}
				if (lookupClassMethod(base, expr.name) !== null) {
					this.error(expr.nameSpan, `Method '${expr.name}' must be called`);
					return ERROR;
				}
				this.error(
					expr.nameSpan,
					`'${base.info.name}' has no member '${expr.name}'`,
				);
				return ERROR;
			}
			case "protocol": {
				const subst = buildSubst(base.info.typeParams, base.typeArgs);
				const prop = base.info.props.get(expr.name);
				if (prop) {
					const propType = substitute(prop.type, subst);
					this.hovers.push({
						span: expr.nameSpan,
						text: `${prop.mutable ? "var" : "let"} ${expr.name}: ${typeToString(propType)}`,
					});
					return propType;
				}
				if (base.info.methods.has(expr.name)) {
					this.error(expr.nameSpan, `Method '${expr.name}' must be called`);
					return ERROR;
				}
				this.error(
					expr.nameSpan,
					`'${base.info.name}' has no member '${expr.name}'`,
				);
				return ERROR;
			}
			case "array":
			case "string":
			case "dictionary": {
				const receiver = base.kind;
				const member =
					base.kind === "array"
						? getArrayMember(base.element, expr.name)
						: base.kind === "string"
							? getStringMember(expr.name)
							: getDictionaryMember(base.key, base.value, expr.name);
				if (!member) {
					this.error(
						expr.nameSpan,
						`'${typeToString(base)}' has no member '${expr.name}'`,
					);
					return ERROR;
				}
				if (member.kind === "method") {
					this.error(expr.nameSpan, `Method '${expr.name}' must be called`);
					return ERROR;
				}
				this.resolutions.set(expr, {
					kind: "builtinProp",
					receiver,
					name: expr.name,
				});
				return member.type;
			}
			case "typeParam":
				// A constrained param exposes its upper bound's members.
				if (base.info.constraint) {
					return this.memberTypeOf(base.info.constraint, expr);
				}
				this.error(expr.nameSpan, `'${typeToString(base)}' has no members`);
				return ERROR;
			case "error":
				return ERROR;
			default:
				this.error(expr.nameSpan, `'${typeToString(base)}' has no members`);
				return ERROR;
		}
	}

	private checkBinary(expr: Expr & { kind: "binary" }): Type {
		const { op } = expr;
		if (op === "??") {
			const left = this.checkExpr(expr.left);
			if (left.kind === "error") {
				this.checkExpr(expr.right);
				return ERROR;
			}
			if (left.kind !== "optional") {
				this.error(
					expr.left.span,
					`Left side of '??' must be optional, got '${typeToString(left)}'`,
				);
				this.checkExpr(expr.right);
				return left;
			}
			// `T? ?? T -> T` and `T? ?? T? -> T?`. Deferred right sides (nil,
			// closures, empty collections) are checked against the optional type.
			if (isDeferredExpr(expr.right)) {
				const expectedRight = expr.right.kind === "nil" ? left : left.inner;
				this.checkExpr(expr.right, expectedRight);
				return expectedRight;
			}
			const right = this.checkExpr(expr.right);
			if (this.conforms(right, left.inner)) return left.inner;
			if (typeEquals(right, left)) return left;
			this.error(
				expr.right.span,
				`Type '${typeToString(right)}' is not assignable to '${typeToString(left.inner)}'`,
			);
			return left.inner;
		}
		if (op === "||" || op === "&&") {
			this.checkExpr(expr.left, BOOL);
			this.checkExpr(expr.right, BOOL);
			return BOOL;
		}
		if (op === "==" || op === "!=") {
			if (expr.right.kind === "nil" || expr.left.kind === "nil") {
				const valueSide = expr.right.kind === "nil" ? expr.left : expr.right;
				const nilSide = expr.right.kind === "nil" ? expr.right : expr.left;
				const t = this.checkExpr(valueSide);
				this.types.set(nilSide, t);
				if (t.kind !== "optional" && t.kind !== "error") {
					this.error(
						valueSide.span,
						`Comparing non-optional '${typeToString(t)}' to 'nil'`,
					);
				}
				return BOOL;
			}
			const left = this.checkExpr(expr.left);
			this.checkExpr(expr.right, left);
			if (!isEquatable(left)) {
				this.error(
					expr.left.span,
					`'${op}' is not supported for '${typeToString(left)}'`,
				);
			}
			return BOOL;
		}
		if (op === "<" || op === "<=" || op === ">" || op === ">=") {
			const left = this.checkExpr(expr.left);
			this.checkExpr(expr.right, left);
			if (
				left.kind !== "number" &&
				left.kind !== "string" &&
				left.kind !== "error"
			) {
				this.error(
					expr.left.span,
					`'${op}' requires Number or String operands`,
				);
			}
			return BOOL;
		}
		if (op === "+") {
			const left = this.checkExpr(expr.left);
			if (left.kind === "string") {
				this.checkExpr(expr.right, STRING);
				return STRING;
			}
			if (left.kind === "number" || left.kind === "error") {
				this.checkExpr(expr.right, NUMBER);
				return NUMBER;
			}
			this.error(
				expr.left.span,
				`'+' requires Number or String operands, got '${typeToString(left)}'`,
			);
			this.checkExpr(expr.right);
			return ERROR;
		}
		this.checkExpr(expr.left, NUMBER);
		this.checkExpr(expr.right, NUMBER);
		return NUMBER;
	}

	private checkClosure(
		expr: Expr & { kind: "closure" },
		expected?: Type,
	): Type {
		const expectedFunc = expected?.kind === "func" ? expected : undefined;
		const paramTypes: Type[] = [];
		const paramNames: string[] = [];
		let dollarMode = false;
		if (expr.hasHeader) {
			if (expectedFunc && expectedFunc.params.length !== expr.params.length) {
				this.error(
					expr.span,
					`Closure takes ${expr.params.length} parameter(s), but ${expectedFunc.params.length} expected`,
				);
			}
			for (const [i, param] of expr.params.entries()) {
				let type: Type;
				if (param.type) {
					type = this.resolveType(param.type);
				} else {
					const fromExpected = expectedFunc?.params[i]?.type;
					if (fromExpected === undefined || fromExpected.kind === "typeParam") {
						this.error(
							param.nameSpan,
							`Cannot infer the type of parameter '${param.name}'; add an annotation`,
						);
						type = ERROR;
					} else {
						type = fromExpected;
					}
				}
				paramTypes.push(type);
				paramNames.push(param.name);
			}
		} else if (expectedFunc) {
			dollarMode = true;
			for (const [i, param] of expectedFunc.params.entries()) {
				const type = param.type;
				if (type.kind === "typeParam") {
					this.error(
						expr.span,
						"Cannot infer shorthand closure parameter types here; use explicit parameters",
					);
					paramTypes.push(ERROR);
				} else {
					paramTypes.push(type);
				}
				paramNames.push(`$${i}`);
			}
		}
		// Return type: annotation > expected (unless an unsolved type param) > infer
		let ret: Type | "infer";
		if (expr.retType) {
			ret = this.resolveType(expr.retType);
		} else if (expectedFunc && expectedFunc.ret.kind !== "typeParam") {
			ret = expectedFunc.ret;
		} else {
			ret = "infer";
		}
		const scope = new Scope(this.scope, "function");
		if (!dollarMode) {
			for (const [i, name] of paramNames.entries()) {
				if (
					!scope.declare({
						kind: "value",
						name,
						type: paramTypes[i],
						mutable: false,
						origin: "local",
					})
				) {
					this.error(
						expr.params[i]?.nameSpan ?? expr.span,
						`Duplicate parameter '${name}'`,
					);
				}
			}
		}
		const ctx: FuncContext = { ret };
		this.funcStack.push(ctx);
		this.dollarStack.push(dollarMode ? paramTypes : null);
		this.asyncAllowedStack.push(false);
		this.throwsAllowedStack.push(false);
		const savedAwaitDepth = this.awaitDepth;
		this.awaitDepth = 0;
		const savedTryDepth = this.tryDepth;
		this.tryDepth = 0;
		let implicitReturn = false;
		const single = expr.body.length === 1 ? expr.body[0] : undefined;
		if (single?.kind === "expr") {
			const saved = this.scope;
			this.scope = scope;
			const bodySpan = spanOfStmts(expr.body);
			if (bodySpan) this.scopeRecords.push({ span: bodySpan, scope });
			if (ret === "infer") {
				const t = this.checkExpr(single.expr);
				ctx.inferred = t;
				implicitReturn = t.kind !== "void";
			} else if (ret.kind === "void") {
				this.checkExpr(single.expr);
			} else {
				const t = this.checkExpr(single.expr, ret);
				this.markCopy(single.expr, t);
				implicitReturn = true;
			}
			this.scope = saved;
		} else {
			this.checkBlock(expr.body, scope);
		}
		this.awaitDepth = savedAwaitDepth;
		this.tryDepth = savedTryDepth;
		this.throwsAllowedStack.pop();
		this.asyncAllowedStack.pop();
		this.dollarStack.pop();
		this.funcStack.pop();
		const finalRet = ret === "infer" ? (ctx.inferred ?? VOID) : ret;
		if (
			!implicitReturn &&
			finalRet.kind !== "void" &&
			finalRet.kind !== "error" &&
			!alwaysExits(expr.body)
		) {
			this.error(expr.span, "Closure is missing a return on some paths");
		}
		this.resolutions.set(expr, {
			kind: "closure",
			paramNames,
			implicitReturn,
		});
		return {
			kind: "func",
			isAsync: false,
			typeParams: [],
			params: paramTypes.map((type) => ({
				label: null,
				type,
				hasDefault: false,
			})),
			ret: finalRet,
		};
	}

	// ---- Calls ----

	private checkCall(expr: Expr & { kind: "call" }, expected?: Type): Type {
		const callee = expr.callee;
		// Struct initializer / enum case / package member / methods
		if (callee.kind === "ident") {
			const sym = this.scope.lookup(callee.name);
			if (sym?.kind === "type") {
				this.types.set(callee, sym.type);
				if (sym.type.kind === "struct") {
					const info = sym.type.info;
					this.resolutions.set(callee, { kind: "structInit", info });
					const initType: FuncType = {
						kind: "func",
						isAsync: false,
						typeParams: info.typeParams,
						params: info.fields.map((f) => ({
							label: f.name,
							type: f.type,
							hasDefault: false,
						})),
						ret: canonicalInstance("struct", info),
					};
					return this.applyCall(expr, initType, expected);
				}
				if (sym.type.kind === "enum") {
					this.error(
						callee.span,
						`Use '${callee.name}.<case>(...)' to construct an enum value`,
					);
					return ERROR;
				}
				if (sym.type.kind === "class") {
					const info = sym.type.info;
					this.resolutions.set(callee, { kind: "classInit", info });
					if (!info.init) {
						for (const arg of expr.args) this.checkExpr(arg.expr);
						return canonicalClass(info);
					}
					return this.applyCall(expr, info.init, expected);
				}
				if (sym.type.kind === "protocol") {
					this.error(callee.span, "Protocols cannot be constructed");
					for (const arg of expr.args) this.checkExpr(arg.expr);
					return ERROR;
				}
				this.error(callee.span, `Type '${callee.name}' is not callable`);
				return ERROR;
			}
		}
		if (callee.kind === "member") {
			const result = this.checkMethodCall(expr, callee, expected);
			if (result !== undefined) return result;
		}
		const calleeType = this.checkExpr(callee);
		if (calleeType.kind === "func") {
			const calleeResolution = this.resolutions.get(callee);
			return this.applyCall(
				expr,
				calleeType,
				expected,
				calleeResolution?.kind === "packageMember"
					? { declared: calleeType, baseSubst: EMPTY_SUBST, convention: "host" }
					: undefined,
			);
		}
		if (calleeType.kind !== "error") {
			this.error(
				callee.span,
				`Cannot call a value of type '${typeToString(calleeType)}'`,
			);
		}
		for (const arg of expr.args) this.checkExpr(arg.expr);
		return ERROR;
	}

	/** Handles enum-case construction and host/builtin method calls. */
	private checkMethodCall(
		expr: Expr & { kind: "call" },
		callee: Expr & { kind: "member" },
		expected?: Type,
	): Type | undefined {
		if (callee.object.kind === "superRef") {
			return this.checkSuperCall(expr, callee);
		}
		if (callee.object.kind === "ident") {
			const sym = this.scope.lookup(callee.object.name);
			if (sym?.kind === "type" && sym.type.kind === "enum") {
				this.types.set(callee.object, sym.type);
				this.resolutions.set(callee.object, { kind: "typeRef" });
				const info = sym.type.info;
				const caseInfo = info.cases.find((c) => c.name === callee.name);
				if (!caseInfo) {
					this.error(
						callee.nameSpan,
						`Enum '${info.name}' has no case '${callee.name}'`,
					);
					for (const arg of expr.args) this.checkExpr(arg.expr);
					return ERROR;
				}
				this.resolutions.set(callee, {
					kind: "enumCase",
					info,
					caseName: callee.name,
				});
				this.types.set(callee, sym.type);
				const caseType: FuncType = {
					kind: "func",
					isAsync: false,
					typeParams: info.typeParams,
					params: caseInfo.assoc.map((a) => ({
						label: a.label,
						type: a.type,
						hasDefault: false,
					})),
					ret: canonicalInstance("enum", info),
				};
				return this.applyCall(expr, caseType, expected);
			}
			if (sym?.kind === "package") {
				// Fall through to checkMember, which resolves namespace members;
				// the resulting func type is applied via the generic call path.
				return undefined;
			}
		}
		const objType = this.checkExpr(callee.object);
		const { base: rawBase, chained } = this.unwrapChain(
			callee.object,
			objType,
			callee,
		);
		// A constrained type param dispatches through its upper bound.
		const base =
			rawBase.kind === "typeParam" && rawBase.info.constraint
				? rawBase.info.constraint
				: rawBase;
		let methodType: FuncType | undefined;
		let boundary: CallBoundary | undefined;
		if (base.kind === "host") {
			const method = base.info.methods.get(callee.name);
			if (method) {
				const subst = buildSubst(base.info.typeParams, base.typeArgs);
				const func = substitute(method, subst);
				if (func.kind === "func") {
					methodType = func;
					boundary = { declared: method, baseSubst: subst, convention: "host" };
					this.resolutions.set(callee, {
						kind: "hostMethod",
						name: callee.name,
					});
					this.hovers.push({
						span: callee.nameSpan,
						text: `fn ${callee.name}${typeToString(func)}`,
					});
				}
			}
		} else if (base.kind === "class") {
			const method = lookupClassMethod(base, callee.name);
			if (method) {
				methodType = method.func;
				boundary = {
					declared: method.declared,
					baseSubst: method.subst,
					convention: "uniform",
				};
				this.resolutions.set(callee, {
					kind: "classMethod",
					name: callee.name,
				});
				this.hovers.push({
					span: callee.nameSpan,
					text: `fn ${callee.name}${typeToString(method.func)}`,
				});
			}
		} else if (base.kind === "protocol") {
			const declared = base.info.methods.get(callee.name);
			if (declared) {
				const subst = buildSubst(base.info.typeParams, base.typeArgs);
				const func = substitute(declared, subst);
				if (func.kind === "func") {
					methodType = func;
					this.resolutions.set(callee, {
						kind: "classMethod",
						name: callee.name,
					});
					this.hovers.push({
						span: callee.nameSpan,
						text: `fn ${callee.name}${typeToString(func)}`,
					});
				}
			}
		} else if (base.kind === "struct" || base.kind === "enum") {
			const entry = base.info.methods.get(callee.name);
			if (entry) {
				const subst = buildSubst(base.info.typeParams, base.typeArgs);
				const func = substitute(entry.func, subst);
				if (func.kind === "func") {
					methodType = func;
					boundary = {
						declared: entry.func,
						baseSubst: subst,
						convention: "uniform",
					};
					this.resolutions.set(callee, {
						kind: "valueMethod",
						ownerName: base.info.name,
						moduleName: base.info.moduleName,
						name: callee.name,
					});
					if (entry.mutating) this.requireMutableBase(callee.object);
					this.hovers.push({
						span: callee.nameSpan,
						text: `fn ${callee.name}${typeToString(func)}`,
					});
				}
			}
		} else if (
			base.kind === "array" ||
			base.kind === "string" ||
			base.kind === "dictionary"
		) {
			const member =
				base.kind === "array"
					? getArrayMember(base.element, callee.name)
					: base.kind === "string"
						? getStringMember(callee.name)
						: getDictionaryMember(base.key, base.value, callee.name);
			if (member?.kind === "method") {
				methodType = member.func;
				this.resolutions.set(callee, {
					kind: "builtinMethod",
					receiver: base.kind,
					name: callee.name,
				});
				if (member.mutating) this.requireMutableBase(callee.object);
				if (
					base.kind === "dictionary" &&
					callee.name === "removeValue" &&
					stringLiteralMembers(base.key) !== null
				) {
					this.error(
						callee.nameSpan,
						"'removeValue' is not available on exhaustive-key dictionaries",
					);
				}
			}
		}
		if (methodType === undefined) {
			// Not a method: treat as a member access producing a callable value.
			const memberType = this.memberTypeOf(base, callee);
			const adjusted =
				chained && memberType.kind !== "optional"
					? optionalOf(memberType)
					: memberType;
			this.types.set(callee, adjusted);
			if (chained) this.chainOptional.add(callee);
			if (memberType.kind === "func") {
				if (chained) {
					this.error(
						callee.span,
						"Cannot call an optional function; unwrap it first",
					);
					return ERROR;
				}
				return this.applyCall(expr, memberType, expected);
			}
			if (memberType.kind !== "error") {
				this.error(callee.nameSpan, `'${callee.name}' is not callable`);
			}
			for (const arg of expr.args) this.checkExpr(arg.expr);
			return ERROR;
		}
		this.types.set(callee, methodType);
		const ret = this.applyCall(
			expr,
			methodType,
			chained ? undefined : expected,
			boundary,
		);
		if (chained) {
			this.chainOptional.add(callee);
			this.chainOptional.add(expr);
			return ret.kind === "optional" ? ret : optionalOf(ret);
		}
		return ret;
	}

	private checkSuperCall(
		expr: Expr & { kind: "call" },
		callee: Expr & { kind: "member" },
	): Type {
		const ctx = this.classCtx.at(-1);
		if (!ctx) {
			this.error(
				callee.object.span,
				"'super' is only available inside class members",
			);
			for (const arg of expr.args) this.checkExpr(arg.expr);
			return ERROR;
		}
		const parent = instantiatedSuperclass(ctx.instance);
		if (parent === null) {
			this.error(
				callee.object.span,
				`'${ctx.instance.info.name}' has no superclass`,
			);
			for (const arg of expr.args) this.checkExpr(arg.expr);
			return ERROR;
		}
		this.types.set(callee.object, parent);
		if (callee.name === "init") {
			if (!ctx.inInit) {
				this.error(
					callee.nameSpan,
					"'super.init' can only be called from 'init'",
				);
			}
			this.resolutions.set(callee, { kind: "superInit" });
			const parentInit = parent.info.init;
			if (!parentInit) {
				for (const arg of expr.args) this.checkExpr(arg.expr);
				return VOID;
			}
			const subst = buildSubst(parent.info.typeParams, parent.typeArgs);
			const applied = substitute(parentInit, subst);
			if (applied.kind === "func") {
				this.applyCall(expr, { ...applied, typeParams: [] }, undefined, {
					declared: parentInit,
					baseSubst: subst,
					convention: "uniform",
				});
			}
			return VOID;
		}
		const method = lookupClassMethod(parent, callee.name);
		if (method === null) {
			this.error(
				callee.nameSpan,
				`'${parent.info.name}' has no method '${callee.name}'`,
			);
			for (const arg of expr.args) this.checkExpr(arg.expr);
			return ERROR;
		}
		this.resolutions.set(callee, { kind: "superMethod", name: callee.name });
		this.types.set(callee, method.func);
		return this.applyCall(expr, method.func, undefined, {
			declared: method.declared,
			baseSubst: method.subst,
			convention: "uniform",
		});
	}

	/** Label matching, generic solving, and argument checking for any call. */
	private applyCall(
		expr: Expr & { kind: "call" },
		funcType: FuncType,
		expected?: Type,
		boundary?: CallBoundary,
	): Type {
		if (funcType.isAsync) {
			this.asyncCallsSeen++;
			if (this.awaitDepth === 0) {
				this.error(
					expr.span,
					"Call to an async function must be marked with 'await'",
				);
			}
		}
		if (funcType.throws) {
			this.throwingCallsSeen++;
			if (this.tryDepth === 0) {
				this.error(
					expr.span,
					"Call to a throwing function must be marked with 'try'",
				);
			}
			if (!(this.throwsAllowedStack.at(-1) ?? false)) {
				this.error(
					expr.span,
					"Errors thrown from here are not handled; use do-catch or mark the enclosing function 'throws'",
				);
			}
		}
		const args = expr.args;
		const params = funcType.params;
		const trailingIndex = args.findIndex((a) => a.trailing);
		const hasTrailing = trailingIndex !== -1;
		const normalArgs = hasTrailing ? args.slice(0, trailingIndex) : args;
		const normalParamCount = hasTrailing ? params.length - 1 : params.length;
		if (hasTrailing && params.length === 0) {
			this.error(args[trailingIndex].expr.span, "Extra trailing closure");
		}
		// Labels are optional and may mix with positional arguments: labeled
		// arguments bind by name first, then positional arguments fill the
		// leftmost unbound parameters in order. Note that this makes argument
		// evaluation follow parameter order, not source order.
		const slots: (number | "omitted" | "missing" | undefined)[] = new Array(
			params.length,
		).fill(undefined);
		for (const [argIndex, arg] of normalArgs.entries()) {
			if (arg.label === null) continue;
			const paramIndex = params.findIndex(
				(p, i) => i < normalParamCount && p.label === arg.label,
			);
			if (paramIndex === -1) {
				this.error(
					arg.labelSpan ?? arg.expr.span,
					`No parameter named '${arg.label}:'`,
				);
				this.checkExpr(arg.expr);
				continue;
			}
			if (slots[paramIndex] !== undefined) {
				this.error(
					arg.labelSpan ?? arg.expr.span,
					`Multiple arguments for parameter '${arg.label}:'`,
				);
				this.checkExpr(arg.expr);
				continue;
			}
			slots[paramIndex] = argIndex;
		}
		for (const [argIndex, arg] of normalArgs.entries()) {
			if (arg.label !== null) continue;
			const paramIndex = slots.findIndex(
				(binding, i) => i < normalParamCount && binding === undefined,
			);
			if (paramIndex === -1) {
				this.error(arg.expr.span, "Extra argument in call");
				this.checkExpr(arg.expr);
				continue;
			}
			slots[paramIndex] = argIndex;
		}
		for (let paramIndex = 0; paramIndex < normalParamCount; paramIndex++) {
			if (slots[paramIndex] !== undefined) continue;
			const param = params[paramIndex];
			if (param.hasDefault) {
				slots[paramIndex] = "omitted";
			} else {
				slots[paramIndex] = "missing";
				this.error(
					expr.span,
					`Missing argument${param.label !== null ? ` for '${param.label}:'` : ""}`,
				);
			}
		}
		if (hasTrailing) {
			if (slots[params.length - 1] !== undefined) {
				this.error(
					args[trailingIndex].expr.span,
					"Multiple arguments for the trailing closure parameter",
				);
			}
			slots[params.length - 1] = trailingIndex;
		}
		const bound = slots.map((binding) => binding ?? "missing");

		const solvable = funcType.typeParams;
		const subst: Substitution = new Map();
		const deferred: number[] = [];
		for (const [paramIndex, binding] of bound.entries()) {
			if (typeof binding !== "number") continue;
			const arg = args[binding];
			if (isDeferredExpr(arg.expr)) {
				deferred.push(paramIndex);
				continue;
			}
			const paramType = params[paramIndex].type;
			if (solvable.length === 0) {
				const t = this.checkExpr(arg.expr, paramType);
				this.markCopy(arg.expr, t);
				continue;
			}
			const partial = substitute(paramType, subst);
			const stillOpen = unsolvedParams(partial, subst, solvable).length > 0;
			const t = this.checkExpr(arg.expr, stillOpen ? undefined : partial);
			if (!unify(paramType, t, subst, solvable) && t.kind !== "error") {
				this.error(
					arg.expr.span,
					`Type '${typeToString(t)}' is not assignable to '${typeToString(substitute(paramType, subst))}'`,
				);
			}
			this.markCopy(arg.expr, t);
		}
		if (solvable.length > 0 && expected !== undefined) {
			unify(funcType.ret, expected, subst, solvable);
		}
		for (const paramIndex of deferred) {
			const binding = bound[paramIndex];
			if (typeof binding !== "number") continue;
			const arg = args[binding];
			const expectedType = substitute(params[paramIndex].type, subst);
			const t = this.checkExpr(arg.expr, expectedType);
			if (solvable.length > 0) {
				unify(params[paramIndex].type, t, subst, solvable);
			}
			this.markCopy(arg.expr, t);
		}
		if (solvable.length > 0) {
			const open = unsolvedParams(funcType.ret, subst, solvable);
			for (const info of open) {
				this.error(
					expr.span,
					`Could not infer generic parameter '${info.name}'`,
				);
				subst.set(info.id, ERROR);
			}
			this.checkConstraints(solvable, subst, expr.span);
		}
		this.callPlans.set(expr, {
			ordered: bound.map((b) =>
				typeof b === "number"
					? { kind: "arg", argIndex: b }
					: { kind: "omitted" },
			),
		});
		this.markCallBoundary(
			expr,
			bound,
			boundary ?? {
				declared: funcType,
				baseSubst: EMPTY_SUBST,
				convention: "uniform",
			},
			subst,
		);
		return substitute(funcType.ret, subst);
	}

	/**
	 * Representation conversions at a call boundary: arguments convert into
	 * the callee's convention (uniform generic / plain host), the result back
	 * into the caller's concrete repr.
	 */
	private markCallBoundary(
		expr: Expr & { kind: "call" },
		bound: (number | "omitted" | "missing")[],
		boundary: CallBoundary,
		solved: Substitution,
	): void {
		const combined: Substitution =
			boundary.baseSubst.size === 0
				? solved
				: new Map([...boundary.baseSubst, ...solved]);
		if (boundary.convention === "uniform" && combined.size === 0) return;
		const declared = boundary.declared;
		for (const [paramIndex, binding] of bound.entries()) {
			if (typeof binding !== "number") continue;
			const arg = expr.args[binding];
			const declaredParam = declared.params[paramIndex]?.type;
			if (declaredParam === undefined) continue;
			const co =
				boundary.convention === "host"
					? hostCoercion(declaredParam, combined, "toHost")
					: genericCoercion(declaredParam, combined, "toGeneric");
			this.addCoercion(arg.expr, co, "post", arg.expr.span);
		}
		const retCo =
			boundary.convention === "host"
				? hostCoercion(declared.ret, combined, "fromHost")
				: genericCoercion(declared.ret, combined, "fromGeneric");
		this.addCoercion(expr, retCo, "pre", expr.span);
	}

	// ---- Helpers ----

	/** Verify solved type arguments against their `<T: C>` upper bounds. */
	private checkConstraints(
		typeParams: TypeParamInfo[],
		subst: Substitution,
		span: Span,
	): void {
		for (const param of typeParams) {
			if (!param.constraint) continue;
			const solved = subst.get(param.id);
			if (solved === undefined || solved.kind === "error") continue;
			const bound = substitute(param.constraint, subst);
			if (!typeConforms(solved, bound)) {
				this.error(
					span,
					`Type '${typeToString(solved)}' does not satisfy the constraint '${typeToString(bound)}' of '${param.name}'`,
				);
			}
		}
	}

	/**
	 * Mark `expr` for a defensive copy when it may alias an existing
	 * value-semantics value. Freshly constructed values need no copy.
	 */
	private markCopy(expr: Expr, type: Type): void {
		if (!hasValueSemantics(type)) return;
		switch (expr.kind) {
			case "ident":
			case "member":
			case "subscript":
			case "force":
				this.copies.add(expr);
				return;
			case "await":
			case "try":
				this.markCopy(expr.operand, type);
				return;
			case "ternary":
				this.markCopy(expr.thenExpr, type);
				this.markCopy(expr.elseExpr, type);
				return;
			case "binary":
				if (expr.op === "??") {
					this.markCopy(expr.left, type);
					this.markCopy(expr.right, type);
				}
				return;
			default:
				return;
		}
	}

	/**
	 * A value-producing `do { ... }` (optionally `catch { ... }`) expression.
	 * The body runs inline: `await` and `try` inherit the enclosing context,
	 * while `return` yields the do value and loops do not cross the boundary.
	 * A lone expression statement yields implicitly; otherwise every path
	 * must `return`.
	 */
	private checkDoExpr(expr: Expr & { kind: "doExpr" }, expected?: Type): Type {
		const ctx: FuncContext = { ret: expected ?? "infer" };
		this.funcStack.push(ctx);
		const savedLoopDepth = this.loopDepth;
		this.loopDepth = 0;
		const checkBody = (body: Stmt[], scope: Scope): boolean => {
			const single = body.length === 1 ? body[0] : undefined;
			if (single?.kind === "expr") {
				const saved = this.scope;
				this.scope = scope;
				const bodySpan = spanOfStmts(body);
				if (bodySpan) this.scopeRecords.push({ span: bodySpan, scope });
				const target = ctx.ret === "infer" ? ctx.inferred : ctx.ret;
				const t = this.checkExpr(single.expr, target);
				if (ctx.ret === "infer") ctx.inferred ??= t;
				this.markCopy(single.expr, t);
				this.scope = saved;
				return true;
			}
			this.checkBlock(body, scope);
			return alwaysExits(body);
		};
		if (expr.catchBody === undefined) {
			if (!checkBody(expr.body, new Scope(this.scope, "block"))) {
				this.error(
					expr.span,
					"A do expression must return a value on every path",
				);
			}
		} else {
			this.throwsAllowedStack.push(true);
			const bodyYields = checkBody(expr.body, new Scope(this.scope, "block"));
			this.throwsAllowedStack.pop();
			const catchScope = new Scope(this.scope, "block");
			catchScope.declare({
				kind: "value",
				name: "error",
				type: this.errorProtocolType() ?? ERROR,
				mutable: false,
				origin: "local",
			});
			const catchYields = checkBody(expr.catchBody, catchScope);
			if (!bodyYields || !catchYields) {
				this.error(
					expr.span,
					"A do expression must return a value on every path",
				);
			}
		}
		this.loopDepth = savedLoopDepth;
		this.funcStack.pop();
		return ctx.ret === "infer" ? (ctx.inferred ?? VOID) : ctx.ret;
	}

	/** The stdlib's `Error` marker protocol, if it is in scope. */
	private errorProtocolType(): Type | null {
		const sym = this.scope.lookup("Error");
		if (sym?.kind !== "type" || sym.type.kind !== "protocol") return null;
		return sym.type;
	}

	private error(span: Span, message: string): void {
		this.diagnostics.push({ span, message, severity: "error" });
	}

	private result(): CheckResult {
		return {
			diagnostics: this.diagnostics,
			types: this.types,
			resolutions: this.resolutions,
			callPlans: this.callPlans,
			copies: this.copies,
			coercions: this.coercions,
			patternBindCoercions: this.patternBindCoercions,
			chainOptional: this.chainOptional,
			patternTypes: this.patternTypes,
			classInfos: this.classInfos,
			hovers: this.hovers,
			scopeRecords: this.scopeRecords,
			moduleExports: this.moduleExportsMap,
			exportedValueNames: this.exportedValueNames,
		};
	}
}

function identResolution(sym: ValueSymbol): Resolution {
	if (sym.origin === "packageMember" && sym.packageName !== undefined) {
		return {
			kind: "packageMember",
			packageName: sym.packageName,
			memberName: sym.name,
		};
	}
	if (sym.origin === "moduleMember" && sym.packageName !== undefined) {
		return {
			kind: "moduleMember",
			moduleName: sym.packageName,
			memberName: sym.name,
		};
	}
	return { kind: "local" };
}

function canonicalClass(info: ClassInfo): Type & { kind: "class" } {
	return {
		kind: "class",
		info,
		typeArgs: info.typeParams.map((p) => ({ kind: "typeParam", info: p })),
	};
}

function canonicalProtocol(info: ProtocolInfo): Type & { kind: "protocol" } {
	return {
		kind: "protocol",
		info,
		typeArgs: info.typeParams.map((p) => ({ kind: "typeParam", info: p })),
	};
}

function hasInheritanceCycle(info: ClassInfo): boolean {
	const seen = new Set<ClassInfo>([info]);
	let cur = info.superclass;
	while (cur !== null) {
		if (seen.has(cur.info)) return true;
		seen.add(cur.info);
		cur = cur.info.superclass;
	}
	return false;
}

/** Find a field along the class chain, with type arguments applied. */
function lookupClassField(
	instance: (Type & { kind: "class" }) | null,
	name: string,
): {
	type: Type;
	mutable: boolean;
	owner: ClassInfo;
	declared: Type;
	subst: Substitution;
} | null {
	for (let cur = instance; cur !== null; cur = instantiatedSuperclass(cur)) {
		const field = cur.info.fields.find((f) => f.name === name);
		if (field) {
			const subst = buildSubst(cur.info.typeParams, cur.typeArgs);
			return {
				type: substitute(field.type, subst),
				mutable: field.mutable,
				owner: cur.info,
				declared: field.type,
				subst,
			};
		}
	}
	return null;
}

/** Find a method along the class chain, with type arguments applied. */
function lookupClassMethod(
	instance: (Type & { kind: "class" }) | null,
	name: string,
): { func: FuncType; declared: FuncType; subst: Substitution } | null {
	for (let cur = instance; cur !== null; cur = instantiatedSuperclass(cur)) {
		const method = cur.info.methods.get(name);
		if (method) {
			const subst = buildSubst(cur.info.typeParams, cur.typeArgs);
			const func = substitute(method.func, subst);
			return func.kind === "func"
				? { func, declared: method.func, subst }
				: null;
		}
	}
	return null;
}

function canonicalInstance(
	kind: "struct",
	info: StructInfo,
): Type & { kind: "struct" };
function canonicalInstance(
	kind: "enum",
	info: EnumInfo,
): Type & { kind: "enum" };
function canonicalInstance(
	kind: "struct" | "enum",
	info: StructInfo | EnumInfo,
): Type {
	const typeArgs: Type[] = info.typeParams.map((p) => ({
		kind: "typeParam",
		info: p,
	}));
	return kind === "struct"
		? { kind: "struct", info: info as StructInfo, typeArgs }
		: { kind: "enum", info: info as EnumInfo, typeArgs };
}

/** Whether a declared type contains `optional(typeParam)` anywhere. */
function hasOptionalTypeParam(type: Type): boolean {
	switch (type.kind) {
		case "optional":
			return (
				type.inner.kind === "typeParam" || hasOptionalTypeParam(type.inner)
			);
		case "array":
			return hasOptionalTypeParam(type.element);
		case "dictionary":
			return hasOptionalTypeParam(type.key) || hasOptionalTypeParam(type.value);
		case "func":
			return funcHasOptionalTypeParam(type);
		case "struct":
		case "enum":
		case "class":
		case "protocol":
		case "host":
			return type.typeArgs.some((arg) => hasOptionalTypeParam(arg));
		case "union":
			return type.members.some((m) => hasOptionalTypeParam(m));
		default:
			return false;
	}
}

function funcHasOptionalTypeParam(func: FuncType): boolean {
	return (
		func.params.some((p) => hasOptionalTypeParam(p.type)) ||
		hasOptionalTypeParam(func.ret)
	);
}

/** Split a union into members matching / not matching an `is` target. */
function matchUnionMembers(
	union: UnionType,
	target: Type,
): { matched: Type[]; rest: Type[] } {
	const matched: Type[] = [];
	const rest: Type[] = [];
	for (const member of union.members) {
		(typeConforms(member, target) ? matched : rest).push(member);
	}
	return { matched, rest };
}

/** Runtime discrimination class used for union soundness checks. */
function discriminationClass(type: Type): string | null {
	switch (type.kind) {
		case "number":
			return "number";
		case "string":
			return "string";
		case "bool":
			return "bool";
		case "literal":
			return type.base;
		case "array":
			return "array";
		case "dictionary":
			return "dictionary";
		case "func":
			return "func";
		case "struct":
			// Plain objects: two structs cannot be told apart at runtime.
			return "struct";
		case "host":
			return "host";
		case "enum":
			return "enum";
		default:
			return null;
	}
}

function isEquatable(type: Type): boolean {
	switch (type.kind) {
		case "number":
		case "string":
		case "bool":
		case "literal":
		case "error":
			return true;
		case "union":
			return type.members.every((m) => isEquatable(m));
		default:
			return false;
	}
}

/** The literal text of a pure (non-interpolated) string expression. */
function literalTextOf(expr: Expr): string | null {
	if (expr.kind !== "string") return null;
	let text = "";
	for (const part of expr.parts) {
		if (part.kind !== "text") return null;
		text += part.value;
	}
	return text;
}

/** Expressions that cannot be inferred without an expected type. */
function isDeferredExpr(expr: Expr): boolean {
	return (
		expr.kind === "closure" ||
		expr.kind === "nil" ||
		(expr.kind === "array" && expr.elements.length === 0) ||
		(expr.kind === "dict" && expr.entries.length === 0)
	);
}

function spanOfStmts(stmts: Stmt[]): Span | undefined {
	if (stmts.length === 0) return undefined;
	return { start: stmts[0].span.start, end: (stmts.at(-1) as Stmt).span.end };
}

/** Conservative "all paths return" analysis for missing-return checks. */
function alwaysExits(stmts: Stmt[]): boolean {
	return stmts.some((stmt) => stmtExits(stmt));
}

function stmtExits(stmt: Stmt): boolean {
	switch (stmt.kind) {
		case "return":
		case "throw":
			return true;
		case "doCatch":
			return alwaysExits(stmt.body) && alwaysExits(stmt.catchBody);
		case "if":
			return (
				stmt.elseBody !== undefined &&
				alwaysExits(stmt.thenBody) &&
				alwaysExits(stmt.elseBody)
			);
		case "switch":
			return (
				stmt.cases.length > 0 && stmt.cases.every((c) => alwaysExits(c.body))
			);
		default:
			return false;
	}
}

/** Like alwaysExits, but break/continue also count (for guard else bodies). */
function alwaysLeaves(stmts: Stmt[]): boolean {
	return stmts.some((stmt) => stmtLeaves(stmt));
}

function stmtLeaves(stmt: Stmt): boolean {
	switch (stmt.kind) {
		case "return":
		case "break":
		case "continue":
		case "throw":
			return true;
		case "doCatch":
			return alwaysLeaves(stmt.body) && alwaysLeaves(stmt.catchBody);
		case "if":
			return (
				stmt.elseBody !== undefined &&
				alwaysLeaves(stmt.thenBody) &&
				alwaysLeaves(stmt.elseBody)
			);
		case "switch":
			return (
				stmt.cases.length > 0 && stmt.cases.every((c) => alwaysLeaves(c.body))
			);
		default:
			return false;
	}
}

/** A top-level `super.init(...)` expression statement in an init body. */
export function isSuperInitStmt(stmt: Stmt): boolean {
	return (
		stmt.kind === "expr" &&
		stmt.expr.kind === "call" &&
		stmt.expr.callee.kind === "member" &&
		stmt.expr.callee.object.kind === "superRef" &&
		stmt.expr.callee.name === "init"
	);
}

/** Span of the first `self` or `super` use in the given statements, if any. */
function firstSelfOrSuperUse(stmts: Stmt[]): Span | null {
	for (const stmt of stmts) {
		const found = selfOrSuperInStmt(stmt);
		if (found !== null) return found;
	}
	return null;
}

function selfOrSuperInStmt(stmt: Stmt): Span | null {
	const exprs: Expr[] = [];
	const bodies: Stmt[][] = [];
	switch (stmt.kind) {
		case "binding":
			exprs.push(stmt.init);
			break;
		case "assign":
			exprs.push(stmt.target, stmt.value);
			break;
		case "expr":
			exprs.push(stmt.expr);
			break;
		case "return":
			if (stmt.value) exprs.push(stmt.value);
			break;
		case "throw":
			exprs.push(stmt.expr);
			break;
		case "doCatch":
			bodies.push(stmt.body, stmt.catchBody);
			break;
		case "if":
			for (const cond of stmt.conds) exprs.push(cond.expr);
			bodies.push(stmt.thenBody);
			if (stmt.elseBody) bodies.push(stmt.elseBody);
			break;
		case "guard":
			for (const cond of stmt.conds) exprs.push(cond.expr);
			bodies.push(stmt.elseBody);
			break;
		case "while":
			exprs.push(stmt.cond);
			bodies.push(stmt.body);
			break;
		case "for":
			if (stmt.source.kind === "range") {
				exprs.push(stmt.source.from, stmt.source.to);
			} else {
				exprs.push(stmt.source.expr);
			}
			bodies.push(stmt.body);
			break;
		case "switch":
			exprs.push(stmt.subject);
			for (const switchCase of stmt.cases) bodies.push(switchCase.body);
			break;
		case "func":
			bodies.push(stmt.body);
			break;
		default:
			break;
	}
	for (const expr of exprs) {
		const found = selfOrSuperInExpr(expr);
		if (found !== null) return found;
	}
	for (const body of bodies) {
		const found = firstSelfOrSuperUse(body);
		if (found !== null) return found;
	}
	return null;
}

function selfOrSuperInExpr(expr: Expr): Span | null {
	if (expr.kind === "ident") {
		return expr.name === "self" ? expr.span : null;
	}
	if (expr.kind === "superRef") return expr.span;
	const children: Expr[] = [];
	const bodies: Stmt[][] = [];
	switch (expr.kind) {
		case "string":
			for (const part of expr.parts) {
				if (part.kind === "expr") children.push(part.expr);
			}
			break;
		case "array":
			children.push(...expr.elements);
			break;
		case "dict":
			for (const entry of expr.entries) {
				children.push(entry.key, entry.value);
			}
			break;
		case "await":
		case "try":
		case "force":
		case "is":
		case "unary":
			children.push(expr.operand);
			break;
		case "binary":
			children.push(expr.left, expr.right);
			break;
		case "ternary":
			children.push(expr.cond, expr.thenExpr, expr.elseExpr);
			break;
		case "subscript":
			children.push(expr.object, expr.index);
			break;
		case "member":
			children.push(expr.object);
			break;
		case "doExpr":
			bodies.push(expr.body);
			if (expr.catchBody) bodies.push(expr.catchBody);
			break;
		case "closure":
			bodies.push(expr.body);
			break;
		case "call":
			children.push(expr.callee);
			for (const arg of expr.args) children.push(arg.expr);
			break;
		default:
			break;
	}
	for (const child of children) {
		const found = selfOrSuperInExpr(child);
		if (found !== null) return found;
	}
	for (const body of bodies) {
		const found = firstSelfOrSuperUse(body);
		if (found !== null) return found;
	}
	return null;
}

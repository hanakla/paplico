import {
	coreMemberNames,
	getArrayMember,
	getDictionaryMember,
	getStringMember,
	type MemberInfo,
} from "../checker/builtins";
import type { CheckResult, ScopeRecord } from "../checker/check";
import type { Scope } from "../checker/scope";
import type { Type } from "../checker/types";
import { typeToString } from "../checker/types";
import {
	buildSubst,
	instantiatedSuperclass,
	substitute,
} from "../checker/unify";
import type { AnalyzeOutput, ScriptHost } from "../host/ScriptHost";
import type { Diagnostic, Expr, Program, Span, Stmt } from "../syntax/ast";

export interface CompletionItem {
	label: string;
	kind:
		| "variable"
		| "function"
		| "type"
		| "package"
		| "property"
		| "method"
		| "case"
		| "keyword";
	/** Type text shown next to the label. */
	detail?: string;
	/** Text to insert; defaults to the label. */
	insertText?: string;
	/** `insertText` is a snippet with `${n:placeholder}` tab stops. */
	insertTextIsSnippet?: boolean;
	/** Sort key; items without one are ordered by their label. */
	sortText?: string;
}

export interface HoverInfo {
	text: string;
	span: Span;
}

export interface SignatureHelpInfo {
	/** Full signature text, containing every parameter label as a substring. */
	label: string;
	parameters: { label: string }[];
	activeParameter: number;
}

export interface DefinitionInfo {
	/** Span of the referenced name at the query offset. */
	origin: Span;
	/** Span of the declaration name to jump to (same document). */
	target: Span;
}

type CallExpr = Extract<Expr, { kind: "call" }>;
type RefExpr = Extract<Expr, { kind: "ident" } | { kind: "member" }>;
type TypeDeclStmt = Extract<Stmt, { kind: "struct" } | { kind: "enum" }>;
type DeclFrame = Map<string, Span>;

const KEYWORDS = [
	"let",
	"var",
	"fn",
	"struct",
	"enum",
	"case",
	"default",
	"if",
	"else",
	"guard",
	"for",
	"in",
	"while",
	"return",
	"break",
	"continue",
	"switch",
	"is",
	"class",
	"protocol",
	"do",
	"try",
	"catch",
	"throw",
	"throws",
	"init",
	"self",
	"super",
	"override",
	"mutating",
	"use",
	"from",
	"export",
	"async",
	"await",
	"nil",
	"true",
	"false",
];

/**
 * Editor-facing analysis API. Monaco-independent: offsets in, plain data out.
 * `update` is async because module resolution may be async.
 */
export class LanguageService {
	private text = "";
	private check: CheckResult | null = null;
	private ast: Program | null = null;
	private moduleUnits: AnalyzeOutput["moduleUnits"] = [];

	public constructor(private host: ScriptHost) {}

	/** Re-analyze the document. Returns all diagnostics (parse + type). */
	public async update(text: string): Promise<Diagnostic[]> {
		this.text = text;
		const analysis = await this.host.analyze(text);
		this.check = analysis.check;
		this.ast = analysis.ast;
		this.moduleUnits = analysis.moduleUnits;
		return analysis.diagnostics;
	}

	public hoverAt(offset: number): HoverInfo | null {
		if (!this.check) return null;
		let best: HoverInfo | null = null;
		for (const entry of this.check.hovers) {
			if (offset < entry.span.start || offset >= entry.span.end) continue;
			if (
				best === null ||
				entry.span.end - entry.span.start < best.span.end - best.span.start
			) {
				best = { text: entry.text, span: entry.span };
			}
		}
		return best;
	}

	public completionsAt(offset: number): CompletionItem[] {
		const moduleItems = this.moduleCompletionsAt(offset);
		if (moduleItems !== null) return moduleItems;
		if (!this.check) return [];
		const wordStart = this.scanIdentStart(offset);
		const before = wordStart - 1;
		if (before >= 0 && this.text[before] === "@") {
			return [{ label: "test", kind: "keyword", detail: "attribute" }];
		}
		if (before >= 0 && this.text[before] === ".") {
			return this.memberCompletions(before);
		}
		return [
			...this.argumentLabelCompletions(offset),
			...this.scopeCompletions(offset),
		];
	}

	/**
	 * Labels of the parameters an enclosing call has not bound yet, so an
	 * argument position offers what still needs to be written there.
	 */
	private argumentLabelCompletions(offset: number): CompletionItem[] {
		const call = this.innermostCallAt(offset);
		if (call === null || !this.check) return [];
		const calleeType = this.check.types.get(call.callee);
		if (calleeType?.kind !== "func") return [];

		const labeled = new Set<string>();
		let positionalCount = 0;
		for (const arg of call.args) {
			if (arg.trailing) continue;
			const start = arg.labelSpan?.start ?? arg.expr.span.start;
			// The argument being typed binds nothing yet.
			if (start <= offset && offset <= arg.expr.span.end) continue;
			if (arg.label !== null) {
				labeled.add(arg.label);
				continue;
			}
			// Parser recovery fills a missing argument with a zero-width node.
			if (arg.expr.span.start === arg.expr.span.end) continue;
			positionalCount++;
		}

		return calleeType.params
			.filter((param) => param.label !== null && !labeled.has(param.label))
			.slice(positionalCount)
			.map((param, index) => ({
				label: `${param.label}:`,
				kind: "property" as const,
				detail: typeToString(param.type),
				insertText: `${param.label}: `,
				sortText: `!${index}`,
			}));
	}

	/**
	 * Module completions inside a `use` statement, or null when the offset
	 * is not in one. Three contexts:
	 * - after `use ` (typing the binding): inserts `<name> from "<specifier>"`
	 * - inside `use { ... } from "spec"` braces: the module's export names
	 * - inside the `from "..."` string: inserts the specifier
	 */
	public moduleCompletionsAt(offset: number): CompletionItem[] | null {
		const lineStart = this.text.lastIndexOf("\n", offset - 1) + 1;
		const lineEndIndex = this.text.indexOf("\n", offset);
		const lineEnd = lineEndIndex === -1 ? this.text.length : lineEndIndex;
		const line = this.text.slice(lineStart, offset);
		const rest = this.text.slice(offset, lineEnd);
		const specifiers = this.host.knownModuleSpecifiers();
		if (/\buse\b[^"]*\bfrom\s+"[^"]*$/.test(line)) {
			return specifiers.map((specifier) => ({
				label: specifier,
				kind: "package",
				detail: "module",
			}));
		}
		const inBraces = /\buse\s*\{([^}]*)$/.exec(line);
		const braceRest = /^([^}"]*)\}\s*from\s+"([^"]+)"/.exec(rest);
		if (inBraces && braceRest) {
			// The word being typed is a filter prefix, not an already-used name.
			const settled = inBraces[1].replace(/[A-Za-z_][A-Za-z0-9_]*$/, "");
			return this.exportCompletions(braceRest[2], `${settled},${braceRest[1]}`);
		}
		if (/^\s*use\s+([A-Za-z_][A-Za-z0-9_]*)?$/.test(line)) {
			return specifiers.map((specifier) => ({
				label: specifier,
				kind: "package",
				detail: "module",
				insertText: `${moduleBindingName(specifier)} from ${JSON.stringify(specifier)}`,
			}));
		}
		return null;
	}

	/** Export names of a resolved module, minus the ones already listed. */
	private exportCompletions(
		specifier: string,
		listed: string,
	): CompletionItem[] {
		const unit = this.moduleUnits.find((u) => u.moduleName === specifier);
		if (!unit) return [];
		const taken = new Set(
			[...listed.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]),
		);
		const items: CompletionItem[] = [];
		for (const member of unit.check.moduleExports.values()) {
			if (taken.has(member.name)) continue;
			items.push({
				label: member.name,
				kind:
					member.kind === "type"
						? "type"
						: member.type.kind === "func"
							? "function"
							: "variable",
				detail: typeToString(member.type),
			});
		}
		return items;
	}

	public signatureHelpAt(offset: number): SignatureHelpInfo | null {
		if (!this.check) return null;
		const call = this.innermostCallAt(offset);
		if (call === null) return null;
		const signature = this.signatureOfCallee(call.callee);
		if (signature === null) return null;
		return {
			label: signature.label,
			parameters: signature.parameters,
			activeParameter: this.activeParameterOf(call, offset),
		};
	}

	// ---- Signature help ----

	/** Innermost call whose argument list (after the callee) contains `offset`. */
	private innermostCallAt(offset: number): CallExpr | null {
		if (!this.check) return null;
		let best: CallExpr | null = null;
		for (const node of this.check.types.keys()) {
			if (node.kind !== "call") continue;
			if (offset <= node.span.start || offset >= node.span.end) continue;
			if (offset <= node.callee.span.end) continue;
			if (
				best === null ||
				node.span.end - node.span.start < best.span.end - best.span.start
			) {
				best = node;
			}
		}
		return best;
	}

	private signatureOfCallee(
		callee: Expr,
	): { label: string; parameters: { label: string }[] } | null {
		if (!this.check) return null;
		const resolution = this.check.resolutions.get(callee);
		if (resolution?.kind === "structInit") {
			const parameters = resolution.info.fields.map((field) => ({
				label: `${field.name}: ${typeToString(field.type)}`,
			}));
			return {
				label: `${resolution.info.name}(${parameters.map((p) => p.label).join(", ")})`,
				parameters,
			};
		}
		if (resolution?.kind === "enumCase") {
			const caseName = resolution.caseName;
			const enumCase = resolution.info.cases.find((c) => c.name === caseName);
			if (enumCase === undefined) return null;
			const parameters = enumCase.assoc.map((assoc) => ({
				label: `${assoc.label}: ${typeToString(assoc.type)}`,
			}));
			return {
				label: `${resolution.info.name}.${caseName}(${parameters.map((p) => p.label).join(", ")})`,
				parameters,
			};
		}
		const calleeType = this.check.types.get(callee);
		if (calleeType?.kind !== "func") return null;
		const parameters = calleeType.params.map((param) => {
			const typed =
				param.label !== null
					? `${param.label}: ${typeToString(param.type)}`
					: typeToString(param.type);
			return { label: param.hasDefault ? `${typed} = …` : typed };
		});
		const prefix = calleeType.isAsync ? "async " : "";
		return {
			label: `${prefix}(${parameters.map((p) => p.label).join(", ")}) -> ${typeToString(calleeType.ret)}`,
			parameters,
		};
	}

	/**
	 * Parameter position for the argument under `offset`. Between arguments
	 * (e.g. right after a comma) it advances to the next parameter.
	 */
	private activeParameterOf(call: CallExpr, offset: number): number {
		let argIndex: number | null = null;
		let completedCount = 0;
		for (const [i, arg] of call.args.entries()) {
			if (arg.trailing) continue;
			const start = arg.labelSpan?.start ?? arg.expr.span.start;
			const end = arg.expr.span.end;
			if (start <= offset && offset <= end) {
				argIndex = i;
				break;
			}
			if (end < offset) completedCount++;
		}
		const resolvedIndex = argIndex ?? completedCount;
		const plan = this.check?.callPlans.get(call);
		if (plan) {
			const paramIndex = plan.ordered.findIndex(
				(slot) => slot.kind === "arg" && slot.argIndex === resolvedIndex,
			);
			if (paramIndex !== -1) return paramIndex;
		}
		return resolvedIndex;
	}

	public definitionAt(offset: number): DefinitionInfo | null {
		if (!this.check || !this.ast) return null;
		const ref = this.referenceNodeAt(offset);
		if (ref === null) return null;
		const resolution = this.check.resolutions.get(ref);
		if (ref.kind === "ident") {
			if (resolution === undefined) return null;
			const origin = ref.span;
			if (resolution.kind === "local") {
				const target = resolveInBlock(this.ast, ref.name, ref.span.start, []);
				return target !== null ? { origin, target } : null;
			}
			if (resolution.kind === "structInit" || resolution.kind === "typeRef") {
				const typeName =
					resolution.kind === "structInit" ? resolution.info.name : ref.name;
				const decl = findTypeDecl(this.ast, typeName);
				return decl !== null ? { origin, target: decl.nameSpan } : null;
			}
			if (resolution.kind === "packageRef") {
				const packageName = resolution.packageName;
				const useStmt = this.ast.find(
					(stmt): stmt is Extract<Stmt, { kind: "use" }> =>
						stmt.kind === "use" && stmt.binding?.name === packageName,
				);
				return useStmt?.binding !== undefined && useStmt.binding !== null
					? { origin, target: useStmt.binding.span }
					: null;
			}
			// Package/module members and builtins have no source in this document.
			return null;
		}
		const origin = ref.nameSpan;
		if (resolution?.kind === "enumCase") {
			const caseName = resolution.caseName;
			const decl = findTypeDecl(this.ast, resolution.info.name);
			if (decl?.kind !== "enum") return null;
			const caseDecl = decl.cases.find((c) => c.name === caseName);
			return caseDecl !== undefined
				? { origin, target: caseDecl.nameSpan }
				: null;
		}
		if (resolution !== undefined) return null;
		// Unresolved member: struct field access, found via the object's type.
		const objType = this.check.types.get(ref.object);
		const base = objType?.kind === "optional" ? objType.inner : objType;
		if (base?.kind !== "struct") return null;
		const decl = findTypeDecl(this.ast, base.info.name);
		if (decl?.kind !== "struct") return null;
		const field = decl.fields.find((f) => f.name === ref.name);
		return field !== undefined ? { origin, target: field.nameSpan } : null;
	}

	// ---- Definition ----

	/** Ident at `offset`, or member access whose name token contains `offset`. */
	private referenceNodeAt(offset: number): RefExpr | null {
		if (!this.check) return null;
		let best: { node: RefExpr; width: number } | null = null;
		for (const node of this.check.types.keys()) {
			if (node.kind !== "ident" && node.kind !== "member") continue;
			const span = node.kind === "ident" ? node.span : node.nameSpan;
			if (!spanContains(span, offset)) continue;
			const width = span.end - span.start;
			if (best === null || width < best.width) {
				best = { node, width };
			}
		}
		return best?.node ?? null;
	}

	// ---- Member completion ----

	private memberCompletions(dotPos: number): CompletionItem[] {
		// `?.` chains complete on the unwrapped type.
		const objEnd = this.text[dotPos - 1] === "?" ? dotPos - 1 : dotPos;
		const identItems = this.identBasedMembers(objEnd);
		if (identItems !== null) return identItems;
		const objType = this.typedNodeEndingAt(objEnd);
		if (objType === null) return [];
		const base =
			this.text[dotPos - 1] === "?" && objType.kind === "optional"
				? objType.inner
				: objType;
		return this.membersOfType(base);
	}

	/** Handles `package.` and `EnumType.` even when the AST is broken. */
	private identBasedMembers(objEnd: number): CompletionItem[] | null {
		const identStart = this.scanIdentStart(objEnd);
		if (identStart === objEnd) return null;
		const name = this.text.slice(identStart, objEnd);
		const scope = this.scopeAt(identStart);
		const sym = scope?.lookup(name);
		if (sym === undefined) return null;
		if (sym.kind === "package") {
			return [...sym.members.values()].flatMap((member) => {
				if (member.kind === "type") return [];
				return [
					callableItem(
						member.name,
						member.type.kind === "func" ? "function" : "variable",
						member.type,
					),
				];
			});
		}
		if (sym.kind === "type" && sym.type.kind === "enum") {
			return sym.type.info.cases.map((c) => ({
				label: c.name,
				kind: "case" as const,
				detail:
					c.assoc.length > 0
						? `(${c.assoc.map((a) => `${a.label}: ${typeToString(a.type)}`).join(", ")})`
						: undefined,
			}));
		}
		return null;
	}

	private typedNodeEndingAt(end: number): Type | null {
		if (!this.check) return null;
		let best: { node: Expr; type: Type } | null = null;
		for (const [node, type] of this.check.types) {
			if (node.span.end !== end || type.kind === "error") continue;
			if (best === null || node.span.start < best.node.span.start) {
				best = { node, type };
			}
		}
		return best?.type ?? null;
	}

	private membersOfType(type: Type): CompletionItem[] {
		switch (type.kind) {
			case "struct": {
				const subst = buildSubst(type.info.typeParams, type.typeArgs);
				return [
					...type.info.fields.map((f) => ({
						label: f.name,
						kind: "property" as const,
						detail: typeToString(substitute(f.type, subst)),
					})),
					...[...type.info.methods.entries()].map(([name, method]) =>
						callableItem(name, "method", substitute(method.func, subst)),
					),
				];
			}
			case "enum": {
				const subst = buildSubst(type.info.typeParams, type.typeArgs);
				return [...type.info.methods.entries()].map(([name, method]) =>
					callableItem(name, "method", substitute(method.func, subst)),
				);
			}
			case "class": {
				const items: CompletionItem[] = [];
				const seen = new Set<string>();
				for (
					let cur: (Type & { kind: "class" }) | null = type;
					cur !== null;
					cur = instantiatedSuperclass(cur)
				) {
					const subst = buildSubst(cur.info.typeParams, cur.typeArgs);
					for (const field of cur.info.fields) {
						if (seen.has(field.name)) continue;
						seen.add(field.name);
						items.push({
							label: field.name,
							kind: "property",
							detail: typeToString(substitute(field.type, subst)),
						});
					}
					for (const [name, method] of cur.info.methods) {
						if (seen.has(name)) continue;
						seen.add(name);
						items.push(
							callableItem(name, "method", substitute(method.func, subst)),
						);
					}
				}
				return items;
			}
			case "protocol": {
				const subst = buildSubst(type.info.typeParams, type.typeArgs);
				return [
					...[...type.info.props.entries()].map(([name, prop]) => ({
						label: name,
						kind: "property" as const,
						detail: typeToString(substitute(prop.type, subst)),
					})),
					...[...type.info.methods.entries()].map(([name, method]) =>
						callableItem(name, "method", substitute(method, subst)),
					),
				];
			}
			case "host":
				return [
					...[...type.info.props.entries()].map(([name, prop]) => ({
						label: name,
						kind: "property" as const,
						detail: typeToString(prop.type),
					})),
					...[...type.info.methods.entries()].map(([name, method]) =>
						callableItem(name, "method", method),
					),
				];
			case "array":
				return this.coreMembers("Array", (name) =>
					getArrayMember(type.element, name),
				);
			case "string":
				return this.coreMembers("String", (name) => getStringMember(name));
			case "dictionary":
				return this.coreMembers("Dictionary", (name) =>
					getDictionaryMember(type.key, type.value, name),
				);
			default:
				return [];
		}
	}

	private coreMembers(
		typeName: "Array" | "String" | "Dictionary",
		lookup: (name: string) => MemberInfo | undefined,
	): CompletionItem[] {
		const names = coreMemberNames(typeName);
		const items: CompletionItem[] = [];
		for (const name of names.props) {
			const member = lookup(name);
			items.push({
				label: name,
				kind: "property",
				detail: member?.kind === "prop" ? typeToString(member.type) : undefined,
			});
		}
		for (const name of names.methods) {
			const member = lookup(name);
			items.push(
				member?.kind === "method"
					? callableItem(name, "method", member.func)
					: { label: name, kind: "method" },
			);
		}
		return items;
	}

	// ---- Scope completion ----

	private scopeCompletions(offset: number): CompletionItem[] {
		const scope = this.scopeAt(offset);
		const items: CompletionItem[] = [];
		const seen = new Set<string>();
		for (let s = scope; s; s = s.parent) {
			for (const sym of s.ownSymbols()) {
				const name = sym.name;
				if (seen.has(name)) continue;
				seen.add(name);
				if (sym.kind === "value") {
					items.push(
						callableItem(
							name,
							sym.type.kind === "func" ? "function" : "variable",
							sym.type,
						),
					);
				} else if (sym.kind === "type") {
					items.push({ label: name, kind: "type" });
				} else {
					items.push({ label: name, kind: "package" });
				}
			}
		}
		for (const keyword of KEYWORDS) {
			if (!seen.has(keyword)) {
				items.push({ label: keyword, kind: "keyword" });
			}
		}
		return items;
	}

	private scopeAt(offset: number): Scope | null {
		if (!this.check) return null;
		let best: ScopeRecord | null = null;
		for (const record of this.check.scopeRecords) {
			if (offset < record.span.start || offset > record.span.end) continue;
			if (
				best === null ||
				record.span.end - record.span.start <= best.span.end - best.span.start
			) {
				best = record;
			}
		}
		return best?.scope ?? this.check.scopeRecords[0]?.scope ?? null;
	}

	private scanIdentStart(offset: number): number {
		let i = offset;
		while (i > 0 && /[A-Za-z0-9_]/.test(this.text[i - 1])) i--;
		return i;
	}
}

// ---- Definition resolution helpers ----

/**
 * Resolve a local value reference at `offset` to its declaration name span,
 * mirroring lexical scoping: function names are hoisted per block, `let`/`var`
 * and `guard let` bind the statements that follow them.
 */
function resolveInBlock(
	block: Stmt[],
	name: string,
	offset: number,
	outer: DeclFrame[],
): Span | null {
	const frame: DeclFrame = new Map();
	for (const stmt of block) {
		if (stmt.kind === "func") frame.set(stmt.sig.name, stmt.sig.nameSpan);
	}
	const frames = [...outer, frame];
	for (const stmt of block) {
		if (stmt.span.end <= offset) {
			if (stmt.kind === "binding") frame.set(stmt.name, stmt.nameSpan);
			if (stmt.kind === "guard") {
				for (const cond of stmt.conds) {
					if (cond.kind === "optionalBinding") {
						frame.set(cond.name, cond.nameSpan);
					}
				}
			}
			continue;
		}
		if (offset < stmt.span.start) break;
		return resolveInStmt(stmt, name, offset, frames);
	}
	return lookupFrames(frames, name);
}

function resolveInStmt(
	stmt: Stmt,
	name: string,
	offset: number,
	frames: DeclFrame[],
): Span | null {
	switch (stmt.kind) {
		case "binding":
			// The binding's own name is not visible inside its initializer.
			return resolveInExpr(stmt.init, name, offset, frames);
		case "func": {
			const frame: DeclFrame = new Map();
			for (const param of stmt.sig.params) {
				frame.set(param.name, param.nameSpan);
			}
			return resolveInBlock(stmt.body, name, offset, [...frames, frame]);
		}
		case "if": {
			// Each condition sees the bindings the earlier ones introduced.
			const condFrame: DeclFrame = new Map();
			for (const cond of stmt.conds) {
				if (spanContains(cond.expr.span, offset)) {
					return resolveInExpr(cond.expr, name, offset, [...frames, condFrame]);
				}
				if (cond.kind === "optionalBinding") {
					condFrame.set(cond.name, cond.nameSpan);
				}
			}
			if (blockContains(stmt.thenBody, offset)) {
				return resolveInBlock(stmt.thenBody, name, offset, [
					...frames,
					condFrame,
				]);
			}
			if (stmt.elseBody && blockContains(stmt.elseBody, offset)) {
				return resolveInBlock(stmt.elseBody, name, offset, frames);
			}
			return lookupFrames(frames, name);
		}
		case "guard": {
			// The guard bindings are visible after the statement, not in its else.
			const condFrame: DeclFrame = new Map();
			for (const cond of stmt.conds) {
				if (spanContains(cond.expr.span, offset)) {
					return resolveInExpr(cond.expr, name, offset, [...frames, condFrame]);
				}
				if (cond.kind === "optionalBinding") {
					condFrame.set(cond.name, cond.nameSpan);
				}
			}
			if (blockContains(stmt.elseBody, offset)) {
				return resolveInBlock(stmt.elseBody, name, offset, frames);
			}
			return lookupFrames(frames, name);
		}
		case "for": {
			const sources =
				stmt.source.kind === "range"
					? [stmt.source.from, stmt.source.to]
					: [stmt.source.expr];
			for (const source of sources) {
				if (spanContains(source.span, offset)) {
					return resolveInExpr(source, name, offset, frames);
				}
			}
			const frame: DeclFrame = new Map();
			if (stmt.binding.kind === "single") {
				frame.set(stmt.binding.name, stmt.binding.nameSpan);
			} else {
				frame.set(stmt.binding.key.name, stmt.binding.key.nameSpan);
				frame.set(stmt.binding.value.name, stmt.binding.value.nameSpan);
			}
			return resolveInBlock(stmt.body, name, offset, [...frames, frame]);
		}
		case "while": {
			if (spanContains(stmt.cond.span, offset)) {
				return resolveInExpr(stmt.cond, name, offset, frames);
			}
			return resolveInBlock(stmt.body, name, offset, frames);
		}
		case "switch": {
			if (spanContains(stmt.subject.span, offset)) {
				return resolveInExpr(stmt.subject, name, offset, frames);
			}
			for (const switchCase of stmt.cases) {
				if (!spanContains(switchCase.span, offset)) continue;
				const frame: DeclFrame = new Map();
				if (
					switchCase.pattern !== "default" &&
					switchCase.pattern.kind === "case"
				) {
					for (const binding of switchCase.pattern.bindings) {
						frame.set(binding.name, binding.nameSpan);
					}
				}
				return resolveInBlock(switchCase.body, name, offset, [
					...frames,
					frame,
				]);
			}
			return lookupFrames(frames, name);
		}
		case "return":
			return stmt.value !== undefined
				? resolveInExpr(stmt.value, name, offset, frames)
				: lookupFrames(frames, name);
		case "throw":
			return resolveInExpr(stmt.expr, name, offset, frames);
		case "doCatch": {
			if (blockContains(stmt.body, offset)) {
				return resolveInBlock(stmt.body, name, offset, frames);
			}
			if (blockContains(stmt.catchBody, offset)) {
				const frame: DeclFrame = new Map();
				// The implicit catch binding; its "declaration" is the `do`.
				frame.set("error", {
					start: stmt.span.start,
					end: stmt.span.start + 2,
				});
				return resolveInBlock(stmt.catchBody, name, offset, [...frames, frame]);
			}
			return lookupFrames(frames, name);
		}
		case "assign":
			return spanContains(stmt.target.span, offset)
				? resolveInExpr(stmt.target, name, offset, frames)
				: resolveInExpr(stmt.value, name, offset, frames);
		case "expr":
			return resolveInExpr(stmt.expr, name, offset, frames);
		default:
			return lookupFrames(frames, name);
	}
}

function resolveInExpr(
	expr: Expr,
	name: string,
	offset: number,
	frames: DeclFrame[],
): Span | null {
	if (expr.kind === "closure") {
		const frame: DeclFrame = new Map();
		for (const param of expr.params) frame.set(param.name, param.nameSpan);
		return resolveInBlock(expr.body, name, offset, [...frames, frame]);
	}
	if (expr.kind === "doExpr") {
		if (blockContains(expr.body, offset)) {
			return resolveInBlock(expr.body, name, offset, frames);
		}
		if (expr.catchBody && blockContains(expr.catchBody, offset)) {
			const frame: DeclFrame = new Map();
			// The implicit catch binding; its "declaration" is the `do`.
			frame.set("error", { start: expr.span.start, end: expr.span.start + 2 });
			return resolveInBlock(expr.catchBody, name, offset, [...frames, frame]);
		}
		return lookupFrames(frames, name);
	}
	for (const child of childExprs(expr)) {
		if (spanContains(child.span, offset)) {
			return resolveInExpr(child, name, offset, frames);
		}
	}
	return lookupFrames(frames, name);
}

function childExprs(expr: Expr): Expr[] {
	switch (expr.kind) {
		case "string":
			return expr.parts.flatMap((part) =>
				part.kind === "expr" ? [part.expr] : [],
			);
		case "array":
			return expr.elements;
		case "dict":
			return expr.entries.flatMap((entry) => [entry.key, entry.value]);
		case "await":
		case "try":
		case "force":
		case "unary":
			return [expr.operand];
		case "call":
			return [expr.callee, ...expr.args.map((arg) => arg.expr)];
		case "member":
			return [expr.object];
		case "subscript":
			return [expr.object, expr.index];
		case "binary":
			return [expr.left, expr.right];
		case "ternary":
			return [expr.cond, expr.thenExpr, expr.elseExpr];
		default:
			return [];
	}
}

function lookupFrames(frames: DeclFrame[], name: string): Span | null {
	for (const frame of frames.toReversed()) {
		const span = frame.get(name);
		if (span !== undefined) return span;
	}
	return null;
}

function findTypeDecl(program: Program, name: string): TypeDeclStmt | null {
	for (const stmt of program) {
		if (
			(stmt.kind === "struct" || stmt.kind === "enum") &&
			stmt.name === name
		) {
			return stmt;
		}
	}
	return null;
}

function spanContains(span: Span, offset: number): boolean {
	return span.start <= offset && offset < span.end;
}

function blockContains(block: Stmt[], offset: number): boolean {
	return block.some((stmt) => spanContains(stmt.span, offset));
}

/**
 * Completion item for a callable, whose insert text spells out the argument
 * labels as tab stops. Omittable parameters are left out: they are what the
 * caller most often wants to skip.
 */
function callableItem(
	label: string,
	kind: CompletionItem["kind"],
	type: Type,
): CompletionItem {
	const item: CompletionItem = { label, kind, detail: typeToString(type) };
	if (type.kind !== "func") return item;

	const required = type.params.filter((param) => !param.hasDefault);
	item.insertText = `${label}(${required
		.map((param, index) => {
			const placeholder = `\${${index + 1}:${typeToString(param.type)}}`;
			return param.label === null
				? placeholder
				: `${param.label}: ${placeholder}`;
		})
		.join(", ")})`;
	item.insertTextIsSnippet = true;
	return item;
}

/** Default namespace binding for a specifier: its last identifier-ish segment. */
function moduleBindingName(specifier: string): string {
	const segment = specifier.split("/").at(-1) ?? specifier;
	const cleaned = segment.replace(/[^A-Za-z0-9_]/g, "_").replace(/^\d+/, "");
	return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

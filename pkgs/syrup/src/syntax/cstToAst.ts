import type { CstElement, CstNode, IToken } from "chevrotain";
import type {
	BinaryOp,
	CallArg,
	ClosureParam,
	Condition,
	DeclTypeMember,
	Diagnostic,
	DictEntry,
	EnumCaseDecl,
	Expr,
	FieldDecl,
	ForBinding,
	ForSource,
	FuncSig,
	MethodDecl,
	ParamDecl,
	Pattern,
	Program,
	Span,
	Stmt,
	StringPart,
	SwitchCase,
	TypeNode,
	TypeParamDecl,
} from "./ast";
import { syrupParser } from "./parser";
import { type StringPayload, syrupLexer } from "./tokens";

export interface ParseResult {
	ast: Program;
	diagnostics: Diagnostic[];
}

export function parseProgram(source: string): ParseResult {
	const diagnostics: Diagnostic[] = [];
	const cst = runParser(source, 0, diagnostics, "program");
	const ast = cst === null ? [] : new AstBuilder(diagnostics).program(cst);
	return { ast, diagnostics };
}

function runParser(
	source: string,
	baseOffset: number,
	diagnostics: Diagnostic[],
	entry: "program" | "expression",
): CstNode | null {
	const lexed = syrupLexer.tokenize(source);
	for (const err of lexed.errors) {
		diagnostics.push({
			span: {
				start: baseOffset + err.offset,
				end: baseOffset + err.offset + Math.max(err.length, 1),
			},
			message: err.message,
			severity: "error",
		});
	}
	syrupParser.input = lexed.tokens;
	const cst =
		entry === "program" ? syrupParser.program() : syrupParser.expression();
	for (const err of syrupParser.errors) {
		const tok = err.token;
		const start = Number.isNaN(tok.startOffset)
			? source.length
			: tok.startOffset;
		const end = Number.isNaN(tok.endOffset ?? Number.NaN)
			? start + 1
			: (tok.endOffset as number) + 1;
		diagnostics.push({
			span: { start: baseOffset + start, end: baseOffset + end },
			message: err.message,
			severity: "error",
		});
	}
	return cst ?? null;
}

/** Recursively shift every `span`-ish property by `delta` (for interpolation fragments). */
function shiftSpans(node: unknown, delta: number): void {
	if (Array.isArray(node)) {
		for (const item of node) shiftSpans(item, delta);
		return;
	}
	if (node !== null && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (
				(key === "span" || key.endsWith("Span")) &&
				value !== null &&
				typeof value === "object"
			) {
				const s = value as Span;
				s.start += delta;
				s.end += delta;
			} else {
				shiftSpans(value, delta);
			}
		}
	}
}

// ---- CST access helpers ----

function isToken(el: CstElement): el is IToken {
	return "image" in el;
}

function subs(cst: CstNode, name: string): CstNode[] {
	const els = cst.children[name] ?? [];
	return els.filter((el): el is CstNode => !isToken(el));
}

function sub(cst: CstNode, name: string): CstNode | undefined {
	return subs(cst, name)[0];
}

function toks(cst: CstNode, name: string): IToken[] {
	const els = cst.children[name] ?? [];
	return els.filter(isToken);
}

function tok(cst: CstNode, name: string): IToken | undefined {
	return toks(cst, name)[0];
}

function has(cst: CstNode, name: string): boolean {
	return (cst.children[name] ?? []).length > 0;
}

function tokSpan(token: IToken): Span {
	return {
		start: token.startOffset,
		end: (token.endOffset ?? token.startOffset) + 1,
	};
}

function nodeSpan(cst: CstNode): Span {
	const loc = cst.location;
	if (
		loc === undefined ||
		loc.startOffset === undefined ||
		Number.isNaN(loc.startOffset)
	) {
		return { start: 0, end: 0 };
	}
	return {
		start: loc.startOffset,
		end: (loc.endOffset ?? loc.startOffset) + 1,
	};
}

/** Merge several token groups into source order. */
function mergedToks(cst: CstNode, names: string[]): IToken[] {
	return names
		.flatMap((name) => toks(cst, name))
		.sort((a, b) => a.startOffset - b.startOffset);
}

function numberValue(token: IToken): number {
	return Number(token.image.replaceAll("_", ""));
}

// ---- AST builder ----

class AstBuilder {
	public constructor(private diagnostics: Diagnostic[]) {}

	public program(cst: CstNode): Program {
		return subs(cst, "statement")
			.map((s) => this.statement(s))
			.filter((s): s is Stmt => s !== null);
	}

	private error(span: Span, message: string): void {
		this.diagnostics.push({ span, message, severity: "error" });
	}

	private statement(cst: CstNode): Stmt | null {
		const span = nodeSpan(cst);
		const exported = sub(cst, "exportedDecl");
		if (exported) return this.exportedDecl(exported);
		const useS = sub(cst, "useStmt");
		if (useS) return this.useStmt(useS);
		const binding = sub(cst, "bindingDecl");
		if (binding) return this.bindingDecl(binding);
		const func = sub(cst, "funcDecl");
		if (func) return this.funcDecl(func);
		const struct = sub(cst, "structDecl");
		if (struct) return this.structDecl(struct);
		const enumD = sub(cst, "enumDecl");
		if (enumD) return this.enumDecl(enumD);
		const classD = sub(cst, "classDecl");
		if (classD) return this.classDecl(classD);
		const protocolD = sub(cst, "protocolDecl");
		if (protocolD) return this.protocolDecl(protocolD);
		const declare = sub(cst, "declareDecl");
		if (declare) return this.declareDecl(declare);
		const ifS = sub(cst, "ifStmt");
		if (ifS) return this.ifStmt(ifS);
		const guardS = sub(cst, "guardStmt");
		if (guardS) return this.guardStmt(guardS);
		const forS = sub(cst, "forStmt");
		if (forS) return this.forStmt(forS);
		const whileS = sub(cst, "whileStmt");
		if (whileS) return this.whileStmt(whileS);
		const switchS = sub(cst, "switchStmt");
		if (switchS) return this.switchStmt(switchS);
		const returnS = sub(cst, "returnStmt");
		if (returnS) return this.returnStmt(returnS);
		const throwS = sub(cst, "throwStmt");
		if (throwS) return this.throwStmt(throwS);
		const doCatchS = sub(cst, "doCatchStmt");
		if (doCatchS) return this.doCatchStmt(doCatchS);
		if (has(cst, "Break")) return { kind: "break", span };
		if (has(cst, "Continue")) return { kind: "continue", span };
		if (has(cst, "Semicolon")) return null;
		const exprS = sub(cst, "exprStatement");
		if (exprS) return this.exprStatement(exprS);
		return null;
	}

	private exportedDecl(cst: CstNode): Stmt | null {
		const inner =
			sub(cst, "bindingDecl") ??
			sub(cst, "funcDecl") ??
			sub(cst, "structDecl") ??
			sub(cst, "enumDecl") ??
			sub(cst, "classDecl") ??
			sub(cst, "protocolDecl");
		if (!inner) return null;
		const stmt =
			inner.name === "bindingDecl"
				? this.bindingDecl(inner)
				: inner.name === "funcDecl"
					? this.funcDecl(inner)
					: inner.name === "structDecl"
						? this.structDecl(inner)
						: inner.name === "enumDecl"
							? this.enumDecl(inner)
							: inner.name === "classDecl"
								? this.classDecl(inner)
								: this.protocolDecl(inner);
		if (
			stmt !== null &&
			(stmt.kind === "binding" ||
				stmt.kind === "func" ||
				stmt.kind === "struct" ||
				stmt.kind === "enum" ||
				stmt.kind === "class" ||
				stmt.kind === "protocol")
		) {
			stmt.exported = true;
		}
		return stmt;
	}

	private useStmt(cst: CstNode): Stmt | null {
		const str = tok(cst, "StringLiteral");
		if (!str) return null;
		const payload = str.payload as StringPayload;
		const specifierSpan = tokSpan(str);
		if (
			payload.unterminated ||
			payload.segments.some((s) => s.kind !== "text")
		) {
			this.error(
				specifierSpan,
				"Module specifier must be a plain string literal",
			);
			return null;
		}
		const specifier = payload.segments
			.map((s) => (s.kind === "text" ? s.value : ""))
			.join("");
		const idents = toks(cst, "Identifier");
		const braced = has(cst, "LCurly");
		return {
			kind: "use",
			specifier,
			specifierSpan,
			binding: braced
				? null
				: { name: idents[0].image, span: tokSpan(idents[0]) },
			named: braced
				? idents.map((id) => ({ name: id.image, span: tokSpan(id) }))
				: null,
			span: nodeSpan(cst),
		};
	}

	private bindingDecl(cst: CstNode): Stmt | null {
		const name = tok(cst, "Identifier");
		const initCst = sub(cst, "expression");
		if (!name || !initCst) return null;
		const typeCst = sub(cst, "typeRef");
		return {
			kind: "binding",
			mutable: has(cst, "Var"),
			name: name.image,
			nameSpan: tokSpan(name),
			type: typeCst ? this.typeRef(typeCst) : undefined,
			init: this.expression(initCst),
			span: nodeSpan(cst),
		};
	}

	private funcSig(cst: CstNode): FuncSig | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const paramsCst = sub(cst, "paramList");
		const retCst = sub(cst, "typeRef");
		const attributes = subs(cst, "attribute").flatMap((attrCst) => {
			const attrName = tok(attrCst, "Identifier");
			return attrName
				? [{ name: attrName.image, span: nodeSpan(attrCst) }]
				: [];
		});
		return {
			name: name.image,
			nameSpan: tokSpan(name),
			isAsync: has(cst, "Async"),
			throws: has(cst, "Throws"),
			attributes,
			typeParams: this.genericParamDecls(cst),
			params: paramsCst ? this.paramList(paramsCst) : [],
			retType: retCst ? this.typeRef(retCst) : undefined,
		};
	}

	private genericParamDecls(cst: CstNode): TypeParamDecl[] {
		const genericsCst = subs(cst, "genericParams")[0];
		if (!genericsCst) return [];
		return subs(genericsCst, "genericParam").flatMap((paramCst) => {
			const name = tok(paramCst, "Identifier");
			if (!name) return [];
			const constraintCst = sub(paramCst, "typeRef");
			return [
				{
					name: name.image,
					nameSpan: tokSpan(name),
					constraint: constraintCst ? this.typeRef(constraintCst) : undefined,
				},
			];
		});
	}

	private funcDecl(cst: CstNode): Stmt | null {
		const sig = this.funcSig(cst);
		const blockCst = sub(cst, "block");
		if (!sig || !blockCst) return null;
		return {
			kind: "func",
			sig,
			body: this.block(blockCst),
			span: nodeSpan(cst),
		};
	}

	private paramList(cst: CstNode): ParamDecl[] {
		return subs(cst, "param")
			.map((p) => this.param(p))
			.filter((p): p is ParamDecl => p !== null);
	}

	private param(cst: CstNode): ParamDecl | null {
		const first = tok(cst, "first");
		const typeCst = sub(cst, "typeRef");
		if (!first || !typeCst) return null;
		const second = tok(cst, "second");
		const defaultCst = sub(cst, "expression");
		// Labels are optional at call sites, so the `_ name` form is gone.
		if (second && first.image === "_") {
			this.error(
				tokSpan(first),
				"'_' parameter labels are no longer needed; write the parameter name only",
			);
		}
		const name = second ? second.image : first.image;
		const omittable = tok(cst, "omittable");
		return {
			// Recovery for `_ name`: behave as if only the name were written.
			label: second && first.image !== "_" ? first.image : name,
			name,
			nameSpan: tokSpan(second ?? first),
			type: this.typeRef(typeCst),
			defaultValue: defaultCst ? this.expression(defaultCst) : undefined,
			omittable: omittable !== undefined,
			omittableSpan: omittable ? tokSpan(omittable) : undefined,
		};
	}

	private structDecl(cst: CstNode): Stmt | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const fields = subs(cst, "fieldDecl")
			.map((f) => this.fieldDecl(f))
			.filter((f): f is FieldDecl => f !== null);
		return {
			kind: "struct",
			name: name.image,
			nameSpan: tokSpan(name),
			typeParams: this.genericParamDecls(cst),
			fields,
			methods: this.methodDecls(cst),
			span: nodeSpan(cst),
		};
	}

	private fieldDecl(cst: CstNode): FieldDecl | null {
		const name = tok(cst, "Identifier");
		const typeCst = sub(cst, "typeRef");
		if (!name || !typeCst) return null;
		const defaultCst = sub(cst, "expression");
		return {
			mutable: has(cst, "Var"),
			name: name.image,
			nameSpan: tokSpan(name),
			type: this.typeRef(typeCst),
			defaultValue: defaultCst ? this.expression(defaultCst) : undefined,
		};
	}

	private methodDecls(cst: CstNode): MethodDecl[] {
		return subs(cst, "methodDecl").flatMap((methodCst) => {
			const funcCst = sub(methodCst, "funcDecl");
			if (!funcCst) return [];
			const sig = this.funcSig(funcCst);
			const blockCst = sub(funcCst, "block");
			if (!sig || !blockCst) return [];
			const modifier = tok(methodCst, "modifier");
			if (
				modifier &&
				modifier.image !== "override" &&
				modifier.image !== "mutating"
			) {
				this.error(
					tokSpan(modifier),
					`Unknown method modifier '${modifier.image}'; expected 'override' or 'mutating'`,
				);
			}
			return [
				{
					sig,
					body: this.block(blockCst),
					mutating: modifier?.image === "mutating",
					override: modifier?.image === "override",
					span: nodeSpan(methodCst),
				},
			];
		});
	}

	private classDecl(cst: CstNode): Stmt | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const fields = subs(cst, "fieldDecl")
			.map((f) => this.fieldDecl(f))
			.filter((f): f is FieldDecl => f !== null);
		const inits = subs(cst, "initDecl").flatMap((initCst) => {
			const keyword = tok(initCst, "initKeyword");
			const blockCst = sub(initCst, "block");
			if (!keyword || !blockCst) return [];
			if (keyword.image !== "init") {
				this.error(
					tokSpan(keyword),
					`Unexpected '${keyword.image}'; did you mean 'init'?`,
				);
				return [];
			}
			const paramsCst = sub(initCst, "paramList");
			return [
				{
					params: paramsCst ? this.paramList(paramsCst) : [],
					body: this.block(blockCst),
					span: nodeSpan(initCst),
				},
			];
		});
		return {
			kind: "class",
			name: name.image,
			nameSpan: tokSpan(name),
			typeParams: this.genericParamDecls(cst),
			heritage: subs(cst, "heritage").map((h) => this.typeRef(h)),
			fields,
			inits,
			methods: this.methodDecls(cst),
			span: nodeSpan(cst),
		};
	}

	private protocolDecl(cst: CstNode): Stmt | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const props = subs(cst, "fieldDecl").flatMap((fieldCst) => {
			const field = this.fieldDecl(fieldCst);
			if (!field) return [];
			if (field.defaultValue) {
				this.error(
					field.nameSpan,
					"Protocol properties cannot have default values",
				);
			}
			return [{ ...field, defaultValue: undefined }];
		});
		const methods = subs(cst, "declareFunc")
			.map((funcCst) => this.funcSig(funcCst))
			.filter((sig): sig is FuncSig => sig !== null);
		return {
			kind: "protocol",
			name: name.image,
			nameSpan: tokSpan(name),
			typeParams: this.genericParamDecls(cst),
			props,
			methods,
			span: nodeSpan(cst),
		};
	}

	private enumDecl(cst: CstNode): Stmt | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const cases = subs(cst, "enumCaseDecl")
			.map((c) => this.enumCaseDecl(c))
			.filter((c): c is EnumCaseDecl => c !== null);
		return {
			kind: "enum",
			name: name.image,
			nameSpan: tokSpan(name),
			typeParams: this.genericParamDecls(cst),
			cases,
			methods: this.methodDecls(cst),
			span: nodeSpan(cst),
		};
	}

	private enumCaseDecl(cst: CstNode): EnumCaseDecl | null {
		const name = tok(cst, "Identifier");
		if (!name) return null;
		const assoc = subs(cst, "assocParam").flatMap((a) => {
			const label = tok(a, "Identifier");
			const typeCst = sub(a, "typeRef");
			if (!label || !typeCst) return [];
			return [{ label: label.image, type: this.typeRef(typeCst) }];
		});
		return { name: name.image, nameSpan: tokSpan(name), assoc };
	}

	private declareDecl(cst: CstNode): Stmt | null {
		const span = nodeSpan(cst);
		const funcCst = sub(cst, "declareFunc");
		if (funcCst) {
			const sig = this.funcSig(funcCst);
			return sig ? { kind: "declareFunc", sig, span } : null;
		}
		const letCst = sub(cst, "declareLet");
		if (letCst) {
			const name = tok(letCst, "Identifier");
			const typeCst = sub(letCst, "typeRef");
			if (!name || !typeCst) return null;
			return {
				kind: "declareLet",
				name: name.image,
				nameSpan: tokSpan(name),
				type: this.typeRef(typeCst),
				span,
			};
		}
		const typeCstNode = sub(cst, "declareType");
		if (typeCstNode) {
			const name = tok(typeCstNode, "name");
			if (!name) return null;
			const members = subs(typeCstNode, "declareTypeMember")
				.map((m) => this.declareTypeMember(m))
				.filter((m): m is DeclTypeMember => m !== null);
			return {
				kind: "declareType",
				name: name.image,
				nameSpan: tokSpan(name),
				typeParams: this.genericParamDecls(typeCstNode),
				members,
				span,
			};
		}
		return null;
	}

	private declareTypeMember(cst: CstNode): DeclTypeMember | null {
		if (has(cst, "Fn")) {
			const name = tok(cst, "methodName");
			if (!name) return null;
			const mutatingTok = tok(cst, "mutatingKeyword");
			if (mutatingTok && mutatingTok.image !== "mutating") {
				this.error(
					tokSpan(mutatingTok),
					`Unexpected '${mutatingTok.image}'; did you mean 'mutating'?`,
				);
			}
			const paramsCst = sub(cst, "paramList");
			const retCst = sub(cst, "typeRef");
			return {
				kind: "method",
				mutating: mutatingTok?.image === "mutating",
				sig: {
					name: name.image,
					nameSpan: tokSpan(name),
					isAsync: has(cst, "Async"),
					throws: false,
					attributes: [],
					typeParams: this.genericParamDecls(cst),
					params: paramsCst ? this.paramList(paramsCst) : [],
					retType: retCst ? this.typeRef(retCst) : undefined,
				},
			};
		}
		const name = tok(cst, "Identifier");
		const typeCst = sub(cst, "typeRef");
		if (!name || !typeCst) return null;
		return {
			kind: "prop",
			mutable: has(cst, "Var"),
			name: name.image,
			nameSpan: tokSpan(name),
			type: this.typeRef(typeCst),
		};
	}

	private ifStmt(cst: CstNode): Stmt | null {
		const conds = this.conditionList(cst);
		const blocks = subs(cst, "block");
		if (conds.length === 0 || blocks.length === 0) return null;
		const nestedIf = sub(cst, "ifStmt");
		let elseBody: Stmt[] | undefined;
		if (nestedIf) {
			const nested = this.ifStmt(nestedIf);
			elseBody = nested ? [nested] : [];
		} else if (blocks.length > 1) {
			elseBody = this.block(blocks[1]);
		}
		return {
			kind: "if",
			conds,
			thenBody: this.block(blocks[0]),
			elseBody,
			span: nodeSpan(cst),
		};
	}

	private conditionList(cst: CstNode): Condition[] {
		const listCst = sub(cst, "conditionList");
		if (!listCst) return [];
		return subs(listCst, "condition").map((c) => this.condition(c));
	}

	private condition(cst: CstNode): Condition {
		const exprCst = sub(cst, "condExpression");
		const expr = exprCst
			? this.condExpression(exprCst)
			: ({ kind: "bool", value: true, span: nodeSpan(cst) } satisfies Expr);
		const binding = tok(cst, "Identifier");
		if (has(cst, "Let") && binding) {
			return {
				kind: "optionalBinding",
				name: binding.image,
				nameSpan: tokSpan(binding),
				expr,
			};
		}
		return { kind: "expr", expr };
	}

	private condExpression(cst: CstNode): Expr {
		const inner = sub(cst, "expression");
		return inner
			? this.expression(inner)
			: { kind: "bool", value: true, span: nodeSpan(cst) };
	}

	private forStmt(cst: CstNode): Stmt | null {
		const single = tok(cst, "single");
		const tupleKey = tok(cst, "tupleKey");
		const tupleValue = tok(cst, "tupleValue");
		const sourceCst = sub(cst, "source");
		const blockCst = sub(cst, "block");
		if (!sourceCst || !blockCst) return null;
		let binding: ForBinding;
		if (single) {
			binding = {
				kind: "single",
				name: single.image,
				nameSpan: tokSpan(single),
			};
		} else if (tupleKey && tupleValue) {
			binding = {
				kind: "tuple",
				key: { name: tupleKey.image, nameSpan: tokSpan(tupleKey) },
				value: { name: tupleValue.image, nameSpan: tokSpan(tupleValue) },
			};
		} else {
			return null;
		}
		const from = this.condExpression(sourceCst);
		const rangeEndCst = sub(cst, "rangeEnd");
		const source: ForSource = rangeEndCst
			? {
					kind: "range",
					from,
					to: this.condExpression(rangeEndCst),
					inclusive: has(cst, "RangeIncl"),
				}
			: { kind: "iterable", expr: from };
		return {
			kind: "for",
			binding,
			source,
			body: this.block(blockCst),
			span: nodeSpan(cst),
		};
	}

	private guardStmt(cst: CstNode): Stmt | null {
		const conds = this.conditionList(cst);
		const blockCst = sub(cst, "block");
		if (conds.length === 0 || !blockCst) return null;
		return {
			kind: "guard",
			conds,
			elseBody: this.block(blockCst),
			span: nodeSpan(cst),
		};
	}

	private whileStmt(cst: CstNode): Stmt | null {
		const condCst = sub(cst, "condExpression");
		const blockCst = sub(cst, "block");
		if (!condCst || !blockCst) return null;
		return {
			kind: "while",
			cond: this.condExpression(condCst),
			body: this.block(blockCst),
			span: nodeSpan(cst),
		};
	}

	private switchStmt(cst: CstNode): Stmt | null {
		const subjectCst = sub(cst, "condExpression");
		if (!subjectCst) return null;
		const cases = subs(cst, "switchCase")
			.map((c) => this.switchCase(c))
			.filter((c): c is SwitchCase => c !== null);
		return {
			kind: "switch",
			subject: this.condExpression(subjectCst),
			cases,
			span: nodeSpan(cst),
		};
	}

	private switchCase(cst: CstNode): SwitchCase | null {
		const body = subs(cst, "statement")
			.map((s) => this.statement(s))
			.filter((s): s is Stmt => s !== null);
		const span = nodeSpan(cst);
		if (has(cst, "Default")) return { pattern: "default", body, span };
		const patternCst = sub(cst, "casePattern");
		if (!patternCst) return null;
		const pattern = this.casePattern(patternCst);
		return pattern ? { pattern, body, span } : null;
	}

	private casePattern(cst: CstNode): Pattern | null {
		const span = nodeSpan(cst);
		if (has(cst, "Is")) {
			const typeCst = sub(cst, "typeRef");
			if (!typeCst) return null;
			return { kind: "typePattern", type: this.typeRef(typeCst), span };
		}
		const caseName = tok(cst, "caseName");
		if (caseName) {
			return {
				kind: "case",
				name: caseName.image,
				nameSpan: tokSpan(caseName),
				bindings: toks(cst, "binding").map((b) => ({
					name: b.image,
					nameSpan: tokSpan(b),
				})),
			};
		}
		const num = tok(cst, "NumberLiteral");
		if (num) {
			const value = numberValue(num);
			return {
				kind: "literal",
				value: has(cst, "Minus") ? -value : value,
				span,
			};
		}
		const str = tok(cst, "StringLiteral");
		if (str) {
			const payload = str.payload as StringPayload;
			const exprSegments = payload.segments.filter((s) => s.kind === "expr");
			if (exprSegments.length > 0) {
				this.error(tokSpan(str), "Interpolation is not allowed in patterns");
			}
			const value = payload.segments
				.map((s) => (s.kind === "text" ? s.value : ""))
				.join("");
			return { kind: "literal", value, span };
		}
		if (has(cst, "True")) return { kind: "literal", value: true, span };
		if (has(cst, "False")) return { kind: "literal", value: false, span };
		return null;
	}

	private returnStmt(cst: CstNode): Stmt {
		const valueCst = sub(cst, "expression");
		return {
			kind: "return",
			value: valueCst ? this.expression(valueCst) : undefined,
			span: nodeSpan(cst),
		};
	}

	private throwStmt(cst: CstNode): Stmt | null {
		const exprCst = sub(cst, "expression");
		if (!exprCst) return null;
		return {
			kind: "throw",
			expr: this.expression(exprCst),
			span: nodeSpan(cst),
		};
	}

	private doCatchStmt(cst: CstNode): Stmt {
		const bodyCst = sub(cst, "block");
		const catchCst = sub(cst, "catchBlock");
		return {
			kind: "doCatch",
			body: bodyCst ? this.block(bodyCst) : [],
			catchBody: catchCst ? this.block(catchCst) : [],
			span: nodeSpan(cst),
		};
	}

	private exprStatement(cst: CstNode): Stmt | null {
		const targetCst = sub(cst, "target");
		if (!targetCst) return null;
		const target = this.expression(targetCst);
		const valueCst = sub(cst, "value");
		if (!valueCst) {
			return { kind: "expr", expr: target, span: nodeSpan(cst) };
		}
		const opTok = mergedToks(cst, [
			"Equals",
			"PlusEq",
			"MinusEq",
			"StarEq",
			"SlashEq",
		])[0];
		const op = (opTok?.image ?? "=") as "=" | "+=" | "-=" | "*=" | "/=";
		return {
			kind: "assign",
			target,
			op,
			value: this.expression(valueCst),
			span: nodeSpan(cst),
		};
	}

	private block(cst: CstNode): Stmt[] {
		return subs(cst, "statement")
			.map((s) => this.statement(s))
			.filter((s): s is Stmt => s !== null);
	}

	// ---- Expressions ----

	private expression(cst: CstNode): Expr {
		const condCst = sub(cst, "cond");
		const cond = condCst
			? this.nilCoalesce(condCst)
			: ({ kind: "nil", span: nodeSpan(cst) } satisfies Expr);
		const thenCst = sub(cst, "then");
		const elseCst = sub(cst, "else");
		if (!thenCst || !elseCst) return cond;
		return {
			kind: "ternary",
			cond,
			thenExpr: this.expression(thenCst),
			elseExpr: this.expression(elseCst),
			span: nodeSpan(cst),
		};
	}

	private nilCoalesce(cst: CstNode): Expr {
		const operands = subs(cst, "logicalOr").map((o) => this.logicalOr(o));
		// `??` is right-associative
		return operands.reduceRight((right, left) =>
			combineBinary(left, "??", right),
		);
	}

	private logicalOr(cst: CstNode): Expr {
		return this.leftFold(
			subs(cst, "logicalAnd").map((o) => this.logicalAnd(o)),
			["||"],
		);
	}

	private logicalAnd(cst: CstNode): Expr {
		return this.leftFold(
			subs(cst, "equality").map((o) => this.equality(o)),
			["&&"],
		);
	}

	private equality(cst: CstNode): Expr {
		const operands = subs(cst, "comparison").map((o) => this.comparison(o));
		if (operands.length === 1) return operands[0];
		const op = has(cst, "EqualsEquals") ? "==" : "!=";
		return combineBinary(operands[0], op, operands[1]);
	}

	private comparison(cst: CstNode): Expr {
		const operands = subs(cst, "additive").map((o) => this.additive(o));
		if (operands.length === 1) return operands[0];
		const opTok = mergedToks(cst, [
			"Less",
			"LessEq",
			"Greater",
			"GreaterEq",
		])[0];
		return combineBinary(
			operands[0],
			(opTok?.image ?? "<") as BinaryOp,
			operands[1],
		);
	}

	private additive(cst: CstNode): Expr {
		const operands = subs(cst, "multiplicative").map((o) =>
			this.multiplicative(o),
		);
		const ops = mergedToks(cst, ["Plus", "Minus"]).map(
			(t) => t.image as BinaryOp,
		);
		return foldBinary(operands, ops);
	}

	private multiplicative(cst: CstNode): Expr {
		const operands = subs(cst, "castExpr").map((o) => this.castExpr(o));
		const ops = mergedToks(cst, ["Star", "Slash", "Percent"]).map(
			(t) => t.image as BinaryOp,
		);
		return foldBinary(operands, ops);
	}

	private castExpr(cst: CstNode): Expr {
		const operandCst = sub(cst, "unaryExpr");
		const operand = operandCst
			? this.unaryExpr(operandCst)
			: ({ kind: "nil", span: nodeSpan(cst) } satisfies Expr);
		const typeCst = sub(cst, "typeRef");
		if (!has(cst, "Is") || !typeCst) return operand;
		return {
			kind: "is",
			operand,
			type: this.typeRef(typeCst),
			span: nodeSpan(cst),
		};
	}

	private leftFold(operands: Expr[], ops: BinaryOp[]): Expr {
		return foldBinary(
			operands,
			Array.from({ length: operands.length - 1 }, () => ops[0]),
		);
	}

	private unaryExpr(cst: CstNode): Expr {
		const nested = sub(cst, "unaryExpr");
		if (nested) {
			if (has(cst, "Await")) {
				return {
					kind: "await",
					operand: this.unaryExpr(nested),
					span: nodeSpan(cst),
				};
			}
			if (has(cst, "Try")) {
				return {
					kind: "try",
					operand: this.unaryExpr(nested),
					span: nodeSpan(cst),
				};
			}
			const op = has(cst, "Bang") ? "!" : "-";
			return {
				kind: "unary",
				op,
				operand: this.unaryExpr(nested),
				span: nodeSpan(cst),
			};
		}
		const postfix = sub(cst, "postfixExpr");
		return postfix
			? this.postfixExpr(postfix)
			: { kind: "nil", span: nodeSpan(cst) };
	}

	private postfixExpr(cst: CstNode): Expr {
		const primaryCst = sub(cst, "primaryExpr");
		let current: Expr = primaryCst
			? this.primaryExpr(primaryCst)
			: { kind: "nil", span: nodeSpan(cst) };
		let prevWasCallParens = false;
		for (const opCst of subs(cst, "postfixOp")) {
			const opSpan = nodeSpan(opCst);
			const span: Span = { start: current.span.start, end: opSpan.end };
			const callCst = sub(opCst, "callParens");
			if (callCst) {
				current = {
					kind: "call",
					callee: current,
					args: this.callArgs(callCst),
					span,
				};
				prevWasCallParens = true;
				continue;
			}
			const closureCst = sub(opCst, "closureLiteral");
			if (closureCst) {
				const closure = this.closureLiteral(closureCst);
				const arg: CallArg = { label: null, expr: closure, trailing: true };
				if (prevWasCallParens && current.kind === "call") {
					current.args.push(arg);
					current.span = span;
				} else {
					current = { kind: "call", callee: current, args: [arg], span };
				}
				prevWasCallParens = false;
				continue;
			}
			prevWasCallParens = false;
			const ident = tok(opCst, "Identifier");
			if (has(opCst, "Dot") && ident) {
				current = {
					kind: "member",
					object: current,
					name: ident.image,
					nameSpan: tokSpan(ident),
					optional: false,
					span,
				};
				continue;
			}
			if (has(opCst, "OptionalChain") && ident) {
				current = {
					kind: "member",
					object: current,
					name: ident.image,
					nameSpan: tokSpan(ident),
					optional: true,
					span,
				};
				continue;
			}
			const indexCst = sub(opCst, "nestedExpression");
			if (indexCst) {
				current = {
					kind: "subscript",
					object: current,
					index: this.nestedExpression(indexCst),
					span,
				};
				continue;
			}
			if (has(opCst, "Bang")) {
				current = { kind: "force", operand: current, span };
			}
		}
		return current;
	}

	private callArgs(cst: CstNode): CallArg[] {
		return subs(cst, "callArg").flatMap((argCst) => {
			const exprCst = sub(argCst, "nestedExpression");
			if (!exprCst) return [];
			const label = tok(argCst, "argLabel");
			return [
				{
					label: label ? label.image : null,
					labelSpan: label ? tokSpan(label) : undefined,
					expr: this.nestedExpression(exprCst),
				},
			];
		});
	}

	private nestedExpression(cst: CstNode): Expr {
		const inner = sub(cst, "expression");
		return inner
			? this.expression(inner)
			: { kind: "nil", span: nodeSpan(cst) };
	}

	private primaryExpr(cst: CstNode): Expr {
		const span = nodeSpan(cst);
		const num = tok(cst, "NumberLiteral");
		if (num) return { kind: "number", value: numberValue(num), span };
		const str = tok(cst, "StringLiteral");
		if (str) return this.stringLiteral(str);
		if (has(cst, "Nil")) return { kind: "nil", span };
		if (has(cst, "True")) return { kind: "bool", value: true, span };
		if (has(cst, "False")) return { kind: "bool", value: false, span };
		if (has(cst, "Super")) return { kind: "superRef", span };
		const dollar = tok(cst, "DollarIdent");
		if (dollar) {
			return {
				kind: "dollar",
				index: Number(dollar.image.slice(1)),
				span,
			};
		}
		const ident = tok(cst, "Identifier");
		if (ident) return { kind: "ident", name: ident.image, span };
		const dictCst = sub(cst, "dictLiteral");
		if (dictCst) return this.dictLiteral(dictCst);
		const doCst = sub(cst, "doExprLiteral");
		if (doCst) return this.doExprLiteral(doCst);
		const closureCst = sub(cst, "closureLiteral");
		if (closureCst) return this.closureLiteral(closureCst);
		const bracketCst = sub(cst, "bracketLiteral");
		if (bracketCst) return this.bracketLiteral(bracketCst);
		const nestedList = subs(cst, "nestedExpression");
		if (nestedList.length > 0) return this.nestedExpression(nestedList[0]);
		return { kind: "nil", span };
	}

	private doExprLiteral(cst: CstNode): Expr {
		const bodyCst = sub(cst, "block");
		const catchCst = sub(cst, "catchBlock");
		return {
			kind: "doExpr",
			body: bodyCst ? this.block(bodyCst) : [],
			catchBody: catchCst ? this.block(catchCst) : undefined,
			span: nodeSpan(cst),
		};
	}

	private bracketLiteral(cst: CstNode): Expr {
		return {
			kind: "array",
			elements: subs(cst, "nestedExpression").map((e) =>
				this.nestedExpression(e),
			),
			span: nodeSpan(cst),
		};
	}

	private dictLiteral(cst: CstNode): Expr {
		const entries: DictEntry[] = [];
		for (const entryCst of subs(cst, "dictEntry")) {
			const valueCst = sub(entryCst, "entryValue");
			if (!valueCst) continue;
			const value = this.nestedExpression(valueCst);
			const bareKey = tok(entryCst, "bareKey");
			if (bareKey) {
				entries.push({
					key: {
						kind: "string",
						parts: [{ kind: "text", value: bareKey.image }],
						span: tokSpan(bareKey),
					},
					value,
					computed: false,
				});
				continue;
			}
			const stringKey = tok(entryCst, "stringKey");
			if (stringKey) {
				entries.push({
					key: this.stringLiteral(stringKey),
					value,
					computed: false,
				});
				continue;
			}
			const computedCst = sub(entryCst, "computedKey");
			if (computedCst) {
				entries.push({
					key: this.nestedExpression(computedCst),
					value,
					computed: true,
				});
			}
		}
		return { kind: "dict", entries, span: nodeSpan(cst) };
	}

	private stringLiteral(token: IToken): Expr {
		const payload = token.payload as StringPayload;
		const span = tokSpan(token);
		if (payload.unterminated) {
			this.error(span, "Unterminated string literal");
		}
		const parts: StringPart[] = [];
		for (const segment of payload.segments) {
			if (segment.kind === "text") {
				parts.push({ kind: "text", value: segment.value });
				continue;
			}
			const expr = this.parseFragment(segment.source, segment.start);
			if (expr) parts.push({ kind: "expr", expr });
		}
		return { kind: "string", parts, span };
	}

	private parseFragment(source: string, baseOffset: number): Expr | null {
		const cst = runParser(source, baseOffset, this.diagnostics, "expression");
		if (cst === null) return null;
		const expr = this.expression(cst);
		shiftSpans(expr, baseOffset);
		return expr;
	}

	private closureLiteral(cst: CstNode): Expr {
		const headerCst = sub(cst, "closureHeader");
		const params: ClosureParam[] = [];
		let retType: TypeNode | undefined;
		if (headerCst) {
			const paramCsts = subs(headerCst, "closureParam");
			if (paramCsts.length > 0 || has(headerCst, "LParen")) {
				for (const p of paramCsts) {
					const name = tok(p, "Identifier");
					if (!name) continue;
					const typeCst = sub(p, "typeRef");
					params.push({
						name: name.image,
						nameSpan: tokSpan(name),
						type: typeCst ? this.typeRef(typeCst) : undefined,
					});
				}
				const retCst = sub(headerCst, "typeRef");
				if (retCst) retType = this.typeRef(retCst);
			} else {
				for (const name of toks(headerCst, "Identifier")) {
					params.push({ name: name.image, nameSpan: tokSpan(name) });
				}
			}
		}
		return {
			kind: "closure",
			params,
			retType,
			body: subs(cst, "statement")
				.map((s) => this.statement(s))
				.filter((s): s is Stmt => s !== null),
			hasHeader: headerCst !== undefined,
			span: nodeSpan(cst),
		};
	}

	// ---- Types ----

	private typeRef(cst: CstNode): TypeNode {
		const members = subs(cst, "member").map((m) => this.typeMember(m));
		if (members.length === 0) return { kind: "void", span: nodeSpan(cst) };
		if (members.length === 1) return members[0];
		return { kind: "union", members, span: nodeSpan(cst) };
	}

	private typeMember(cst: CstNode): TypeNode {
		const primaryCst = sub(cst, "typePrimary");
		let type: TypeNode = primaryCst
			? this.typePrimary(primaryCst)
			: { kind: "void", span: nodeSpan(cst) };
		// `?` adds one optional layer; a `??` token adds two (`Number??`).
		const suffixes = [
			...toks(cst, "Question").map((q) => ({ token: q, levels: 1 })),
			...toks(cst, "NilCoalesce").map((q) => ({ token: q, levels: 2 })),
		].sort((a, b) => a.token.startOffset - b.token.startOffset);
		for (const { token, levels } of suffixes) {
			for (let i = 0; i < levels; i++) {
				type = {
					kind: "optional",
					inner: type,
					span: { start: type.span.start, end: tokSpan(token).end },
				};
			}
		}
		return type;
	}

	private typePrimary(cst: CstNode): TypeNode {
		const span = nodeSpan(cst);
		const ident = tok(cst, "Identifier");
		if (ident) {
			const argsCst = sub(cst, "typeArgs");
			return {
				kind: "named",
				name: ident.image,
				args: argsCst
					? subs(argsCst, "typeRef").map((a) => this.typeRef(a))
					: [],
				span,
			};
		}
		// `[T]` (Array) sugar / `[K: V]` dictionary type
		const bracketElement = sub(cst, "bracketElement");
		if (bracketElement) {
			const dictValue = sub(cst, "dictValue");
			if (dictValue) {
				return {
					kind: "named",
					name: "Dictionary",
					args: [this.typeRef(bracketElement), this.typeRef(dictValue)],
					span,
				};
			}
			return {
				kind: "named",
				name: "Array",
				args: [this.typeRef(bracketElement)],
				span,
			};
		}
		// Literal types
		const num = tok(cst, "NumberLiteral");
		if (num) {
			const value = numberValue(num);
			return {
				kind: "literalType",
				value: has(cst, "Minus") ? -value : value,
				span,
			};
		}
		const str = tok(cst, "StringLiteral");
		if (str) {
			const payload = str.payload as StringPayload;
			if (payload.segments.some((s) => s.kind === "expr")) {
				this.error(span, "Interpolation is not allowed in literal types");
			}
			return {
				kind: "literalType",
				value: payload.segments
					.map((s) => (s.kind === "text" ? s.value : ""))
					.join(""),
				span,
			};
		}
		if (has(cst, "True")) return { kind: "literalType", value: true, span };
		if (has(cst, "False")) return { kind: "literalType", value: false, span };
		const retCst = sub(cst, "ret");
		const paramCsts = subs(cst, "typeRef");
		if (retCst) {
			return {
				kind: "func",
				params: paramCsts.map((p) => this.typeRef(p)),
				ret: this.typeRef(retCst),
				span,
			};
		}
		if (paramCsts.length === 0) return { kind: "void", span };
		if (paramCsts.length === 1) return this.typeRef(paramCsts[0]);
		this.error(span, "Tuple types are not supported");
		return this.typeRef(paramCsts[0]);
	}
}

function combineBinary(left: Expr, op: BinaryOp, right: Expr): Expr {
	return {
		kind: "binary",
		op,
		left,
		right,
		span: { start: left.span.start, end: right.span.end },
	};
}

function foldBinary(operands: Expr[], ops: BinaryOp[]): Expr {
	let result = operands[0];
	for (let i = 1; i < operands.length; i++) {
		result = combineBinary(result, ops[i - 1], operands[i]);
	}
	return result;
}

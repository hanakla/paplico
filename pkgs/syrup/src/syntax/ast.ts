// Source spans are absolute character offsets into the compiled source text.
export interface Span {
	start: number;
	end: number;
}

export interface Diagnostic {
	span: Span;
	message: string;
	severity: "error" | "warning";
}

// ---- Type annotations (syntactic) ----

export type TypeNode =
	| { kind: "named"; name: string; args: TypeNode[]; span: Span }
	| { kind: "optional"; inner: TypeNode; span: Span }
	| { kind: "func"; params: TypeNode[]; ret: TypeNode; span: Span }
	| { kind: "literalType"; value: string | number | boolean; span: Span }
	| { kind: "union"; members: TypeNode[]; span: Span }
	| { kind: "void"; span: Span };

// ---- Expressions ----

export type StringPart =
	| { kind: "text"; value: string }
	| { kind: "expr"; expr: Expr };

export interface DictEntry {
	key: Expr;
	value: Expr;
	/** true for `[expr]:` computed keys (never key-exhaustiveness material). */
	computed: boolean;
}

export interface CallArg {
	label: string | null;
	labelSpan?: Span;
	expr: Expr;
	trailing?: boolean;
}

export interface ClosureParam {
	name: string;
	nameSpan: Span;
	type?: TypeNode;
}

export type Expr =
	| { kind: "number"; value: number; span: Span }
	| { kind: "string"; parts: StringPart[]; span: Span }
	| { kind: "bool"; value: boolean; span: Span }
	| { kind: "nil"; span: Span }
	| { kind: "ident"; name: string; span: Span }
	| { kind: "dollar"; index: number; span: Span }
	| { kind: "array"; elements: Expr[]; span: Span }
	| { kind: "dict"; entries: DictEntry[]; span: Span }
	| { kind: "await"; operand: Expr; span: Span }
	| { kind: "try"; operand: Expr; span: Span }
	| { kind: "doExpr"; body: Stmt[]; catchBody?: Stmt[]; span: Span }
	| { kind: "is"; operand: Expr; type: TypeNode; span: Span }
	| { kind: "superRef"; span: Span }
	| {
			kind: "closure";
			params: ClosureParam[];
			retType?: TypeNode;
			body: Stmt[];
			hasHeader: boolean;
			span: Span;
	  }
	| { kind: "call"; callee: Expr; args: CallArg[]; span: Span }
	| {
			kind: "member";
			object: Expr;
			name: string;
			nameSpan: Span;
			optional: boolean;
			span: Span;
	  }
	| { kind: "subscript"; object: Expr; index: Expr; span: Span }
	| { kind: "force"; operand: Expr; span: Span }
	| { kind: "unary"; op: "!" | "-"; operand: Expr; span: Span }
	| { kind: "binary"; op: BinaryOp; left: Expr; right: Expr; span: Span }
	| { kind: "ternary"; cond: Expr; thenExpr: Expr; elseExpr: Expr; span: Span };

export type BinaryOp =
	| "??"
	| "||"
	| "&&"
	| "=="
	| "!="
	| "<"
	| "<="
	| ">"
	| ">="
	| "+"
	| "-"
	| "*"
	| "/"
	| "%";

// ---- Declarations ----

export interface ParamDecl {
	/** External argument label. `null` when declared with `_`. */
	label: string | null;
	name: string;
	nameSpan: Span;
	type: TypeNode;
	defaultValue?: Expr;
	/** Declared as `name?: Type`. Only allowed in `declare`. */
	omittable?: boolean;
	omittableSpan?: Span;
}

export interface AttributeDecl {
	name: string;
	span: Span;
}

export interface TypeParamDecl {
	name: string;
	nameSpan: Span;
	/** `<T: Shape>` upper bound; must resolve to a class or protocol type. */
	constraint?: TypeNode;
}

export interface FuncSig {
	name: string;
	nameSpan: Span;
	isAsync: boolean;
	/** `fn f() throws -> T`: calls must be marked `try` and handled. */
	throws: boolean;
	attributes: AttributeDecl[];
	typeParams: TypeParamDecl[];
	params: ParamDecl[];
	retType?: TypeNode;
}

export interface FieldDecl {
	mutable: boolean;
	name: string;
	nameSpan: Span;
	type: TypeNode;
	defaultValue?: Expr;
}

export interface MethodDecl {
	sig: FuncSig;
	body: Stmt[];
	mutating: boolean;
	override: boolean;
	span: Span;
}

export interface InitDecl {
	params: ParamDecl[];
	body: Stmt[];
	span: Span;
}

export interface EnumCaseDecl {
	name: string;
	nameSpan: Span;
	assoc: { label: string; type: TypeNode }[];
}

export type DeclTypeMember =
	| {
			kind: "prop";
			mutable: boolean;
			name: string;
			nameSpan: Span;
			type: TypeNode;
	  }
	| { kind: "method"; sig: FuncSig; mutating: boolean };

// ---- Statements ----

export type Condition =
	| { kind: "expr"; expr: Expr }
	| { kind: "optionalBinding"; name: string; nameSpan: Span; expr: Expr };

export type ForSource =
	| { kind: "range"; from: Expr; to: Expr; inclusive: boolean }
	| { kind: "iterable"; expr: Expr };

export type ForBinding =
	| { kind: "single"; name: string; nameSpan: Span }
	| {
			kind: "tuple";
			key: { name: string; nameSpan: Span };
			value: { name: string; nameSpan: Span };
	  };

export type Pattern =
	| {
			kind: "case";
			name: string;
			nameSpan: Span;
			bindings: { name: string; nameSpan: Span }[];
	  }
	| { kind: "literal"; value: number | string | boolean; span: Span }
	| { kind: "typePattern"; type: TypeNode; span: Span };

export interface SwitchCase {
	pattern: Pattern | "default";
	body: Stmt[];
	span: Span;
}

export type Stmt =
	| {
			kind: "binding";
			mutable: boolean;
			exported?: boolean;
			name: string;
			nameSpan: Span;
			type?: TypeNode;
			init: Expr;
			span: Span;
	  }
	| { kind: "func"; sig: FuncSig; body: Stmt[]; exported?: boolean; span: Span }
	| {
			kind: "struct";
			name: string;
			nameSpan: Span;
			typeParams: TypeParamDecl[];
			fields: FieldDecl[];
			methods: MethodDecl[];
			exported?: boolean;
			span: Span;
	  }
	| {
			kind: "enum";
			name: string;
			nameSpan: Span;
			typeParams: TypeParamDecl[];
			cases: EnumCaseDecl[];
			methods: MethodDecl[];
			exported?: boolean;
			span: Span;
	  }
	| {
			kind: "class";
			name: string;
			nameSpan: Span;
			typeParams: TypeParamDecl[];
			/** Superclass and/or conformed protocols (resolved by the checker). */
			heritage: TypeNode[];
			fields: FieldDecl[];
			inits: InitDecl[];
			methods: MethodDecl[];
			exported?: boolean;
			span: Span;
	  }
	| {
			kind: "protocol";
			name: string;
			nameSpan: Span;
			typeParams: TypeParamDecl[];
			props: FieldDecl[];
			methods: FuncSig[];
			exported?: boolean;
			span: Span;
	  }
	| {
			kind: "use";
			/** Module specifier string (resolved by the host's module resolver). */
			specifier: string;
			specifierSpan: Span;
			/** `use ns from "..."`: namespace binding name, or null. */
			binding: { name: string; span: Span } | null;
			/** `use { a, b } from "..."`: imported member names, or null. */
			named: { name: string; span: Span }[] | null;
			span: Span;
	  }
	| {
			kind: "if";
			conds: Condition[];
			thenBody: Stmt[];
			elseBody?: Stmt[];
			span: Span;
	  }
	| { kind: "guard"; conds: Condition[]; elseBody: Stmt[]; span: Span }
	| {
			kind: "for";
			binding: ForBinding;
			source: ForSource;
			body: Stmt[];
			span: Span;
	  }
	| { kind: "while"; cond: Expr; body: Stmt[]; span: Span }
	| { kind: "switch"; subject: Expr; cases: SwitchCase[]; span: Span }
	| { kind: "return"; value?: Expr; span: Span }
	| { kind: "break"; span: Span }
	| { kind: "continue"; span: Span }
	| { kind: "throw"; expr: Expr; span: Span }
	| { kind: "doCatch"; body: Stmt[]; catchBody: Stmt[]; span: Span }
	| {
			kind: "assign";
			target: Expr;
			op: "=" | "+=" | "-=" | "*=" | "/=";
			value: Expr;
			span: Span;
	  }
	| { kind: "expr"; expr: Expr; span: Span }
	| { kind: "declareFunc"; sig: FuncSig; span: Span }
	| {
			kind: "declareLet";
			name: string;
			nameSpan: Span;
			type: TypeNode;
			span: Span;
	  }
	| {
			kind: "declareType";
			name: string;
			nameSpan: Span;
			typeParams: TypeParamDecl[];
			members: DeclTypeMember[];
			span: Span;
	  };

export type Program = Stmt[];

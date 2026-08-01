// Semantic types. Type identity for structs/enums/host types is nominal
// (by Info object identity); generic instances also compare type arguments.

export interface FuncParam {
	label: string | null;
	type: Type;
	hasDefault: boolean;
}

export interface FuncType {
	kind: "func";
	isAsync: boolean;
	/** Calls must be marked `try` and handled (Swift `throws`). */
	throws?: boolean;
	typeParams: TypeParamInfo[];
	params: FuncParam[];
	ret: Type;
}

export interface TypeParamInfo {
	name: string;
	id: number;
	/** Upper bound from `<T: Shape>` (class or protocol type), if any. */
	constraint?: Type;
}

export interface StructInfo {
	name: string;
	typeParams: TypeParamInfo[];
	fields: { name: string; type: Type; mutable: boolean }[];
	/** Statically dispatched methods (emitted as free functions). */
	methods: Map<string, { func: FuncType; mutating: boolean }>;
	/** Defining module (null = entry script / host-side unit). */
	moduleName: string | null;
}

export interface EnumInfo {
	name: string;
	typeParams: TypeParamInfo[];
	cases: { name: string; assoc: { label: string; type: Type }[] }[];
	/** Statically dispatched methods (emitted as free functions). */
	methods: Map<string, { func: FuncType; mutating: boolean }>;
	/** Defining module (null = entry script / host-side unit). */
	moduleName: string | null;
}

export interface HostTypeInfo {
	name: string;
	typeParams: TypeParamInfo[];
	props: Map<string, { type: Type; mutable: boolean }>;
	methods: Map<string, FuncType>;
}

export interface ClassInfo {
	name: string;
	typeParams: TypeParamInfo[];
	/** Instantiated superclass type (with type arguments), if any. */
	superclass: (Type & { kind: "class" }) | null;
	/** Instantiated conformed protocols (declared on this class). */
	protocols: (Type & { kind: "protocol" })[];
	fields: {
		name: string;
		type: Type;
		mutable: boolean;
		hasDefault: boolean;
	}[];
	init: FuncType | null;
	methods: Map<string, { func: FuncType; override: boolean }>;
	/** Defining module (null = entry script / host-side unit). */
	moduleName: string | null;
}

export interface ProtocolInfo {
	name: string;
	typeParams: TypeParamInfo[];
	props: Map<string, { type: Type; mutable: boolean }>;
	methods: Map<string, FuncType>;
}

export type LiteralType = {
	kind: "literal";
	base: "number" | "string" | "bool";
	value: number | string | boolean;
};

export type UnionType = { kind: "union"; members: Type[] };

export type Type =
	| { kind: "number" }
	| { kind: "string" }
	| { kind: "bool" }
	| { kind: "void" }
	| { kind: "array"; element: Type }
	| { kind: "dictionary"; key: Type; value: Type }
	| { kind: "optional"; inner: Type }
	| FuncType
	| { kind: "struct"; info: StructInfo; typeArgs: Type[] }
	| { kind: "enum"; info: EnumInfo; typeArgs: Type[] }
	| { kind: "class"; info: ClassInfo; typeArgs: Type[] }
	| { kind: "protocol"; info: ProtocolInfo; typeArgs: Type[] }
	| { kind: "host"; info: HostTypeInfo; typeArgs: Type[] }
	| { kind: "typeParam"; info: TypeParamInfo }
	| LiteralType
	| UnionType
	| { kind: "error" };

export const NUMBER: Type = { kind: "number" };
export const STRING: Type = { kind: "string" };
export const BOOL: Type = { kind: "bool" };
export const VOID: Type = { kind: "void" };
export const ERROR: Type = { kind: "error" };

export function arrayOf(element: Type): Type {
	return { kind: "array", element };
}

export function dictionaryOf(key: Type, value: Type): Type {
	return { kind: "dictionary", key, value };
}

export function optionalOf(inner: Type): Type {
	// Chaining never produces nested optionals implicitly; explicit T?? is kept.
	return { kind: "optional", inner };
}

/**
 * Whether values of this optional type are boxed at runtime. Plain optionals
 * store `null | value`; nested optionals (`T??`) and optionals of a type
 * parameter (`T?` may instantiate to a nested optional) store
 * `null | {$some: value}` so `.some(nil)` stays distinct from `.none`.
 */
export function boxedRepr(type: Type): boolean {
	return (
		type.kind === "optional" &&
		(type.inner.kind === "optional" || type.inner.kind === "typeParam")
	);
}

/** Number of optional layers wrapping the core type. */
export function optionalDepth(type: Type): number {
	let depth = 0;
	let cur = type;
	while (cur.kind === "optional") {
		depth++;
		cur = cur.inner;
	}
	return depth;
}

export function literalOf(value: number | string | boolean): LiteralType {
	const base =
		typeof value === "number"
			? "number"
			: typeof value === "string"
				? "string"
				: "bool";
	return { kind: "literal", base, value };
}

/** Base primitive of a literal type. */
export function literalBase(literal: LiteralType): Type {
	switch (literal.base) {
		case "number":
			return NUMBER;
		case "string":
			return STRING;
		case "bool":
			return BOOL;
	}
}

/** Collapse a member list into a single type or a union (deduplicated). */
export function unionOf(members: Type[]): Type {
	const flat: Type[] = [];
	for (const member of members) {
		const items = member.kind === "union" ? member.members : [member];
		for (const item of items) {
			if (!flat.some((existing) => typeEquals(existing, item))) {
				flat.push(item);
			}
		}
	}
	if (flat.length === 0) return ERROR;
	if (flat.length === 1) return flat[0];
	return { kind: "union", members: flat };
}

/** Whether every string-literal member makes up the union (dictionary keys). */
export function stringLiteralMembers(type: Type): string[] | null {
	if (type.kind === "literal" && type.base === "string") {
		return [type.value as string];
	}
	if (type.kind !== "union") return null;
	const values: string[] = [];
	for (const member of type.members) {
		if (member.kind !== "literal" || member.base !== "string") return null;
		values.push(member.value as string);
	}
	return values;
}

export function isError(type: Type): boolean {
	return type.kind === "error";
}

/** Structural + nominal equality (no implicit conversions). */
export function typeEquals(a: Type, b: Type): boolean {
	if (a.kind === "error" || b.kind === "error") return true;
	if (a.kind !== b.kind) return false;
	switch (a.kind) {
		case "number":
		case "string":
		case "bool":
		case "void":
			return true;
		case "array":
			return typeEquals(a.element, (b as typeof a).element);
		case "dictionary": {
			const bd = b as typeof a;
			return typeEquals(a.key, bd.key) && typeEquals(a.value, bd.value);
		}
		case "optional":
			return typeEquals(a.inner, (b as typeof a).inner);
		case "func": {
			const bf = b as FuncType;
			return (
				a.isAsync === bf.isAsync &&
				(a.throws ?? false) === (bf.throws ?? false) &&
				a.params.length === bf.params.length &&
				a.params.every((p, i) => typeEquals(p.type, bf.params[i].type)) &&
				typeEquals(a.ret, bf.ret)
			);
		}
		case "struct":
		case "enum":
		case "class":
		case "protocol":
		case "host": {
			const bi = b as typeof a;
			return (
				a.info === bi.info &&
				a.typeArgs.length === bi.typeArgs.length &&
				a.typeArgs.every((arg, i) => typeEquals(arg, bi.typeArgs[i]))
			);
		}
		case "typeParam":
			return a.info === (b as typeof a).info;
		case "literal": {
			const bl = b as LiteralType;
			return a.base === bl.base && a.value === bl.value;
		}
		case "union": {
			const bu = b as UnionType;
			return (
				a.members.length === bu.members.length &&
				a.members.every((m) => bu.members.some((n) => typeEquals(m, n)))
			);
		}
	}
}

/** Whether values of this type carry value semantics (copied on assignment). */
export function hasValueSemantics(type: Type): boolean {
	switch (type.kind) {
		case "struct":
		case "enum":
			return true;
		case "optional":
			return hasValueSemantics(type.inner);
		case "union":
			return type.members.some((m) => hasValueSemantics(m));
		default:
			return false;
	}
}

export function typeToString(type: Type): string {
	switch (type.kind) {
		case "number":
			return "Number";
		case "string":
			return "String";
		case "bool":
			return "Bool";
		case "void":
			return "Void";
		case "array":
			return `Array<${typeToString(type.element)}>`;
		case "dictionary":
			return `[${typeToString(type.key)}: ${typeToString(type.value)}]`;
		case "optional": {
			const inner = typeToString(type.inner);
			return type.inner.kind === "func" ? `(${inner})?` : `${inner}?`;
		}
		case "func": {
			const params = type.params
				.map(
					(p) =>
						`${p.label !== null ? `${p.label}: ` : ""}${typeToString(p.type)}`,
				)
				.join(", ");
			return `${type.isAsync ? "async " : ""}(${params})${type.throws ? " throws" : ""} -> ${typeToString(type.ret)}`;
		}
		case "struct":
		case "enum":
		case "class":
		case "protocol":
		case "host":
			return type.typeArgs.length > 0
				? `${type.info.name}<${type.typeArgs.map(typeToString).join(", ")}>`
				: type.info.name;
		case "typeParam":
			return type.info.name;
		case "literal":
			return typeof type.value === "string"
				? JSON.stringify(type.value)
				: String(type.value);
		case "union":
			return type.members
				.map((m) =>
					m.kind === "func" ? `(${typeToString(m)})` : typeToString(m),
				)
				.join(" | ");
		case "error":
			return "<error>";
	}
}

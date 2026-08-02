import type { TypeNode } from "../syntax/ast";
import { parseProgram } from "../syntax/cstToAst";
import { CORE_TYPE_DECLARATIONS } from "./coreDeclarations";
import type { FuncType, Type, TypeParamInfo } from "./types";
import {
	arrayOf,
	BOOL,
	dictionaryOf,
	NUMBER,
	optionalOf,
	STRING,
	VOID,
} from "./types";
import { buildSubst, substitute } from "./unify";

export type MemberInfo =
	| { kind: "prop"; type: Type }
	| { kind: "method"; func: FuncType; mutating: boolean };

interface CoreTypeMembers {
	typeParams: TypeParamInfo[];
	props: Map<string, Type>;
	methods: Map<string, { func: FuncType; mutating: boolean }>;
}

export function getArrayMember(
	element: Type,
	name: string,
): MemberInfo | undefined {
	return instantiatedMember("Array", [element], name);
}

export function getStringMember(name: string): MemberInfo | undefined {
	return instantiatedMember("String", [], name);
}

export function getDictionaryMember(
	key: Type,
	value: Type,
	name: string,
): MemberInfo | undefined {
	return instantiatedMember("Dictionary", [key, value], name);
}

export function coreMemberNames(typeName: "Array" | "String" | "Dictionary"): {
	props: string[];
	methods: string[];
} {
	const entry = coreTable().get(typeName);
	if (!entry) return { props: [], methods: [] };
	return {
		props: [...entry.props.keys()],
		methods: [...entry.methods.keys()],
	};
}

// ---- Core declaration loading ----

let cachedTable: Map<string, CoreTypeMembers> | null = null;
// Core type params use negative ids so they never collide with user decls.
let nextCoreParamId = -1;

function coreTable(): Map<string, CoreTypeMembers> {
	cachedTable ??= buildCoreTable();
	return cachedTable;
}

function instantiatedMember(
	typeName: string,
	typeArgs: Type[],
	name: string,
): MemberInfo | undefined {
	const entry = coreTable().get(typeName);
	if (!entry) return undefined;
	const subst = buildSubst(entry.typeParams, typeArgs);
	const prop = entry.props.get(name);
	if (prop !== undefined) {
		return { kind: "prop", type: substitute(prop, subst) };
	}
	const method = entry.methods.get(name);
	if (method !== undefined) {
		const func = substitute(method.func, subst);
		if (func.kind !== "func") throw new Error("substitute changed func kind");
		return { kind: "method", func, mutating: method.mutating };
	}
	return undefined;
}

function buildCoreTable(): Map<string, CoreTypeMembers> {
	const { ast, diagnostics } = parseProgram(CORE_TYPE_DECLARATIONS);
	if (diagnostics.length > 0) {
		throw new Error(
			`Invalid core declarations: ${diagnostics.map((d) => d.message).join(", ")}`,
		);
	}
	const table = new Map<string, CoreTypeMembers>();
	for (const stmt of ast) {
		if (stmt.kind !== "declareType") {
			throw new Error("Core declarations may only contain declare type");
		}

		const typeParams = stmt.typeParams.map((decl) => ({
			name: decl.name,
			id: nextCoreParamId--,
		}));
		const typeEnv = new Map(typeParams.map((p) => [p.name, p]));
		const props = new Map<string, Type>();
		const methods = new Map<string, { func: FuncType; mutating: boolean }>();
		for (const member of stmt.members) {
			if (member.kind === "prop") {
				props.set(member.name, resolveCoreType(member.type, typeEnv));
				continue;
			}
			const methodParams = member.sig.typeParams.map((decl) => ({
				name: decl.name,
				id: nextCoreParamId--,
			}));
			const env = new Map([
				...typeEnv,
				...methodParams.map((p) => [p.name, p] as const),
			]);
			methods.set(member.sig.name, {
				mutating: member.mutating,
				func: {
					kind: "func",
					isAsync: member.sig.isAsync,
					typeParams: methodParams,
					params: member.sig.params.map((p) => ({
						label: p.label,
						type: resolveCoreType(p.type, env),
						hasDefault: false,
					})),
					ret: member.sig.retType
						? resolveCoreType(member.sig.retType, env)
						: VOID,
				},
			});
		}
		table.set(stmt.name, { typeParams, props, methods });
	}
	return table;
}

function resolveCoreType(
	node: TypeNode,
	env: Map<string, TypeParamInfo>,
): Type {
	switch (node.kind) {
		case "void":
			return VOID;
		case "literalType":
		case "union":
			throw new Error("Core declarations may not use literal/union types");
		case "optional":
			return optionalOf(resolveCoreType(node.inner, env));
		case "func":
			return {
				kind: "func",
				isAsync: false,
				typeParams: [],
				params: node.params.map((p) => ({
					label: null,
					type: resolveCoreType(p, env),
					hasDefault: false,
				})),
				ret: resolveCoreType(node.ret, env),
			};
		case "named": {
			const param = env.get(node.name);
			if (param) return { kind: "typeParam", info: param };
			switch (node.name) {
				case "Number":
					return NUMBER;
				case "String":
					return STRING;
				case "Bool":
					return BOOL;
				case "Void":
					return VOID;
				case "Array":
					return arrayOf(resolveCoreType(node.args[0], env));
				case "Optional":
					return optionalOf(resolveCoreType(node.args[0], env));
				case "Dictionary":
					return dictionaryOf(
						resolveCoreType(node.args[0], env),
						resolveCoreType(node.args[1], env),
					);
				default:
					throw new Error(
						`Core declarations reference unknown type '${node.name}'`,
					);
			}
		}
	}
}

import type { HostTypeInfo, Type } from "../checker/types";
import { __syrupStruct } from "../emit/runtime";
import { isHandleRef } from "./types";

/**
 * Shape of a value crossing the worker boundary (main → worker direction).
 * Only return values need shapes: host objects become opaque handles.
 */
export type MarshalShape =
	| { kind: "value" }
	| { kind: "handle"; info: HostTypeInfo }
	| { kind: "optional"; of: MarshalShape }
	| { kind: "array"; of: MarshalShape }
	| { kind: "dict"; of: MarshalShape }
	| { kind: "function" };

export function shapeOfType(type: Type): MarshalShape {
	switch (type.kind) {
		case "host":
			return { kind: "handle", info: type.info };
		case "optional":
			return { kind: "optional", of: shapeOfType(type.inner) };
		case "array":
			return { kind: "array", of: shapeOfType(type.element) };
		case "dictionary":
			return { kind: "dict", of: shapeOfType(type.value) };
		case "func":
			return { kind: "function" };
		default:
			// Plain data (numbers, strings, structs, enums, ...). Generic type
			// params also land here: generic host fns cannot return host objects.
			return { kind: "value" };
	}
}

export function shapeContainsFunction(shape: MarshalShape): boolean {
	switch (shape.kind) {
		case "function":
			return true;
		case "optional":
		case "array":
		case "dict":
			return shapeContainsFunction(shape.of);
		default:
			return false;
	}
}

/** Main-thread handle table: host object <-> numeric id. */
export class HandleTable {
	private byId = new Map<number, { value: object; info: HostTypeInfo }>();
	private idsByValue = new WeakMap<object, number>();
	private nextId = 1;

	public wrap(value: object, info: HostTypeInfo): { $syrupHandle: number } {
		let id = this.idsByValue.get(value);
		if (id === undefined) {
			id = this.nextId++;
			this.idsByValue.set(value, id);
			this.byId.set(id, { value, info });
		}
		return { $syrupHandle: id };
	}

	public resolve(id: number): { value: object; info: HostTypeInfo } {
		const entry = this.byId.get(id);
		if (!entry) throw new Error(`Unknown host handle #${id}`);
		return entry;
	}

	public clear(): void {
		this.byId.clear();
		this.idsByValue = new WeakMap();
		this.nextId = 1;
	}
}

/** Wrap an outgoing (main → worker) value according to its declared shape. */
export function marshalResult(
	value: unknown,
	shape: MarshalShape,
	handles: HandleTable,
): unknown {
	if (value === null || value === undefined) return null;
	switch (shape.kind) {
		case "value":
			return value;
		case "handle":
			if (typeof value !== "object") {
				throw new Error(
					`Host returned a non-object for host type '${shape.info.name}'`,
				);
			}
			return handles.wrap(value, shape.info);
		case "optional":
			return marshalResult(value, shape.of, handles);
		case "array":
			if (!Array.isArray(value)) {
				throw new Error("Host returned a non-array for an Array type");
			}
			return value.map((item) => marshalResult(item, shape.of, handles));
		case "dict": {
			if (!(value instanceof Map)) {
				throw new Error("Host returned a non-Map for a Dictionary type");
			}
			const out = new Map<unknown, unknown>();
			for (const [k, v] of value)
				out.set(k, marshalResult(v, shape.of, handles));
			return out;
		}
		case "function":
			throw new Error("Function values cannot cross the worker boundary");
	}
}

/** Deeply replace incoming (worker → main) handle refs with real objects. */
export function unmarshalValue(value: unknown, handles: HandleTable): unknown {
	if (value === null || typeof value !== "object") return value;
	if (isHandleRef(value)) return handles.resolve(value.$syrupHandle).value;
	if (Array.isArray(value)) {
		return value.map((item) => unmarshalValue(item, handles));
	}
	if (value instanceof Map) {
		const out = new Map<unknown, unknown>();
		for (const [k, v] of value) out.set(k, unmarshalValue(v, handles));
		return out;
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = unmarshalValue(item, handles);
	}
	return out;
}

/**
 * Convert an outgoing value into a postable form. Struct instances (value
 * data, marked with the symbol-keyed `[__syrupStruct]` static on their
 * class) are flattened to plain objects; functions and reference class
 * instances are rejected, since structured cloning would strip their
 * behavior.
 */
export function toPostable(value: unknown): unknown {
	if (typeof value === "function") {
		throw new Error("Function values cannot cross the worker boundary");
	}
	if (value === null || typeof value !== "object") return value;
	if (isHandleRef(value)) return value;
	if (Array.isArray(value)) return value.map((item) => toPostable(item));
	if (value instanceof Map) {
		const out = new Map<unknown, unknown>();
		for (const [k, v] of value) out.set(k, toPostable(v));
		return out;
	}
	const proto = Object.getPrototypeOf(value) as {
		constructor?: { [__syrupStruct]?: boolean };
	} | null;
	if (
		proto !== Object.prototype &&
		proto !== null &&
		proto.constructor?.[__syrupStruct] !== true
	) {
		throw new Error("Class instances cannot cross the worker boundary");
	}
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) out[key] = toPostable(item);
	return out;
}

/**
 * Host operations injected into compiled programs as `__host`.
 * The in-process runner resolves these synchronously; the worker runner
 * turns each into an RPC round-trip. Generated code awaits every op.
 */
export interface HostOps {
	/** Call a package function (declare fn). */
	call(pkg: string, member: string, args: unknown[]): unknown;
	/** Read a package value (declare let). */
	get(pkg: string, member: string): unknown;
	/** Read a host object property. Null/undefined targets yield null. */
	prop(target: unknown, name: string): unknown;
	/** Write a host object property. */
	setProp(target: unknown, name: string, value: unknown): unknown;
	/** Call a host object method. Null/undefined targets yield null. */
	method(target: unknown, name: string, args: unknown[]): unknown;
}

/** Minimal transport between the broker (main) and executor (worker). */
export interface RunnerTransport {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
}

/** Structural shim for Worker so this package never depends on DOM types. */
export interface WorkerLike {
	postMessage(message: unknown): void;
	onmessage: ((event: { data: unknown }) => void) | null;
	terminate?(): void;
}

export type RunnerRequest =
	| { type: "run"; code: string }
	| {
			type: "invokeModule";
			code: string;
			exportName: string;
			args: unknown[];
	  }
	| {
			type: "hostCall";
			id: number;
			op: "call" | "get" | "prop" | "setProp" | "method";
			pkg?: string;
			member?: string;
			target?: unknown;
			name?: string;
			args?: unknown[];
			value?: unknown;
	  };

export type RunnerResponse =
	| { type: "result"; id: number; value: unknown }
	| { type: "reject"; id: number; message: string }
	| { type: "done"; value?: unknown }
	| { type: "error"; message: string };

/** Opaque reference to a main-thread host object, safe to structured-clone. */
export interface HandleRef {
	$syrupHandle: number;
}

export function isHandleRef(value: unknown): value is HandleRef {
	return (
		typeof value === "object" &&
		value !== null &&
		"$syrupHandle" in value &&
		typeof (value as HandleRef).$syrupHandle === "number"
	);
}

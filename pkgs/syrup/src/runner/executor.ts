import { __syrupStruct } from "../emit/runtime";
import { toPostable } from "./marshal";
import type {
	HostOps,
	RunnerRequest,
	RunnerResponse,
	RunnerTransport,
} from "./types";

/**
 * Worker-side executor: receives compiled code, runs it with `__host` ops
 * that forward every host operation to the broker over the transport.
 */
export function createExecutor(transport: RunnerTransport): void {
	let nextId = 1;
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	const request = (
		payload: Omit<RunnerRequest & { type: "hostCall" }, "id">,
	): Promise<unknown> => {
		const postable = {
			...payload,
			args: payload.args?.map((arg) => toPostable(arg)),
			value: toPostable(payload.value),
		};
		return new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			transport.post({ ...postable, id });
		});
	};

	const hostOps: HostOps = {
		call: (pkg, member, args) =>
			request({ type: "hostCall", op: "call", pkg, member, args }),
		get: (pkg, member) => request({ type: "hostCall", op: "get", pkg, member }),
		prop: (target, name) =>
			request({ type: "hostCall", op: "prop", target, name }),
		setProp: (target, name, value) =>
			request({ type: "hostCall", op: "setProp", target, name, value }),
		method: (target, name, args) =>
			request({ type: "hostCall", op: "method", target, name, args }),
	};

	const execute = async (code: string): Promise<void> => {
		const AsyncFunction = Object.getPrototypeOf(async function noop() {
			// no-op: only used to obtain the AsyncFunction constructor
		}).constructor as new (
			...params: string[]
		) => (host: HostOps, structMarker: symbol) => Promise<void>;
		const program = new AsyncFunction("__host", "__syrupStruct", code);
		await program(hostOps, __syrupStruct);
	};

	const invokeModule = async (
		code: string,
		exportName: string,
		args: unknown[],
	): Promise<unknown> => {
		const AsyncFunction = Object.getPrototypeOf(async function noop() {
			// no-op: only used to obtain the AsyncFunction constructor
		}).constructor as new (
			...params: string[]
		) => (host: HostOps, structMarker: symbol) => Promise<unknown>;
		const program = new AsyncFunction("__host", "__syrupStruct", code);
		const moduleExports = await program(hostOps, __syrupStruct);
		if (typeof moduleExports !== "object" || moduleExports === null) {
			throw new Error("Compiled module did not return its exports");
		}
		const exported = Reflect.get(moduleExports, exportName);
		if (typeof exported !== "function") {
			throw new Error(`Module has no exported function '${exportName}'`);
		}
		return await Reflect.apply(exported, moduleExports, args);
	};

	transport.onMessage((raw) => {
		const message = raw as RunnerRequest | RunnerResponse;
		if (message.type === "result") {
			pending.get(message.id)?.resolve(message.value);
			pending.delete(message.id);
			return;
		}
		if (message.type === "reject") {
			pending.get(message.id)?.reject(new Error(message.message));
			pending.delete(message.id);
			return;
		}
		if (message.type === "run") {
			execute(message.code)
				.then(() => transport.post({ type: "done" } satisfies RunnerResponse))
				.catch((error) =>
					transport.post({
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					} satisfies RunnerResponse),
				);
			return;
		}
		if (message.type === "invokeModule") {
			invokeModule(message.code, message.exportName, message.args)
				.then((value) =>
					transport.post({
						type: "done",
						value: toPostable(value),
					} satisfies RunnerResponse),
				)
				.catch((error) =>
					transport.post({
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					} satisfies RunnerResponse),
				);
		}
	});
}

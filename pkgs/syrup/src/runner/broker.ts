import type { PackageEnv } from "../checker/check";
import type { FuncType, HostTypeInfo } from "../checker/types";
import {
	HandleTable,
	type MarshalShape,
	marshalResult,
	shapeOfType,
	unmarshalValue,
} from "./marshal";
import type { RunnerRequest, RunnerResponse, RunnerTransport } from "./types";

/**
 * Main-thread side of the worker sandbox: owns the real runtime bindings and
 * the handle table, and answers `__host` RPCs coming from the executor.
 */
export class RunnerBroker {
	private handles = new HandleTable();
	private fnShapes = new Map<string, MarshalShape>();
	private letShapes = new Map<string, MarshalShape>();
	private active: {
		resolve: (value: unknown) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	} | null = null;
	private disposed = false;

	public constructor(
		private packages: {
			env: PackageEnv;
			runtime: Record<string, unknown>;
		}[],
		private transport: RunnerTransport,
		private options: {
			timeoutMs?: number;
			onTimeout?: () => void;
		} = {},
	) {
		for (const { env } of packages) {
			for (const member of env.members.values()) {
				if (member.kind !== "value") continue;
				const key = `${env.name}.${member.name}`;
				if (member.type.kind === "func") {
					this.fnShapes.set(key, shapeOfType(member.type.ret));
				} else {
					this.letShapes.set(key, shapeOfType(member.type));
				}
			}
		}
		transport.onMessage((message) => {
			void this.handleMessage(message as RunnerResponse | RunnerRequest);
		});
	}

	/** Execute compiled code in the connected executor. One run at a time. */
	public run(code: string): Promise<void> {
		return this.start({ type: "run", code }).then(() => undefined);
	}

	/** Evaluate compiled module code and call one of its exported functions. */
	public invokeModule(
		code: string,
		options: { exportName: string; args?: unknown[] },
	): Promise<unknown> {
		return this.start({
			type: "invokeModule",
			code,
			exportName: options.exportName,
			args: options.args ?? [],
		});
	}

	/** Reject the active operation and prevent further use of this broker. */
	public dispose(error = new Error("Worker runner disposed")): void {
		this.disposed = true;
		this.finish((active) => active.reject(error));
	}

	private start(
		message: RunnerRequest & { type: "run" | "invokeModule" },
	): Promise<unknown> {
		if (this.disposed) {
			return Promise.reject(new Error("Worker runner is disposed"));
		}
		if (this.active) {
			return Promise.reject(new Error("A script is already running"));
		}
		return new Promise<unknown>((resolve, reject) => {
			const timeoutMs = this.options.timeoutMs ?? 60_000;
			const timeout = setTimeout(() => {
				this.finish((active) =>
					active.reject(
						new Error(`Script execution timed out after ${timeoutMs}ms`),
					),
				);
				this.disposed = true;
				this.options.onTimeout?.();
			}, timeoutMs);
			this.active = { resolve, reject, timeout };
			this.transport.post(message);
		});
	}

	private async handleMessage(
		message: RunnerRequest | RunnerResponse,
	): Promise<void> {
		if (message.type === "done") {
			this.finish((active) => active.resolve(message.value));
			return;
		}
		if (message.type === "error") {
			const failure = new Error(message.message);
			this.finish((active) => active.reject(failure));
			return;
		}
		if (message.type !== "hostCall") return;
		try {
			const value = await this.performOp(message);
			this.transport.post({
				type: "result",
				id: message.id,
				value,
			} satisfies RunnerResponse);
		} catch (error) {
			this.transport.post({
				type: "reject",
				id: message.id,
				message: error instanceof Error ? error.message : String(error),
			} satisfies RunnerResponse);
		}
	}

	private finish(
		settle: (active: NonNullable<typeof this.active>) => void,
	): void {
		const active = this.active;
		this.active = null;
		this.handles.clear();
		if (active) {
			clearTimeout(active.timeout);
			settle(active);
		}
	}

	private async performOp(
		message: RunnerRequest & { type: "hostCall" },
	): Promise<unknown> {
		switch (message.op) {
			case "call": {
				const pkg = message.pkg ?? "";
				const member = message.member ?? "";
				const runtime = this.runtimeOf(pkg);
				const fn = runtime[member];
				if (typeof fn !== "function") {
					throw new Error(
						`Runtime binding '${pkg}.${member}' is not a function`,
					);
				}
				const args = (message.args ?? []).map((a) =>
					unmarshalValue(a, this.handles),
				);
				const result = await fn(...args);
				const shape =
					this.fnShapes.get(`${pkg}.${member}`) ?? ({ kind: "value" } as const);
				return marshalResult(result, shape, this.handles);
			}
			case "get": {
				const pkg = message.pkg ?? "";
				const member = message.member ?? "";
				const runtime = this.runtimeOf(pkg);
				const shape =
					this.letShapes.get(`${pkg}.${member}`) ??
					({ kind: "value" } as const);
				return marshalResult(runtime[member], shape, this.handles);
			}
			case "prop": {
				const entry = this.targetOf(message.target);
				if (entry === null) return null;
				const name = message.name ?? "";
				const value = Reflect.get(entry.value, name);
				const propType = entry.info.props.get(name)?.type;
				return marshalResult(
					value,
					propType ? shapeOfType(propType) : { kind: "value" },
					this.handles,
				);
			}
			case "setProp": {
				const entry = this.targetOf(message.target);
				if (entry === null) return null;
				Reflect.set(
					entry.value,
					message.name ?? "",
					unmarshalValue(message.value, this.handles),
				);
				return null;
			}
			case "method": {
				const entry = this.targetOf(message.target);
				if (entry === null) return null;
				const name = message.name ?? "";
				const fn = Reflect.get(entry.value, name);
				if (typeof fn !== "function") {
					throw new Error(`Host object has no method '${name}'`);
				}
				const args = (message.args ?? []).map((a) =>
					unmarshalValue(a, this.handles),
				);
				const result = await Reflect.apply(fn, entry.value, args);
				const methodType: FuncType | undefined = entry.info.methods.get(name);
				return marshalResult(
					result,
					methodType ? shapeOfType(methodType.ret) : { kind: "value" },
					this.handles,
				);
			}
		}
	}

	private runtimeOf(pkg: string): Record<string, unknown> {
		const found = this.packages.find((p) => p.env.name === pkg);
		if (!found) throw new Error(`Unknown package '${pkg}'`);
		return found.runtime;
	}

	private targetOf(
		target: unknown,
	): { value: object; info: HostTypeInfo } | null {
		if (target === null || target === undefined) return null;
		const unwrapped = unmarshalValue(target, this.handles);
		if (typeof unwrapped !== "object" || unwrapped === null) return null;
		// Recover the declared type info for shape lookups.
		if (
			typeof target === "object" &&
			target !== null &&
			"$syrupHandle" in target
		) {
			const id = (target as { $syrupHandle: number }).$syrupHandle;
			return this.handles.resolve(id);
		}
		return null;
	}
}

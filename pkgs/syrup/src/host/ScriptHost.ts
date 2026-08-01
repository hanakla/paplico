import {
	type CheckResult,
	checkDeclarations,
	checkProgram,
	type ModuleExports,
	type PackageEnv,
} from "../checker/check";
import type { TypeSymbol } from "../checker/scope";
import {
	type EmitOptions,
	type EmitUnit,
	emitBundle,
	moduleJsName,
} from "../emit/emitter";
import { __syrupStruct } from "../emit/runtime";
import { RunnerBroker } from "../runner/broker";
import { createInProcessOps } from "../runner/inProcess";
import type { HostOps, RunnerTransport, WorkerLike } from "../runner/types";
import type { Diagnostic, Program } from "../syntax/ast";
import { parseProgram } from "../syntax/cstToAst";
import { createStdlibRuntime, STDLIB_DECLARATIONS } from "./stdlib";

export interface PackageRegistration {
	/** Global (or namespace) name the package occupies inside scripts. */
	name: string;
	/** Syrup declaration source (`declare fn` / `declare let` / `declare type`). */
	declarations: string;
	/** Runtime bindings, keyed by declared name. */
	runtime: Record<string, unknown>;
	/**
	 * "namespace" (default): members are used as `name.member(...)`.
	 * "global": every declaration becomes a bare global.
	 */
	expose?: "namespace" | "global";
}

/**
 * Resolves an `import <specifier>` to Syrup module source. Return null or
 * undefined when the module does not exist.
 */
export type ModuleResolver = (
	specifier: string,
) => string | null | undefined | Promise<string | null | undefined>;

export interface CompileOutput {
	/** null when diagnostics contain errors. */
	code: string | null;
	diagnostics: Diagnostic[];
}

export interface AnalyzeOutput {
	ast: Program;
	check: CheckResult;
	/** Modules of the bundle in dependency order (entry excluded). */
	moduleUnits: EmitUnit[];
	diagnostics: Diagnostic[];
}

export interface TestResult {
	name: string;
	passed: boolean;
	/** Failure message; null when the test passed. */
	error: string | null;
}

export interface WorkerRunner {
	run(code: string): Promise<void>;
	/** Run test-mode compiled code and collect reported results. */
	runTests(code: string): Promise<TestResult[]>;
	/** Evaluate compiled module code and call an exported function. */
	invokeModule(
		code: string,
		options: { exportName: string; args?: unknown[] },
	): Promise<unknown>;
	/** Stop the active operation and terminate the worker. */
	stop(): void;
	dispose(): void;
}

/**
 * A Syrup module loaded by the host. Exported functions are plain JS
 * functions with argument labels erased (call positionally, in declaration
 * order); results may be promises, so `call` always awaits.
 *
 * Value mapping: `nil` ⇔ `null`, dictionaries are `Map`s, structs/enums are
 * plain objects (`$case` tag for enums).
 */
export interface LoadedScriptModule {
	/** Exported values, keyed by export name. */
	exports: Record<string, unknown>;
	get(name: string): unknown;
	/** Call an exported function with positional arguments. */
	call(name: string, args?: unknown[]): Promise<unknown>;
}

export interface ScriptHostOptions {
	/** Receives `print` output. Defaults to console.log. */
	stdout?: (text: string) => void;
}

export function createScriptHost(options: ScriptHostOptions = {}): ScriptHost {
	return new ScriptHost(options);
}

export class ScriptHost {
	private packages: { env: PackageEnv; runtime: Record<string, unknown> }[] =
		[];
	private takenGlobals = new Set<string>();
	private resolver: ModuleResolver | null = null;
	private knownSpecifiers: string[] = [];

	public constructor(options: ScriptHostOptions = {}) {
		const stdout = options.stdout ?? ((text: string) => console.log(text));
		this.registerPackage({
			name: "std",
			declarations: STDLIB_DECLARATIONS,
			runtime: createStdlibRuntime(stdout),
			expose: "global",
		});
	}

	public registerPackage(registration: PackageRegistration): void {
		const expose = registration.expose ?? "namespace";
		const { ast, diagnostics } = parseProgram(registration.declarations);
		throwOnErrors(registration.name, diagnostics);
		const externalTypes = new Map<string, TypeSymbol>();
		for (const { env } of this.packages) {
			for (const member of env.members.values()) {
				if (member.kind === "type") externalTypes.set(member.name, member);
			}
		}
		const result = checkDeclarations(ast, registration.name, externalTypes);
		throwOnErrors(registration.name, result.diagnostics);

		const claimed: string[] = [];
		for (const member of result.members.values()) {
			if (member.kind === "type") claimed.push(member.name);
			else if (expose === "global") claimed.push(member.name);
		}
		if (expose === "namespace") claimed.push(registration.name);
		for (const name of claimed) {
			if (this.takenGlobals.has(name)) {
				throw new Error(
					`Package '${registration.name}': global name '${name}' is already taken`,
				);
			}
		}
		for (const name of claimed) this.takenGlobals.add(name);

		this.packages.push({
			env: { name: registration.name, expose, members: result.members },
			runtime: registration.runtime,
		});
	}

	/**
	 * Register how `use` specifiers are resolved to module sources.
	 * `options.knownSpecifiers` lists resolvable specifiers for editor
	 * completion (`use ...` / `from "..."`); resolution itself stays dynamic.
	 */
	public setModuleResolver(
		resolver: ModuleResolver,
		options: { knownSpecifiers?: string[] } = {},
	): void {
		this.resolver = resolver;
		this.knownSpecifiers = options.knownSpecifiers ?? [];
	}

	/** Module specifiers advertised for editor completion. */
	public knownModuleSpecifiers(): string[] {
		return this.knownSpecifiers;
	}

	public packageEnvs(): PackageEnv[] {
		return this.packages.map((p) => p.env);
	}

	/** Parse + resolve imports + type check without emitting. */
	public async analyze(source: string): Promise<AnalyzeOutput> {
		const diagnostics: Diagnostic[] = [];
		const { ast, diagnostics: parseDiagnostics } = parseProgram(source);
		diagnostics.push(...parseDiagnostics);

		const moduleAsts = await this.loadModuleGraph(ast, diagnostics);
		const moduleUnits: EmitUnit[] = [];
		const exports: ModuleExports[] = [];
		for (const loaded of moduleAsts) {
			const check = checkProgram(loaded.ast, this.packageEnvs(), {
				mode: "module",
				moduleName: loaded.name,
				imports: exports,
			});
			for (const diagnostic of check.diagnostics) {
				diagnostics.push({
					...diagnostic,
					message: `[module ${loaded.name}] ${diagnostic.message}`,
				});
			}
			exports.push({ name: loaded.name, members: check.moduleExports });
			moduleUnits.push({ moduleName: loaded.name, ast: loaded.ast, check });
		}
		const check = checkProgram(ast, this.packageEnvs(), {
			mode: "script",
			imports: exports,
		});
		diagnostics.push(...check.diagnostics);
		return { ast, check, moduleUnits, diagnostics };
	}

	public async compile(
		source: string,
		options: EmitOptions = {},
	): Promise<CompileOutput> {
		const { ast, check, moduleUnits, diagnostics } = await this.analyze(source);
		if (diagnostics.some((d) => d.severity === "error")) {
			return { code: null, diagnostics };
		}
		return {
			code: emitBundle(
				[...moduleUnits, { moduleName: null, ast, check }],
				options,
			),
			diagnostics,
		};
	}

	/** Execute compiled code in-process (trusted scripts, tests). */
	public async run(code: string): Promise<void> {
		const ops = createInProcessOps(this.runtimeMap());
		const program = asyncFunction(code);
		await program(ops);
	}

	/**
	 * Load Syrup source as a module (in-process) and hand back its exports,
	 * so the host can call script-defined functions directly. Imports inside
	 * the source resolve through the registered module resolver. Throws on
	 * compile errors.
	 */
	public async loadModule(
		source: string,
		options: { name?: string } = {},
	): Promise<LoadedScriptModule> {
		const name = options.name ?? "main";
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error(`Invalid module name '${name}'`);
		}
		const diagnostics: Diagnostic[] = [];
		const { ast, diagnostics: parseDiagnostics } = parseProgram(source);
		diagnostics.push(...parseDiagnostics);
		const moduleAsts = await this.loadModuleGraph(ast, diagnostics);
		if (moduleAsts.some((loaded) => loaded.name === name)) {
			throw new Error(
				`Module name '${name}' conflicts with an imported module`,
			);
		}
		const units: EmitUnit[] = [];
		const exports: ModuleExports[] = [];
		for (const loaded of moduleAsts) {
			const check = checkProgram(loaded.ast, this.packageEnvs(), {
				mode: "module",
				moduleName: loaded.name,
				imports: exports,
			});
			for (const diagnostic of check.diagnostics) {
				diagnostics.push({
					...diagnostic,
					message: `[module ${loaded.name}] ${diagnostic.message}`,
				});
			}
			exports.push({ name: loaded.name, members: check.moduleExports });
			units.push({ moduleName: loaded.name, ast: loaded.ast, check });
		}
		const check = checkProgram(ast, this.packageEnvs(), {
			mode: "module",
			moduleName: name,
			imports: exports,
		});
		diagnostics.push(...check.diagnostics);
		const errors = diagnostics.filter((d) => d.severity === "error");
		if (errors.length > 0) {
			throw new Error(
				`Syrup module compile failed:\n${errors.map((d) => d.message).join("\n")}`,
			);
		}
		units.push({ moduleName: name, ast, check });
		const code = `${emitBundle(units)}\nreturn ${moduleJsName(name)};`;
		const ops = createInProcessOps(this.runtimeMap());
		const program = asyncFunction(code);
		const result = await program(ops);
		const moduleExports =
			typeof result === "object" && result !== null
				? (result as Record<string, unknown>)
				: {};
		return {
			exports: moduleExports,
			get: (memberName) => moduleExports[memberName],
			call: async (memberName, args = []) => {
				const fn = moduleExports[memberName];
				if (typeof fn !== "function") {
					throw new Error(
						`Module '${name}' has no exported function '${memberName}'`,
					);
				}
				return await fn(...args);
			},
		};
	}

	/**
	 * Compile in test mode and run every `@test` function in-process.
	 * Top-level statements run first, then each test; failed expectations
	 * (or any thrown runtime error) mark the test failed. Throws on compile
	 * errors.
	 */
	public async runTests(source: string): Promise<TestResult[]> {
		const output = await this.compile(source, { mode: "test" });
		if (output.code === null) {
			const messages = output.diagnostics
				.filter((d) => d.severity === "error")
				.map((d) => d.message)
				.join("\n");
			throw new Error(`Syrup compile failed:\n${messages}`);
		}
		const results: TestResult[] = [];
		const map = this.runtimeMap();
		map.__syrupTest = testReporterRuntime(results);
		const program = asyncFunction(output.code);
		await program(createInProcessOps(map));
		return results;
	}

	/** Compile and run in-process in one step. Throws on compile errors. */
	public async runSource(source: string): Promise<CompileOutput> {
		const output = await this.compile(source);
		if (output.code === null) {
			const messages = output.diagnostics
				.filter((d) => d.severity === "error")
				.map((d) => d.message)
				.join("\n");
			throw new Error(`Syrup compile failed:\n${messages}`);
		}
		await this.run(output.code);
		return output;
	}

	/**
	 * Create a sandboxed runner backed by a Web Worker whose entry installs
	 * `installWorkerRuntime()` from `@paplico/syrup/worker`.
	 */
	public createWorkerRunner(
		worker: WorkerLike,
		options: { timeoutMs?: number } = {},
	): WorkerRunner {
		const transport: RunnerTransport = {
			post: (message) => worker.postMessage(message),
			onMessage: (handler) => {
				worker.onmessage = (event) => handler(event.data);
			},
		};
		let collector: TestResult[] | null = null;
		const terminate = () => {
			worker.onmessage = null;
			worker.terminate?.();
		};
		const broker = new RunnerBroker(
			[
				...this.packages,
				{
					env: {
						name: "__syrupTest",
						expose: "namespace",
						members: new Map(),
					},
					runtime: testReporterRuntime({
						push: (result: TestResult) => collector?.push(result),
					}),
				},
			],
			transport,
			{
				timeoutMs: options.timeoutMs,
				onTimeout: terminate,
			},
		);
		return {
			run: (code) => broker.run(code),
			runTests: async (code) => {
				const results: TestResult[] = [];
				collector = results;
				try {
					await broker.run(code);
				} finally {
					collector = null;
				}
				return results;
			},
			invokeModule: (code, invokeOptions) =>
				broker.invokeModule(code, invokeOptions),
			stop: () => {
				broker.dispose(new Error("Script execution stopped"));
				terminate();
			},
			dispose: () => {
				broker.dispose();
				terminate();
			},
		};
	}

	private runtimeMap(): Record<string, Record<string, unknown>> {
		const map: Record<string, Record<string, unknown>> = {};
		for (const { env, runtime } of this.packages) {
			map[env.name] = runtime;
		}
		return map;
	}

	// ---- Module graph loading ----

	private async loadModuleGraph(
		entryAst: Program,
		diagnostics: Diagnostic[],
	): Promise<{ name: string; ast: Program }[]> {
		const order: { name: string; ast: Program }[] = [];
		const state = new Map<string, "loading" | "done">();
		const visit = async (
			name: string,
			importSpan: { start: number; end: number },
		): Promise<void> => {
			const current = state.get(name);
			if (current === "done") return;
			if (current === "loading") {
				diagnostics.push({
					span: importSpan,
					message: `Circular import involving module '${name}'`,
					severity: "error",
				});
				return;
			}
			state.set(name, "loading");
			const source = this.resolver ? await this.resolver(name) : null;
			if (source === null || source === undefined) {
				// checkProgram reports "Cannot resolve module" at the import site;
				// distinguish the missing-resolver case for a clearer message.
				if (!this.resolver) {
					diagnostics.push({
						span: importSpan,
						message:
							"No module resolver configured (ScriptHost.setModuleResolver)",
						severity: "error",
					});
				}
				state.set(name, "done");
				return;
			}
			const parsed = parseProgram(source);
			for (const diagnostic of parsed.diagnostics) {
				diagnostics.push({
					...diagnostic,
					message: `[module ${name}] ${diagnostic.message}`,
				});
			}
			for (const stmt of parsed.ast) {
				if (stmt.kind === "use") {
					await visit(stmt.specifier, stmt.specifierSpan);
				}
			}
			state.set(name, "done");
			order.push({ name, ast: parsed.ast });
		};
		for (const stmt of entryAst) {
			if (stmt.kind === "use") await visit(stmt.specifier, stmt.specifierSpan);
		}
		return order;
	}
}

/** Runtime bindings for the hidden `__syrupTest` reporting package. */
function testReporterRuntime(sink: {
	push: (result: TestResult) => void;
}): Record<string, unknown> {
	return {
		report: (name: string, passed: boolean, error: string | null) =>
			sink.push({ name, passed, error }),
	};
}

function asyncFunction(code: string): (host: HostOps) => Promise<unknown> {
	const AsyncFunction = Object.getPrototypeOf(async function noop() {
		// no-op: only used to obtain the AsyncFunction constructor
	}).constructor as new (
		...params: string[]
	) => (host: HostOps, structMarker: symbol) => Promise<unknown>;
	const program = new AsyncFunction("__host", "__syrupStruct", code);
	return (host) => program(host, __syrupStruct);
}

function throwOnErrors(packageName: string, diagnostics: Diagnostic[]): void {
	const errors = diagnostics.filter((d) => d.severity === "error");
	if (errors.length > 0) {
		throw new Error(
			`Invalid declarations for package '${packageName}':\n${errors
				.map((d) => d.message)
				.join("\n")}`,
		);
	}
}

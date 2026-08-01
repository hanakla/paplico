import type { CheckResult } from "../checker/check";
import type { ClassInfo, ProtocolInfo, Type } from "../checker/types";
import type {
	Condition,
	Expr,
	InitDecl,
	MethodDecl,
	Stmt,
} from "../syntax/ast";
import type { EmitUnit } from "./emitter";

/**
 * Bundle-wide effect analysis: decides which user functions, closures, and
 * methods can be emitted as plain synchronous JS, and which call sites need
 * `await`.
 *
 * Soundness rules:
 * - A call site may drop `await` only when every possible callee is provably
 *   sync-emitted. Awaiting a sync function is always safe, so method
 *   *definitions* are colored by their own bodies while dynamic call sites
 *   join over every override reachable from the static receiver type
 *   ("method slots"). Class hierarchies are closed within one bundle, so the
 *   join is computed after walking every unit.
 * - Function values are tracked through immutable `let` bindings and through
 *   the parameters of `fn`s / struct·enum methods ("parameter slots"): a
 *   parameter's color is the join of every function value passed for it at
 *   any call site in the bundle. A function whose reference escapes to an
 *   untracked place (stored in data, passed to the host, exported) gets all
 *   its parameter slots pinned async, since unseen callers may pass async
 *   callbacks. Everything else with unknown provenance stays awaited (and
 *   colors its caller async).
 */

export interface EffectInfo {
	isFnAsync(stmt: Stmt & { kind: "func" }): boolean;
	isClosureAsync(expr: Expr & { kind: "closure" }): boolean;
	isValueMethodAsync(method: MethodDecl): boolean;
	isClassMethodAsync(method: MethodDecl): boolean;
	isInitAsync(init: InitDecl): boolean;
	/**
	 * True when the class's whole inheritance tree has only sync inits, so
	 * every class in it compiles to a native JS constructor. A subclass
	 * `__init` cannot chain into a parent's native constructor, so the
	 * pattern is decided per tree, not per class.
	 */
	usesNativeConstructor(info: ClassInfo): boolean;
	isCallAwaited(node: Expr & { kind: "call" }): boolean;
	/** Array HOF calls whose callback is sync (use the sync helper variant). */
	isHofSync(node: Expr & { kind: "call" }): boolean;
}

export function analyzeBundle(units: EmitUnit[]): EffectInfo {
	return new EffectAnalyzer().run(units);
}

type FnKey = object;

interface CallDecision {
	node: Expr & { kind: "call" };
	target: "always" | "never" | FnKey;
}

interface HofDecision {
	node: Expr & { kind: "call" };
	callback: FnKey | null; // null = unknown callback (async helper, awaited)
}

const ROOT: FnKey = { root: true };
const HOF_METHODS = new Set(["map", "filter", "reduce", "sorted"]);
const HOF_CALLBACK_INDEX: Record<string, number> = {
	map: 0,
	filter: 0,
	reduce: 1,
	sorted: 0,
};

class EffectAnalyzer {
	private effectful = new Map<FnKey, boolean>();
	private deps = new Map<FnKey, Set<FnKey>>();
	private calls: CallDecision[] = [];
	private hofs: HofDecision[] = [];
	private current: FnKey = ROOT;
	/** Lexical table of callable names: fn node, or "value" for shadowing. */
	private scopes: Map<string, FnKey | "value">[] = [new Map()];
	private check!: CheckResult;
	private currentClass: ClassInfo | null = null;

	// Bundle-wide indexes (infos are shared object references across units).
	private moduleFns = new Map<string, FnKey>(); // `${module}:${fn}`
	private valueMethods = new Map<string, MethodDecl>(); // `${module}:${owner}.${m}`
	private classMethodBodies = new Map<ClassInfo, Map<string, MethodDecl>>();
	private classInits = new Map<ClassInfo, InitDecl>();
	private classInfos: ClassInfo[] = [];
	private slots = new Map<ClassInfo | ProtocolInfo, Map<string, FnKey>>();
	/** Per-parameter color slots for statically-dispatched callables. */
	private fnParamSlots = new Map<FnKey, FnKey[]>();
	/** Ident nodes consumed as tracked function references (skip escape). */
	private consumedIdents = new Set<Expr>();

	public run(units: EmitUnit[]): EffectInfo {
		this.mark(ROOT, true); // top level allows awaits unconditionally
		for (const unit of units) {
			this.check = unit.check;
			this.indexUnit(unit);
			this.walkStmts(unit.ast);
		}
		this.buildSlotEdges();
		this.solve();
		return this.info();
	}

	private indexUnit(unit: EmitUnit): void {
		for (const stmt of unit.ast) {
			if (stmt.kind === "func" && unit.moduleName !== null) {
				this.moduleFns.set(`${unit.moduleName}:${stmt.sig.name}`, stmt);
			}
			if (stmt.kind === "struct" || stmt.kind === "enum") {
				for (const method of stmt.methods) {
					this.valueMethods.set(
						`${unit.moduleName ?? ""}:${stmt.name}.${method.sig.name}`,
						method,
					);
					// Created before walking so call sites that precede the
					// declaration still record their argument colors.
					this.ensureParamSlots(method, method.sig.params.length);
				}
			}
			if (stmt.kind === "class") {
				const info = unit.check.classInfos.get(stmt);
				if (!info) continue;
				this.classInfos.push(info);
				const bodies = new Map<string, MethodDecl>();
				for (const method of stmt.methods) {
					bodies.set(method.sig.name, method);
				}
				this.classMethodBodies.set(info, bodies);
				const init = stmt.inits[0];
				if (init) {
					this.classInits.set(info, init);
					this.ensureParamSlots(init, init.params.length);
				}
			}
		}
	}

	// ---- Fixpoint ----

	private mark(key: FnKey, value: boolean): void {
		if (value) this.effectful.set(key, true);
		else if (!this.effectful.has(key)) this.effectful.set(key, false);
	}

	private addDepFrom(source: FnKey, target: FnKey): void {
		const set = this.deps.get(source) ?? new Set();
		set.add(target);
		this.deps.set(source, set);
	}

	private addDep(target: FnKey): void {
		this.addDepFrom(this.current, target);
	}

	private solve(): void {
		let changed = true;
		while (changed) {
			changed = false;
			for (const [key, targets] of this.deps) {
				if (this.effectful.get(key)) continue;
				for (const target of targets) {
					if (this.effectful.get(target)) {
						this.effectful.set(key, true);
						changed = true;
						break;
					}
				}
			}
		}
	}

	private isAsyncKey(key: FnKey): boolean {
		return this.effectful.get(key) === true;
	}

	private info(): EffectInfo {
		const awaited = new Set<Expr>();
		for (const call of this.calls) {
			if (call.target === "never") continue;
			if (call.target === "always" || this.isAsyncKey(call.target)) {
				awaited.add(call.node);
			}
		}
		const hofSync = new Set<Expr>();
		for (const hof of this.hofs) {
			if (hof.callback !== null && !this.isAsyncKey(hof.callback)) {
				hofSync.add(hof.node);
			} else {
				awaited.add(hof.node);
			}
		}
		const nativeCtor = this.computeNativeConstructors();
		return {
			isFnAsync: (stmt) => stmt.sig.isAsync || this.isAsyncKey(stmt),
			isClosureAsync: (expr) => this.isAsyncKey(expr),
			isValueMethodAsync: (method) =>
				method.sig.isAsync || this.isAsyncKey(method),
			isClassMethodAsync: (method) =>
				method.sig.isAsync || this.isAsyncKey(method),
			isInitAsync: (init) => this.isAsyncKey(init),
			usesNativeConstructor: (info) => nativeCtor.get(info) ?? true,
			isCallAwaited: (node) => awaited.has(node),
			isHofSync: (node) => hofSync.has(node),
		};
	}

	private computeNativeConstructors(): Map<ClassInfo, boolean> {
		const children = new Map<ClassInfo, ClassInfo[]>();
		for (const info of this.classInfos) {
			const parent = info.superclass?.info ?? null;
			if (!parent) continue;
			const list = children.get(parent) ?? [];
			list.push(info);
			children.set(parent, list);
		}
		const treeHasAsyncInit = (info: ClassInfo): boolean => {
			const init = this.classInits.get(info);
			if (init && this.isAsyncKey(init)) return true;
			return (children.get(info) ?? []).some(treeHasAsyncInit);
		};
		const result = new Map<ClassInfo, boolean>();
		const fill = (info: ClassInfo, native: boolean): void => {
			result.set(info, native);
			for (const child of children.get(info) ?? []) fill(child, native);
		};
		for (const info of this.classInfos) {
			if (info.superclass) continue;
			fill(info, !treeHasAsyncInit(info));
		}
		return result;
	}

	// ---- Method slots (dynamic dispatch joins) ----

	private slotKey(owner: ClassInfo | ProtocolInfo, name: string): FnKey {
		let table = this.slots.get(owner);
		if (!table) {
			table = new Map();
			this.slots.set(owner, table);
		}
		let key = table.get(name);
		if (!key) {
			key = { slot: `${owner.name}.${name}` };
			table.set(name, key);
			this.mark(key, false);
		}
		return key;
	}

	private nearestImpl(info: ClassInfo | null, name: string): MethodDecl | null {
		for (let cur = info; cur !== null; cur = cur.superclass?.info ?? null) {
			const body = this.classMethodBodies.get(cur)?.get(name);
			if (body) return body;
		}
		return null;
	}

	/**
	 * A slot (static type × method) is async when any override reachable from
	 * that static type is async. Built after every unit has been walked, so
	 * subclasses in later units flow back into earlier call sites.
	 */
	private buildSlotEdges(): void {
		for (const info of this.classInfos) {
			const bodies = this.classMethodBodies.get(info) ?? new Map();
			for (const [name, body] of bodies) {
				// The defining class and every ancestor that knows this method
				// may dispatch to this body.
				for (
					let ancestor: ClassInfo | null = info;
					ancestor !== null;
					ancestor = ancestor.superclass?.info ?? null
				) {
					if (this.nearestImpl(ancestor, name) === null) continue;
					this.addDepFrom(this.slotKey(ancestor, name), body);
				}
			}
			// Protocol slots join over every conforming class's implementation.
			for (
				let cur: ClassInfo | null = info;
				cur !== null;
				cur = cur.superclass?.info ?? null
			) {
				for (const conformed of cur.protocols) {
					for (const name of conformed.info.methods.keys()) {
						const impl = this.nearestImpl(info, name);
						if (impl) {
							this.addDepFrom(this.slotKey(conformed.info, name), impl);
						}
					}
				}
			}
			// Init chains: a subclass init awaits its parent init.
			const init = this.classInits.get(info);
			const parent = info.superclass?.info ?? null;
			if (init && parent) {
				const parentInit = this.classInits.get(parent);
				if (parentInit) this.addDepFrom(init, parentInit);
			}
		}
	}

	// ---- Parameter slots (function-typed argument joins) ----

	private ensureParamSlots(key: FnKey, count: number): FnKey[] {
		let slots = this.fnParamSlots.get(key);
		if (!slots) {
			slots = Array.from({ length: count }, (_, i) => ({ param: i }));
			for (const slot of slots) this.mark(slot, false);
			this.fnParamSlots.set(key, slots);
		}
		return slots;
	}

	/** The function's reference escaped: unseen callers may pass async args. */
	private escapeFn(key: FnKey): void {
		const slots = this.fnParamSlots.get(key);
		if (!slots) return;
		for (const slot of slots) this.effectful.set(slot, true);
	}

	/** Join each function-valued argument's color into the callee's slots. */
	private addParamEdges(fn: FnKey, node: Expr & { kind: "call" }): void {
		const slots = this.fnParamSlots.get(fn);
		if (!slots) return;
		const plan = this.check.callPlans.get(node);
		if (!plan) {
			for (const slot of slots) this.effectful.set(slot, true);
			return;
		}
		plan.ordered.forEach((planned, i) => {
			const slot = slots[i];
			if (!slot || planned.kind !== "arg") return;
			const argExpr = node.args[planned.argIndex]?.expr;
			if (!argExpr) return;
			if (argExpr.kind === "closure") {
				this.addDepFrom(slot, argExpr);
				return;
			}
			if (argExpr.kind === "ident") {
				const named = this.lookupName(argExpr.name);
				if (named !== undefined && named !== "value") {
					this.consumedIdents.add(argExpr);
					// The callee may re-invoke it with untracked arguments.
					this.escapeFn(named);
					this.addDepFrom(slot, named);
					return;
				}
			}
			if (this.check.types.get(argExpr)?.kind === "func") {
				this.effectful.set(slot, true);
			}
		});
	}

	// ---- Walking ----

	private inFunction(
		key: FnKey,
		initialAsync: boolean,
		walk: () => void,
	): void {
		const savedCurrent = this.current;
		this.mark(key, initialAsync);
		this.current = key;
		this.scopes.push(new Map());
		walk();
		this.scopes.pop();
		this.current = savedCurrent;
	}

	private declareName(name: string, entry: FnKey | "value"): void {
		this.scopes.at(-1)?.set(name, entry);
	}

	private lookupName(name: string): FnKey | "value" | undefined {
		for (let i = this.scopes.length - 1; i >= 0; i--) {
			const entry = this.scopes[i].get(name);
			if (entry !== undefined) return entry;
		}
		return undefined;
	}

	private walkStmts(stmts: Stmt[]): void {
		this.scopes.push(new Map());
		// Hoist fn names so mutual/forward references stay tracked.
		for (const stmt of stmts) {
			if (stmt.kind !== "func") continue;
			this.declareName(stmt.sig.name, stmt);
			this.ensureParamSlots(stmt, stmt.sig.params.length);
			// Exported functions are callable from the host with arbitrary
			// (possibly async) function arguments.
			if (stmt.exported === true) this.escapeFn(stmt);
		}
		for (const stmt of stmts) this.walkStmt(stmt);
		this.scopes.pop();
	}

	private walkStmt(stmt: Stmt): void {
		switch (stmt.kind) {
			case "binding": {
				let entry: FnKey | "value" = "value";
				if (!stmt.mutable) {
					if (stmt.init.kind === "closure") {
						entry = stmt.init;
					} else if (stmt.init.kind === "ident") {
						const named = this.lookupName(stmt.init.name);
						if (named !== undefined && named !== "value") {
							entry = named;
							this.consumedIdents.add(stmt.init);
						}
					}
				}
				this.walkExpr(stmt.init);
				this.declareName(stmt.name, entry);
				return;
			}
			case "func": {
				this.declareName(stmt.sig.name, stmt);
				const slots = this.ensureParamSlots(stmt, stmt.sig.params.length);
				this.walkParamDefaults(stmt.sig.params, slots);
				this.inFunction(stmt, stmt.sig.isAsync, () => {
					stmt.sig.params.forEach((param, i) => {
						this.declareName(param.name, slots[i]);
					});
					this.walkStmts(stmt.body);
				});
				return;
			}
			case "struct":
			case "enum":
				for (const method of stmt.methods) {
					this.walkCallable(
						method,
						method.sig.isAsync,
						method.sig.params,
						this.ensureParamSlots(method, method.sig.params.length),
						() => this.walkStmts(method.body),
					);
				}
				return;
			case "class": {
				const info = this.check.classInfos.get(stmt) ?? null;
				const savedClass = this.currentClass;
				this.currentClass = info;
				const init = stmt.inits[0];
				if (init) {
					const initSlots = this.ensureParamSlots(init, init.params.length);
					// Exported classes can be constructed by the host with
					// arbitrary (possibly async) function arguments.
					if (stmt.exported === true) this.escapeFn(init);
					this.inFunction(init, false, () => {
						this.declareName("self", "value");
						init.params.forEach((param, i) => {
							if (param.defaultValue) {
								this.walkExpr(param.defaultValue);
								if (param.defaultValue.kind === "closure") {
									this.addDepFrom(initSlots[i], param.defaultValue);
								}
							}
							this.declareName(param.name, initSlots[i]);
						});
						// Field defaults are evaluated inside __init.
						for (const field of stmt.fields) {
							if (field.defaultValue) this.walkExpr(field.defaultValue);
						}
						this.walkStmts(init.body);
					});
				}
				for (const method of stmt.methods) {
					// Class methods dispatch dynamically; their parameters are
					// not slot-tracked (calls through them stay awaited).
					this.walkCallable(
						method,
						method.sig.isAsync,
						method.sig.params,
						null,
						() => this.walkStmts(method.body),
					);
				}
				this.currentClass = savedClass;
				return;
			}
			case "protocol":
			case "use":
			case "declareFunc":
			case "declareLet":
			case "declareType":
			case "break":
			case "continue":
				return;
			case "if":
				for (const cond of stmt.conds) this.walkCondition(cond);
				this.walkStmts(stmt.thenBody);
				if (stmt.elseBody) this.walkStmts(stmt.elseBody);
				return;
			case "guard":
				for (const cond of stmt.conds) {
					this.walkCondition(cond);
					if (cond.kind === "optionalBinding") {
						this.declareName(cond.name, "value");
					}
				}
				this.walkStmts(stmt.elseBody);
				return;
			case "for":
				if (stmt.source.kind === "range") {
					this.walkExpr(stmt.source.from);
					this.walkExpr(stmt.source.to);
				} else {
					this.walkExpr(stmt.source.expr);
				}
				this.walkStmts(stmt.body);
				return;
			case "while":
				this.walkExpr(stmt.cond);
				this.walkStmts(stmt.body);
				return;
			case "switch":
				this.walkExpr(stmt.subject);
				for (const switchCase of stmt.cases) {
					this.walkStmts(switchCase.body);
				}
				return;
			case "return":
				if (stmt.value) this.walkExpr(stmt.value);
				return;
			case "throw":
				this.walkExpr(stmt.expr);
				return;
			case "doCatch":
				this.walkStmts(stmt.body);
				this.declareName("error", "value");
				this.walkStmts(stmt.catchBody);
				return;
			case "assign":
				this.walkAssign(stmt);
				return;
			case "expr":
				this.walkExpr(stmt.expr);
				return;
		}
	}

	private walkCallable(
		key: FnKey,
		initialAsync: boolean,
		params: { name: string; defaultValue?: Expr }[],
		slots: FnKey[] | null,
		walkBody: () => void,
	): void {
		this.walkParamDefaults(params, slots);
		this.inFunction(key, initialAsync, () => {
			this.declareName("self", "value");
			params.forEach((param, i) => {
				this.declareName(param.name, slots?.[i] ?? "value");
			});
			walkBody();
		});
	}

	private walkParamDefaults(
		params: { name: string; defaultValue?: Expr }[],
		slots: FnKey[] | null,
	): void {
		params.forEach((param, i) => {
			if (!param.defaultValue) return;
			this.walkExpr(param.defaultValue);
			const slot = slots?.[i];
			if (slot && param.defaultValue.kind === "closure") {
				this.addDepFrom(slot, param.defaultValue);
			}
		});
	}

	private walkCondition(cond: Condition): void {
		this.walkExpr(cond.expr);
		if (cond.kind === "optionalBinding") {
			this.declareName(cond.name, "value");
		}
	}

	private walkAssign(stmt: Stmt & { kind: "assign" }): void {
		// Host property writes go through `await __host.setProp(...)`.
		if (stmt.target.kind === "member") {
			const objType = this.check.types.get(stmt.target.object);
			if (objType?.kind === "host") this.mark(this.current, true);
		}
		this.walkExpr(stmt.target);
		this.walkExpr(stmt.value);
	}

	private walkExpr(expr: Expr): void {
		switch (expr.kind) {
			case "number":
			case "bool":
			case "nil":
			case "dollar":
			case "superRef":
				return;
			case "string":
				for (const part of expr.parts) {
					if (part.kind === "expr") this.walkExpr(part.expr);
				}
				return;
			case "ident": {
				if (this.consumedIdents.has(expr)) return;
				const resolution = this.check.resolutions.get(expr);
				// Reading a `declare let` is a host op.
				if (resolution?.kind === "packageMember") this.mark(this.current, true);
				// A bare function reference escapes to an untracked place.
				const named = this.lookupName(expr.name);
				if (named !== undefined && named !== "value") this.escapeFn(named);
				return;
			}
			case "array":
				for (const element of expr.elements) this.walkExpr(element);
				return;
			case "dict":
				for (const entry of expr.entries) {
					this.walkExpr(entry.key);
					this.walkExpr(entry.value);
				}
				return;
			case "await":
			case "try":
			case "force":
			case "is":
			case "unary":
				this.walkExpr(expr.operand);
				return;
			case "doExpr":
				// The body runs inline: its effects belong to this function.
				this.walkStmts(expr.body);
				if (expr.catchBody) {
					this.declareName("error", "value");
					this.walkStmts(expr.catchBody);
				}
				return;
			case "binary":
				this.walkExpr(expr.left);
				this.walkExpr(expr.right);
				return;
			case "ternary":
				this.walkExpr(expr.cond);
				this.walkExpr(expr.thenExpr);
				this.walkExpr(expr.elseExpr);
				return;
			case "subscript":
				this.walkExpr(expr.object);
				this.walkExpr(expr.index);
				return;
			case "member":
				this.walkMember(expr);
				return;
			case "closure": {
				const resolution = this.check.resolutions.get(expr);
				this.inFunction(expr, false, () => {
					if (resolution?.kind === "closure") {
						for (const name of resolution.paramNames) {
							this.declareName(name, "value");
						}
					}
					this.walkStmts(expr.body);
				});
				return;
			}
			case "call":
				this.walkCall(expr);
				return;
		}
	}

	private walkMember(expr: Expr & { kind: "member" }): void {
		const resolution = this.check.resolutions.get(expr);
		if (resolution?.kind === "packageMember") {
			this.mark(this.current, true);
			return;
		}
		if (resolution?.kind === "moduleMember") {
			// A module function referenced as a value escapes tracking.
			const fn = this.moduleFns.get(
				`${resolution.moduleName}:${resolution.memberName}`,
			);
			if (fn) this.escapeFn(fn);
			return;
		}
		if (resolution?.kind === "enumCase") return;
		if (resolution?.kind === "builtinProp") {
			this.walkExpr(expr.object);
			return;
		}
		const objType = this.check.types.get(expr.object);
		const baseIsHost =
			objType?.kind === "host" ||
			(objType?.kind === "optional" && objType.inner.kind === "host");
		if (baseIsHost) this.mark(this.current, true);
		this.walkExpr(expr.object);
	}

	private receiverInfo(object: Expr): ClassInfo | ProtocolInfo | null {
		let type: Type | undefined = this.check.types.get(object);
		if (type?.kind === "optional") type = type.inner;
		// Constrained type params dispatch through their upper bound.
		if (type?.kind === "typeParam" && type.info.constraint) {
			type = type.info.constraint;
		}
		if (type?.kind === "class" || type?.kind === "protocol") {
			return type.info;
		}
		return null;
	}

	private walkCall(node: Expr & { kind: "call" }): void {
		const callee = node.callee;
		const resolution = this.check.resolutions.get(callee);
		const walkArgs = (): void => {
			for (const arg of node.args) this.walkExpr(arg.expr);
		};
		const dynamic = (target: FnKey): void => {
			this.addDep(target);
			this.calls.push({ node, target });
		};
		const always = (): void => {
			this.mark(this.current, true);
			this.calls.push({ node, target: "always" });
		};
		switch (resolution?.kind) {
			case "structInit":
			case "enumCase":
				this.calls.push({ node, target: "never" });
				walkArgs();
				return;
			case "packageMember":
			case "hostMethod": {
				always();
				if (callee.kind === "member" && resolution.kind === "hostMethod") {
					this.walkExpr(callee.object);
				}
				walkArgs();
				return;
			}
			case "classInit": {
				const init = this.classInits.get(resolution.info);
				if (init) {
					dynamic(init);
					this.addParamEdges(init, node);
				} else {
					always();
				}
				walkArgs();
				return;
			}
			case "classMethod": {
				if (callee.kind === "member") {
					this.walkExpr(callee.object);
					const owner = this.receiverInfo(callee.object);
					if (owner) {
						dynamic(this.slotKey(owner, resolution.name));
					} else {
						always();
					}
				} else {
					always();
				}
				walkArgs();
				return;
			}
			case "superMethod": {
				const parent = this.currentClass?.superclass?.info ?? null;
				const impl = this.nearestImpl(parent, resolution.name);
				if (impl) dynamic(impl);
				else always();
				walkArgs();
				return;
			}
			case "superInit": {
				const parent = this.currentClass?.superclass?.info ?? null;
				const parentInit = parent ? this.classInits.get(parent) : undefined;
				if (parentInit) {
					dynamic(parentInit);
					this.addParamEdges(parentInit, node);
				} else {
					this.calls.push({ node, target: "never" });
				}
				walkArgs();
				return;
			}
			case "moduleMember": {
				const fn = this.moduleFns.get(
					`${resolution.moduleName}:${resolution.memberName}`,
				);
				if (fn) {
					dynamic(fn);
					this.addParamEdges(fn, node);
				} else {
					always(); // exported bindings holding closures, etc.
				}
				walkArgs();
				return;
			}
			case "valueMethod": {
				if (callee.kind === "member") this.walkExpr(callee.object);
				const method = this.valueMethods.get(
					`${resolution.moduleName ?? ""}:${resolution.ownerName}.${resolution.name}`,
				);
				if (method) {
					dynamic(method);
					this.addParamEdges(method, node);
				} else {
					always();
				}
				walkArgs();
				return;
			}
			case "builtinMethod": {
				if (callee.kind === "member") this.walkExpr(callee.object);
				if (HOF_METHODS.has(resolution.name)) {
					const plan = this.check.callPlans.get(node);
					const cbIndex = HOF_CALLBACK_INDEX[resolution.name];
					const slot = plan?.ordered[cbIndex];
					const cbArg =
						slot?.kind === "arg" ? node.args[slot.argIndex] : undefined;
					for (const arg of node.args) {
						this.walkExpr(arg.expr);
					}
					const trackedCb = this.trackedCallback(cbArg?.expr);
					if (trackedCb !== null) {
						this.addDep(trackedCb);
						this.hofs.push({ node, callback: trackedCb });
					} else {
						this.mark(this.current, true);
						this.hofs.push({ node, callback: null });
					}
					return;
				}
				this.calls.push({ node, target: "never" });
				walkArgs();
				return;
			}
			default: {
				// Plain function-value call: known local fn → dep; else unknown.
				if (callee.kind === "ident") {
					const entry = this.lookupName(callee.name);
					if (entry !== undefined && entry !== "value") {
						dynamic(entry);
						this.addParamEdges(entry, node);
						walkArgs();
						return;
					}
				}
				this.walkExpr(callee);
				always();
				walkArgs();
				return;
			}
		}
	}

	/** A HOF callback argument with a trackable color, or null. */
	private trackedCallback(expr: Expr | undefined): FnKey | null {
		if (!expr) return null;
		if (expr.kind === "closure") {
			return expr;
		}
		if (expr.kind === "ident") {
			const named = this.lookupName(expr.name);
			if (named !== undefined && named !== "value") {
				this.consumedIdents.add(expr);
				// The helper invokes it with untracked arguments.
				this.escapeFn(named);
				return named;
			}
		}
		return null;
	}
}

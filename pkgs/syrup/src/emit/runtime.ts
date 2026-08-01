/**
 * Marker keying the `static [__syrupStruct] = true` field on emitted struct
 * classes. Compiled programs receive this exact symbol as the `__syrupStruct`
 * parameter of their wrapping AsyncFunction, so package-side runtime code
 * (worker marshaling, `expect` deep equality) and emitted code agree on it
 * without a global registry.
 */
export const __syrupStruct = Symbol("syrupStruct");

/**
 * Embedded runtime helpers. The emitter tracks which helpers a program
 * actually references and prepends only those (each is self-contained).
 * The effect analysis decides per call whether the awaiting (`__arrMap`)
 * or synchronous (`__arrMapS`) HOF variant is used.
 */
export const RUNTIME_HELPER_SOURCES: Record<string, string> = {
	// Values thrown by Syrup \`throw\` travel inside a tagged JS Error. Emitted
	// \`catch\` blocks only accept tagged errors, so runtime traps (__force,
	// out-of-range subscripts) and host exceptions stay uncatchable.
	__thrownTag: `const __thrownTag = Symbol("syrupThrown");`,
	__throwVal: `const __throwVal = (v) => {
	const e = new Error("Uncaught Syrup error");
	e[__thrownTag] = v;
	return e;
};`,
	__structCopy: `const __structCopy = (v, o) => Object.assign(Object.create(Object.getPrototypeOf(v)), v, o);`,
	__isStructInst: `const __isStructInst = (v) => typeof v === "object" && v !== null && Object.getPrototypeOf(v)?.constructor?.[__syrupStruct] === true;`,
	__force: `const __force = (v) => {
	if (v === null || v === undefined) {
		throw new Error("Unexpectedly found nil while force-unwrapping");
	}
	return v;
};`,
	// Boxed-optional variants: nested optionals (T??) and optionals of a type
	// parameter store their some-case as {$some: value} so .some(nil) stays
	// distinct from .none.
	__forceN: `const __forceN = (v) => {
	if (v === null || v === undefined) {
		throw new Error("Unexpectedly found nil while force-unwrapping");
	}
	return v.$some;
};`,
	__firstN: `const __firstN = (a) => (a.length > 0 ? { $some: a[0] } : null);`,
	__lastN: `const __lastN = (a) => (a.length > 0 ? { $some: a[a.length - 1] } : null);`,
	__dictGetN: `const __dictGetN = (d, k) => (d.has(k) ? { $some: d.get(k) } : null);`,
	__dictRemoveN: `const __dictRemoveN = (d, k) => {
	if (!d.has(k)) return null;
	const v = d.get(k);
	d.delete(k);
	return { $some: v };
};`,
	__copyOptN: `const __copyOptN = (v, f) => (v === null || v === undefined ? null : { $some: f(v.$some) });`,
	__optStr: `const __optStr = (v) =>
	v === null || v === undefined
		? "nil"
		: typeof v === "object" && "$some" in v
			? "Optional(" + __optStr(v.$some) + ")"
			: String(v);`,
	__idx: `const __idx = (a, i) => {
	if (!(i >= 0 && i < a.length)) {
		throw new RangeError("Array index " + i + " out of range");
	}
	return a[i];
};`,
	__idxSet: `const __idxSet = (a, i, v) => {
	if (!(i >= 0 && i < a.length)) {
		throw new RangeError("Array index " + i + " out of range");
	}
	a[i] = v;
};`,
	__first: `const __first = (a) => (a.length > 0 ? a[0] : null);`,
	__last: `const __last = (a) => (a.length > 0 ? a[a.length - 1] : null);`,
	__chain: `const __chain = (v, f) => (v === null || v === undefined ? null : f(v));`,
	__copyOpt: `const __copyOpt = (v, f) => (v === null || v === undefined ? null : f(v));`,
	__dictRemove: `const __dictRemove = (d, k) => {
	const v = d.has(k) ? d.get(k) : null;
	d.delete(k);
	return v;
};`,
	__arrMap: `const __arrMap = async (a, f) => {
	const out = [];
	for (const x of a) out.push(await f(x));
	return out;
};`,
	__arrMapS: `const __arrMapS = (a, f) => a.map((x) => f(x));`,
	__arrFilterS: `const __arrFilterS = (a, f) => a.filter((x) => f(x));`,
	__arrReduceS: `const __arrReduceS = (a, initial, f) => a.reduce((acc, x) => f(acc, x), initial);`,
	__sortedS: `const __sortedS = (a, cmp) =>
	[...a].sort((x, y) => (cmp(x, y) ? -1 : cmp(y, x) ? 1 : 0));`,
	__arrFilter: `const __arrFilter = async (a, f) => {
	const out = [];
	for (const x of a) if (await f(x)) out.push(x);
	return out;
};`,
	__arrReduce: `const __arrReduce = async (a, initial, f) => {
	let acc = initial;
	for (const x of a) acc = await f(acc, x);
	return acc;
};`,
	__sorted: `const __sorted = async (a, cmp) => {
	const out = [...a];
	for (let i = 1; i < out.length; i++) {
		const x = out[i];
		let j = i - 1;
		while (j >= 0 && (await cmp(x, out[j]))) {
			out[j + 1] = out[j];
			j--;
		}
		out[j + 1] = x;
	}
	return out;
};`,
};

import type { Type } from "./types";

export interface ValueSymbol {
	kind: "value";
	name: string;
	type: Type;
	mutable: boolean;
	/**
	 * Where the value lives at runtime:
	 * - local: user-declared binding/function/param (plain JS identifier)
	 * - packageMember: member of a registered package (host call boundary)
	 * - moduleMember: export of an imported Syrup module (`__mod_<name>`)
	 */
	origin: "local" | "packageMember" | "moduleMember";
	/** Container (package or module) name for non-local origins. */
	packageName?: string;
}

export interface TypeSymbol {
	kind: "type";
	name: string;
	type: Type;
}

export interface PackageSymbol {
	kind: "package";
	name: string;
	/** "package": registered host package. "module": imported Syrup module. */
	runtime: "package" | "module";
	/**
	 * Module specifier for runtime "module": `use ns from "spec"` binds the
	 * name `ns` while member resolutions target the module `spec`.
	 */
	moduleName?: string;
	members: Map<string, ValueSymbol | TypeSymbol>;
}

export type SyrupSymbol = ValueSymbol | TypeSymbol | PackageSymbol;

export class Scope {
	private symbols = new Map<string, SyrupSymbol>();

	public constructor(
		public readonly parent: Scope | null,
		public readonly kind: "global" | "function" | "block",
	) {}

	public lookup(name: string): SyrupSymbol | undefined {
		return this.symbols.get(name) ?? this.parent?.lookup(name);
	}

	public lookupOwn(name: string): SyrupSymbol | undefined {
		return this.symbols.get(name);
	}

	/** Returns false when the name is already declared in this exact scope. */
	public declare(symbol: SyrupSymbol): boolean {
		if (this.symbols.has(symbol.name)) return false;
		this.symbols.set(symbol.name, symbol);
		return true;
	}

	/** Force-set a symbol (used for flow-narrowing shadows). */
	public redeclare(symbol: SyrupSymbol): void {
		this.symbols.set(symbol.name, symbol);
	}

	public ownSymbols(): IterableIterator<SyrupSymbol> {
		return this.symbols.values();
	}
}

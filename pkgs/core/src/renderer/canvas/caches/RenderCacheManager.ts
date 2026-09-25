import { AppearanceCache } from "./AppearanceCache";
import { BlendCache } from "./BlendCache";
import { CompoundPathCache } from "./CompoundPathCache";
import { FilteredElementCache } from "./FilteredElementCache";
import { GradientCache } from "./GradientCache";
import { GroupPathCache } from "./GroupPathCache";
import { MeshWarpCache } from "./MeshWarpCache";
import { OutlineCache } from "./OutlineCache";
import { StampCache } from "./StampCache";
import { StripCache } from "./StripCache";

/** All element caches for one document, swapped as a unit. */
interface DocumentCacheScope {
	outline: OutlineCache;
	strip: StripCache;
	compoundPath: CompoundPathCache;
	groupPath: GroupPathCache;
	meshWarp: MeshWarpCache;
	stamp: StampCache;
	gradient: GradientCache;
	blend: BlendCache;
	appearance: AppearanceCache;
	filteredElement: FilteredElementCache;
}

/** Scope id used before any document is activated (tests construct a manager
 *  and use the caches directly without setActiveDocument). */
const DEFAULT_SCOPE_ID = "";
/** Live scope budget. The main document plus transient render documents
 *  (brush preview, exports) fit comfortably; least-recently-activated scopes
 *  past this are destroyed. */
const MAX_SCOPES = 4;

/**
 * Unified cache manager for the rendering pipeline. Holds all element caches
 * scoped PER DOCUMENT and provides coordinated invalidation: each rendered
 * document id owns an isolated set of caches, so a transient document render
 * (brush preview, export of a scratch document) can never prune or pollute
 * the main document's entries.
 *
 * Owned by RenderOrchestrator (one instance per canvas target) and passed
 * to CanvasLayer, ElementRenderer, and the BrushRenderer.
 *
 * The cache properties resolve the ACTIVE document's scope on every access.
 * Never capture them at construction time (no `const g = manager.outline`
 * kept across frames, no object-literal snapshot) — a held instance pins
 * whichever document was active when it was read. Pass accessors/thunks
 * instead.
 */
interface RenderCacheManagerOptions {
	stampCacheMaxBytes?: number;
}

export class RenderCacheManager {
	private readonly scopes = new Map<string, DocumentCacheScope>();
	private active: DocumentCacheScope;

	public constructor(private readonly options: RenderCacheManagerOptions = {}) {
		this.active = createScope(options.stampCacheMaxBytes);
		this.scopes.set(DEFAULT_SCOPE_ID, this.active);
	}

	public get outline(): OutlineCache {
		return this.active.outline;
	}
	public get strip(): StripCache {
		return this.active.strip;
	}
	public get compoundPath(): CompoundPathCache {
		return this.active.compoundPath;
	}
	public get groupPath(): GroupPathCache {
		return this.active.groupPath;
	}
	public get meshWarp(): MeshWarpCache {
		return this.active.meshWarp;
	}
	public get stamp(): StampCache {
		return this.active.stamp;
	}
	public get gradient(): GradientCache {
		return this.active.gradient;
	}
	public get blend(): BlendCache {
		return this.active.blend;
	}
	public get appearance(): AppearanceCache {
		return this.active.appearance;
	}
	public get filteredElement(): FilteredElementCache {
		return this.active.filteredElement;
	}

	/**
	 * Bind the caches to `documentId`'s scope, creating it on first sight.
	 * Called at the top of every CanvasLayer.render, so an export/preview
	 * render of another document swaps the whole cache set instead of pruning
	 * the previous document's entries. Scopes past the budget are destroyed
	 * least-recently-activated first.
	 */
	public setActiveDocument(documentId: string): void {
		let scope = this.scopes.get(documentId);
		if (scope) {
			// Refresh recency — Map iteration order doubles as the LRU order.
			this.scopes.delete(documentId);
		} else {
			scope = createScope(this.options.stampCacheMaxBytes);
		}
		this.scopes.set(documentId, scope);
		this.active = scope;
		this.evictOverBudget();
	}

	/**
	 * Destroy `documentId`'s scope (all GPU resources included) — for document
	 * replacement and for transient render documents whose constant element
	 * ids would otherwise accumulate composite-key entries forever. The active
	 * scope is recreated empty so the cache accessors stay usable.
	 */
	public dropDocument(documentId: string): void {
		const scope = this.scopes.get(documentId);
		if (!scope) return;
		destroyScope(scope);
		this.scopes.delete(documentId);
		if (scope === this.active) {
			const fresh = createScope(this.options.stampCacheMaxBytes);
			this.scopes.set(documentId, fresh);
			this.active = fresh;
		}
	}

	/** Flush deferred GPU destroys of EVERY scope (not just the active one —
	 *  a scope deactivated mid-frame must still release its evicted buffers). */
	public flushPendingDestroy(): void {
		for (const scope of this.scopes.values()) {
			scope.appearance.flushPendingDestroy();
			scope.filteredElement.flushPendingDestroy();
		}
	}

	/**
	 * Prune stale entries for elements that no longer exist in the document.
	 * Caches are self-validating so live elements keep their entries.
	 * Called on RenderStrategy.full.
	 */
	public onDocumentChange(liveObjects: Record<string, unknown>): void {
		// Synthetic render keys derive from a live element id with a "::" suffix
		// (e.g. blend intermediates "<blendId>::s0_1", appearance entries
		// "<elementId>::<appearanceUid>"). Liveness is checked on the
		// base id (the part before "::") so their GPU buffers are not destroyed
		// mid-flight by stale-entry pruning every full render; deletion still uses
		// the full key.
		const baseId = (key: string): string => {
			const i = key.indexOf("::");
			return i === -1 ? key : key.slice(0, i);
		};

		// Per-id caches (outline/strip/compound/group/blend/appearance).
		// Each is scanned independently since not every element populates all.
		const staleIds: string[] = [];
		const collectStale = (
			keys: Iterable<string>,
			liveId: (key: string) => string = baseId,
		): void => {
			for (const key of keys) {
				if (!(liveId(key) in liveObjects)) staleIds.push(key);
			}
		};
		// Outline and strip keys are pre-filter composites
		// ("<elementId>:<filterUid>[,...][:<appearanceUid>:<subFilterUids>]"),
		// extrude fills ("<elementId>:extrude-fill:<appearanceUid>") or group
		// appearances ("<groupId>:group-app:..."). They are judged on the id
		// before the first ":" so a full render keeps them. A variant whose
		// pre-filter set changed stays until its element is deleted.
		collectStale(this.outline.keys(), compositeElementId);
		collectStale(this.strip.keys(), compositeElementId);
		collectStale(this.compoundPath.keys());
		collectStale(this.groupPath.keys());
		collectStale(this.meshWarp.keys());
		collectStale(this.blend.keys());
		collectStale(this.appearance.keys());
		collectStale(this.filteredElement.keys());

		if (staleIds.length > 0) {
			this.outline.deleteMany(staleIds);
			this.strip.deleteMany(staleIds);
			this.compoundPath.deleteMany(staleIds);
			this.groupPath.deleteMany(staleIds);
			this.meshWarp.deleteMany(staleIds);
			this.blend.deleteMany(staleIds);
			this.appearance.deleteMany(staleIds);
			this.filteredElement.deleteMany(staleIds);
		}

		// Gradient and stamp caches use composite keys "elementId:...".
		// The element id is the substring before the first ":"; for blend keys
		// ("<blendId>::...") that resolves to the live blend id, so they survive.
		// Stamp keys ("<id>:<scatterFp>:<aspect>:<hash>") MUST be judged this
		// way, not by baseId: they contain single colons only, so the "::" split
		// returns the whole key and never matches a live id, which would wipe
		// the entire stamp cache on every full render.
		for (const key of this.gradient.keys()) {
			if (!(compositeElementId(key) in liveObjects)) this.gradient.delete(key);
		}
		const staleStampKeys: string[] = [];
		for (const key of this.stamp.keys()) {
			if (!(compositeElementId(key) in liveObjects)) staleStampKeys.push(key);
		}
		if (staleStampKeys.length > 0) this.stamp.deleteMany(staleStampKeys);
	}

	/** Clear all caches of every scope (full teardown or device lost). */
	public clearAll(): void {
		for (const scope of this.scopes.values()) destroyScope(scope);
		this.scopes.clear();
		this.active = createScope(this.options.stampCacheMaxBytes);
		this.scopes.set(DEFAULT_SCOPE_ID, this.active);
	}

	/** Destroy least-recently-activated scopes past the budget. */
	private evictOverBudget(): void {
		while (this.scopes.size > MAX_SCOPES) {
			let evicted = false;
			for (const [id, scope] of this.scopes) {
				if (scope === this.active) continue;
				destroyScope(scope);
				this.scopes.delete(id);
				evicted = true;
				break;
			}
			if (!evicted) break;
		}
	}
}

// Helpers

function createScope(stampCacheMaxBytes?: number): DocumentCacheScope {
	return {
		outline: new OutlineCache(),
		strip: new StripCache(),
		compoundPath: new CompoundPathCache(),
		groupPath: new GroupPathCache(),
		meshWarp: new MeshWarpCache(),
		stamp: new StampCache(stampCacheMaxBytes),
		gradient: new GradientCache(),
		blend: new BlendCache(),
		appearance: new AppearanceCache(),
		filteredElement: new FilteredElementCache(),
	};
}

/** Release a scope's entries including their GPU resources — every cache's
 *  clear() destroys (or flushes deferred destroys of) what it owns. */
function destroyScope(scope: DocumentCacheScope): void {
	scope.outline.clear();
	scope.strip.clear();
	scope.compoundPath.clear();
	scope.groupPath.clear();
	scope.meshWarp.clear();
	scope.stamp.clear();
	scope.gradient.clear();
	scope.blend.clear();
	scope.appearance.clear();
	scope.filteredElement.clear();
	scope.filteredElement.flushPendingDestroy();
}

/** The element id a composite cache key belongs to: the part before the first ":". */
function compositeElementId(key: string): string {
	const i = key.indexOf(":");
	return i === -1 ? key : key.slice(0, i);
}

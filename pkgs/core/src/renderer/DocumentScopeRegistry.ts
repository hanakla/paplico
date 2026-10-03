import type { TextState } from "./canvas/CanvasLayerTypes";
import { BlendCache } from "./canvas/caches/BlendCache";
import { CompoundPathCache } from "./canvas/caches/CompoundPathCache";
import { GroupPathCache } from "./canvas/caches/GroupPathCache";
import { MeshWarpCache } from "./canvas/caches/MeshWarpCache";

/** The glyph outline caches a canvas reads through its TextState. */
type TextPathCaches = Pick<
	TextState,
	"pathCache" | "pendingPathLoads" | "stalePathCache"
>;

/**
 * Caches that depend only on one document's content, shared by every canvas
 * target that draws the document.
 */
export class DocumentRenderScope {
	/** Glyph outlines keyed by TextRenderer.computeTextCacheKey. */
	public readonly text: TextPathCaches = {
		pathCache: new Map(),
		pendingPathLoads: new Map(),
		stalePathCache: new Map(),
	};
	/** Self-validating CPU geometry; each entry checks its sources' fingerprint. */
	public readonly compoundPath = new CompoundPathCache();
	public readonly groupPath = new GroupPathCache();
	public readonly meshWarp = new MeshWarpCache();
	public readonly blend = new BlendCache();

	/**
	 * Move the outlines of `elementId`, or of every text when omitted, to the
	 * stale map. Canvases keep drawing them until the new layout lands.
	 */
	public invalidateText(elementId?: string): void {
		const { pathCache, pendingPathLoads, stalePathCache } = this.text;
		const matches = (key: string) =>
			!elementId || key.startsWith(`${elementId}:`);
		for (const [key, entry] of pathCache) {
			if (!matches(key)) continue;
			stalePathCache.set(key, entry);
			pathCache.delete(key);
		}
		// A layout still in flight was started before the invalidation (a font
		// that just loaded, say). Dropping its entry lets a new request start,
		// and makes the old one discard its result when it lands.
		for (const key of pendingPathLoads.keys()) {
			if (matches(key)) pendingPathLoads.delete(key);
		}
	}
}

/** Live scope budget, matching RenderCacheManager's per-canvas scopes. */
const MAX_SCOPES = 4;

/**
 * The DocumentRenderScope of each document id the renderer has drawn. Scopes
 * past the budget are dropped least-recently-used first.
 *
 * An isolated target draws documents that reuse the live one's id with other
 * content (a stored revision, a timelapse replay), so it gets scopes of its
 * own that go with the target.
 */
export class DocumentScopeRegistry {
	private readonly scopes = new Map<string, DocumentRenderScope>();

	/** The scope of `documentId`, created on first sight. */
	public get(
		documentId: string,
		isolatedTargetId?: string,
	): DocumentRenderScope {
		const key = scopeKey(documentId, isolatedTargetId);
		const scope = this.scopes.get(key) ?? new DocumentRenderScope();
		// Map iteration order doubles as the LRU order.
		this.scopes.delete(key);
		this.scopes.set(key, scope);
		for (const oldest of this.scopes.keys()) {
			if (this.scopes.size <= MAX_SCOPES) break;
			this.scopes.delete(oldest);
		}
		return scope;
	}

	/** Drop the shared scope of `documentId`. */
	public drop(documentId: string): void {
		this.scopes.delete(documentId);
	}

	/** Drop every scope the isolated target `targetId` drew with. */
	public dropIsolatedTarget(targetId: string): void {
		const prefix = scopeKey("", targetId);
		for (const key of this.scopes.keys()) {
			if (key.startsWith(prefix)) this.scopes.delete(key);
		}
	}

	/** @see DocumentRenderScope.invalidateText */
	public invalidateText(elementId?: string): void {
		for (const scope of this.scopes.values()) scope.invalidateText(elementId);
	}
}

// Helpers

function scopeKey(documentId: string, isolatedTargetId?: string): string {
	return isolatedTargetId
		? `${isolatedTargetId}\u0000${documentId}`
		: documentId;
}

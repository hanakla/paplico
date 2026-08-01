import type { ObjectsChangeDelta } from "../collaboration/YjsProvider";
import type { Document, TextElement } from "../schema";

/**
 * Reverse index of text dependencies: which text elements are bound to a
 * path (axisBinding.pathObjectId) and how text regions are chained
 * (flow.nextTextElementId).
 *
 * Paplico feeds it the per-object change stream; {@link notifyDelta} returns
 * the set of text element IDs whose layout caches must be invalidated
 * (dependents of a changed axis path, plus every member of a changed chain).
 *
 * Geometry revisions are monotonic counters per referenced path, used inside
 * TextRenderer cache keys so stale layouts self-invalidate.
 */
export class TextDependencyIndex {
	/** axis path id → ids of texts bound to it */
	private pathToTexts = new Map<string, Set<string>>();
	/** text id → axis path id */
	private textToPath = new Map<string, string>();
	/** flow source text id → target text id */
	private flowNext = new Map<string, string>();
	/** flow target text id → source text ids (duplicates possible under collab) */
	private flowPrev = new Map<string, Set<string>>();
	/** referenced path id → geometry revision */
	private geometryRevisions = new Map<string, number>();

	/** Rebuild from a full document (document replace / full sync). */
	public rebuild(document: Document): void {
		this.pathToTexts.clear();
		this.textToPath.clear();
		this.flowNext.clear();
		this.flowPrev.clear();
		for (const obj of Object.values(document.objects)) {
			if (obj.type === "text") this.register(obj);
		}
	}

	/**
	 * Apply a per-object delta. Returns text IDs needing cache invalidation.
	 */
	public notifyDelta(delta: ObjectsChangeDelta): Set<string> {
		const invalidate = new Set<string>();

		const bumpPathDependents = (pathId: string) => {
			const dependents = this.pathToTexts.get(pathId);
			if (!dependents || dependents.size === 0) return;
			this.geometryRevisions.set(
				pathId,
				(this.geometryRevisions.get(pathId) ?? 0) + 1,
			);
			for (const textId of dependents) {
				this.collectChain(textId, invalidate);
			}
		};

		// Geometry changes of referenced axis paths
		for (const [id] of delta.added) bumpPathDependents(id);
		for (const [id] of delta.updated) bumpPathDependents(id);
		for (const id of delta.deleted) bumpPathDependents(id);

		// Text registrations (invalidate both the old and the new chain shape)
		for (const [, obj] of delta.added) {
			if (obj.type !== "text") continue;
			this.register(obj);
			this.collectChain(obj.id, invalidate);
		}
		for (const [, obj] of delta.updated) {
			if (obj.type !== "text") continue;
			this.collectChain(obj.id, invalidate);
			this.unregister(obj.id);
			this.register(obj);
			this.collectChain(obj.id, invalidate);
		}
		for (const id of delta.deleted) {
			if (
				!this.textToPath.has(id) &&
				!this.flowNext.has(id) &&
				!this.flowPrev.has(id)
			) {
				continue;
			}
			this.collectChain(id, invalidate);
			this.unregister(id);
		}

		return invalidate;
	}

	/**
	 * Every member of the flow chain containing textId, head first.
	 * Returns [textId] when the element is not chained.
	 */
	public chainMemberIds(textId: string): string[] {
		// Upstream to head (deterministic across peers: smallest source id wins)
		let head = textId;
		const visitedUp = new Set<string>([textId]);
		for (;;) {
			const source = this.findFlowSourceId(head);
			if (!source || visitedUp.has(source)) break;
			visitedUp.add(source);
			head = source;
		}
		// Downstream from head
		const members: string[] = [head];
		const visitedDown = new Set<string>([head]);
		let current = head;
		for (;;) {
			const next = this.flowNext.get(current);
			if (!next || visitedDown.has(next)) break;
			visitedDown.add(next);
			members.push(next);
			current = next;
		}
		return members;
	}

	/**
	 * The text flowing into textId. With concurrent duplicate inflows the
	 * smallest source id wins (deterministic across peers).
	 */
	public findFlowSourceId(textId: string): string | null {
		const sources = this.flowPrev.get(textId);
		if (!sources || sources.size === 0) return null;
		return [...sources].sort()[0];
	}

	/** Monotonic geometry revision of a referenced path (0 if never bumped). */
	public getGeometryRevision(pathId: string): number {
		return this.geometryRevisions.get(pathId) ?? 0;
	}

	private register(text: TextElement): void {
		const pathId = text.axisBinding?.pathObjectId;
		if (pathId) {
			this.textToPath.set(text.id, pathId);
			let dependents = this.pathToTexts.get(pathId);
			if (!dependents) {
				dependents = new Set();
				this.pathToTexts.set(pathId, dependents);
			}
			dependents.add(text.id);
		}
		const next = text.flow?.nextTextElementId;
		if (next) {
			this.flowNext.set(text.id, next);
			let sources = this.flowPrev.get(next);
			if (!sources) {
				sources = new Set();
				this.flowPrev.set(next, sources);
			}
			sources.add(text.id);
		}
	}

	private unregister(textId: string): void {
		const pathId = this.textToPath.get(textId);
		if (pathId) {
			this.textToPath.delete(textId);
			const dependents = this.pathToTexts.get(pathId);
			dependents?.delete(textId);
			if (dependents?.size === 0) this.pathToTexts.delete(pathId);
		}
		const next = this.flowNext.get(textId);
		if (next) {
			this.flowNext.delete(textId);
			const sources = this.flowPrev.get(next);
			sources?.delete(textId);
			if (sources?.size === 0) this.flowPrev.delete(next);
		}
	}

	/** Add every chain member of textId (via current links) to `out` */
	private collectChain(textId: string, out: Set<string>): void {
		for (const id of this.chainMemberIds(textId)) out.add(id);
	}
}

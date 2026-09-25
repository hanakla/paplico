import * as Y from "yjs";
import { yMapToObject } from "../collaboration/extractDocumentFromYDoc";
import {
	type AnyArtObject,
	type BoundingBox,
	getContainerChildIds,
	isContainer,
} from "../schema";
import { calculateElementBounds } from "../utils/geometry/bounds";
import type {
	TimelapseDirtyRect,
	TimelapseEntry,
	TimelapseIndex,
} from "./types";

/** Object ids touched by a single recorded update. */
export interface TimelapseChangeSet {
	upserted: ReadonlySet<string>;
	deleted: ReadonlySet<string>;
}

/**
 * Reduces each recorded update to one world rect: the union of the affected
 * objects' bounds before and after the change. Moving an object out of an
 * artboard still changes what that artboard shows, so the "before" half is
 * required — the ledger is the only writer of its own map, which makes the
 * stored value structurally guaranteed to predate the update being tracked.
 *
 * A `null` result means the affected area could not be determined. Callers
 * treat that as "affects everything", so the filter only ever loosens.
 */
export class TimelapseBoundsLedger {
	private readonly bounds = new Map<string, TimelapseDirtyRect>();

	public track(
		changes: TimelapseChangeSet | null,
		getWorldBounds: (id: string) => BoundingBox | null,
	): TimelapseDirtyRect | null {
		if (!changes) return null;

		let union: MutableRect | null = null;
		let unknown = false;

		for (const id of changes.deleted) {
			const before = this.bounds.get(id);
			// Never recorded, so the vanished area is unknown.
			if (before) union = unionRect(union, before);
			else unknown = true;
			this.bounds.delete(id);
		}

		for (const id of changes.upserted) {
			if (changes.deleted.has(id)) continue;

			const before = this.bounds.get(id);
			if (before) union = unionRect(union, before);

			const after = getWorldBounds(id);
			if (!after) {
				// Stale entries would silently shrink a later union.
				this.bounds.delete(id);
				unknown = true;
				continue;
			}

			const rect = toDirtyRect(after);
			this.bounds.set(id, rect);
			union = unionRect(union, rect);
		}

		if (unknown || !union) return null;
		return [union.minX, union.minY, union.maxX, union.maxY];
	}

	/** Replace the whole ledger after the document was swapped wholesale. */
	public seed(
		elementIds: Iterable<string>,
		getWorldBounds: (id: string) => BoundingBox | null,
	): void {
		this.bounds.clear();
		for (const id of elementIds) {
			const bounds = getWorldBounds(id);
			if (bounds) this.bounds.set(id, toDirtyRect(bounds));
		}
	}
}

/**
 * Rebuilds the dirty-rect index for recordings saved before the index existed.
 * Feed every entry in order; the builder replays them into its own Y.Doc.
 *
 * Bounds resolve to the changed element's top-level ancestor, which is already
 * world space and needs no ancestor transform chain. That is looser than what
 * the recorder stores, and looser only costs playback time.
 */
export class TimelapseIndexBuilder {
	private readonly doc = new Y.Doc();
	private readonly ledger = new TimelapseBoundsLedger();
	private readonly objects = new Map<string, AnyArtObject>();
	private readonly upserted = new Set<string>();
	private readonly deleted = new Set<string>();
	private parentMap: Map<string, string> | null = null;

	public constructor() {
		this.doc.getMap("objects").observeDeep((events) => {
			for (const event of events) {
				if (event.path.length > 0) {
					this.upserted.add(event.path[0] as string);
					continue;
				}
				if (!(event instanceof Y.YMapEvent)) continue;
				for (const [key, change] of event.changes.keys) {
					if (change.action === "delete") this.deleted.add(key);
					else this.upserted.add(key);
				}
			}
		});
	}

	/** Apply one recorded update and return the rect it dirtied. */
	public step(update: Uint8Array): TimelapseDirtyRect | null {
		this.upserted.clear();
		this.deleted.clear();
		Y.applyUpdate(this.doc, update);

		if (this.upserted.size === 0 && this.deleted.size === 0) return null;

		this.syncObjects();
		return this.ledger.track(
			{ upserted: this.upserted, deleted: this.deleted },
			(id) => this.worldBoundsOf(id),
		);
	}

	public destroy(): void {
		this.doc.destroy();
	}

	private syncObjects(): void {
		const yObjects = this.doc.getMap("objects");
		let containerTouched = false;

		for (const id of this.deleted) {
			const removed = this.objects.get(id);
			if (removed && isContainer(removed)) containerTouched = true;
			this.objects.delete(id);
		}

		for (const id of this.upserted) {
			if (this.deleted.has(id)) continue;

			const yObject = yObjects.get(id);
			if (!(yObject instanceof Y.Map)) {
				this.objects.delete(id);
				continue;
			}

			const previous = this.objects.get(id);
			if (previous && isContainer(previous)) containerTouched = true;

			// A replayed stream may carry element types this build cannot decode.
			try {
				const element = yMapToObject(yObject);
				this.objects.set(id, element);
				if (isContainer(element)) containerTouched = true;
			} catch {
				this.objects.delete(id);
			}
		}

		if (containerTouched) this.parentMap = null;
	}

	private worldBoundsOf(id: string): BoundingBox | null {
		const rootElement = this.objects.get(this.resolveRootId(id));
		if (!rootElement) return null;
		// Geometry recorded by an older build can be shaped in ways the current
		// bounds math rejects. An unresolved rect only loosens the filter.
		try {
			return calculateElementBounds(rootElement, this.objects);
		} catch {
			return null;
		}
	}

	private resolveRootId(id: string): string {
		const parents = this.ensureParentMap();
		const seen = new Set<string>();
		let current = id;

		while (!seen.has(current)) {
			seen.add(current);
			const parent = parents.get(current);
			if (!parent) break;
			current = parent;
		}

		return current;
	}

	private ensureParentMap(): Map<string, string> {
		if (this.parentMap) return this.parentMap;

		const parents = new Map<string, string>();
		for (const [id, element] of this.objects) {
			for (const childId of getContainerChildIds(element) ?? []) {
				parents.set(childId, id);
			}
		}

		this.parentMap = parents;
		return parents;
	}
}

/** Rebuild the whole index in one pass. Used when no keyframe pass is running. */
export function buildTimelapseIndex(
	entries: readonly TimelapseEntry[],
): TimelapseIndex {
	const builder = new TimelapseIndexBuilder();
	const rects = entries.map((entry) => builder.step(entry.u));
	builder.destroy();
	return { rects };
}

interface MutableRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

function toDirtyRect(bounds: BoundingBox): TimelapseDirtyRect {
	return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY];
}

function unionRect(
	accumulator: MutableRect | null,
	rect: TimelapseDirtyRect,
): MutableRect {
	const [minX, minY, maxX, maxY] = rect;
	if (!accumulator) return { minX, minY, maxX, maxY };

	accumulator.minX = Math.min(accumulator.minX, minX);
	accumulator.minY = Math.min(accumulator.minY, minY);
	accumulator.maxX = Math.max(accumulator.maxX, maxX);
	accumulator.maxY = Math.max(accumulator.maxY, maxY);
	return accumulator;
}

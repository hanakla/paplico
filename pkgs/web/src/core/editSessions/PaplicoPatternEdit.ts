/**
 * PaplicoPatternEdit — minimal state machine for entering an isolated
 * "pattern-edit" session.
 *
 * The session expands a pattern def's members onto a transient working layer
 * placed at the top of the document, pushes the working layer onto the
 * editing-group stack so existing tools (Pen/Select/PathEdit) only operate on
 * the def's elements, then on commit translates the working copies back into
 * def-local space, replaces the def's rootElementIds with their new IDs, and
 * tears the transient layer down.
 *
 * Undo isolation: every mutation issued during a session is tagged with the
 * exported `PATTERN_EDIT_ORIGIN` symbol so the main UndoManager (which
 * tracks `null`-origin transactions) ignores them. The host (Paplico) is
 * expected to keep a session-scoped UndoManager that tracks the
 * `PATTERN_EDIT_ORIGIN` origin instead.
 *
 * Collaboration safety: the transient layer carries `transientKind:
 * "pattern-edit"` and `ownerClientId = ydoc.clientID` so the papf writer /
 * exporter can drop it and peers can GC stale residue from crashed sessions.
 */

import { ref } from "valtio";
import type { UndoManager } from "yjs";
import type { YjsProvider } from "../collaboration/YjsProvider";
import type { RendererState } from "../Paplico";
import { buildPatternEditOverlay } from "../renderer/ui/builders/patternEdit";
import { OVERLAY_KEYS, type OverlayKey } from "../renderer/ui/overlayKeys";
import { setSelectionOverlay } from "../renderer/ui/overlaySink";
import type { UIOverlay } from "../renderer/ui/primitives";
import { OVERLAY_Z, UI_THEME } from "../renderer/ui/theme";
import {
	type AnyArtObject,
	type BoundingBox,
	generateUid,
	type Layer,
	TRANSIENT_LAYER_KIND,
} from "../schema";
import { cloneElementsWithIdRemap } from "../utils/cloneElements";
import { calculateElementBounds } from "../utils/geometry/bounds";
import { neverReached } from "../utils/lang";

/**
 * Origin marker used to differentiate pattern-edit mutations from regular
 * document mutations. The main UndoManager (tracked origins = `null` only)
 * does not record these; the session UndoManager is constructed with
 * `{ trackedOrigins: new Set([PATTERN_EDIT_ORIGIN]) }`.
 */
export const PATTERN_EDIT_ORIGIN: symbol = Symbol("pattern-edit");

const PATTERN_PREVIEW_ID_PREFIX = "__pattern-edit-preview__:";
const PREVIEW_OPACITY_SCALE = 0.32;
/** Generic overlay channel key for the tile-guide rectangle. */
const PATTERN_EDIT_OVERLAY_KEY = OVERLAY_KEYS.patternEditTile;

interface PatternEditSession {
	readonly defId: string;
	/**
	 * Yjs IDs of every working-copy clone created for this session, captured
	 * at `enter()` time. Elements added mid-session (e.g. a new stroke) are
	 * NOT reflected here — commit()/cancel()/preview code reads the transient
	 * layer's *current* elementIds instead (see `getLiveRootElementIds`).
	 */
	readonly workingElementIds: string[];
	/**
	 * Yjs IDs of the working-copy roots at `enter()` time. Like
	 * `workingElementIds`, this is a snapshot — use `getLiveRootElementIds`
	 * for the current root set.
	 */
	readonly rootWorkingElementIds: string[];
	/** ID of the transient layer holding the working copies. */
	readonly transientLayerId: string;
	/** World-space offset the originals were translated by when expanded. */
	readonly expansionOffset: { x: number; y: number };
}

interface PaplicoPatternEditOptions {
	store: RendererState;
	yjsProvider: YjsProvider;
	getViewportCenter?: () => { x: number; y: number } | null;
	/** Write the tile-guide overlay into the generic overlay channel. */
	setOverlay: (key: OverlayKey, overlay: UIOverlay | null) => void;
	/** Hand keyboard focus back to the canvas. See PaplicoMaskEdit for why:
	 *  entering from a button leaves focus there, and Escape is gated on the
	 *  canvas having it. */
	focusCanvas?: () => void;
}

export class PaplicoPatternEdit {
	private readonly store: RendererState;
	private readonly yjsProvider: YjsProvider;
	private readonly getViewportCenter:
		| (() => { x: number; y: number } | null)
		| null;
	private readonly setOverlay: (
		key: OverlayKey,
		overlay: UIOverlay | null,
	) => void;
	private session: PatternEditSession | null = null;
	private previousCurrentLayerId: string | null = null;

	/**
	 * Session-scoped UndoManager that only tracks `PATTERN_EDIT_ORIGIN`
	 * operations (object adds/updates/deletes on the transient layer).
	 * Constructed lazily in `enter()` and torn down in `commit()` / `cancel()`.
	 * The main UndoManager (which only tracks `null`-origin operations)
	 * ignores PATTERN_EDIT_ORIGIN entirely, so the two managers never observe
	 * the same stack items.
	 */
	private sessionUndoManager: UndoManager | null = null;
	private readonly focusCanvas: (() => void) | undefined;

	public constructor(options: PaplicoPatternEditOptions) {
		this.store = options.store;
		this.yjsProvider = options.yjsProvider;
		this.getViewportCenter = options.getViewportCenter ?? null;
		this.setOverlay = options.setOverlay;
		this.focusCanvas = options.focusCanvas;
	}

	/** Currently active session, or null when not editing a pattern. */
	public getSession(): PatternEditSession | null {
		return this.session;
	}

	/** True when a pattern-edit session is active. */
	public isActive(): boolean {
		return this.session != null;
	}

	public refreshSessionVisuals(): void {
		this.updateOverlay();
	}

	public getSessionRootBounds(): BoundingBox | null {
		if (!this.session) return null;
		const elementsMap = new Map(Object.entries(this.store.document.objects));
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const id of this.getLiveRootElementIds()) {
			const element = this.store.document.objects[id];
			if (!element) continue;
			const bounds = calculateElementBounds(element, elementsMap);
			minX = Math.min(minX, bounds.minX);
			minY = Math.min(minY, bounds.minY);
			maxX = Math.max(maxX, bounds.maxX);
			maxY = Math.max(maxY, bounds.maxY);
		}

		if (minX === Number.POSITIVE_INFINITY) return null;
		return {
			minX,
			minY,
			maxX,
			maxY,
			width: maxX - minX,
			height: maxY - minY,
		};
	}

	/** Undo the last session-scoped operation. No-op outside a session. */
	public undo(): boolean {
		if (!this.sessionUndoManager) return false;
		this.sessionUndoManager.undo();
		return true;
	}

	/** Redo the last session-scoped undone operation. No-op outside a session. */
	public redo(): boolean {
		if (!this.sessionUndoManager) return false;
		this.sessionUndoManager.redo();
		return true;
	}

	/**
	 * Enter a pattern-edit session for the given def. The def's member
	 * elements are deep-cloned with new IDs, translated by `expansionOffset`
	 * to land at the viewport center, added to a transient layer, and the
	 * transient layer is pushed onto the editing-group stack so other tools
	 * operate exclusively on the working copies.
	 *
	 * Returns false when the def is missing, has no members, or another
	 * session is already active (callers must commit/cancel first).
	 */
	public enter(defId: string): boolean {
		if (this.session) return false;
		const doc = this.store.document;
		const entry = doc.defs?.[defId];
		if (!entry) return false;
		if (entry.rootElementIds.length === 0) return false;

		// Build the snapshot to expand: roots + descendants reachable via
		// container references. Pulled inline rather than imported from
		// PaplicoCommands so PaplicoPatternEdit stays a standalone module.
		const memberIds = collectSubtreeIds(entry.rootElementIds, doc.objects);
		const sourceElements: AnyArtObject[] = [];
		for (const id of memberIds) {
			const obj = doc.objects[id];
			if (obj) sourceElements.push(obj);
		}
		if (sourceElements.length === 0) return false;

		const { cloned, idMap } = cloneElementsWithIdRemap(sourceElements);

		// Translate top-level clones to the current viewport center so the
		// user can see them. Children keep their parent-relative coords.
		const expansionCenter = this.resolveExpansionCenter();
		const vx = expansionCenter.x;
		const vy = expansionCenter.y;
		const rootIdSet = new Set(entry.rootElementIds);
		const rootWorkingElementIds = entry.rootElementIds
			.map((id) => idMap.get(id))
			.filter((id): id is string => typeof id === "string");
		for (const c of cloned) {
			const sourceOldId = [...idMap.entries()].find(
				([, newId]) => newId === c.id,
			)?.[0];
			if (!sourceOldId || !rootIdSet.has(sourceOldId)) continue;
			c.transform = {
				...c.transform,
				x: c.transform.x + vx,
				y: c.transform.y + vy,
			};
		}

		const transientLayerId = generateUid("layer");
		const ownerClientId = String(this.yjsProvider.ydoc.clientID);
		const transientLayer: Layer = {
			id: transientLayerId,
			name: `Pattern Edit: ${entry.name ?? entry.id}`,
			elementIds: rootWorkingElementIds,
			visible: true,
			locked: false,
			opacity: 1.0,
			transientKind: TRANSIENT_LAYER_KIND.PATTERN_EDIT,
			ownerClientId,
		};

		// Open the session UndoManager BEFORE writing so the very first edits
		// land in its stack. The manager only observes PATTERN_EDIT_ORIGIN, so
		// it will keep tracking the user's subsequent in-session edits.
		this.sessionUndoManager = this.yjsProvider.createSessionUndoManager(
			new Set([PATTERN_EDIT_ORIGIN]),
		);

		this.yjsProvider.transact(() => {
			for (const c of cloned) {
				this.yjsProvider.addObjectOnly(c, PATTERN_EDIT_ORIGIN);
			}
			this.yjsProvider.addLayer(transientLayer);
		}, PATTERN_EDIT_ORIGIN);

		// Clear the initial expansion from the session stack — the user
		// shouldn't undo back to "no working layer yet" (that would orphan
		// the session). Subsequent edits remain undoable.
		this.sessionUndoManager.clear();

		// Mirror the session UndoManager's stack into the shared
		// canUndo/canRedo UI state while this session is active (registered
		// after clear() so the initial expansion doesn't flicker canUndo).
		this.sessionUndoManager.on("stack-item-added", () =>
			this.syncUndoRedoState(),
		);
		this.sessionUndoManager.on("stack-item-popped", () =>
			this.syncUndoRedoState(),
		);
		this.syncUndoRedoState();

		// Push the first cloned root group / element id onto the editing
		// stack so tools scope themselves to the working copies. We use the
		// transient layer id as a stand-in editing-scope token; the existing
		// editingScopeStack handling treats anything on the stack as the
		// active editing context (see collectEditablePaths).
		this.previousCurrentLayerId = this.store.currentLayerId;
		this.store.currentLayerId = transientLayerId;
		this.store.editingScopeStack.push(transientLayerId);
		this.clearSelectionState();

		this.session = {
			defId,
			workingElementIds: cloned.map((c) => c.id),
			rootWorkingElementIds,
			transientLayerId,
			expansionOffset: { x: vx, y: vy },
		};
		this.updateOverlay();
		this.focusCanvas?.();
		return true;
	}

	/**
	 * Commit the active session: working copies are translated back into
	 * def-local space (subtracting the expansion offset), the def's
	 * rootElementIds are replaced with the new ids, and the transient
	 * layer is removed.
	 *
	 * Mutations to `document.objects` happen with `null` origin so the
	 * main UndoManager can roll back the commit. The transient layer is
	 * itself removed under `PATTERN_EDIT_ORIGIN` since its existence is
	 * a session detail.
	 */
	public commit(): boolean {
		const s = this.session;
		if (!s) return false;

		const doc = this.store.document;
		const entry = doc.defs?.[s.defId];
		if (!entry) {
			this.cancel();
			return false;
		}

		// Live-derive the working roots from the transient layer's *current*
		// elementIds rather than the enter()-time snapshot, so elements added
		// mid-session (e.g. a new stroke drawn while editing) are promoted
		// into the def instead of being silently discarded.
		const workingRoots = this.getLiveRootElementIds();
		if (workingRoots.length === 0) {
			// Nothing to promote (e.g. the user deleted every working
			// element) — fall back to cancel() rather than leaving the def
			// with an empty rootElementIds list.
			this.cancel();
			return false;
		}

		// Isolate this commit's undo group from any main-origin edit that
		// may have happened just before entering the session (captureTimeout
		// would otherwise merge them into one undo step).
		this.yjsProvider.stopUndoCapture();

		// Translate each top-level working element back to def-local space
		// before promoting it. Per-element updates carry the `null` origin
		// so the main UndoManager records the commit as a regular edit.
		this.yjsProvider.transact(() => {
			for (const id of workingRoots) {
				const obj = doc.objects[id];
				if (!obj) continue;
				this.yjsProvider.updateElement(
					s.transientLayerId,
					id,
					{
						transform: {
							...obj.transform,
							x: obj.transform.x - s.expansionOffset.x,
							y: obj.transform.y - s.expansionOffset.y,
						},
					},
					null,
				);
			}
			// Replace def members with the (now def-local) working ids.
			this.yjsProvider.replaceDefElements(s.defId, workingRoots, null);
		}, null);

		// Tear down the transient layer under PATTERN_EDIT_ORIGIN so the
		// main undo history isn't polluted by removing session-only
		// scaffolding — undoing the commit should restore the def to its
		// pre-session state in one step, not resurrect the working layer.
		this.yjsProvider.deleteLayer(
			s.transientLayerId,
			{ deleteObjects: false },
			PATTERN_EDIT_ORIGIN,
		);
		const idx = this.store.editingScopeStack.lastIndexOf(s.transientLayerId);
		if (idx >= 0) this.store.editingScopeStack.splice(idx, 1);
		this.restoreCurrentLayerId();

		this.teardownSessionUndoManager();
		this.session = null;
		this.updateOverlay();
		return true;
	}

	/**
	 * Cancel the active session: the transient layer is removed and the
	 * editing-group stack is restored. No def mutations are committed.
	 */
	public cancel(): boolean {
		const s = this.session;
		if (!s) return false;

		// Union of the enter()-time snapshot and the transient layer's
		// current (live) subtree: session edits since enter() may have added
		// elements that never made it into `workingElementIds`, and elements
		// removed from the layer (e.g. via a session undo) may still linger
		// in `workingElementIds`. Deleting the union covers both.
		const liveSubtreeIds = collectSubtreeIds(
			this.getLiveRootElementIds(),
			this.store.document.objects,
		);
		const idsToDelete = new Set([...s.workingElementIds, ...liveSubtreeIds]);

		this.yjsProvider.deleteElements(
			{ [s.transientLayerId]: [...idsToDelete] },
			PATTERN_EDIT_ORIGIN,
		);
		this.yjsProvider.deleteLayer(
			s.transientLayerId,
			{ deleteObjects: false },
			PATTERN_EDIT_ORIGIN,
		);
		const idx = this.store.editingScopeStack.lastIndexOf(s.transientLayerId);
		if (idx >= 0) this.store.editingScopeStack.splice(idx, 1);
		this.restoreCurrentLayerId();
		this.teardownSessionUndoManager();
		this.session = null;
		this.updateOverlay();
		return true;
	}

	/**
	 * Garbage-collect transient pattern-edit layers owned by clients that
	 * no longer have an active session. Called by the host on document
	 * load to clear residue from crashed peers. Returns the number of
	 * layers removed.
	 */
	public garbageCollectStaleLayers(
		activeClientIds: ReadonlySet<string>,
	): number {
		const stale: string[] = [];
		for (const layer of this.store.document.layers) {
			if (layer.transientKind !== TRANSIENT_LAYER_KIND.PATTERN_EDIT) continue;
			if (layer.ownerClientId && activeClientIds.has(layer.ownerClientId))
				continue;
			stale.push(layer.id);
		}
		for (const id of stale) {
			this.yjsProvider.deleteLayer(id);
		}
		return stale.length;
	}

	private updateOverlay(): void {
		const s = this.session;

		// Mirror the session identity into reactive state (PatternEditBar gate).
		// Only rewrite on identity change to avoid re-render noise — this method
		// runs on every document/objects update while a session is active.
		const mirrored = this.store.patternEditSession;
		if (s ? mirrored?.defId !== s.defId : mirrored !== null) {
			this.store.patternEditSession = s ? { defId: s.defId } : null;
		}

		if (!s) {
			this.syncPreviewTransients(null);
			this.setOverlay(PATTERN_EDIT_OVERLAY_KEY, null);
			return;
		}
		const doc = this.store.document;
		const entry = doc.defs?.[s.defId];
		if (!entry?.tile) {
			this.syncPreviewTransients(null);
			this.setOverlay(PATTERN_EDIT_OVERLAY_KEY, null);
			return;
		}
		this.syncPreviewTransients(entry);
		const rootBounds = this.getSessionRootBounds();
		const centerX = rootBounds
			? (rootBounds.minX + rootBounds.maxX) / 2
			: s.expansionOffset.x;
		const centerY = rootBounds
			? (rootBounds.minY + rootBounds.maxY) / 2
			: s.expansionOffset.y;
		this.setOverlay(PATTERN_EDIT_OVERLAY_KEY, {
			zIndex: OVERLAY_Z.patternEdit,
			primitives: buildPatternEditOverlay(
				{
					centerX,
					centerY,
					tileWidth: entry.tile.width,
					tileHeight: entry.tile.height,
				},
				UI_THEME,
			),
		});
	}

	private resolveExpansionCenter(): { x: number; y: number } {
		const center = this.getViewportCenter?.() ?? null;
		if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
			return center;
		}
		return {
			x: this.store.document.viewport.x,
			y: this.store.document.viewport.y,
		};
	}

	private restoreCurrentLayerId(): void {
		const previous = this.previousCurrentLayerId;
		this.previousCurrentLayerId = null;
		if (
			previous &&
			this.store.document.layers.some((layer) => layer.id === previous)
		) {
			this.store.currentLayerId = previous;
			return;
		}
		this.store.currentLayerId = this.store.document.layers[0]?.id ?? null;
	}

	private clearSelectionState(): void {
		this.store.selectedElementIds = [];
		this.store.selectionBounds = null;
		setSelectionOverlay(this.store.uiOverlayState, null);
	}

	/**
	 * Live root element ids from the transient layer's *current* elementIds,
	 * rather than the enter()-time snapshot in `session.rootWorkingElementIds`.
	 * Elements added mid-session (e.g. a new stroke drawn while editing) live
	 * in the transient layer immediately but are never appended to the
	 * snapshot, so commit()/cancel()/bounds/preview code must read from here
	 * to see them.
	 */
	private getLiveRootElementIds(): string[] {
		const s = this.session;
		if (!s) return [];
		const layer = this.store.document.layers.find(
			(l) => l.id === s.transientLayerId,
		);
		if (!layer) return [];
		return layer.elementIds.filter(
			(id) => this.store.document.objects[id] != null,
		);
	}

	/**
	 * Mirror undo/redo availability into the shared canUndo/canRedo UI
	 * state: the session UndoManager's stack while a session is active, the
	 * main YjsProvider's otherwise.
	 */
	private syncUndoRedoState(): void {
		if (this.sessionUndoManager) {
			this.store.canUndo = this.sessionUndoManager.canUndo();
			this.store.canRedo = this.sessionUndoManager.canRedo();
		} else {
			this.store.canUndo = this.yjsProvider.canUndo();
			this.store.canRedo = this.yjsProvider.canRedo();
		}
	}

	private teardownSessionUndoManager(): void {
		this.sessionUndoManager?.destroy();
		this.sessionUndoManager = null;
		this.syncUndoRedoState();
	}

	private syncPreviewTransients(
		entry: { tile?: { width: number; height: number } } | null,
	): void {
		const next = new Map(
			[...this.store.transientElements].filter(
				([id]) => !id.startsWith(PATTERN_PREVIEW_ID_PREFIX),
			),
		);
		const s = this.session;
		const tile = entry?.tile;
		const liveRootIds = this.getLiveRootElementIds();
		if (
			!s ||
			!tile ||
			!(tile.width > 0) ||
			!(tile.height > 0) ||
			liveRootIds.length === 0
		) {
			this.store.transientElements = ref(next);
			return;
		}

		// Deep-clone the working subtree per neighbor cell with deterministic,
		// cell-scoped IDs. Previews must NOT share child IDs with the working
		// copies: the renderer's transform registry resolves each element's
		// parent by ID, so shared children would all snap to a single cell.
		const objects = this.store.document.objects;
		const subtreeIds = collectSubtreeIds(liveRootIds, objects);
		const sources: AnyArtObject[] = [];
		for (const id of subtreeIds) {
			const obj = objects[id];
			if (obj) sources.push(obj);
		}

		for (let row = -1; row <= 1; row++) {
			for (let col = -1; col <= 1; col++) {
				if (row === 0 && col === 0) continue;
				const cellPrefix = `${PATTERN_PREVIEW_ID_PREFIX}${s.transientLayerId}:${row}:${col}:`;
				const { cloned, idMap } = cloneElementsWithIdRemap(sources, {
					mintId: (el) => `${cellPrefix}${el.id}`,
				});
				const rootCloneIds = new Set(liveRootIds.map((id) => idMap.get(id)));
				for (const c of cloned) {
					const isRoot = rootCloneIds.has(c.id);
					next.set(c.id, {
						layerId: s.transientLayerId,
						element: isRoot
							? {
									...c,
									opacity: c.opacity * PREVIEW_OPACITY_SCALE,
									transform: {
										...c.transform,
										x: c.transform.x + tile.width * col,
										y: c.transform.y + tile.height * row,
									},
								}
							: c,
						topLevel: isRoot,
					});
				}
			}
		}

		this.store.transientElements = ref(next);
	}
}

/**
 * Collect a def subtree: the given roots plus every descendant reachable via
 * container references (group children / clip paths, blend members / spine,
 * compound-path sources, repeat sources, text path bindings, object masks).
 */
function collectSubtreeIds(
	rootIds: readonly string[],
	objects: Record<string, AnyArtObject>,
): Set<string> {
	const memberIds = new Set<string>();
	const stack = [...rootIds];
	while (stack.length > 0) {
		const id = stack.pop();
		if (!id) continue;
		if (memberIds.has(id)) continue;
		memberIds.add(id);
		const obj = objects[id];
		if (!obj) continue;
		if (obj.mask) for (const mid of obj.mask.elementIds) stack.push(mid);
		switch (obj.type) {
			case "group":
				for (const cid of obj.childIds) stack.push(cid);
				if (obj.clipPathId) stack.push(obj.clipPathId);
				break;
			case "blend":
				for (const cid of obj.objectIds) stack.push(cid);
				if (obj.spineSourceId) stack.push(obj.spineSourceId);
				break;
			case "compound-path":
				for (const s of obj.sources) stack.push(s.id);
				break;
			case "repeat":
				for (const cid of obj.sourceIds) stack.push(cid);
				break;
			case "mesh":
				for (const cid of obj.childIds) stack.push(cid);
				break;
			case "text":
				if (obj.axisBinding) stack.push(obj.axisBinding.pathObjectId);
				if (obj.clipPathId) stack.push(obj.clipPathId);
				break;
			case "path":
			case "image":
			case "reference3d":
				// Reference no other elements beyond the mask handled above.
				break;
			default:
				neverReached(obj, "unhandled element type in subtree walk");
		}
	}
	return memberIds;
}

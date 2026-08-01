/**
 * PaplicoMaskEdit — isolated editing session for an `ArtObject.mask`.
 *
 * Mask content belongs to no layer, so there is normally no surface the
 * ordinary tools can reach it through. A session lends it one: a transient
 * layer listing the mask's roots, pushed onto the editing-group stack so the
 * tools scope themselves to it and the composite-level isolation dim leaves the
 * masked element visible underneath as something to draw against.
 *
 * Mask content is stored in its owner's local frame, but the session edits in
 * world space — the roots are converted on the way in and back on the way out.
 * Editing in the stored frame was tried and does not work: a session that
 * leaves the content in owner-local space silently shifts anything drawn or
 * pasted mid-session, because tools author in world space, and hanging the
 * content off a group carrying the owner's transform shifts it again whenever a
 * shape is resized, since a group's transform pivots on the centre of its
 * children's bounds. World space in, owner-local out, is the only arrangement
 * with no hidden frame for the tools to disagree with.
 *
 * Unlike {@link PaplicoPatternEdit}, nothing is cloned. A pattern def is a
 * template with many instances, so it is expanded into working copies; a mask
 * has exactly one owner, so the session edits the real objects where they are.
 *
 * While a session is open the owner's `mask.elementIds` is emptied, which is
 * how the owner renders unmasked: an empty mask hides nothing. A half-drawn
 * mask would otherwise hide the very thing being masked.
 */

import type { YjsProvider } from "../collaboration/YjsProvider";
import type { RendererState } from "../Paplico";
import {
	type ElementTransform,
	generateUid,
	getTransform,
	type Layer,
	TRANSIENT_LAYER_KIND,
} from "../schema";
import {
	composeTransforms,
	solveChildTransform,
} from "../utils/geometry/geometry";

export interface MaskEditSession {
	/** Element whose mask is being edited. */
	readonly ownerId: string;
	/** Layer lending the mask content a place the tools can reach. */
	readonly transientLayerId: string;
	/** The owner's frame, used to convert the content in and back out. */
	readonly ownerWorldTransform: ElementTransform;
}

export interface PaplicoMaskEditOptions {
	store: RendererState;
	yjsProvider: YjsProvider;
	/** The element's transform with every ancestor composed in. */
	getWorldTransform: (elementId: string) => ElementTransform;
	/** Hand keyboard focus back to the canvas. Entering from a button leaves
	 *  focus on that button, and every canvas keybinding — Escape included — is
	 *  gated on the canvas having focus, so the session would be unleavable by
	 *  keyboard until the user clicked the canvas. */
	focusCanvas?: () => void;
	/** Select an element (through the proper selection path, so the overlay and
	 *  bounds follow). Used to leave the owner selected after editing its mask. */
	selectElement?: (elementId: string) => void;
}

export class PaplicoMaskEdit {
	private readonly store: RendererState;
	private readonly yjsProvider: YjsProvider;
	private readonly getWorldTransform: (elementId: string) => ElementTransform;
	private readonly focusCanvas: (() => void) | undefined;
	private readonly selectElement: ((elementId: string) => void) | undefined;
	private session: MaskEditSession | null = null;
	private previousCurrentLayerId: string | null = null;

	public constructor(options: PaplicoMaskEditOptions) {
		this.store = options.store;
		this.yjsProvider = options.yjsProvider;
		this.getWorldTransform = options.getWorldTransform;
		this.focusCanvas = options.focusCanvas;
		this.selectElement = options.selectElement;
	}

	public getSession(): MaskEditSession | null {
		return this.session;
	}

	public isActive(): boolean {
		return this.session != null;
	}

	/**
	 * Open a session for the given element's mask.
	 *
	 * Returns false when the element is missing, carries no mask, or another
	 * session is already open (callers must leave first).
	 */
	public enter(ownerId: string): boolean {
		if (this.session) return false;
		const owner = this.store.document.objects[ownerId];
		const ownerMask = owner?.mask;
		if (!owner || !ownerMask) return false;

		const ownerWorldTransform = this.getWorldTransform(ownerId);
		const originalRoots = ownerMask.elementIds
			.map((id) => {
				const root = this.store.document.objects[id];
				return root ? { id, transform: getTransform(root) } : null;
			})
			.filter((entry): entry is { id: string; transform: ElementTransform } =>
				Boolean(entry),
			);

		const transientLayerId = generateUid("layer");
		const transientLayer: Layer = {
			id: transientLayerId,
			// Named for what it is, not for what it belongs to: the panel shows
			// this layer only while its own session is open, so the owner's name
			// would say something the user already knows, and its id nothing.
			name: "Mask",
			elementIds: originalRoots.map((root) => root.id),
			visible: true,
			locked: false,
			opacity: 1.0,
			transientKind: TRANSIENT_LAYER_KIND.MASK_EDIT,
			ownerClientId: String(this.yjsProvider.ydoc.clientID),
		};

		this.yjsProvider.transact(() => {
			for (const root of originalRoots) {
				this.writeTransform(
					root.id,
					composeTransforms(ownerWorldTransform, root.transform),
				);
			}
			this.yjsProvider.addLayer(transientLayer);
			// Emptying the mask is what unmasks the owner for the duration, and
			// what stops the renderer composing the content under it while the
			// session has it in world space.
			//
			// Skipped when it is already empty, and not merely to save a write: an
			// untracked write to a key discards what a tracked one before it left
			// there, so writing the same value again over a just-created mask makes
			// creating it un-undoable.
			if (ownerMask.elementIds.length > 0) {
				this.yjsProvider.updateElement("", ownerId, {
					mask: { ...ownerMask, elementIds: [] },
				});
			}
		});

		this.previousCurrentLayerId = this.store.currentLayerId;
		this.store.currentLayerId = transientLayerId;
		this.store.editingScopeStack.push(transientLayerId);
		this.clearSelectionState();

		this.session = {
			ownerId,
			transientLayerId,
			ownerWorldTransform,
		};
		this.store.maskEditSession = { ownerId };
		this.focusCanvas?.();
		return true;
	}

	/**
	 * Close the session.
	 *
	 * There is nothing to confirm or discard: the session edits the mask's real
	 * objects in place, so everything drawn into it was already part of the
	 * document as it happened, and the ordinary history already holds it.
	 * Leaving only undoes the loan — the content goes back into the owner's
	 * frame and back into the mask, and the layer that lent it to the tools
	 * goes away.
	 *
	 * Roots are read back from the transient layer rather than from an entry
	 * snapshot, so shapes added or removed mid-session are reflected instead of
	 * silently dropped, and every one of them is converted back the same way.
	 */
	public leave(): boolean {
		const s = this.session;
		if (!s) return false;

		const rootIds = this.getLiveRootElementIds();

		this.yjsProvider.transact(() => {
			for (const id of rootIds) {
				const root = this.store.document.objects[id];
				if (!root) continue;
				this.writeTransform(
					id,
					solveChildTransform(s.ownerWorldTransform, getTransform(root)),
				);
			}
			this.writeMaskElementIds(s.ownerId, rootIds);
		});

		this.teardown(s);
		// Leave the element whose mask was edited selected — that is what the
		// user was working on, and it is otherwise unreachable now that the
		// working layer is gone. teardown cleared the transient-layer selection
		// first, so this is the surviving one.
		if (this.store.document.objects[s.ownerId]) {
			this.selectElement?.(s.ownerId);
		}
		return true;
	}

	/**
	 * Close the session if the mask it is editing has gone — undone, deleted, or
	 * removed by a peer. Editing something that no longer exists has nothing to
	 * write back, and the working layer would sit there with no way to explain
	 * itself.
	 */
	public leaveIfMaskGone(): void {
		const s = this.session;
		if (!s) return;
		if (this.store.document.objects[s.ownerId]?.mask) return;
		this.leave();
	}

	/**
	 * Remove mask-edit layers owned by clients that no longer have a session.
	 * Called on document load to clear residue from crashed peers.
	 *
	 * @returns the number of layers removed.
	 */
	public garbageCollectStaleLayers(
		activeClientIds: ReadonlySet<string>,
	): number {
		const stale: string[] = [];
		for (const layer of this.store.document.layers) {
			if (layer.transientKind !== TRANSIENT_LAYER_KIND.MASK_EDIT) continue;
			if (layer.ownerClientId && activeClientIds.has(layer.ownerClientId))
				continue;
			stale.push(layer.id);
		}
		for (const id of stale) {
			this.yjsProvider.deleteLayer(id, { deleteObjects: false });
		}
		return stale.length;
	}

	private writeTransform(elementId: string, transform: ElementTransform): void {
		this.yjsProvider.updateElement("", elementId, { transform });
	}

	/** Replace the owner's mask roots, keeping the mask's other settings. */
	private writeMaskElementIds(ownerId: string, elementIds: string[]): void {
		const mask = this.store.document.objects[ownerId]?.mask;
		if (!mask) return;
		this.yjsProvider.updateElement("", ownerId, {
			mask: { ...mask, elementIds },
		});
	}

	/**
	 * Tear the working layer down and restore the surrounding editing state.
	 * Its elements are left alone — they are the mask.
	 */
	private teardown(session: MaskEditSession): void {
		this.yjsProvider.deleteLayer(session.transientLayerId, {
			deleteObjects: false,
		});

		const idx = this.store.editingScopeStack.lastIndexOf(
			session.transientLayerId,
		);
		if (idx >= 0) this.store.editingScopeStack.splice(idx, 1);
		this.restoreCurrentLayerId();

		this.session = null;
		this.store.maskEditSession = null;
		this.clearSelectionState();
	}

	/**
	 * The mask's roots as they stand now, read from the transient layer. Shapes
	 * drawn mid-session appear there immediately but never in the entry-time
	 * snapshot.
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
	}
}

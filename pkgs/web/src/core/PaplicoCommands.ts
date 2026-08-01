/**
 * PaplicoCommands - Centralized document mutation commands
 *
 * All document mutations that go through YjsProvider are encapsulated here.
 * This class receives the DocumentStore and YjsProvider via dependency injection,
 * keeping core/ free from stores/ imports.
 */

import { normalizeBrushSettings } from "./brush/normalize";
import { createBuiltinBrushFiles } from "./brush/presets";
import type { YjsProvider } from "./collaboration/YjsProvider";
import {
	createIdentityTransform,
	createMeshWarpObject,
	createReference3DElement,
	createRepeatObject,
} from "./document/factory";
import type { SpatialIndex } from "./document/SpatialIndex";
import { Clipboard, PAPLICO_ELEMENTS_MIME } from "./infra/Clipboard";
import type { RendererState } from "./Paplico";
import type { PaplicoSelection } from "./PaplicoSelection";
import {
	cornersFromBounds,
	projectionErrorThreshold,
	projectViaH,
	solveHomography,
} from "./renderer/filters/perspectiveWarp";
import {
	fitSegmentsWithProjection,
	type Point,
} from "./renderer/filters/projectiveBezier";
import { setArtboardSelectionOverlay } from "./renderer/ui/overlaySink";
import {
	type AnyArtObject,
	type Artboard,
	type BlendMode,
	type BlendObject,
	type BlendSpacing,
	type BooleanOperation,
	type BrushPreset,
	type BrushSettings,
	BUILTIN_BRUSH_IDS,
	type Color,
	type ColorProfileSettings,
	type CompoundPath,
	type CubicBezierSegment,
	type DefEntry,
	type DefKind,
	type ElementTransform,
	type EmbeddedFile,
	type EraseMask,
	type FillAppearance,
	type FillColor,
	type Filter,
	type Group,
	generateUid,
	getContainerChildIds,
	getTransform,
	type HdrSettings,
	type ImageObject,
	isBlend,
	isCompoundPath,
	isContainer,
	isFreeGradient,
	isGroup,
	isIdentityTransform,
	isLinearGradient,
	isMesh,
	isMeshGradient,
	isPath,
	isRadialGradient,
	isRepeat,
	type Layer,
	type MeshArtObject,
	type MeshGradientVertex,
	type ObjectMask,
	type Path,
	type PathSegment,
	type Reference3DDef,
	type Reference3DElement,
	type Reference3DNode,
	type RepeatGridParams,
	type RepeatMirrorParams,
	type RepeatMode,
	type RepeatObject,
	type RepeatRadialParams,
	type StrokeAppearance,
	type StrokeColor,
	type TextContent,
	type TextElement,
	type Vec2,
} from "./schema";
import type { ToolSettings } from "./tools/toolSettings";
import type { TextRenderer } from "./typography/TextRenderer";
import { splitTextContentAt } from "./typography/textContent";
import { cloneElementsWithIdRemap } from "./utils/cloneElements";
import {
	buildElementColorUpdates,
	type CollectedColor,
	collectElementColors,
	type FilterHandlerLookup,
} from "./utils/color";
import {
	computeSpineKeyPlacements,
	relocateSpineAnchorsToKeys,
} from "./utils/geometry/blendInterpolation";
import {
	brandLocalBBox,
	brandWorldBBox,
	calculateElementBounds,
	calculateLocalElementBounds,
	calculateMeshCoordinateBounds,
	calculateRepeatSourceUnion,
	translateBounds,
} from "./utils/geometry/bounds";
import {
	composeTransforms,
	computeInverseCompositionTransform,
	solveChildTransform,
} from "./utils/geometry/geometry";
import {
	deleteMeshVertex,
	demoteMeshColorVertexToDerived,
	syncDerivedVertices,
} from "./utils/geometry/meshGradient";
import {
	createLocalPointDeformer,
	type DeformFrame,
	deformGradientFilters,
	flattenElementIds,
	isDeformableElement,
	resolveStoredTransform,
} from "./utils/geometry/pointDeform";
import { toWorldPath, translateSegments } from "./utils/geometry/segmentOps";
import { deepClone, neverReached } from "./utils/lang";
import { parseSvgToArtObjects, type SvgImportResult } from "./utils/svgImport";

/**
 * Result of createBlendFromSelection. `reason` distinguishes a user-facing
 * rejection ("different-parent": sources span multiple layers/groups) from a
 * silent no-op precondition ("invalid": locked, or fewer than two paths).
 */
export type CreateBlendResult =
	| { ok: true; blendId: string }
	| { ok: false; reason: "invalid" | "different-parent" };

export interface CommandContext {
	store: RendererState;
	yjsProvider: YjsProvider;
	spatial: SpatialIndex;
	isReadonly: () => boolean;
	renderElementsToPNG?: (
		elementIds: string[],
	) => Promise<{ blob: Blob } | null>;
	filterHandlerLookup?: FilterHandlerLookup;
	toolSettings?: ToolSettings;
	getTextRenderer?: () => TextRenderer | null;
	selection?: PaplicoSelection;
	/**
	 * Origin to tag Yjs mutations with. Paplico wires this to return
	 * PATTERN_EDIT_ORIGIN while a pattern-edit session is active so the
	 * session-scoped UndoManager (not the main one) tracks the edit.
	 * Undefined outside of any special editing context.
	 */
	getMutationOrigin?: () => unknown;
	/**
	 * The history of the active editing session, or null outside one. Its edits
	 * carry a session origin the main UndoManager does not track, so undo has to
	 * be handed to the session that recorded them — otherwise it silently walks
	 * the document's history instead, and the session's own edits are unreachable.
	 */
	getSessionHistory?: () => {
		undo: () => boolean;
		redo: () => boolean;
	} | null;
}

export class PaplicoCommands {
	public constructor(private ctx: CommandContext) {}

	// --- Helper: get selected element ---

	private getSelectedElement(): AnyArtObject | null {
		if (this.ctx.store.selectedElementIds.length === 0) return null;
		const selectedId = this.ctx.store.selectedElementIds[0];
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return null;

		return this.ctx.store.document.objects[selectedId] ?? null;
	}

	private getMutationOrigin(): unknown | undefined {
		return this.ctx.getMutationOrigin?.();
	}

	/** Returns true if the current room is readonly — all mutations should be blocked. */
	private cannotMutate(): boolean {
		return this.ctx.isReadonly();
	}

	/** Returns true if the element (or its ancestor group / layer) is locked. */
	private isElementLocked(elementId: string): boolean {
		return this.ctx.spatial.isElementLocked(elementId);
	}

	/** Returns true if the given layer is locked. */
	private isLayerLocked(layerId?: string): boolean {
		const lid = layerId ?? this.ctx.store.currentLayerId;
		if (!lid) return false;
		const layer = this.ctx.store.document.layers.find((l) => l.id === lid);
		return layer?.locked === true;
	}

	/** Returns true if the current editing context (layer + scope stack) is locked. */
	private isCurrentContextLocked(): boolean {
		if (this.isLayerLocked()) return true;

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (editingScopeId && this.isElementLocked(editingScopeId)) return true;
		return false;
	}

	// --- Element Operations ---

	public addPath(path: Path): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;

		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add path");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		const currentT = getTransform(path);
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, path, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, path.id, path.type, currentT);
		}, this.getMutationOrigin());
	}

	public addImage(image: ImageObject): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add image");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		const currentT = getTransform(image);
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, image, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, image.id, image.type, currentT);
		}, this.getMutationOrigin());
	}

	public addText(text: TextElement): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (!this.ctx.store.currentLayerId) {
			console.warn("No layer selected, cannot add text");
			return;
		}

		const layerId = this.ctx.store.currentLayerId;
		const currentT = getTransform(text);
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(layerId, text, this.getMutationOrigin());
			this.moveIntoEditingScope(layerId, text.id, text.type, currentT);
		}, this.getMutationOrigin());
	}

	/**
	 * Sets element transform so that composeTransforms(scopeWorldT, newT) preserves
	 * the element's original world-space appearance despite the ancestor transform chain.
	 * Then adds the element to the editing scope container's childIds.
	 */
	private moveIntoEditingScope(
		layerId: string,
		elementId: string,
		elementType: string,
		currentTransform: ElementTransform,
	): void {
		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (!editingScopeId) return;

		const scopeElement = this.ctx.store.document.objects[editingScopeId];
		if (!scopeElement) return;

		// Single-element scope: new elements go to the scope element's own
		// parent — its ancestor container, or the layer root where addElement
		// already placed them (in which case there is nothing to move).
		const targetContainerId = isContainer(scopeElement)
			? editingScopeId
			: this.ctx.spatial.getParentGroupId(editingScopeId);
		if (!targetContainerId) return;

		const container = this.ctx.store.document.objects[targetContainerId];
		if (!container) return;

		const scopeWorldT = this.getEditingScopeWorldTransform(targetContainerId);

		if (isCompoundPath(container) && elementType === "path") {
			this.applyCompensatingTransform(
				layerId,
				elementId,
				currentTransform,
				scopeWorldT,
			);
			this.ctx.yjsProvider.addSourceToCompoundPath(
				layerId,
				targetContainerId,
				elementId,
				"union",
				this.getMutationOrigin(),
			);
		} else if (!isCompoundPath(container)) {
			this.applyCompensatingTransform(
				layerId,
				elementId,
				currentTransform,
				scopeWorldT,
			);
			this.ctx.yjsProvider.addElementToGroup(
				layerId,
				targetContainerId,
				elementId,
				this.getMutationOrigin(),
			);
		}
		// CompoundPath + non-path: element stays at layer root untouched
	}

	private applyCompensatingTransform(
		layerId: string,
		elementId: string,
		currentTransform: ElementTransform,
		groupWorldT: ElementTransform,
	): void {
		if (isIdentityTransform(groupWorldT)) return;
		const compensatingT = computeInverseCompositionTransform(groupWorldT);
		const newT = composeTransforms(compensatingT, currentTransform);
		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			{ transform: newT } as Partial<AnyArtObject>,
			this.getMutationOrigin(),
		);
	}

	private getEditingScopeWorldTransform(
		groupId: string,
	): ReturnType<typeof getTransform> {
		const ancestorT = this.ctx.spatial.getAncestorTransform(groupId);
		const group = this.ctx.store.document.objects[groupId];
		if (!group) return createIdentityTransform();
		const groupT = getTransform(group);
		return ancestorT ? composeTransforms(ancestorT, groupT) : groupT;
	}

	public updateElement(
		layerId: string,
		elementId: string,
		updates: Partial<AnyArtObject>,
	): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;

		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		// Save accurate text bounds BEFORE Yjs sync. The Yjs update handler
		// fires syncObjectsDelta → clearBoundsCache(id) synchronously, so
		// reading after yjsProvider.updateElement would always return null.
		const existingTextBounds =
			element.type === "text" ? this.ctx.spatial.getBounds(elementId) : null;

		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			updates,
			this.getMutationOrigin(),
		);

		// Text bounds: restore accurate async-computed bounds after sync chain
		if (element.type === "text") {
			const updatedElement = this.ctx.store.document.objects[elementId] as
				| TextElement
				| undefined;
			if (!updatedElement) return;

			const textUpdates = updates as Partial<TextElement>;
			const layoutAffected =
				textUpdates.content !== undefined ||
				textUpdates.defaultStyle !== undefined ||
				textUpdates.layout !== undefined;
			const positionAffected =
				textUpdates.x !== undefined || textUpdates.y !== undefined;

			if (layoutAffected) {
				if (existingTextBounds) {
					this.ctx.spatial.setBounds(elementId, existingTextBounds);
				}
			} else if (existingTextBounds) {
				// No layout change:
				// if position changed, move the cached bounds by the same delta.
				if (positionAffected) {
					const nextX = textUpdates.x ?? updatedElement.x;
					const nextY = textUpdates.y ?? updatedElement.y;
					const deltaX = nextX - updatedElement.x;
					const deltaY = nextY - updatedElement.y;
					this.ctx.spatial.setBounds(
						elementId,
						brandWorldBBox(translateBounds(existingTextBounds, deltaX, deltaY)),
					);
				} else {
					this.ctx.spatial.setBounds(elementId, existingTextBounds);
				}
			}
		}
	}

	public deleteElements(elementIds: string[]): void {
		if (this.cannotMutate()) return;

		elementIds = elementIds.filter((id) => !this.isElementLocked(id));
		if (elementIds.length === 0) return;

		const deleteSet = new Set(
			elementIds.filter((id) => this.ctx.store.document.objects[id]),
		);
		if (deleteSet.size === 0) return;

		const origin = this.getMutationOrigin();

		// Detach text bindings / flow links that reference deleted elements
		// (same origin so one undo restores both the deletion and the cleanup)
		this.cleanupTextReferencesForDelete(deleteSet, origin);

		// Find elements in layer.elementIds (top-level)
		const byLayer: Record<string, string[]> = {};
		for (const layer of this.ctx.store.document.layers) {
			const matched = layer.elementIds.filter((id) => deleteSet.has(id));
			if (matched.length > 0) byLayer[layer.id] = matched;
		}

		// Find elements inside group.childIds (nested)
		const foundInLayer = new Set(Object.values(byLayer).flat());
		const remaining = [...deleteSet].filter((id) => !foundInLayer.has(id));

		const byGroup: Record<string, string[]> = {};
		if (remaining.length > 0) {
			const remainSet = new Set(remaining);
			for (const obj of Object.values(this.ctx.store.document.objects)) {
				if (!obj || !isGroup(obj)) continue;
				const matched = obj.childIds.filter((id) => remainSet.has(id));
				if (matched.length > 0) {
					byGroup[obj.id] = matched;
					for (const id of matched) remainSet.delete(id);
				}
				if (remainSet.size === 0) break;
			}
		}

		if (Object.keys(byLayer).length === 0 && Object.keys(byGroup).length === 0)
			return;

		// Update parent groups' childIds before deleting objects
		for (const [groupId, ids] of Object.entries(byGroup)) {
			const group = this.ctx.store.document.objects[groupId] as Group;
			const idsToRemove = new Set(ids);
			const newChildIds = group.childIds.filter((id) => !idsToRemove.has(id));
			this.ctx.yjsProvider.updateElement(
				"",
				groupId,
				{ childIds: newChildIds } as Partial<AnyArtObject>,
				origin,
			);
		}

		// Delete objects from yDoc + remove from layer elementIds
		// yjsProvider.deleteElements deletes from yObjects for ALL ids,
		// and removes from layer.elementIds where found (no-op for group children)
		const currentLayerId = this.ctx.store.currentLayerId ?? "";
		const allByLayer = { ...byLayer };
		const groupChildIds = Object.values(byGroup).flat();
		if (groupChildIds.length > 0) {
			allByLayer[currentLayerId] ??= [];
			allByLayer[currentLayerId] = [
				...allByLayer[currentLayerId],
				...groupChildIds,
			];
		}

		this.ctx.yjsProvider.deleteElements(allByLayer, origin);
	}

	/**
	 * Reference cleanup before deleting elements:
	 * - Texts bound to a deleted axis path lose their binding (plain text)
	 * - Flow links pointing at deleted regions are spliced past them
	 * - A deleted head's content is promoted into the first surviving region
	 * Guide-ified axis paths keep their hidden appearance; unbinding does not
	 * restore them.
	 */
	private cleanupTextReferencesForDelete(
		deleteSet: Set<string>,
		origin: unknown,
	): void {
		const objects = this.ctx.store.document.objects;

		for (const obj of Object.values(objects)) {
			if (obj?.type !== "text" || deleteSet.has(obj.id)) continue;

			const updates: Partial<TextElement> = {};
			let dirty = false;

			if (obj.axisBinding && deleteSet.has(obj.axisBinding.pathObjectId)) {
				updates.axisBinding = undefined;
				dirty = true;
			}

			if (
				obj.flow?.nextTextElementId &&
				deleteSet.has(obj.flow.nextTextElementId)
			) {
				const next = this.firstSurvivingFlowTarget(
					obj.flow.nextTextElementId,
					deleteSet,
				);
				updates.flow = next ? { nextTextElementId: next } : undefined;
				dirty = true;
			}

			if (dirty) {
				this.ctx.yjsProvider.updateElement(
					"",
					obj.id,
					updates as Partial<AnyArtObject>,
					origin,
				);
			}
		}

		for (const id of deleteSet) {
			const obj = objects[id];
			if (obj?.type !== "text") continue;

			// Head promotion: only heads hold content in a flow chain
			const holdsContent = obj.content.paragraphs.some((p) =>
				p.runs.some((r) => r.text.length > 0),
			);
			if (holdsContent && obj.flow?.nextTextElementId) {
				const successorId = this.firstSurvivingFlowTarget(
					obj.flow.nextTextElementId,
					deleteSet,
				);
				const successor = successorId ? objects[successorId] : undefined;
				if (successor?.type === "text") {
					this.ctx.yjsProvider.updateElement(
						"",
						successor.id,
						{
							content: obj.content,
							defaultStyle: obj.defaultStyle,
						} as Partial<AnyArtObject>,
						origin,
					);
				}
			}
		}
	}

	/** Follow flow links past deleted regions to the first surviving target */
	private firstSurvivingFlowTarget(
		startId: string,
		deleteSet: Set<string>,
	): string | undefined {
		const objects = this.ctx.store.document.objects;
		let next: string | undefined = startId;
		const visited = new Set<string>();
		while (next && deleteSet.has(next) && !visited.has(next)) {
			visited.add(next);
			const target = objects[next];
			next =
				target?.type === "text" ? target.flow?.nextTextElementId : undefined;
		}
		return next && !deleteSet.has(next) ? next : undefined;
	}

	public toggleElementVisibility(layerId: string, elementId: string): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;

		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		const currentVisible = element.visible !== false;
		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			{
				visible: !currentVisible,
			},
			this.getMutationOrigin(),
		);
	}

	public toggleElementLock(layerId: string, elementId: string): void {
		if (this.cannotMutate()) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;
		this.ctx.yjsProvider.updateElement(
			layerId,
			elementId,
			{ locked: !element.locked },
			this.getMutationOrigin(),
		);
	}

	// --- Layer Operations ---

	public addLayer(layer: Layer): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addLayer(layer);
		this.ctx.store.currentLayerId = layer.id;
	}

	public deleteLayer(layerId: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteLayer(layerId);

		if (this.ctx.store.currentLayerId === layerId) {
			if (this.ctx.store.document.layers.length > 0) {
				this.ctx.store.currentLayerId = this.ctx.store.document.layers[0].id;
			} else {
				this.ctx.store.currentLayerId = null;
			}
		}
	}

	public reorderLayers(oldIndex: number, newIndex: number): void {
		if (this.cannotMutate()) return;
		const layerCount = this.ctx.store.document.layers.length;
		if (
			oldIndex < 0 ||
			newIndex < 0 ||
			oldIndex >= layerCount ||
			newIndex >= layerCount ||
			oldIndex === newIndex
		) {
			return;
		}
		this.ctx.yjsProvider.reorderLayers(oldIndex, newIndex);
	}

	public toggleLayerVisibility(layerId: string): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			visible: !layer.visible,
		});
	}

	public toggleLayerLock(layerId: string): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;
		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			locked: !layer.locked,
		});
	}

	public renameLayer(layerId: string, name: string): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, { name });
	}

	public updateLayer(layerId: string, updates: Partial<Layer>): void {
		if (this.cannotMutate()) return;
		const layer = this.ctx.store.document.layers.find(
			(item) => item.id === layerId,
		);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, updates);
	}

	public updateLayerBlendMode(layerId: string, blendMode: BlendMode): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			blendMode,
		});
	}

	public updateLayerOpacity(layerId: string, opacity: number): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;

		this.ctx.yjsProvider.updateLayerAttributes(layerId, {
			opacity,
		});
	}

	// --- Movement Operations ---

	public moveElementForward(elementId: string): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;
		const elementIndex = layer.elementIds.indexOf(elementId);
		if (elementIndex < 0 || elementIndex >= layer.elementIds.length - 1) return;
		if (this.isElementLocked(elementId)) return;

		this.reorderElements(layerId, elementIndex, elementIndex + 1);
	}

	public moveElementBackward(elementId: string): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return;
		const elementIndex = layer.elementIds.indexOf(elementId);
		if (elementIndex <= 0 || elementIndex >= layer.elementIds.length) return;
		if (this.isElementLocked(elementId)) return;

		this.reorderElements(layerId, elementIndex, elementIndex - 1);
	}

	public extractSourceFromCompoundPath(
		compoundPathId: string,
		elementId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(compoundPathId)) return;
		this.ctx.yjsProvider.extractSourceFromCompoundPath(
			compoundPathId,
			elementId,
			layerId,
			insertIndex,
		);
	}

	public reorderCompoundPathSource(
		compoundPathId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(compoundPathId)) return;
		this.ctx.yjsProvider.reorderCompoundPathSource(
			compoundPathId,
			fromIndex,
			toIndex,
		);
	}

	public extractChildFromGroup(
		groupId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		this.ctx.yjsProvider.extractChildFromGroup(
			groupId,
			childId,
			layerId,
			insertIndex,
		);
	}

	public reorderGroupChildren(
		groupId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		this.ctx.yjsProvider.reorderGroupChildren(groupId, fromIndex, toIndex);
	}

	/**
	 * Extract a source out of a blend into a layer. Extracting the spine is not
	 * supported here. When removing the source would leave the blend with fewer
	 * than 2 sources (its minimum), the whole blend is released instead.
	 */
	public extractChildFromBlend(
		blendId: string,
		childId: string,
		layerId: string,
		insertIndex?: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;
		if (childId === blend.spineSourceId) return;
		if (!blend.objectIds.includes(childId)) return;
		if (blend.objectIds.length - 1 < 2) {
			this.releaseBlend(blendId);
			return;
		}
		this.ctx.yjsProvider.extractChildFromBlend(
			blendId,
			childId,
			layerId,
			insertIndex,
		);
	}

	/** Reorder a blend's sources (its draw order). Spine/key positions unchanged. */
	public reorderBlendChildren(
		blendId: string,
		fromIndex: number,
		toIndex: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		this.ctx.yjsProvider.reorderBlendChildren(blendId, fromIndex, toIndex);
	}

	public reorderElements(
		layerId: string,
		oldIndex: number,
		newIndex: number,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.reorderElements(
			layerId,
			oldIndex,
			newIndex,
			this.getMutationOrigin(),
		);
	}

	public moveElementToLayer(
		sourceLayerId: string,
		elementIndex: number,
		targetLayerId: string,
		targetIndex?: number,
	): void {
		if (this.cannotMutate()) return;
		const sourceLayer = this.ctx.store.document.layers.find(
			(l) => l.id === sourceLayerId,
		);
		if (!sourceLayer) return;
		if (elementIndex < 0 || elementIndex >= sourceLayer.elementIds.length)
			return;

		const elementId = sourceLayer.elementIds[elementIndex];
		if (this.isElementLocked(elementId)) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		this.ctx.yjsProvider.moveElementToLayer(
			sourceLayerId,
			elementId,
			targetLayerId,
			targetIndex,
			this.getMutationOrigin(),
		);
	}

	// --- Group Operations ---

	public addSvgImport(result: SvgImportResult): string[] {
		if (this.cannotMutate()) return [];
		if (!this.ctx.store.currentLayerId || result.topLevelIds.length === 0)
			return [];
		this.ctx.yjsProvider.addSvgImport(
			this.ctx.store.currentLayerId,
			result.objects,
			result.files,
			result.topLevelIds,
			result.defs,
		);
		return result.topLevelIds;
	}

	public groupSelectedElements(elementIds: string[]): string | null {
		if (this.cannotMutate()) return null;
		elementIds = elementIds.filter((id) => !this.isElementLocked(id));

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);
		if (editingScopeId) {
			// Inside an editing scope, the selection lives in the parent group's
			// childIds (not in any layer's elementIds). Group within the parent,
			// keeping the children's stacking (z) order regardless of selection
			// order.
			const parentGroup = this.ctx.store.document.objects[editingScopeId];
			if (!parentGroup || !isGroup(parentGroup)) return null;

			const selectedWithIndex = elementIds
				.map((id) => ({ id, index: parentGroup.childIds.indexOf(id) }))
				.filter((item) => item.index !== -1);
			if (selectedWithIndex.length < 2) return null;

			selectedWithIndex.sort((a, b) => a.index - b.index);

			const groupId = this.ctx.yjsProvider.groupElementsInGroup(
				editingScopeId,
				selectedWithIndex.map((item) => item.id),
				this.getMutationOrigin(),
			);
			if (!groupId) return null;

			this.ctx.store.selectedElementIds = [groupId];
			return groupId;
		}

		const selectedSet = new Set(elementIds);
		const positionedSelection: Array<{
			id: string;
			layerId: string;
			layerIndex: number;
			elementIndex: number;
		}> = [];

		for (
			let layerIndex = 0;
			layerIndex < this.ctx.store.document.layers.length;
			layerIndex++
		) {
			const layer = this.ctx.store.document.layers[layerIndex];
			for (
				let elementIndex = 0;
				elementIndex < layer.elementIds.length;
				elementIndex++
			) {
				const id = layer.elementIds[elementIndex];
				if (!selectedSet.has(id)) continue;
				if (!this.ctx.store.document.objects[id]) continue;
				positionedSelection.push({
					id,
					layerId: layer.id,
					layerIndex,
					elementIndex,
				});
			}
		}

		if (positionedSelection.length < 2) return null;

		positionedSelection.sort((a, b) => {
			if (a.layerIndex !== b.layerIndex) {
				return a.layerIndex - b.layerIndex;
			}
			return a.elementIndex - b.elementIndex;
		});

		const topmost = positionedSelection.at(-1);
		if (!topmost) return null;

		const targetLayerId = topmost.layerId;
		const orderedIds = positionedSelection.map((item) => item.id);

		for (const item of positionedSelection) {
			if (item.layerId === targetLayerId) continue;

			this.ctx.yjsProvider.moveElementToLayer(
				item.layerId,
				item.id,
				targetLayerId,
				undefined,
				this.getMutationOrigin(),
			);
		}

		const groupId = this.ctx.yjsProvider.groupElements(
			targetLayerId,
			orderedIds,
			this.getMutationOrigin(),
		);
		if (!groupId) return null;

		this.ctx.store.currentLayerId = targetLayerId;
		this.ctx.store.selectedElementIds = [groupId];

		return groupId;
	}

	/**
	 * Replace a text element with a group containing outlined paths.
	 * Delegates the atomic Yjs mutation to YjsProvider.
	 */
	public outlineTextElement(
		layerId: string,
		textElementId: string,
		paths: Path[],
		group: Group,
	): void {
		if (this.cannotMutate() || this.isElementLocked(textElementId)) return;
		this.ctx.yjsProvider.outlineTextElement(
			layerId,
			textElementId,
			paths,
			group,
		);
	}

	public ungroupElements(groupId: string): void {
		if (this.cannotMutate() || this.isElementLocked(groupId)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		this.ctx.yjsProvider.ungroupElements(layerId, groupId);
	}

	// --- Compound Path Operations ---

	public createCompoundPathFromSelection(
		operation: BooleanOperation,
	): string | null {
		if (this.cannotMutate()) return null;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return null;

		const selectedPaths = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is Path => el !== undefined && isPath(el));

		if (selectedPaths.length < 2) {
			console.warn("Need at least 2 paths to create compound path");
			return null;
		}

		const sources = selectedPaths.map((p) => ({ id: p.id, op: operation }));
		const firstPath = selectedPaths[0];

		const compoundPathId = `compound-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const compoundPath: CompoundPath = {
			type: "compound-path",
			id: compoundPathId,
			sources,
			filters: firstPath.filters ? [...firstPath.filters] : [],
			opacity: firstPath.opacity,
			blendMode: firstPath.blendMode,
			transform: createIdentityTransform(),
		};

		this.ctx.yjsProvider.createCompoundPath(layerId, compoundPath);
		this.ctx.store.selectedElementIds = [compoundPathId];

		return compoundPathId;
	}

	// --- Blend Operations ---

	/**
	 * Create a blend from the selected paths / compound-paths (≥2; other types
	 * ignored). The sources are absorbed: removed from the layer with the blend
	 * taking the topmost source's position. Returns the new blend id, or null.
	 */
	public createBlendFromSelection(
		spacing: BlendSpacing = { type: "steps", count: 5 },
	): CreateBlendResult {
		if (this.cannotMutate()) return { ok: false, reason: "invalid" };

		const selectedSources = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter(
				(el): el is Path | CompoundPath =>
					el !== undefined && (isPath(el) || isCompoundPath(el)),
			);

		if (selectedSources.length < 2) {
			console.warn("Need at least 2 paths/compound-paths to create a blend");
			return { ok: false, reason: "invalid" };
		}

		// Every source must share one parent container: all top-level siblings of
		// the same layer, or all children of the same single group. Mixed parents
		// (different layers, different groups, or layer+group) are rejected —
		// absorbing/restoring across containers would be lossy and the renderer
		// would draw an unabsorbed source twice.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedSources.map((s) => s.id),
		);
		if (!owner.ok) return owner;

		// Normalize the source order to the parent container's stacking (z) order
		// so the blend paints keys/intermediates back-to-front matching the layer,
		// not the (spatial/marquee) selection order. Both the spine (built through
		// the key centers in order) and objectIds derive from this array, so they
		// stay in sync. Use reverseBlend to flip afterwards.
		const orderedSources = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedSources,
		);

		// Auto-create the default spine: a polyline through the key centers (in
		// order). The keys are its vertices, so the keys keep their positions and
		// the spine bends through them. It is absorbed (kept in document.objects,
		// not drawn directly) — an editable guide along which intermediates flow.
		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		const spinePath = buildBlendSpineThroughKeys(orderedSources, elementsMap);

		const blendId = generateUid("blend");
		const blend: BlendObject = {
			type: "blend",
			id: blendId,
			objectIds: orderedSources.map((s) => s.id),
			spacing,
			opacity: 1,
			blendMode: "normal",
			transform: createIdentityTransform(),
			spineSourceId: spinePath?.id,
		};

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			if (spinePath) this.ctx.yjsProvider.addObjectOnly(spinePath, origin);
			this.ctx.yjsProvider.createBlend(owner.parentId, blend);
		}, origin);
		this.ctx.store.selectedElementIds = [blendId];

		return { ok: true, blendId };
	}

	/**
	 * Lay the blend keys out along the spine by POSITION (no rotation — keys keep
	 * their authored orientation): key i is translated so its center sits at the
	 * spine point at equal arc-length i/(N-1). Baked into each key's own transform
	 * (stored == drawn) so the keys stay editable in place.
	 */
	private reflowBlendKeysOntoSpine(
		keys: AnyArtObject[],
		spineSource: Path,
		origin: unknown,
	): void {
		const placements = computeSpineKeyPlacements(spineSource, keys.length);
		if (!placements) return;

		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		keys.forEach((key, i) => {
			const local = calculateLocalElementBounds(key, elementsMap);
			const olx = (local.minX + local.maxX) / 2;
			const oly = (local.minY + local.maxY) / 2;
			const st = getTransform(key);
			const p = placements[i];
			this.ctx.yjsProvider.updateElement(
				"",
				key.id,
				{
					transform: { ...st, x: p.x - olx, y: p.y - oly },
				} as Partial<AnyArtObject>,
				origin,
			);
		});
	}

	/**
	 * Re-lay every blend's keys whose spine is `spineId`. Called after the spine
	 * path's geometry changes (e.g. edited in PathEditTool) so the keys live-follow
	 * the spine and re-distribute along it.
	 */
	public reflowBlendsForSpine(spineId: string): void {
		const spineSource = this.ctx.store.document.objects[spineId];
		if (!spineSource || !isPath(spineSource)) return;

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const obj of Object.values(this.ctx.store.document.objects)) {
				if (!isBlend(obj) || obj.spineSourceId !== spineId) continue;
				const keys = obj.objectIds
					.map((id) => this.ctx.store.document.objects[id])
					.filter((el): el is AnyArtObject => el !== undefined);
				this.reflowBlendKeysOntoSpine(keys, spineSource, origin);
			}
		}, origin);
	}

	/**
	 * If `pathId` is a key of any blend, reshape that blend's spine so it passes
	 * through the (moved) keys again — the spine = polyline through key centers.
	 * Called after a key's geometry changes (e.g. moved in PathEditTool) so the
	 * spine live-follows the key. Updates spine segments only (not via pathUpdate),
	 * so it does not re-trigger key reflow.
	 */
	public rebuildBlendSpineIfKey(pathId: string): void {
		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const obj of Object.values(this.ctx.store.document.objects)) {
				if (!isBlend(obj) || !obj.spineSourceId) continue;
				if (!obj.objectIds.includes(pathId)) continue;
				const keys = obj.objectIds
					.map((id) => this.ctx.store.document.objects[id])
					.filter((el): el is AnyArtObject => el !== undefined);
				if (keys.length < 2) continue;
				const spine = this.ctx.store.document.objects[obj.spineSourceId];
				if (!spine || !isPath(spine)) continue;
				// Move the spine's anchors onto the keys while keeping its cp1/cp2
				// handles so curves are preserved. Fall back to a straight polyline
				// only when the spine has fewer anchors than keys. blendKeyCenters are
				// WORLD coords, so bake the spine to world first and reset its
				// transform to identity — otherwise a spine with a non-identity
				// transform renders the reshaped segments offset by that transform.
				const centers = blendKeyCenters(keys, elementsMap);
				const worldSpine = toWorldPath(spine).segments;
				const segments =
					relocateSpineAnchorsToKeys(worldSpine, centers) ??
					polylineSpineSegments(centers);
				this.ctx.yjsProvider.updateElement(
					"",
					obj.spineSourceId,
					{
						segments,
						transform: createIdentityTransform(),
					} as Partial<AnyArtObject>,
					origin,
				);
			}
		}, origin);
	}

	public updateBlendSpacing(blendId: string, spacing: BlendSpacing): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.updateElement(layerId, blendId, { spacing } as Partial<BlendObject>);
	}

	public updateBlendTilt(blendId: string, tiltToSpine: boolean): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.updateElement(layerId, blendId, {
			tiltToSpine,
		} as Partial<BlendObject>);
	}

	/**
	 * Replace a blend's spine with the given path. The path is absorbed (removed
	 * from the layer) and kept in document.objects as the editable spine source.
	 */
	public replaceBlendSpine(blendId: string, spineSourceId: string): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;

		const spineSource = this.ctx.store.document.objects[spineSourceId];
		if (!spineSource || !isPath(spineSource)) return;

		const keys = blend.objectIds
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.replaceBlendSpine(layerId, blendId, spineSourceId);
			// Reflow the keys onto the new spine (stored == drawn).
			this.reflowBlendKeysOntoSpine(keys, spineSource, origin);
		}, origin);
	}

	/** Reverse the order of a blend's source objects. */
	public reverseBlend(blendId: string): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;
		this.updateElement(layerId, blendId, {
			objectIds: [...blend.objectIds].reverse(),
		} as Partial<BlendObject>);
	}

	/**
	 * Release a blend: remove the blend and restore its source paths into the
	 * layer at the blend's position.
	 */
	public releaseBlend(blendId: string): void {
		if (this.cannotMutate() || this.isElementLocked(blendId)) return;

		const blend = this.ctx.store.document.objects[blendId];
		if (!blend || !isBlend(blend)) return;

		this.ctx.yjsProvider.releaseBlend(blendId);
		this.ctx.store.selectedElementIds = blend.spineSourceId
			? [...blend.objectIds, blend.spineSourceId]
			: [...blend.objectIds];
	}

	// --- Repeat Operations ---

	/**
	 * Create a Repeat (Illustrator-style) from the current selection. Every
	 * selected element becomes a source, absorbed into the repeat (removed from
	 * the layer but kept in document.objects). Any element type may be a source.
	 * All sources must share one container. Returns the new repeat id, or null.
	 */
	public createRepeatFromSelection(mode: RepeatMode = "grid"): string | null {
		if (this.cannotMutate()) return null;

		const selectedSources = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		if (selectedSources.length < 1) return null;

		// One shared parent container, same rule as blend: absorbing across
		// different layers/groups would be lossy and double-draw an unabsorbed
		// source.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedSources.map((s) => s.id),
		);
		if (!owner.ok) return null;

		const orderedSources = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedSources,
		);

		const repeat = createRepeatObject(
			orderedSources.map((s) => s.id),
			{ mode },
		);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.createRepeat(owner.parentId, repeat);
		}, origin);
		this.ctx.store.selectedElementIds = [repeat.id];
		return repeat.id;
	}

	// --- Mesh Warp Operations ---

	/**
	 * Create a mesh warp container from the current selection. Every selected
	 * element becomes a child, absorbed into the container (removed from the
	 * layer but kept in document.objects). The initial cage is one quad
	 * covering the children's combined bounds. Returns the new mesh id, or null.
	 */
	public createMeshWarpFromSelection(): string | null {
		if (this.cannotMutate()) return null;

		const selectedChildren = this.ctx.store.selectedElementIds
			.filter((id) => !this.isElementLocked(id))
			.map((id) => this.ctx.store.document.objects[id])
			.filter((el): el is AnyArtObject => el !== undefined);

		if (selectedChildren.length < 1) return null;

		// One shared parent container, same rule as repeat/blend.
		const owner = resolveBlendSourceContainer(
			this.ctx.store.document,
			selectedChildren.map((s) => s.id),
		);
		if (!owner.ok) return null;

		const orderedChildren = orderSourcesByContainer(
			this.ctx.store.document,
			owner.parentId,
			selectedChildren,
		);

		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		);
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (const child of orderedChildren) {
			const bounds = calculateElementBounds(child, elementsMap);
			minX = Math.min(minX, bounds.minX);
			minY = Math.min(minY, bounds.minY);
			maxX = Math.max(maxX, bounds.maxX);
			maxY = Math.max(maxY, bounds.maxY);
		}
		if (!Number.isFinite(minX)) return null;
		// A zero-area cage would make the warp parametrization degenerate.
		if (maxX - minX < 1) maxX = minX + 1;
		if (maxY - minY < 1) maxY = minY + 1;

		const mesh = createMeshWarpObject(
			orderedChildren.map((s) => s.id),
			{ minX, minY, maxX, maxY },
		);

		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.createMeshWarp(owner.parentId, mesh);
		}, origin);
		this.ctx.store.selectedElementIds = [mesh.id];
		return mesh.id;
	}

	/**
	 * Release a mesh warp container: remove it and restore its children —
	 * untouched, since the warp is non-destructive — into the container at the
	 * mesh's position.
	 */
	public releaseMeshWarp(meshId: string): void {
		if (this.cannotMutate() || this.isElementLocked(meshId)) return;
		const mesh = this.ctx.store.document.objects[meshId];
		if (!mesh || !isMesh(mesh)) return;
		this.ctx.yjsProvider.releaseMeshWarp(meshId);
		this.ctx.store.selectedElementIds = [...mesh.childIds];
	}

	/**
	 * Release a repeat: remove it and restore its source elements into the
	 * container at the repeat's position.
	 */
	public releaseRepeat(repeatId: string): void {
		if (this.cannotMutate() || this.isElementLocked(repeatId)) return;
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.ctx.yjsProvider.releaseRepeat(repeatId);
		this.ctx.store.selectedElementIds = [...repeat.sourceIds];
	}

	public setRepeatMode(repeatId: string, mode: RepeatMode): void {
		if (mode === "mirror") {
			// A "complete mirror": put the axis on the source's edge (half its width
			// from the center, along the default vertical axis) so the reflected copy
			// is flush against the original and the two read as one symmetric object.
			const repeat = this.ctx.store.document.objects[repeatId];
			if (repeat && isRepeat(repeat)) {
				const union = calculateRepeatSourceUnion(
					repeat,
					new Map(Object.entries(this.ctx.store.document.objects)),
				);
				const offset = union ? union.width / 2 : repeat.mirror.offset;
				this.updateRepeatFields(repeatId, {
					mode,
					mirror: roundNumericFields({ ...repeat.mirror, offset }),
				});
				return;
			}
		}
		this.updateRepeatFields(repeatId, { mode });
	}

	public updateRepeatGrid(
		repeatId: string,
		grid: Partial<RepeatGridParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			grid: roundNumericFields({ ...repeat.grid, ...grid }),
		});
	}

	public updateRepeatRadial(
		repeatId: string,
		radial: Partial<RepeatRadialParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			radial: roundNumericFields({ ...repeat.radial, ...radial }),
		});
	}

	public updateRepeatMirror(
		repeatId: string,
		mirror: Partial<RepeatMirrorParams>,
	): void {
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateRepeatFields(repeatId, {
			mirror: roundNumericFields({ ...repeat.mirror, ...mirror }),
		});
	}

	private updateRepeatFields(
		repeatId: string,
		fields: Partial<RepeatObject>,
	): void {
		if (this.cannotMutate() || this.isElementLocked(repeatId)) return;
		const repeat = this.ctx.store.document.objects[repeatId];
		if (!repeat || !isRepeat(repeat)) return;
		this.updateElement("", repeatId, fields as Partial<AnyArtObject>);
	}

	// --- Clipping Path Operations ---

	private setClipPathForGroup(
		groupId: string,
		clipPathId: string | null,
	): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;

		this.ctx.yjsProvider.setClipPath(layerId, groupId, clipPathId);
	}

	public createClipGroupFromTopmost(): string | null {
		if (this.cannotMutate()) return null;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return null;

		const selectedIds = this.ctx.store.selectedElementIds.filter(
			(id) => !this.isElementLocked(id),
		);
		if (selectedIds.length < 2) {
			console.warn("Need at least 2 elements to create clip group");
			return null;
		}

		const editingScopeId = this.ctx.store.editingScopeStack.at(-1);

		if (editingScopeId) {
			// Inside an editing scope: use the group's childIds for index lookup
			const parentGroup = this.ctx.store.document.objects[editingScopeId];
			if (!parentGroup || !isGroup(parentGroup)) return null;

			const selectedWithIndex = selectedIds
				.map((id) => {
					const index = parentGroup.childIds.indexOf(id);
					return { id, index };
				})
				.filter((item) => item.index !== -1);

			if (selectedWithIndex.length < 2) return null;

			selectedWithIndex.sort((a, b) => a.index - b.index);

			const topmostId = selectedWithIndex[selectedWithIndex.length - 1].id;
			const otherIds = selectedWithIndex.slice(0, -1).map((item) => item.id);
			const orderedIds = [topmostId, ...otherIds];

			const groupId = this.ctx.yjsProvider.groupElementsInGroup(
				editingScopeId,
				orderedIds,
				this.getMutationOrigin(),
			);
			if (!groupId) return null;

			this.setClipPathForGroup(groupId, topmostId);
			this.ctx.store.selectedElementIds = [groupId];

			return groupId;
		}

		const layer = this.ctx.store.document.layers.find((l) => l.id === layerId);
		if (!layer) return null;

		const selectedWithIndex = selectedIds
			.map((id) => {
				const index = layer.elementIds.indexOf(id);
				return { id, index };
			})
			.filter((item) => item.index !== -1);

		if (selectedWithIndex.length < 2) return null;

		selectedWithIndex.sort((a, b) => a.index - b.index);

		const topmostId = selectedWithIndex[selectedWithIndex.length - 1].id;
		const otherIds = selectedWithIndex.slice(0, -1).map((item) => item.id);
		const orderedIds = [topmostId, ...otherIds];

		const groupId = this.ctx.yjsProvider.groupElements(
			layerId,
			orderedIds,
			this.getMutationOrigin(),
		);
		if (!groupId) return null;

		this.setClipPathForGroup(groupId, topmostId);
		this.ctx.store.selectedElementIds = [groupId];

		return groupId;
	}

	// --- Object Mask Operations ---

	/**
	 * Give an element an empty mask.
	 *
	 * Nothing disappears: the renderer skips a mask with no content, so an
	 * empty mask reads as "no mask yet" rather than "hide everything". Content
	 * is drawn into it through a mask-edit session.
	 *
	 * Does nothing when the element already has one.
	 */
	public addMaskToElement(elementId: string): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const element = this.ctx.store.document.objects[elementId];
		if (!element || element.mask) return;

		this.updateElementMask(elementId, { elementIds: [] });
	}

	/**
	 * Release an element's mask, promoting what was drawn into it.
	 *
	 * The content is not discarded: it lands beside the element it was masking,
	 * stacked directly above it in the same container. That also keeps it
	 * reachable — mask content belongs to no layer, so clearing the reference
	 * without rehoming it would strand the objects where nothing can select or
	 * delete them.
	 *
	 * Each root is re-parented from the element's local space into the
	 * container's, so it does not move: a shape that sat at the middle of the
	 * masked element is still at its middle afterwards.
	 */
	public removeMaskFromElement(elementId: string): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const document = this.ctx.store.document;
		const owner = document.objects[elementId];
		if (!owner?.mask) return;

		const containerId = findDirectContainerId(document, elementId);
		if (containerId == null) return;

		const roots = owner.mask.elementIds.filter((id) => document.objects[id]);
		const containerTransform =
			this.ctx.spatial.getAncestorTransform(elementId) ??
			createIdentityTransform();
		const ownerTransform = composeTransforms(
			containerTransform,
			getTransform(owner),
		);

		// Higher index renders later, so the roots go in just after the element
		// they were masking, keeping their own order among themselves.
		const siblingIds = containerChildIds(document, containerId);
		const insertAt = siblingIds.indexOf(elementId) + 1;
		const layer = document.layers.find((l) => l.id === containerId);
		const origin = this.getMutationOrigin();

		this.transact(() => {
			this.updateElementMask(elementId, null);

			roots.forEach((id, offset) => {
				const root = document.objects[id];
				if (!root) return;

				const promoted = {
					...root,
					transform: solveChildTransform(
						containerTransform,
						composeTransforms(ownerTransform, getTransform(root)),
					),
				};

				if (layer) {
					this.ctx.yjsProvider.addElement(
						layer.id,
						promoted,
						origin,
						insertAt + offset,
					);
					return;
				}
				this.ctx.yjsProvider.updateElement("", id, promoted, origin);
				// The object is already in the document and in no layer, so the
				// empty layer key leaves the group's childIds as the only edit.
				this.ctx.yjsProvider.addElementToGroup(
					"",
					containerId,
					id,
					origin,
					insertAt + offset,
				);
			});
		});
	}

	/** Turn an element's mask off without discarding what was drawn into it. */
	public setMaskEnabled(elementId: string, enabled: boolean): void {
		this.updateMaskFlag(elementId, { enabled });
	}

	/** Swap which side of the mask keeps the pixels. */
	public setMaskInverted(elementId: string, inverted: boolean): void {
		this.updateMaskFlag(elementId, { inverted });
	}

	private updateMaskFlag(
		elementId: string,
		patch: Partial<Pick<ObjectMask, "enabled" | "inverted">>,
	): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const mask = this.ctx.store.document.objects[elementId]?.mask;
		if (!mask) return;

		this.updateElementMask(elementId, { ...mask, ...patch });
	}

	/**
	 * Write a mask onto an element.
	 *
	 * The layer id is empty because a mask can be set on an element nested
	 * anywhere in the tree, and the update path does not consult it — the same
	 * reason `addEraseMask` passes nothing there.
	 */
	private updateElementMask(elementId: string, mask: ObjectMask | null): void {
		this.updateElement("", elementId, { mask });
	}

	// --- Styling Operations ---

	public updateSelectedElementsStrokeColor(
		strokeColor: StrokeColor | null,
	): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex((f) => f.processor === "stroke");

			if (strokeColor) {
				const strokeApp =
					strokeIdx >= 0 ? (filters[strokeIdx] as StrokeAppearance) : undefined;
				// Swapping the color must not reset everything else the user set
				// on this appearance. Reusing the uid also keeps the filter panel's
				// selection and the render caches keyed by it from resetting on
				// every color tweak.
				const newStroke: StrokeAppearance = {
					uid: strokeApp?.uid ?? generateUid("app"),
					processor: "stroke",
					opacity: strokeApp?.opacity ?? 1,
					blendMode: strokeApp?.blendMode ?? ("normal" as const),
					subFilters: strokeApp?.subFilters,
					paramData: {
						version: "1",
						params: {
							strokeColor,
							brushSettings: strokeApp?.paramData.params.brushSettings,
						},
					},
				};
				if (strokeIdx >= 0) {
					filters[strokeIdx] = newStroke;
				} else {
					filters.push(newStroke);
				}
			} else if (strokeIdx >= 0) {
				filters.splice(strokeIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	/** 選択中要素のfillを任意のFillColor（solid/linear/radial/free）で更新 */
	public updateSelectedElementsFill(fill: FillColor | null): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const fillIdx = filters.findIndex((f) => f.processor === "fill");

			if (fill) {
				const fillApp =
					fillIdx >= 0 ? (filters[fillIdx] as FillAppearance) : undefined;
				// @see updateSelectedElementsStrokeColor for why the existing
				// appearance's own settings are carried over.
				const newFill: FillAppearance = {
					uid: fillApp?.uid ?? generateUid("app"),
					processor: "fill",
					opacity: fillApp?.opacity ?? 1,
					blendMode: fillApp?.blendMode ?? ("normal" as const),
					subFilters: fillApp?.subFilters,
					paramData: { version: "1", params: { fill } },
				};
				if (fillIdx >= 0) {
					filters[fillIdx] = newFill;
				} else {
					filters.push(newFill);
				}
			} else if (fillIdx >= 0) {
				filters.splice(fillIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	/**
	 * Delete the gradient stop / mesh vertex the gradient tool currently has
	 * selected (via toolSettings) from the selected element's fill.
	 * Linear/radial gradients keep at least two stops (an offset-based
	 * gradient needs both ends); free gradients keep at least one stop; mesh
	 * gradients keep their four corner vertices. Returns true when a stop was
	 * removed.
	 */
	public deleteSelectedGradientStop(): boolean {
		if (this.cannotMutate()) return false;

		const elementId = this.ctx.store.selectedElementIds[0];
		const element = elementId
			? this.ctx.store.document.objects[elementId]
			: null;
		const fillApp = element?.filters?.find((f) => f.processor === "fill") as
			| FillAppearance
			| undefined;
		const fill = fillApp?.paramData.params.fill;
		if (!fill) return false;

		if (isLinearGradient(fill) || isRadialGradient(fill)) {
			const stopIndex = this.ctx.toolSettings?.gradientSelectedStopIndex;
			if (stopIndex == null || !fill.stops[stopIndex]) return false;
			if (fill.stops.length <= 2) return false;
			const updated = deepClone(fill);
			updated.stops = updated.stops.filter((_, i) => i !== stopIndex);
			this.updateSelectedElementsFill(updated);
			return true;
		}

		const stopId = this.ctx.toolSettings?.gradientSelectedStopId;
		if (stopId == null) return false;

		if (isMeshGradient(fill)) {
			if (!stopId.startsWith("mesh-vertex:")) return false;
			const vi = Number.parseInt(stopId.split(":")[1], 10);
			const vertex = fill.vertices[vi];
			if (Number.isNaN(vi) || vi < 4 || !vertex) return false;
			// A vertex the user colored in goes back to being derived rather than
			// away: it was part of the mesh before they gave it a color, and
			// removing it would leave the cut line it anchors half-attached.
			const demoted =
				vertex.colorMode === "explicit"
					? demoteMeshColorVertexToDerived<MeshGradientVertex>(
							fill.vertices,
							fill.faces,
							vi,
						)
					: null;
			if (demoted) {
				syncDerivedVertices(demoted, fill.faces);
				this.updateSelectedElementsFill({ ...fill, vertices: demoted });
				return true;
			}
			// Deleting a derived vertex deletes the whole split line it anchors;
			// deleteMeshVertex refuses anything that cannot go (corner-adjacent
			// by-products, lines through explicit vertices).
			const result = deleteMeshVertex<MeshGradientVertex>(
				fill.vertices,
				fill.faces,
				vi,
				4,
			);
			if (result.vertices.length === fill.vertices.length) return false;
			syncDerivedVertices(result.vertices, result.faces);
			this.updateSelectedElementsFill({
				...fill,
				vertices: result.vertices,
				faces: result.faces,
			});
			return true;
		}

		if (!isFreeGradient(fill)) return false;
		if (fill.stops.length <= 1) return false;

		const updated = deepClone(fill);
		updated.stops = updated.stops
			.filter((s) => s.id !== stopId)
			.map((s) => {
				if (!s.edgeCPs) return s;
				const { [stopId]: _, ...rest } = s.edgeCPs;
				return {
					...s,
					edgeCPs: Object.keys(rest).length > 0 ? rest : undefined,
				};
			});
		this.updateSelectedElementsFill(updated);
		return true;
	}

	public swapSelectedElementsColors(): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex((f) => f.processor === "stroke");
			const fillIdx = filters.findIndex((f) => f.processor === "fill");

			const strokeApp =
				strokeIdx >= 0 ? (filters[strokeIdx] as StrokeAppearance) : undefined;
			const fillApp =
				fillIdx >= 0 ? (filters[fillIdx] as FillAppearance) : undefined;

			const oldStrokeColor = strokeApp?.paramData.params.strokeColor ?? null;
			const oldFillColor = fillApp?.paramData.params.fill ?? null;

			// Stroke → Fill
			if (oldStrokeColor) {
				const newFillColor: FillColor =
					oldStrokeColor.type === "stroke-gradient"
						? oldStrokeColor.gradient
						: oldStrokeColor.type === "stroke-pattern"
							? oldStrokeColor.pattern
							: oldStrokeColor;
				const newFill: FillAppearance = {
					uid: fillApp?.uid ?? generateUid("app"),
					processor: "fill",
					opacity: fillApp?.opacity ?? 1,
					blendMode: fillApp?.blendMode ?? ("normal" as const),
					paramData: {
						version: "1",
						params: {
							fill: newFillColor,
						},
					},
				};
				if (fillIdx >= 0) {
					filters[fillIdx] = newFill;
				} else {
					filters.push(newFill);
				}
			} else if (fillIdx >= 0) {
				filters.splice(fillIdx, 1);
			}

			// Fill → Stroke (recalculate strokeIdx after possible splice)
			const newStrokeIdx = filters.findIndex((f) => f.processor === "stroke");
			if (oldFillColor) {
				const newStrokeColor: StrokeColor =
					oldFillColor.type === "linear"
						? {
								type: "stroke-gradient",
								gradient: oldFillColor,
								mode: "within",
							}
						: oldFillColor.type === "solid"
							? oldFillColor
							: oldFillColor.type === "mesh"
								? oldFillColor.vertices.length > 0
									? { type: "solid", color: oldFillColor.vertices[0].color }
									: {
											type: "solid",
											color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
										}
								: oldFillColor.type === "pattern"
									? {
											type: "stroke-pattern",
											pattern: oldFillColor,
											mode: "within",
										}
									: oldFillColor.stops.length > 0
										? { type: "solid", color: oldFillColor.stops[0].color }
										: {
												type: "solid",
												color: { type: "rgb", r: 0, g: 0, b: 0, a: 1 },
											};

				const newStroke: StrokeAppearance = {
					uid: strokeApp?.uid ?? generateUid("app"),
					processor: "stroke",
					opacity: strokeApp?.opacity ?? 1,
					blendMode: strokeApp?.blendMode ?? ("normal" as const),
					paramData: {
						version: "1",
						params: {
							strokeColor: newStrokeColor,
							brushSettings: strokeApp?.paramData.params.brushSettings,
						},
					},
				};
				if (newStrokeIdx >= 0) {
					filters[newStrokeIdx] = newStroke;
				} else {
					filters.push(newStroke);
				}
			} else if (newStrokeIdx >= 0) {
				filters.splice(newStrokeIdx, 1);
			}

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	public updateSelectedElementsFillColor(color: Color | null): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		this.updateSelectedElementsFill(color ? { type: "solid", color } : null);
	}

	public updateSelectedElementsBrushSettings(
		brushSettings: BrushSettings | undefined,
	): void {
		if (this.cannotMutate()) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId || this.ctx.store.selectedElementIds.length === 0) return;

		for (const elementId of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(elementId)) continue;
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			const filters = [...(element.filters ?? [])];
			const strokeIdx = filters.findIndex((f) => f.processor === "stroke");
			if (strokeIdx < 0) continue;

			const strokeApp = filters[strokeIdx] as StrokeAppearance;
			if (
				areBrushSettingsSemanticallyEqual(
					strokeApp.paramData.params.brushSettings,
					brushSettings,
				)
			) {
				continue;
			}
			filters[strokeIdx] = {
				...strokeApp,
				paramData: {
					...strokeApp.paramData,
					params: { ...strokeApp.paramData.params, brushSettings },
				},
			};

			this.ctx.yjsProvider.updateElement(
				layerId,
				elementId,
				{ filters },
				this.getMutationOrigin(),
			);
		}
	}

	// --- Filter Operations ---

	public addFilterToSelectedElement(filter: Filter): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;

		const newFilters = [...(element.filters ?? []), filter];
		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	public removeFilterFromSelectedElement(filterIndex: number): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;

		// The content appearance is structural (renders the element's own
		// content) and must not be deletable — it can only be toggled hidden.
		if (element.filters[filterIndex]?.processor === "content") return;

		const newFilters = element.filters.filter((_, i) => i !== filterIndex);
		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/**
	 * Update a filter at the given index.
	 * - Top-level Appearance properties (`enabled`, `opacity`, `blendMode`,
	 *   `applyToBackdrop`) are merged at the filter root.
	 * - Processor-specific parameters go through `updates.params`, merged into `paramData.params`.
	 */
	public updateFilterForSelectedElement(
		filterIndex: number,
		updates: Partial<
			Pick<Filter, "enabled" | "opacity" | "blendMode" | "applyToBackdrop">
		> & {
			/** Processor-specific params, merged into paramData.params. */
			params?: Record<string, unknown>;
		},
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;

		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const { params, ...topUpdates } = updates;

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			if (!params) return { ...filter, ...topUpdates };

			const currentParams = filter.paramData.params;
			return {
				...filter,
				...topUpdates,
				paramData: {
					...filter.paramData,
					params: {
						...(typeof currentParams === "object" && currentParams !== null
							? currentParams
							: {}),
						...params,
					},
				},
			};
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/** Add a sub-filter to an appearance (fill/stroke) at the given filter index */
	public addSubFilterToAppearance(
		filterIndex: number,
		subFilter: Filter,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const target = element.filters[filterIndex];
		if (target.processor !== "fill" && target.processor !== "stroke") return;

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			return {
				...filter,
				subFilters: [...(filter.subFilters ?? []), subFilter],
			} as Filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/** Remove a sub-filter from an appearance at the given filter/sub-filter indices */
	public removeSubFilterFromAppearance(
		filterIndex: number,
		subFilterIndex: number,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const target = element.filters[filterIndex];
		if (!target.subFilters) return;

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.filter((_, si) => si !== subFilterIndex),
			} as Filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/** Update top-level fields (e.g. enabled) of a sub-filter within an appearance */
	public updateSubFilterForAppearance(
		filterIndex: number,
		subFilterIndex: number,
		updates: Partial<{ enabled: boolean }>,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const target = element.filters[filterIndex];
		if (!target.subFilters) return;

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.map((sub, si) =>
					si === subFilterIndex ? { ...sub, ...updates } : sub,
				),
			} as Filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/** Update paramData.params of a sub-filter within an appearance */
	public updateSubFilterParamsForAppearance(
		filterIndex: number,
		subFilterIndex: number,
		paramUpdates: Record<string, unknown>,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const target = element.filters[filterIndex];
		if (!target.subFilters) return;

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			return {
				...filter,
				subFilters: filter.subFilters?.map((sub, si) => {
					if (si !== subFilterIndex) return sub;
					const existing = sub as {
						paramData?: { version: string; params: Record<string, unknown> };
					};
					if (!existing.paramData) return sub;
					return {
						...sub,
						paramData: {
							...existing.paramData,
							params: { ...existing.paramData.params, ...paramUpdates },
						},
					};
				}),
			} as Filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	/** Reorder a filter within the selected element's filters array */
	public reorderFilter(fromIndex: number, toIndex: number): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (fromIndex === toIndex) return;
		if (
			fromIndex < 0 ||
			fromIndex >= element.filters.length ||
			toIndex < 0 ||
			toIndex >= element.filters.length
		)
			return;

		const newFilters = [...element.filters];
		const [moved] = newFilters.splice(fromIndex, 1);
		newFilters.splice(toIndex, 0, moved);

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	public reorderSubFilter(
		filterIndex: number,
		fromSubIndex: number,
		toSubIndex: number,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (fromSubIndex === toSubIndex) return;
		if (filterIndex < 0 || filterIndex >= element.filters.length) return;

		const target = element.filters[filterIndex];
		if (!target.subFilters) return;
		if (
			fromSubIndex < 0 ||
			fromSubIndex >= target.subFilters.length ||
			toSubIndex < 0 ||
			toSubIndex >= target.subFilters.length
		)
			return;

		const newSubFilters = [...target.subFilters];
		const [moved] = newSubFilters.splice(fromSubIndex, 1);
		newSubFilters.splice(toSubIndex, 0, moved);

		const newFilters = element.filters.map((filter, i) => {
			if (i !== filterIndex) return filter;
			return { ...filter, subFilters: newSubFilters } as Filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	public moveSubFilter(
		fromFilterIndex: number,
		subFilterIndex: number,
		toFilterIndex: number,
	): void {
		if (this.cannotMutate()) return;
		const element = this.getSelectedElement();
		if (!element?.filters || !this.ctx.store.currentLayerId) return;
		if (this.isElementLocked(element.id)) return;
		if (fromFilterIndex === toFilterIndex) return;
		if (
			fromFilterIndex < 0 ||
			fromFilterIndex >= element.filters.length ||
			toFilterIndex < 0 ||
			toFilterIndex >= element.filters.length
		)
			return;

		const source = element.filters[fromFilterIndex];
		const target = element.filters[toFilterIndex];
		if (!source.subFilters) return;
		if (
			target.processor !== "fill" &&
			target.processor !== "stroke" &&
			target.processor !== "content"
		)
			return;
		if (subFilterIndex < 0 || subFilterIndex >= source.subFilters.length)
			return;

		const moved = source.subFilters[subFilterIndex];

		const newFilters = element.filters.map((filter, i) => {
			if (i === fromFilterIndex) {
				return {
					...filter,
					subFilters: filter.subFilters?.filter(
						(_, si) => si !== subFilterIndex,
					),
				} as Filter;
			}
			if (i === toFilterIndex) {
				return {
					...filter,
					subFilters: [...(filter.subFilters ?? []), moved],
				} as Filter;
			}
			return filter;
		});

		this.updateElement(this.ctx.store.currentLayerId, element.id, {
			filters: newFilters,
		});
	}

	// --- Artboard Operations ---

	public addArtboard(artboard: Artboard): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addArtboard(artboard);
	}

	public updateArtboard(id: string, updates: Partial<Artboard>): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.updateArtboard(id, updates);
	}

	public batchUpdateElements(
		elementUpdates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
	): void {
		if (this.cannotMutate()) return;
		elementUpdates = elementUpdates.filter(
			(u) => !this.isElementLocked(u.elementId),
		);
		if (elementUpdates.length === 0) return;
		this.ctx.yjsProvider.batchUpdateElements(
			elementUpdates,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Rotate a single element by angleDeg degrees.
	 * Rotate a single element around (cx, cy).
	 *
	 * For non-group elements, only updates the rotation angle — position
	 * stays unchanged because applyTransformToBounds already rotates
	 * geometry around the raw-bounds center.
	 *
	 * For group elements, rotates each child individually because the GPU
	 * transform composition (composeTransforms) doesn't correctly handle
	 * rotation with differing origins.
	 */
	public rotateElement(
		layerId: string,
		elementId: string,
		angleDeg: number,
		cx: number,
		cy: number,
	): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;

		const element = this.ctx.store.document.objects[elementId];
		if (!element) return;

		if (isGroup(element)) {
			this.rotateElements(element.childIds, angleDeg, cx, cy);
			return;
		}

		const angleRad = (angleDeg * Math.PI) / 180;
		const t = getTransform(element);

		this.updateElement(layerId, elementId, {
			transform: { ...t, rotation: t.rotation + angleRad },
		});
	}

	/**
	 * Rotate multiple elements by angleDeg degrees around center (cx, cy).
	 *
	 * Each element's *visual center* (localBoundsCenter + transform.x/y) is
	 * rotated around (cx, cy), then transform.x/y is back-calculated so
	 * the visual center lands at the rotated position.
	 *
	 * Group elements are handled by recursively rotating their children
	 * instead of modifying the group's own transform.
	 */
	public rotateElements(
		elementIds: string[],
		angleDeg: number,
		cx: number,
		cy: number,
	): void {
		if (this.cannotMutate()) return;

		const angleRad = (angleDeg * Math.PI) / 180;
		const cos = Math.cos(angleRad);
		const sin = Math.sin(angleRad);

		const elementsMap = new Map(
			Object.entries(this.ctx.store.document.objects),
		) as ReadonlyMap<string, AnyArtObject>;

		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];

		this.collectRotateUpdates(
			elementIds,
			angleRad,
			cos,
			sin,
			cx,
			cy,
			elementsMap,
			updates,
		);

		this.batchUpdateElements(updates);
	}

	/** Recursively collect rotation updates, expanding groups into children. */
	private collectRotateUpdates(
		elementIds: string[],
		angleRad: number,
		cos: number,
		sin: number,
		cx: number,
		cy: number,
		elementsMap: ReadonlyMap<string, AnyArtObject>,
		updates: Array<{ elementId: string; updates: Partial<AnyArtObject> }>,
	): void {
		for (const elementId of elementIds) {
			const element = this.ctx.store.document.objects[elementId];
			if (!element) continue;

			if (isGroup(element)) {
				// Recurse into children
				this.collectRotateUpdates(
					element.childIds,
					angleRad,
					cos,
					sin,
					cx,
					cy,
					elementsMap,
					updates,
				);
				continue;
			}

			const t = getTransform(element);
			const localBounds = calculateLocalElementBounds(element, elementsMap);
			const localCx = (localBounds.minX + localBounds.maxX) / 2;
			const localCy = (localBounds.minY + localBounds.maxY) / 2;

			const ancestorT = this.ctx.spatial.getAncestorTransform(elementId);

			let newTx: number;
			let newTy: number;

			if (ancestorT) {
				// Element is inside a transformed group — pivot (cx, cy) is in
				// world space but the child translation is in parent-local space.
				// Convert the visual centre to world through the composed ancestor
				// transform, rotate around the pivot, then solve back for the new
				// child-local translation. Using the shared compose/solve helpers
				// keeps this consistent with the renderer's composition (incl. skew).
				const composedT = composeTransforms(ancestorT, t);
				const worldVcx = localCx + composedT.x;
				const worldVcy = localCy + composedT.y;

				// Rotate around world-space pivot
				const dwx = worldVcx - cx;
				const dwy = worldVcy - cy;
				const newWorldVcx = cx + dwx * cos - dwy * sin;
				const newWorldVcy = cy + dwx * sin + dwy * cos;

				const newChildT = solveChildTransform(ancestorT, {
					...composedT,
					x: newWorldVcx - localCx,
					y: newWorldVcy - localCy,
				});
				newTx = newChildT.x;
				newTy = newChildT.y;
			} else {
				// No ancestor transform — parent-local = world space
				const vcx = localCx + t.x;
				const vcy = localCy + t.y;
				const newVcx = cx + (vcx - cx) * cos - (vcy - cy) * sin;
				const newVcy = cy + (vcx - cx) * sin + (vcy - cy) * cos;
				newTx = newVcx - localCx;
				newTy = newVcy - localCy;
			}

			updates.push({
				elementId,
				updates: {
					transform: {
						...t,
						x: newTx,
						y: newTy,
						rotation: t.rotation + angleRad,
					},
				} as Partial<AnyArtObject>,
			});
		}
	}

	/**
	 * Compute per-element updates that destructively bake a perspective warp —
	 * the homography mapping the four `sourceCorners` onto the four dragged
	 * `corners` (both TL, TR, BR, BL in world space) — into element geometry
	 * (vertex editing, mirroring MeshDeformTool's commit): paths get their
	 * segments re-projected with adaptive subdivision and the stored transform
	 * re-resolved; images get warped corner vertices; meshes get warped
	 * vertices. Groups expand to leaves and compound paths to their source
	 * paths. Text is skipped — the tool outlines it into paths first. Returned
	 * WITHOUT committing so a tool can preview then commit on release.
	 */
	public computePerspectiveWarpUpdates(
		elementIds: string[],
		corners: [Vec2, Vec2, Vec2, Vec2],
		sourceCorners: [Vec2, Vec2, Vec2, Vec2],
	): Array<{ elementId: string; updates: Partial<AnyArtObject> }> {
		if (this.cannotMutate()) return [];

		const toPoints = (quad: [Vec2, Vec2, Vec2, Vec2]) =>
			quad.map(([x, y]) => ({ x, y })) as [Point, Point, Point, Point];
		const H = solveHomography(toPoints(sourceCorners), toPoints(corners));
		if (!H) return [];
		const worldDeform = (x: number, y: number) => projectViaH(x, y, H);

		const getElement = (id: string): AnyArtObject | null =>
			this.ctx.store.document.objects[id] ?? null;

		// Expand groups to leaves, then compound paths to their source paths.
		const leafIds: string[] = [];
		for (const id of flattenElementIds(elementIds, getElement)) {
			const el = getElement(id);
			if (el && isCompoundPath(el)) {
				for (const { id: sourceId } of el.sources) leafIds.push(sourceId);
			} else {
				leafIds.push(id);
			}
		}

		const updates: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}> = [];

		for (const elementId of leafIds) {
			const element = getElement(elementId);
			if (!element || this.isElementLocked(elementId)) continue;
			if (!isDeformableElement(element) || element.type === "text") continue;

			const ancestorTransform =
				this.ctx.spatial.getAncestorTransform(elementId);
			const frame: DeformFrame = {
				ancestorTransform,
				composedTransform: ancestorTransform
					? composeTransforms(ancestorTransform, element.transform)
					: element.transform,
				// For images the deform frame is the x/y/width/height rectangle —
				// the renderer's transform origin — not the corners' AABB.
				localBounds:
					element.type === "image"
						? brandLocalBBox({
								minX: element.x - element.width / 2,
								minY: element.y - element.height / 2,
								maxX: element.x + element.width / 2,
								maxY: element.y + element.height / 2,
								width: element.width,
								height: element.height,
							})
						: calculateLocalElementBounds(element),
			};
			const deformPoint = createLocalPointDeformer(frame, worldDeform);

			if (element.type === "path") {
				// Project through the homography with control-point re-fitting:
				// straight edges bend smoothly under perspective while the anchor
				// count stays put (a rectangle bakes as its original 4 segments) —
				// splits happen only when a single cubic cannot hold the tolerance.
				const segments = fitSegmentsWithProjection(
					element.segments,
					(x, y) => deformPoint({ x, y }),
					projectionErrorThreshold(frame.localBounds),
				);
				const newLocalBounds = calculateLocalElementBounds({
					...element,
					segments,
				});
				const filters = deformGradientFilters(
					element,
					deformPoint,
					frame.localBounds,
					newLocalBounds,
					{ x: 0, y: 0 },
				);
				updates.push({
					elementId,
					updates: {
						segments,
						transform: resolveStoredTransform(frame, newLocalBounds, {
							x: 0,
							y: 0,
						}),
						...(filters ? { filters } : {}),
					} as Partial<AnyArtObject>,
				});
			} else if (element.type === "image") {
				// Bake into the corner vertices: warp the current effective corners
				// (re-warping composes on the previous corners, no filter stacking).
				const current: Array<{ x: number; y: number }> =
					element.corners?.map(([x, y]) => ({ x, y })) ??
					cornersFromBounds(frame.localBounds);
				const newCorners = current.map((p) => {
					const d = deformPoint(p);
					return [d.x, d.y];
				}) as [Vec2, Vec2, Vec2, Vec2];
				updates.push({
					elementId,
					updates: { corners: newCorners } as Partial<AnyArtObject>,
				});
			} else if (element.type === "mesh") {
				// Warp cage vertices + handles only; `src` must stay untouched so
				// the source parametrization (and therefore the children's warp)
				// follows the moved cage. Twin of MeshDeformTool's mesh branch.
				const vertices = element.vertices.map((vertex) => {
					const point = deformPoint(vertex);
					const handles: Record<number, { x: number; y: number }> = {};
					for (const [key, handle] of Object.entries(vertex.handles)) {
						handles[Number(key)] = deformPoint(handle);
					}
					return { ...vertex, ...point, handles };
				});
				const newLocalBounds = brandLocalBBox(
					calculateMeshCoordinateBounds(vertices),
				);
				const filters = deformGradientFilters(
					element,
					deformPoint,
					frame.localBounds,
					newLocalBounds,
					{ x: 0, y: 0 },
				);
				updates.push({
					elementId,
					updates: {
						vertices,
						transform: resolveStoredTransform(frame, newLocalBounds, {
							x: 0,
							y: 0,
						}),
						...(filters ? { filters } : {}),
					} as Partial<AnyArtObject>,
				});
			}
		}

		return updates;
	}

	public commitArtboardMove(
		artboardId: string,
		artboardUpdates: Partial<Artboard>,
		elementMoves: Array<{
			elementId: string;
			updates: Partial<AnyArtObject>;
		}>,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.commitArtboardMove(
			artboardId,
			artboardUpdates,
			elementMoves,
		);
	}

	public deleteArtboard(id: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteArtboard(id);

		if (this.ctx.store.selectedArtboardId === id) {
			this.ctx.store.selectedArtboardId = null;
			setArtboardSelectionOverlay(this.ctx.store.uiOverlayState, null);
		}
	}

	// --- Document Settings ---

	public setHdr(hdr: Partial<HdrSettings>): void {
		if (this.cannotMutate()) return;
		const current = this.ctx.store.document.hdr ?? {
			enabled: false,
			exposure: 0,
		};
		this.ctx.yjsProvider.setHdr({ ...current, ...hdr });
	}

	public setColorProfile(colorProfile: Partial<ColorProfileSettings>): void {
		if (this.cannotMutate()) return;
		const current: ColorProfileSettings = this.ctx.store.document
			.colorProfile ?? { workingSpace: "display-p3" };
		this.ctx.yjsProvider.setColorProfile({ ...current, ...colorProfile });
	}

	public setRasterizationDpi(dpi: number): void {
		if (this.cannotMutate()) return;
		if (!Number.isFinite(dpi) || dpi <= 0) return;
		this.ctx.yjsProvider.setRasterizationDpi(dpi);
	}

	// --- Defs (off-canvas ArtObject definitions) ---
	//
	// Thin wrappers over YjsProvider's def CRUD. Member element CRUD continues
	// to go through addObjectOnly / updateElement / deleteElements — defs only
	// own the rootElementIds list and the def metadata.

	public createDef(entry: DefEntry): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.createDef(entry, this.getMutationOrigin());
	}

	public deleteDef(defId: string): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.deleteDef(defId, this.getMutationOrigin());
	}

	public updateDefMeta(
		defId: string,
		patch: Partial<Pick<DefEntry, "name" | "tile" | "kind">>,
	): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.updateDefMeta(defId, patch, this.getMutationOrigin());
	}

	public replaceDefElements(defId: string, newRootElementIds: string[]): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.replaceDefElements(
			defId,
			newRootElementIds,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Snapshot the current selection as a fresh pattern def and return the new
	 * def id. The resulting DefEntry carries a tile sized to the selection
	 * bbox. See `snapshotSelectionAsDef` for the shared cloning semantics.
	 */
	public createPatternDefFromSelection(name?: string): string | null {
		return this.snapshotSelectionAsDef("pattern", name);
	}

	/**
	 * Snapshot the current selection as a fresh vector-brush def and return
	 * the new def id. Unlike pattern defs, no tile rectangle is recorded —
	 * the brush rasterizer samples the tight bbox of the def's root elements.
	 * See `snapshotSelectionAsDef` for the shared cloning semantics.
	 */
	public createVectorBrushDefFromSelection(name?: string): string | null {
		return this.snapshotSelectionAsDef("vector-brush", name);
	}

	/**
	 * Shared body for `create*DefFromSelection`. The selected (top-level)
	 * elements + their descendants are deeply cloned with re-minted ids,
	 * translated so the selection bbox is centered on the def-local origin,
	 * added to `document.objects` (without a layer reference, mirroring
	 * `BlendObject.spineSourceId`), and finally a new DefEntry of the given
	 * kind is created with the cloned root ids. A tile sized to the selection
	 * bbox is recorded only for `"pattern"` defs.
	 *
	 * Returns null when the selection is empty, contains only unresolvable
	 * ids, or the bbox has zero area.
	 */
	private snapshotSelectionAsDef(kind: DefKind, name?: string): string | null {
		if (this.cannotMutate()) return null;
		const selectedIds = this.ctx.store.selectedElementIds;
		if (selectedIds.length === 0) return null;
		const objects = this.ctx.store.document.objects;
		const topLevel: AnyArtObject[] = [];
		for (const id of selectedIds) {
			const obj = objects[id];
			if (obj) topLevel.push(obj);
		}
		if (topLevel.length === 0) return null;

		// Collect descendants reachable through container references so the
		// def clone is self-contained. Pulled inline here (rather than reusing
		// pasteElements' helper) to keep the snapshot atomic.
		const allIds = new Set<string>();
		const stack: string[] = topLevel.map((e) => e.id);
		while (stack.length > 0) {
			const id = stack.pop()!;
			if (allIds.has(id)) continue;
			allIds.add(id);
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
				case "repeat":
					for (const cid of obj.sourceIds) stack.push(cid);
					break;
				case "compound-path":
					for (const s of obj.sources) stack.push(s.id);
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
					neverReached(obj, "unhandled element type in def snapshot walk");
			}
		}
		const sourceElements: AnyArtObject[] = [];
		for (const id of allIds) {
			const obj = objects[id];
			if (obj) sourceElements.push(obj);
		}

		// Compute the world-space bbox of the top-level selection. Descendants
		// transform through their parents so we only need the visible top-level
		// bounds for the tile rectangle.
		const elementsMap = new Map(sourceElements.map((e) => [e.id, e]));
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const el of topLevel) {
			const b = calculateElementBounds(el, elementsMap);
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}
		if (
			!Number.isFinite(minX) ||
			!Number.isFinite(maxX) ||
			maxX - minX <= 0 ||
			maxY - minY <= 0
		) {
			return null;
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const tileWidth = maxX - minX;
		const tileHeight = maxY - minY;

		// Clone + remap. Only translate the top-level elements so children
		// (whose coordinates are relative to their parents) stay intact.
		const { cloned, idMap } = cloneElementsWithIdRemap(sourceElements);
		const topLevelOldIds = new Set(topLevel.map((e) => e.id));
		for (const c of cloned) {
			const isTopLevel = [...idMap.entries()].some(
				([oldId, newId]) => newId === c.id && topLevelOldIds.has(oldId),
			);
			if (!isTopLevel) continue;
			c.transform = {
				...c.transform,
				x: c.transform.x - cx,
				y: c.transform.y - cy,
			};
		}

		const rootElementIds = topLevel
			.map((e) => idMap.get(e.id))
			.filter((id): id is string => typeof id === "string");

		const defId = generateUid("def");
		const origin = this.getMutationOrigin();
		this.ctx.yjsProvider.transact(() => {
			for (const c of cloned) {
				this.ctx.yjsProvider.addObjectOnly(c, origin);
			}
			const entry: DefEntry = {
				id: defId,
				kind,
				name,
				rootElementIds,
			};
			if (kind === "pattern") {
				entry.tile = { width: tileWidth, height: tileHeight };
			}
			this.ctx.yjsProvider.createDef(entry, origin);
		}, origin);

		return defId;
	}

	// --- File Operations ---

	public addEmbeddedFile(file: EmbeddedFile): string {
		if (this.cannotMutate()) return "";
		return this.ctx.yjsProvider.addFile(file);
	}

	// --- Brush Preset Operations ---

	public addBrushPreset(preset: BrushPreset): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addBrushPreset(preset);
	}

	/**
	 * Ensure built-in brush files exist in the document.
	 * Called during project initialization.
	 */
	public async ensureBuiltinBrushes(): Promise<void> {
		if (this.cannotMutate()) return;
		const builtinTextureIds = Object.values(BUILTIN_BRUSH_IDS).filter(
			(id) => id !== BUILTIN_BRUSH_IDS.svg,
		);
		const hasAllFiles = builtinTextureIds.every((id) =>
			this.ctx.store.document.files.some((file) => file.uid === id),
		);

		if (hasAllFiles) return;

		const files = await createBuiltinBrushFiles();
		for (const file of files) {
			this.ctx.yjsProvider.addFile(file);
		}
	}

	// --- Clipboard Operations ---

	/**
	 * Copy selected elements to system clipboard (PNG + PAPLICO_ELEMENTS_MIME).
	 */
	public async copySelectedToClipboard(): Promise<void> {
		const { elementIds, artObjects } = this.collectSelectedElements();
		if (elementIds.length === 0) return;
		await this.writeToSystemClipboard(elementIds, artObjects);
	}

	/**
	 * Cut selected elements: copy to system clipboard then delete.
	 * Axis paths bound only by cut texts go with them (they are invisible
	 * guides; the clipboard payload carries them for self-contained paste).
	 * Cutting a flow chain's trailing members takes their flowed-in text
	 * along (see materializeFlowCut).
	 */
	public async cutSelectedToClipboard(): Promise<void> {
		if (this.cannotMutate()) return;
		const { elementIds, artObjects } = this.collectSelectedElements();
		if (elementIds.length === 0) return;
		const truncations = await this.materializeFlowCut(elementIds, artObjects);
		await this.writeToSystemClipboard(elementIds, artObjects);
		// Use the ids captured before the clipboard await — the live selection
		// could change during it
		for (const { headId, content } of truncations) {
			this.ctx.yjsProvider.updateElement(
				"",
				headId,
				{ content } as Partial<AnyArtObject>,
				this.getMutationOrigin(),
			);
		}
		this.deleteElements([
			...elementIds,
			...this.collectExclusiveAxisPathIds(new Set(elementIds)),
		]);
	}

	/**
	 * Flow-aware cut: when a chain's trailing members are cut, the text that
	 * flowed into them leaves with them — the head's content is truncated at
	 * the first cut member's flowed range and the removed portion is
	 * materialized into that member's clipboard clone (with the head's
	 * defaultStyle), so pasting it reproduces the visible text. Cutting only
	 * middle members changes nothing here: content stays on the head and
	 * deletion splices the flow to the next surviving region.
	 */
	private async materializeFlowCut(
		cutIds: string[],
		clones: AnyArtObject[],
	): Promise<Array<{ headId: string; content: TextContent }>> {
		const textRenderer = this.ctx.getTextRenderer?.();
		if (!textRenderer) return [];
		const objects = this.ctx.store.document.objects;
		const cutSet = new Set(cutIds);
		const handledHeads = new Set<string>();
		const truncations: Array<{ headId: string; content: TextContent }> = [];

		for (const id of cutIds) {
			const obj = objects[id];
			if (obj?.type !== "text") continue;
			const chain = textRenderer.getFlowChainMembers(obj);
			if (!chain || chain.length <= 1) continue;
			const headId = chain[0].id;
			// A cut head is handled by the existing head-promotion rules
			if (cutSet.has(headId) || handledHeads.has(headId)) continue;

			// Earliest member whose entire downstream suffix is being cut
			let trailingStart = -1;
			for (let i = chain.length - 1; i >= 1; i--) {
				if (!cutSet.has(chain[i].id)) break;
				trailingStart = i;
			}
			if (trailingStart === -1) continue;
			handledHeads.add(headId);

			const member = chain[trailingStart];
			const start = await textRenderer.getFlowedRangeStart(member);
			if (start === null) continue;
			const head = objects[headId];
			if (head?.type !== "text") continue;

			const { before, after } = splitTextContentAt(head.content, start);
			const clone = clones.find((c) => c.id === member.id);
			if (clone?.type === "text") {
				clone.content = after;
				clone.defaultStyle = { ...head.defaultStyle };
			}
			truncations.push({ headId, content: before });
		}
		return truncations;
	}

	/**
	 * Duplicate selected elements in place with a small offset.
	 * Returns IDs of the newly created elements.
	 */
	public duplicateElements(): string[] {
		const { artObjects } = this.collectSelectedElements();
		if (artObjects.length === 0) return [];
		return this.pasteElements(artObjects);
	}

	/**
	 * Duplicate the given elements (and their absorbed container children) with a
	 * direct offset. Shared by the alt-drag gesture (via ToolContext) so it goes
	 * through the same clone / id-numbering / container-remap path as copy-paste.
	 */
	public duplicateElementsByIds(
		elementIds: string[],
		offset: { x: number; y: number } = { x: 0, y: 0 },
	): string[] {
		const { artObjects } = this.collectElementsByIds(elementIds);
		if (artObjects.length === 0) return [];
		return this.pasteElements(artObjects, { offset });
	}

	/**
	 * Read system clipboard and paste whichever supported format is found.
	 * Priority: PAPLICO elements → SVG → raster image → plain text.
	 */
	public async pasteFromSystemClipboard(opt?: {
		viewport?: { x: number; y: number };
		placement?: "front" | "back";
	}): Promise<string[]> {
		try {
			const viewport = opt?.viewport;

			const items = await Clipboard.read();
			for (const item of items) {
				// 1. PAPLICO elements (highest priority)
				if (item.types.includes(PAPLICO_ELEMENTS_MIME)) {
					const blob = await item.getType(PAPLICO_ELEMENTS_MIME);
					const json = await blob.text();
					const elements = JSON.parse(json) as AnyArtObject[];
					if (elements.length === 0) continue;
					return this.pasteElements(elements, opt);
				}
			}

			// 2. SVG
			for (const item of items) {
				if (item.types.includes("image/svg+xml")) {
					const blob = await item.getType("image/svg+xml");
					const svgString = await blob.text();
					if (svgString) {
						return this.pasteSvgString(svgString, viewport);
					}
				}
			}

			// 3. Raster image (PNG, JPEG, WebP, etc.)
			for (const item of items) {
				const imgType = item.types.find(
					(t) => t !== "image/svg+xml" && t.startsWith("image/"),
				);
				if (imgType) {
					const blob = await item.getType(imgType);
					const ext = imgType.split("/")[1] ?? "png";
					const file = new File([blob], `pasted-image.${ext}`, {
						type: imgType,
					});
					const id = await this.pasteImageFile(file, viewport);
					return id ? [id] : [];
				}
			}

			// 4. Plain text
			for (const item of items) {
				if (item.types.includes("text/plain")) {
					const blob = await item.getType("text/plain");
					const text = await blob.text();
					if (text) {
						const id = this.pasteText(text, viewport);
						return id ? [id] : [];
					}
				}
			}
		} catch (err) {
			console.warn("Failed to read system clipboard:", err);
		}
		return [];
	}

	/**
	 * Paste plain text as a TextElement at the given viewport position.
	 * Requires `toolSettings` in the CommandContext for default text style.
	 */
	public pasteText(
		text: string,
		viewport?: { x: number; y: number },
	): string | null {
		const toolSettings = this.ctx.toolSettings;
		if (!toolSettings) {
			console.warn(
				"PaplicoCommands.pasteText: toolSettings not provided in CommandContext",
			);
			return null;
		}

		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		const textElement: TextElement = {
			type: "text",
			id: `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			x: worldX,
			y: worldY,
			transform: createIdentityTransform(),
			content: {
				paragraphs: text.split(/\r?\n/).map((line) => ({
					runs: [
						{
							text: line,
							style: { ...toolSettings.textDefaultStyle },
						},
					],
					alignment: toolSettings.textDefaultAlignment,
					lineHeight: 1.2,
					indent: 0,
					spacing: { before: 0, after: 0 },
				})),
			},
			defaultStyle: { ...toolSettings.textDefaultStyle },
			layout: {
				writingMode: toolSettings.textDefaultWritingMode,
				boxWidth: "auto",
				boxHeight: "auto",
				overflow: "visible",
				wordWrap: false,
			},
			opacity: 1,
			blendMode: "normal",
		};

		this.addText(textElement);

		// Async: outline the glyphs to compute the world-space bounds, then
		// register them with the spatial index for hit-testing and select the
		// new element so it shows up in the selection UI.
		const textRenderer = this.ctx.getTextRenderer?.();
		if (textRenderer) {
			textRenderer
				.textElementToPaths(textElement)
				.then((result) => {
					this.ctx.spatial.setBounds(textElement.id, result.bounds);
					this.ctx.selection?.selectElement(textElement.id, result.bounds);
				})
				.catch((err) => {
					console.error("Failed to compute text bounds:", err);
				});
		}

		return textElement.id;
	}

	/**
	 * Paste an image File as an ImageObject at the given viewport position.
	 * Embeds the file's bytes via addEmbeddedFile.
	 */
	public async pasteImageFile(
		file: File,
		viewport?: { x: number; y: number },
	): Promise<string | null> {
		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		try {
			const arrayBuffer = await file.arrayBuffer();
			const bin = new Uint8Array(arrayBuffer);

			const hashBuffer = await crypto.subtle.digest("SHA-256", bin);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			const hash = hashArray
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			const embeddedFile: EmbeddedFile = {
				uid: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				name: file.name || "pasted-image.png",
				type: file.type,
				hash,
				bin,
			};

			const fileUid = this.addEmbeddedFile(embeddedFile);

			const imageBitmap = await createImageBitmap(file);
			const imageWidth = imageBitmap.width;
			const imageHeight = imageBitmap.height;
			imageBitmap.close();

			const imageObject: ImageObject = {
				type: "image",
				id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				fileUid,
				x: worldX,
				y: worldY,
				width: imageWidth,
				height: imageHeight,
				transform: createIdentityTransform(),
				opacity: 1,
				blendMode: "normal",
			};

			this.addImage(imageObject);
			return imageObject.id;
		} catch (error) {
			console.error("Failed to paste image:", error);
			return null;
		}
	}

	/**
	 * Paste an SVG string by parsing it to ArtObjects.
	 * Falls back to raster image paste if parsing yields no elements.
	 */
	public async pasteSvgString(
		svgString: string,
		viewport?: { x: number; y: number },
		fallbackImageFile?: File,
	): Promise<string[]> {
		const worldX = viewport?.x ?? 0;
		const worldY = viewport?.y ?? 0;

		try {
			const result = await parseSvgToArtObjects(svgString, worldX, worldY);
			if (result.topLevelIds.length > 0) {
				const ids = this.addSvgImport(result);
				this.ctx.store.selectedElementIds = ids;
				return ids;
			}
		} catch (err) {
			console.warn("[pasteSvgString] SVG parsing failed:", err);
		}

		if (fallbackImageFile) {
			const id = await this.pasteImageFile(fallbackImageFile, viewport);
			return id ? [id] : [];
		}

		return [];
	}

	private collectSelectedElements(): {
		elementIds: string[];
		artObjects: AnyArtObject[];
	} {
		return this.collectElementsByIds([...this.ctx.store.selectedElementIds]);
	}

	/**
	 * Deep-clone the given elements plus their absorbed container children
	 * (group children, a blend's source/spine objects) into a flat list.
	 */
	private collectElementsByIds(elementIds: string[]): {
		elementIds: string[];
		artObjects: AnyArtObject[];
	} {
		// Normalize to the current container's stacking (z) order so
		// copy/paste/duplicate preserve the original layer order, independent
		// of selection order (click order or marquee/lasso quadtree traversal
		// order). Mirrors createBlendFromSelection's use of orderSourcesByContainer.
		const parentId =
			this.ctx.store.editingScopeStack.at(-1) ?? this.ctx.store.currentLayerId;
		const orderedIds = parentId
			? orderSourcesByContainer(
					this.ctx.store.document,
					parentId,
					elementIds.map((id) => ({ id })),
				).map((s) => s.id)
			: elementIds;

		const artObjects: AnyArtObject[] = [];

		for (const id of orderedIds) {
			const element = this.ctx.store.document.objects[id];
			if (!element) continue;

			const clone = deepClone(element);
			// Stored transforms of container children are container-local.
			// Normalize top-level clones to world space so every consumer
			// (clipboard payloads, pasteElements → moveIntoEditingScope's
			// world-space compensation) receives world coordinates regardless
			// of where the source element lived. Blends are exempt: their
			// paste path bypasses moveIntoEditingScope, so keep their stored
			// coordinates unchanged.
			if (element.type !== "blend") {
				const ancestorT = this.ctx.spatial.getAncestorTransform(id);
				if (ancestorT) {
					clone.transform = composeTransforms(ancestorT, getTransform(clone));
				}
			}
			artObjects.push(clone);

			if (element.type === "group" || element.type === "mesh") {
				this.collectContainerChildren(element, artObjects);
			} else if (element.type === "blend") {
				this.collectBlendSources(element, artObjects);
			}
		}

		// Bound axis paths travel with their texts so copy/cut/duplicate are
		// self-contained: paste rebinds via the in-set ID remap instead of
		// leaving the clone anchored to the original path
		const included = new Set(artObjects.map((o) => o.id));
		for (const obj of [...artObjects]) {
			if (obj.type !== "text") continue;
			const axisId = obj.axisBinding?.pathObjectId;
			if (!axisId || included.has(axisId)) continue;
			const path = this.ctx.store.document.objects[axisId];
			if (path?.type !== "path") continue;
			included.add(axisId);
			const clone = deepClone(path);
			const ancestorT = this.ctx.spatial.getAncestorTransform(axisId);
			if (ancestorT) {
				clone.transform = composeTransforms(ancestorT, getTransform(clone));
			}
			artObjects.push(clone);
		}

		// Mask content travels with its owner. Without it the copy's mask keeps
		// pointing at the original's shapes, so the two share one mask and
		// moving either drags the other's.
		//
		// Their transforms are owner-local and stay that way — the world-space
		// normalization above is for elements that will be re-parented into a
		// layer, and mask content never is.
		for (const obj of [...artObjects]) {
			const stack = [...(obj.mask?.elementIds ?? [])];
			for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
				if (included.has(id)) continue;
				const source = this.ctx.store.document.objects[id];
				if (!source) continue;
				included.add(id);
				artObjects.push(deepClone(source));
				for (const childId of getContainerChildIds(source) ?? []) {
					stack.push(childId);
				}
				for (const maskId of source.mask?.elementIds ?? []) stack.push(maskId);
			}
		}

		return { elementIds: orderedIds, artObjects };
	}

	/**
	 * Axis paths referenced by texts in the cut set and by no surviving text:
	 * they are invisible guides that would otherwise linger (and get their
	 * invisibly) after their only bound text is cut.
	 */
	private collectExclusiveAxisPathIds(cutSet: Set<string>): string[] {
		const objects = this.ctx.store.document.objects;
		const candidates = new Set<string>();
		for (const id of cutSet) {
			const obj = objects[id];
			if (
				obj?.type === "text" &&
				obj.axisBinding &&
				!cutSet.has(obj.axisBinding.pathObjectId)
			) {
				candidates.add(obj.axisBinding.pathObjectId);
			}
		}
		if (candidates.size === 0) return [];
		for (const obj of Object.values(objects)) {
			if (obj?.type !== "text" || cutSet.has(obj.id)) continue;
			const bound = obj.axisBinding?.pathObjectId;
			if (bound) candidates.delete(bound);
		}
		return [...candidates];
	}

	private async writeToSystemClipboard(
		elementIds: string[],
		artObjects: AnyArtObject[],
	): Promise<void> {
		try {
			// Build ClipboardItem with Promise<Blob> values to avoid awaiting
			// before navigator.clipboard.write(), which would expire Safari's
			// transient user activation and cause NotAllowedError.
			const itemData: Record<string, string | Blob | Promise<Blob>> = {};

			if (this.ctx.renderElementsToPNG) {
				itemData["image/png"] = this.ctx
					.renderElementsToPNG(elementIds)
					.then(
						(result) => result?.blob ?? new Blob([], { type: "image/png" }),
					);
			}

			if (artObjects.length > 0) {
				itemData[PAPLICO_ELEMENTS_MIME] = new Blob(
					[JSON.stringify(artObjects)],
					{ type: PAPLICO_ELEMENTS_MIME },
				);
			}

			if (Object.keys(itemData).length > 0) {
				await Clipboard.write([new ClipboardItem(itemData)]);
			}
		} catch (error) {
			console.warn("Failed to write to system clipboard:", error);
		}
	}

	/**
	 * Paste the given elements into the current layer.
	 *
	 * @param elements - ArtObjects to paste (read from system clipboard).
	 * @param opt.viewport - World-space coordinate used as the center point of the pasted
	 *   elements. The combined bounding box of all pasted elements is computed and each
	 *   anchor point is translated so that the bbox center lands exactly on this position.
	 *   Omit to paste in place (no translation applied).
	 * @param opt.placement - `"back"` moves pasted elements to index 0 of the layer so they
	 *   appear behind all existing elements. Defaults to `"front"` (appended on top).
	 * @returns IDs of the newly created elements.
	 */
	public pasteElements(
		elements: AnyArtObject[],
		opt?: {
			viewport?: { x: number; y: number };
			placement?: "front" | "back";
			offset?: { x: number; y: number };
		},
	): string[] {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return [];
		if (elements.length === 0) return [];
		if (!this.ctx.store.currentLayerId) return [];

		const topLevelElements = this.getTopLevelElements(elements);

		let offsetX = 0;
		let offsetY = 0;
		if (opt?.offset != null) {
			// Direct offset (e.g. alt-drag duplicate) — takes precedence.
			offsetX = opt.offset.x;
			offsetY = opt.offset.y;
		} else if (opt?.viewport != null) {
			const bbox = this.calculateCombinedBounds(topLevelElements, elements);
			offsetX = opt.viewport.x - (bbox.minX + bbox.maxX) / 2;
			offsetY = opt.viewport.y - (bbox.minY + bbox.maxY) / 2;
		}

		const layer = this.ctx.store.document.layers.find(
			(l) => l.id === this.ctx.store.currentLayerId,
		);
		const existingCount =
			opt?.placement === "back" ? (layer?.elementIds.length ?? 0) : 0;

		// Centralize deep-clone + ID remap (containers / blend / compound-path /
		// text path-binding) in cloneElementsWithIdRemap. Preserve the original
		// "${type}-${Date.now()}-${rand9}" ID format used by paste so external
		// consumers of pasted IDs see unchanged shape.
		const now = Date.now();
		const { cloned, idMap } = cloneElementsWithIdRemap(elements, {
			mintId: (el) =>
				`${el.type}-${now}-${Math.random().toString(36).slice(2, 9)}`,
		});
		const clonedById = new Map<string, AnyArtObject>();
		for (let i = 0; i < elements.length; i++) {
			clonedById.set(elements[i]!.id, cloned[i]!);
		}

		const translate = (el: AnyArtObject): AnyArtObject =>
			translateClonedElement(el, offsetX, offsetY);

		// Mask content is reachable only through its owner's `mask`, so it is
		// registered as an object and never listed anywhere. Untranslated: its
		// coordinates are owner-local and the owner carries the paste offset.
		const byId = new Map(elements.map((el) => [el.id, el]));
		const maskContentIds = new Set<string>();
		const maskStack = elements.flatMap((el) => el.mask?.elementIds ?? []);
		for (let id = maskStack.pop(); id !== undefined; id = maskStack.pop()) {
			if (maskContentIds.has(id)) continue;
			const element = byId.get(id);
			if (!element) continue;
			maskContentIds.add(id);
			for (const childId of getContainerChildIds(element) ?? []) {
				maskStack.push(childId);
			}
			for (const nested of element.mask?.elementIds ?? []) {
				maskStack.push(nested);
			}
		}
		if (maskContentIds.size > 0) {
			this.ctx.yjsProvider.transact(() => {
				for (const element of elements) {
					if (!maskContentIds.has(element.id)) continue;
					const clone = clonedById.get(element.id);
					if (!clone) continue;
					this.ctx.yjsProvider.addObjectOnly(clone, this.getMutationOrigin());
				}
			}, this.getMutationOrigin());
		}

		const newTopLevelIds: string[] = [];

		for (const element of topLevelElements) {
			const newId = idMap.get(element.id)!;

			if (element.type === "group") {
				const clonedGroup = clonedById.get(element.id) as Group;
				const layerId = this.ctx.store.currentLayerId!;
				const clonedChildren: AnyArtObject[] = [];

				// Clone children before transaction because `elements` is a Valtio proxy
				// that may mutate during transact() via syncYjsToValtio.
				for (const childId of element.childIds) {
					const childClone = clonedById.get(childId);
					if (!childClone) continue;
					clonedChildren.push(translate(childClone));
				}

				this.ctx.yjsProvider.transact(() => {
					this.ctx.yjsProvider.addElement(
						layerId,
						clonedGroup,
						this.getMutationOrigin(),
					);

					for (const clonedChild of clonedChildren) {
						this.ctx.yjsProvider.addElement(
							layerId,
							clonedChild,
							this.getMutationOrigin(),
						);
						this.ctx.yjsProvider.addElementToGroup(
							layerId,
							newId,
							clonedChild.id,
							this.getMutationOrigin(),
						);
					}

					// Move the pasted group into the editing group (after children are settled)
					this.moveIntoEditingScope(
						layerId,
						newId,
						"group",
						getTransform(clonedGroup),
					);
				}, this.getMutationOrigin());

				newTopLevelIds.push(newId);
			} else if (element.type === "mesh") {
				const layerId = this.ctx.store.currentLayerId!;
				const clonedMesh = clonedById.get(element.id) as MeshArtObject;
				// A mesh container's children (and everything under them) are
				// absorbed: reachable only through childIds, never listed in a
				// layer. Untranslated — their coordinates are container-local
				// and the container carries the paste offset.
				const descendants: AnyArtObject[] = [];
				const childStack = [...element.childIds];
				for (
					let id = childStack.pop();
					id !== undefined;
					id = childStack.pop()
				) {
					const childClone = clonedById.get(id);
					if (childClone) descendants.push(childClone);
					const original = byId.get(id);
					if (!original) continue;
					for (const cid of getContainerChildIds(original) ?? []) {
						childStack.push(cid);
					}
				}
				this.ctx.yjsProvider.transact(() => {
					for (const descendant of descendants) {
						this.ctx.yjsProvider.addObjectOnly(
							descendant,
							this.getMutationOrigin(),
						);
					}
					this.ctx.yjsProvider.addElement(
						layerId,
						clonedMesh,
						this.getMutationOrigin(),
					);
					this.moveIntoEditingScope(
						layerId,
						newId,
						"mesh",
						getTransform(clonedMesh),
					);
				}, this.getMutationOrigin());
				newTopLevelIds.push(newId);
			} else if (element.type === "blend") {
				const blendLayerId = this.ctx.store.currentLayerId!;
				const sourceIds = element.spineSourceId
					? [...element.objectIds, element.spineSourceId]
					: element.objectIds;
				// Clone each source with a fresh id so the copy owns independent
				// source objects; otherwise both blends reference the same sources
				// and editing one is reflected in the other.
				const clonedSources: AnyArtObject[] = [];
				for (const srcId of sourceIds) {
					const srcClone = clonedById.get(srcId);
					if (!srcClone) continue;
					clonedSources.push(translate(srcClone));
				}
				const clonedBlend = clonedById.get(element.id) as BlendObject;
				this.ctx.yjsProvider.transact(() => {
					// Add the cloned sources, then createBlend absorbs them into the
					// new blend (same absorption path as creation).
					for (const clonedSource of clonedSources) {
						this.ctx.yjsProvider.addElement(
							blendLayerId,
							clonedSource,
							this.getMutationOrigin(),
						);
					}
					this.ctx.yjsProvider.createBlend(blendLayerId, clonedBlend);
				}, this.getMutationOrigin());
				newTopLevelIds.push(newId);
			} else {
				const clone = clonedById.get(element.id)!;
				this.addElementByType(translate(clone));
				newTopLevelIds.push(newId);
			}
		}

		// Select pasted elements
		this.ctx.store.selectedElementIds = newTopLevelIds;

		if (opt?.placement === "back") {
			for (let i = 0; i < newTopLevelIds.length; i++) {
				this.ctx.yjsProvider.reorderElements(
					this.ctx.store.currentLayerId!,
					existingCount + i,
					i,
					this.getMutationOrigin(),
				);
			}
		}

		return newTopLevelIds;
	}

	/**
	 * Collect a container's absorbed children (group members, a mesh warp
	 * container's warped children) so copy/duplicate payloads are
	 * self-contained — without them the clone's childIds would keep pointing
	 * at the original's children and the two would share (and co-edit) them.
	 */
	private collectContainerChildren(
		container: Group | MeshArtObject,
		out: AnyArtObject[],
	): void {
		for (const childId of container.childIds) {
			const child = this.ctx.store.document.objects[childId];
			if (!child) continue;
			out.push(deepClone(child));
			if (child.type === "group" || child.type === "mesh") {
				this.collectContainerChildren(child, out);
			}
		}
	}

	private collectBlendSources(blend: BlendObject, out: AnyArtObject[]): void {
		const ids = blend.spineSourceId
			? [...blend.objectIds, blend.spineSourceId]
			: blend.objectIds;
		for (const id of ids) {
			const src = this.ctx.store.document.objects[id];
			if (src) out.push(deepClone(src));
		}
	}

	private getTopLevelElements(elements: AnyArtObject[]): AnyArtObject[] {
		// Elements that are NOT children of any container in the list (group
		// children, or a blend's absorbed source/spine objects).
		const childIds = new Set<string>();
		for (const el of elements) {
			// Mask content is owned by its element and belongs to no layer, so it
			// must not be pasted as an element of its own.
			for (const maskId of el.mask?.elementIds ?? []) childIds.add(maskId);

			if (el.type === "group" || el.type === "mesh") {
				for (const cid of el.childIds) {
					childIds.add(cid);
				}
			} else if (el.type === "blend") {
				for (const oid of el.objectIds) {
					childIds.add(oid);
				}
				if (el.spineSourceId) childIds.add(el.spineSourceId);
			}
		}
		return elements.filter((el) => !childIds.has(el.id));
	}

	private calculateCombinedBounds(
		topLevel: AnyArtObject[],
		allElements: AnyArtObject[],
	): {
		minX: number;
		minY: number;
		maxX: number;
		maxY: number;
	} {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		const elementsMap = new Map(allElements.map((e) => [e.id, e]));

		for (const el of topLevel) {
			const b = calculateElementBounds(el, elementsMap);
			if (b.minX < minX) minX = b.minX;
			if (b.minY < minY) minY = b.minY;
			if (b.maxX > maxX) maxX = b.maxX;
			if (b.maxY > maxY) maxY = b.maxY;
		}

		if (!Number.isFinite(minX)) {
			return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		}
		return { minX, minY, maxX, maxY };
	}

	private addElementByType(element: AnyArtObject): void {
		switch (element.type) {
			case "path":
				this.addPath(element);
				break;
			case "image":
				this.addImage(element);
				break;
			case "text":
				this.addText(element);
				break;
			default: {
				// compound-path, group, etc. - add directly via yjsProvider
				if (!this.ctx.store.currentLayerId) return;
				const layerId = this.ctx.store.currentLayerId;
				const currentT = getTransform(element);
				this.ctx.yjsProvider.transact(() => {
					this.ctx.yjsProvider.addElement(
						layerId,
						element,
						this.getMutationOrigin(),
					);
					this.moveIntoEditingScope(
						layerId,
						element.id,
						element.type,
						currentT,
					);
				}, this.getMutationOrigin());
				break;
			}
		}
	}

	// --- Undo/Redo ---

	public undo(): void {
		if (this.cannotMutate()) return;
		const session = this.ctx.getSessionHistory?.();
		if (session) {
			session.undo();
			return;
		}
		this.ctx.yjsProvider.undo();
	}

	public redo(): void {
		if (this.cannotMutate()) return;
		const session = this.ctx.getSessionHistory?.();
		if (session) {
			session.redo();
			return;
		}
		this.ctx.yjsProvider.redo();
	}

	public updateUndoRedoState(): void {
		this.ctx.store.canUndo = this.ctx.yjsProvider.canUndo();
		this.ctx.store.canRedo = this.ctx.yjsProvider.canRedo();
	}

	public startAdjustColorSession(): AdjustColorSession | null {
		if (this.cannotMutate()) return null;
		const originals = new Map<string, AnyArtObject>();

		const collect = (id: string) => {
			const obj = this.ctx.store.document.objects[id];
			if (!obj) return;
			originals.set(id, deepClone(obj));
			if (obj.type === "group") {
				for (const childId of obj.childIds) collect(childId);
			} else if (isBlend(obj)) {
				// A blend has no paint of its own; its colors live on the absorbed
				// key objects (intermediates interpolate from them). Recurse into the
				// keys so color adjustment reaches the blend.
				for (const keyId of obj.objectIds) collect(keyId);
			} else if (isRepeat(obj)) {
				// A repeat has no paint of its own; its instances are copies of the
				// absorbed sources. Recurse into the sources so color adjustment
				// reaches every instance.
				for (const sourceId of obj.sourceIds) collect(sourceId);
			}
		};

		for (const id of this.ctx.store.selectedElementIds) {
			if (this.isElementLocked(id)) continue;
			collect(id);
		}
		if (originals.size === 0) return null;

		return new AdjustColorSession(
			originals,
			this.ctx.yjsProvider,
			this.getMutationOrigin(),
			this.ctx.filterHandlerLookup,
		);
	}

	// --- YjsProvider delegation (for ToolContext) ---

	public transact(fn: (commands: PaplicoCommands) => void): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.transact(() => fn(this), this.getMutationOrigin());
	}

	public addElementToLayer(layerId: string, element: AnyArtObject): void {
		if (this.cannotMutate() || this.isLayerLocked(layerId)) return;
		const currentT = getTransform(element);
		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.addElement(
				layerId,
				element,
				this.getMutationOrigin(),
			);
			this.moveIntoEditingScope(layerId, element.id, element.type, currentT);
		}, this.getMutationOrigin());
	}

	public addObjectToDocument(element: AnyArtObject): void {
		if (this.cannotMutate()) return;
		this.ctx.yjsProvider.addObjectOnly(element, this.getMutationOrigin());
	}

	// --- Reference3D (shared 3D scene definitions + viewing elements) ---

	/**
	 * Create a fresh shared 3D scene (floor + one box as a starting point) and
	 * a Reference3DElement viewing it, centered at world (x, y). One transaction =
	 * one undo step removing both.
	 */
	public createReference3DScene(
		x: number,
		y: number,
	): Reference3DElement | null {
		const layerId = this.ctx.store.currentLayerId;
		if (this.cannotMutate() || !layerId || this.isLayerLocked(layerId)) {
			return null;
		}

		const def: Reference3DDef = {
			id: generateUid("scene"),
			nodes: [
				{
					id: generateUid("node"),
					kind: "primitive",
					shape: "box",
					transform: {
						position: [0, 0.5, 0],
						rotation: [0, 0, 0, 1],
						scale: [1, 1, 1],
					},
				},
			],
		};
		const element = createReference3DElement({
			sceneId: def.id,
			x,
			y,
			width: 400,
			height: 300,
		});

		this.ctx.yjsProvider.transact(() => {
			this.ctx.yjsProvider.setReference3D(def, this.getMutationOrigin());
			this.ctx.yjsProvider.addElement(
				layerId,
				element,
				this.getMutationOrigin(),
			);
		}, this.getMutationOrigin());

		return element;
	}

	/** Append a node to a shared scene definition. */
	public reference3dAddNode(sceneId: string, node: Reference3DNode): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			[...def.nodes, node],
			this.getMutationOrigin(),
		);
	}

	/** Remove a node from a shared scene definition (one undo step). */
	public reference3dRemoveNode(sceneId: string, nodeId: string): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		const nodes = def.nodes.filter((node) => node.id !== nodeId);
		if (nodes.length === def.nodes.length) return;
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			nodes,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Duplicate a node in a shared scene definition with a small position
	 * offset (one undo step). Returns the new node, or null when missing.
	 */
	public reference3dDuplicateNode(
		sceneId: string,
		nodeId: string,
	): Reference3DNode | null {
		if (this.cannotMutate()) return null;
		const def = this.ctx.store.document.references3d?.[sceneId];
		const source = def?.nodes.find((node) => node.id === nodeId);
		if (!def || !source) return null;

		const duplicate: Reference3DNode = {
			...structuredClone(source),
			id: generateUid("node"),
		};
		duplicate.transform = {
			...duplicate.transform,
			position: [
				duplicate.transform.position[0] + 0.3,
				duplicate.transform.position[1],
				duplicate.transform.position[2] + 0.3,
			],
		};
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			[...def.nodes, duplicate],
			this.getMutationOrigin(),
		);
		return duplicate;
	}

	/** Patch a single node of a shared scene definition (one undo step). */
	public reference3dCommitNode(
		sceneId: string,
		nodeId: string,
		patch: Partial<Reference3DNode>,
	): void {
		if (this.cannotMutate()) return;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return;
		const nodes = def.nodes.map((node) =>
			node.id === nodeId ? ({ ...node, ...patch } as Reference3DNode) : node,
		);
		this.ctx.yjsProvider.updateReference3DNodes(
			sceneId,
			nodes,
			this.getMutationOrigin(),
		);
	}

	/**
	 * Store a VRM binary as an EmbeddedFile (hash-deduplicated) and append a
	 * figure node referencing it, in one transaction (= one undo step).
	 */
	public reference3dAddFigure(
		sceneId: string,
		file: EmbeddedFile,
	): Reference3DNode | null {
		return this.reference3dAppendFileNode(sceneId, file, (fileUid) => ({
			id: generateUid("node"),
			kind: "figure",
			fileUid,
			transform: {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
			pose: { bones: {} },
		}));
	}

	/**
	 * Store a glTF binary (.glb) as an EmbeddedFile (hash-deduplicated) and
	 * append a static mesh node referencing it, in one transaction.
	 */
	public reference3dAddMesh(
		sceneId: string,
		file: EmbeddedFile,
	): Reference3DNode | null {
		return this.reference3dAppendFileNode(sceneId, file, (fileUid) => ({
			id: generateUid("node"),
			kind: "mesh",
			fileUid,
			transform: {
				position: [0, 0, 0],
				rotation: [0, 0, 0, 1],
				scale: [1, 1, 1],
			},
		}));
	}

	private reference3dAppendFileNode(
		sceneId: string,
		file: EmbeddedFile,
		buildNode: (fileUid: string) => Reference3DNode,
	): Reference3DNode | null {
		if (this.cannotMutate()) return null;
		const def = this.ctx.store.document.references3d?.[sceneId];
		if (!def) return null;

		let node: Reference3DNode | null = null;
		this.ctx.yjsProvider.transact(() => {
			node = buildNode(this.ctx.yjsProvider.addFile(file));
			this.ctx.yjsProvider.updateReference3DNodes(
				sceneId,
				[...def.nodes, node],
				this.getMutationOrigin(),
			);
		}, this.getMutationOrigin());

		return node;
	}

	public splitPath(
		layerId: string,
		pathId: string,
		segmentIndex: number,
		pointType: "start" | "end",
	): void {
		if (this.cannotMutate() || this.isElementLocked(pathId)) return;
		this.ctx.yjsProvider.splitPath(
			layerId,
			pathId,
			segmentIndex,
			pointType,
			this.getMutationOrigin(),
		);
	}

	/** Replace a path with several paths built from the given segment runs. */
	public replacePathWithPaths(
		layerId: string,
		pathId: string,
		segmentLists: CubicBezierSegment[][],
	): void {
		if (this.cannotMutate() || this.isElementLocked(pathId)) return;
		this.ctx.yjsProvider.replacePathWithPaths(
			layerId,
			pathId,
			segmentLists,
			this.getMutationOrigin(),
		);
	}

	public splitPathAtAnchor(
		pathId: string,
		segmentIndex: number,
		pointType: "start" | "end",
	): void {
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.splitPath(layerId, pathId, segmentIndex, pointType);
	}

	public mergePaths(
		pathIdA: string,
		endpointA: "start" | "end",
		pathIdB: string,
		endpointB: "start" | "end",
	): void {
		if (this.cannotMutate()) return;
		if (this.isElementLocked(pathIdA) || this.isElementLocked(pathIdB)) return;
		const layerId = this.ctx.store.currentLayerId;
		if (!layerId) return;
		this.ctx.yjsProvider.mergePaths(
			layerId,
			pathIdA,
			endpointA,
			pathIdB,
			endpointB,
			this.getMutationOrigin(),
		);
	}

	public stopUndoCapture(): void {
		this.ctx.yjsProvider.stopUndoCapture();
	}

	public addPaths(
		paths: Path[],
		insertIndex?: number,
		targetLayerId?: string,
	): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		if (insertIndex !== undefined) {
			const layerId = targetLayerId ?? this.ctx.store.currentLayerId;
			if (!layerId) return;
			const origin = this.getMutationOrigin();
			this.ctx.yjsProvider.transact(() => {
				for (const [offset, path] of paths.entries()) {
					this.ctx.yjsProvider.addElement(
						layerId,
						path,
						origin,
						insertIndex + offset,
					);
				}
			}, origin);
			return;
		}

		for (const path of paths) {
			this.addPath(path);
		}
	}

	public addPathsToGroup(
		paths: Path[],
		groupId: string,
		insertIndex?: number,
		targetLayerId?: string,
	): void {
		if (this.cannotMutate() || this.isCurrentContextLocked()) return;
		const layerId = targetLayerId ?? this.ctx.store.currentLayerId;
		if (!layerId) return;
		const origin = this.getMutationOrigin();

		this.ctx.yjsProvider.transact(() => {
			for (const [offset, path] of paths.entries()) {
				this.ctx.yjsProvider.addElement(layerId, path, origin);
				this.ctx.yjsProvider.addElementToGroup(
					layerId,
					groupId,
					path.id,
					origin,
					insertIndex === undefined ? undefined : insertIndex + offset,
				);
			}
		}, origin);
	}

	public addEraseMask(elementId: string, mask: EraseMask): void {
		if (this.cannotMutate() || this.isElementLocked(elementId)) return;
		const obj = this.ctx.store.document.objects[elementId];
		if (!obj || obj.type !== "path") return;
		const existing = obj.eraseMasks ?? [];
		this.ctx.yjsProvider.updateElement(
			"",
			elementId,
			{ eraseMasks: [...existing, mask] },
			this.getMutationOrigin(),
		);
	}
}

function areBrushSettingsSemanticallyEqual(
	left: unknown,
	right: unknown,
): boolean {
	if (left == null || right == null) return left == null && right == null;

	return (
		JSON.stringify(normalizeBrushSettings(left)) ===
		JSON.stringify(normalizeBrushSettings(right))
	);
}

export class AdjustColorSession {
	public readonly collectedColors: CollectedColor[];
	private disposed = false;

	public constructor(
		private originalElements: Map<string, AnyArtObject>,
		private yjsProvider: YjsProvider,
		private origin?: unknown,
		private filterHandlerLookup?: FilterHandlerLookup,
	) {
		this.collectedColors = [...originalElements.entries()]
			.flatMap(([id, el]) =>
				collectElementColors(id, el, this.filterHandlerLookup),
			)
			.map((c, i) => ({ ...c, index: i }));
		this.yjsProvider.stopUndoCapture();
	}

	public preview(adjuster: (color: Color) => Color): CollectedColor[] {
		if (this.disposed) return this.collectedColors;

		const updates = [...this.originalElements.entries()].map(([id, el]) => ({
			elementId: id,
			updates: buildElementColorUpdates(el, adjuster, this.filterHandlerLookup),
		}));

		this.yjsProvider.batchUpdateElements(updates, this.origin);

		return this.collectedColors.map((cc) => ({
			...cc,
			color: adjuster(cc.color),
		}));
	}

	public apply(): void {
		if (this.disposed) return;
		this.yjsProvider.stopUndoCapture();
		this.disposed = true;
	}

	public cancel(): void {
		if (this.disposed) return;

		const updates = [...this.originalElements.entries()].map(([id, el]) => ({
			elementId: id,
			updates: {
				filters: el.filters,
			} as Partial<AnyArtObject>,
		}));

		this.yjsProvider.batchUpdateElements(updates, this.origin);
		this.yjsProvider.stopUndoCapture();
		// Undo the preview changes
		this.yjsProvider.undo();
		this.disposed = true;
	}
}

/** Center of each element in its own (container-local) space. */
function blendKeyCenters(
	keys: AnyArtObject[],
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Array<{ x: number; y: number }> {
	return keys.map((key) => {
		const b = calculateElementBounds(key, elementsMap);
		return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
	});
}

/** Straight polyline segments through the given points (in order, ≥2). */
function polylineSpineSegments(
	centers: Array<{ x: number; y: number }>,
): PathSegment[] {
	const segments: PathSegment[] = [];
	for (let i = 1; i < centers.length; i++) {
		segments.push({
			start: i === 1 ? { x: centers[0].x, y: centers[0].y } : undefined,
			cp1: { x: 0, y: 0 },
			cp2: { x: 0, y: 0 },
			end: { x: centers[i].x, y: centers[i].y },
			startTiltX: 0,
			startTiltY: 0,
			endTiltX: 0,
			endTiltY: 0,
			startDeltaTime: 0,
			endDeltaTime: 0,
			isMoved: i === 1,
		});
	}
	return segments;
}

/**
 * Default blend spine: a polyline through the key centers (in order). The keys
 * are the spine's vertices, so the spine bends through every key and moving a
 * key reshapes it. Returns null for fewer than two keys.
 */
function buildBlendSpineThroughKeys(
	keys: AnyArtObject[],
	elementsMap: ReadonlyMap<string, AnyArtObject>,
): Path | null {
	if (keys.length < 2) return null;
	return {
		type: "path",
		id: generateUid("path"),
		segments: polylineSpineSegments(blendKeyCenters(keys, elementsMap)),
		opacity: 1,
		blendMode: "normal",
		transform: createIdentityTransform(),
	};
}

/**
 * Resolve the single parent container (layer or group) that directly holds every
 * blend source. Returns the parent id (a layer id or a group id) on success, or
 * a "different-parent" error when sources do not all share one container.
 */
/** Round every numeric field of a params object to 3 decimals, leaving
 *  non-numeric fields (e.g. booleans) untouched. */
function roundNumericFields<T extends Record<string, unknown>>(obj: T): T {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		out[key] =
			typeof value === "number" ? Math.round(value * 1000) / 1000 : value;
	}
	return out as T;
}

function resolveBlendSourceContainer(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	sourceIds: readonly string[],
): { ok: true; parentId: string } | { ok: false; reason: "different-parent" } {
	let parentId: string | null = null;
	for (const id of sourceIds) {
		const container = findDirectContainerId(document, id);
		if (!container) return { ok: false, reason: "different-parent" };
		if (parentId === null) parentId = container;
		else if (parentId !== container)
			return { ok: false, reason: "different-parent" };
	}
	if (parentId === null) return { ok: false, reason: "different-parent" };
	return { ok: true, parentId };
}

/**
 * Reorder `sources` to match the parent container's child ordering (a layer's
 * elementIds or a group's childIds), i.e. the document stacking (z) order. All
 * sources are guaranteed (by resolveBlendSourceContainer) to be direct children
 * of `parentId`, so each is found in the container's id list.
 */
function orderSourcesByContainer<T extends { id: string }>(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	parentId: string,
	sources: readonly T[],
): T[] {
	const layer = document.layers.find((l) => l.id === parentId);
	const orderedIds =
		layer?.elementIds ?? getContainerChildIds(document.objects[parentId]) ?? [];
	const rank = new Map(orderedIds.map((id, i) => [id, i]));
	return [...sources].sort(
		(a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
	);
}

/**
 * Find the id of the container directly holding `id`: the layer whose
 * elementIds lists it, or the group whose childIds lists it. Returns null when
 * the element is not a direct child of any layer or group.
 */
function findDirectContainerId(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	id: string,
): string | null {
	const layer = document.layers.find((l) => l.elementIds.includes(id));
	if (layer) return layer.id;
	for (const obj of Object.values(document.objects)) {
		if (isGroup(obj) && obj.childIds.includes(id)) return obj.id;
	}
	return null;
}

/**
 * Applies a world-space offset to a freshly cloned element (i.e. one returned by
 * cloneElementsWithIdRemap). Only translates element types whose anchor lives
 * directly on the element (path segments, image x/y, text x/y). Container-like
 * types (group / blend / compound-path / mesh) carry no anchor of their own and
 * are returned unchanged; their internal sources are translated separately by
 * the caller.
 */
function translateClonedElement(
	element: AnyArtObject,
	offsetX: number,
	offsetY: number,
): AnyArtObject {
	if (offsetX === 0 && offsetY === 0) return element;
	if (element.type === "path") {
		return {
			...element,
			segments: translateSegments(element.segments, offsetX, offsetY),
		} satisfies Path;
	}
	if (element.type === "image" || element.type === "text") {
		return { ...element, x: element.x + offsetX, y: element.y + offsetY };
	}
	return element;
}

/**
 * Display-ordered ids held directly by a container, whether that container is
 * a layer or a group. Index 0 renders first, so later entries sit on top.
 */
function containerChildIds(
	document: { layers: readonly Layer[]; objects: Record<string, AnyArtObject> },
	containerId: string,
): readonly string[] {
	const layer = document.layers.find((l) => l.id === containerId);
	if (layer) return layer.elementIds;
	const container = document.objects[containerId];
	return container && isGroup(container) ? container.childIds : [];
}

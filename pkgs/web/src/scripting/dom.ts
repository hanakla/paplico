import type { PaplicoCommands } from "@/core/PaplicoCommands";
import type { PaplicoSelection } from "@/core/PaplicoSelection";
import type {
	AnyArtObject,
	Artboard,
	ColorProfileSettings,
	Document,
	HdrSettings,
	Layer,
} from "@/core/schema";
import { calculateElementBounds } from "@/core/utils/geometry/bounds";
import { deepClone } from "@/utils/lang";
import type {
	PaplicoScriptingBridge,
	ScriptArtboard,
	ScriptArtObject,
	ScriptDocument,
	ScriptEditor,
	ScriptFileSystem,
	ScriptLayer,
} from "./api";

type AutomationTarget = {
	readonly uiState: {
		readonly document: Document;
		readonly selectedElementIds: string[];
		readonly currentLayerId: string | null;
	};
	readonly commands: Pick<
		PaplicoCommands,
		| "stopUndoCapture"
		| "setColorProfile"
		| "setHdr"
		| "setRasterizationDpi"
		| "transact"
		| "updateArtboard"
		| "updateElement"
		| "updateLayer"
	>;
	readonly selection: Pick<PaplicoSelection, "clear" | "selectMultiple">;
};

type EntityKind = "artboard" | "document" | "element" | "layer";

type BufferedPatch = {
	kind: EntityKind;
	id: string;
	updates: Record<string, unknown>;
	paths: Map<string, unknown>;
};

export class PaplicoAutomationDom implements PaplicoScriptingBridge {
	private readonly wrapperCache = new Map<string, object>();
	private readonly patches = new Map<string, BufferedPatch>();
	private pendingSelection: string[] | null = null;
	private buffering = false;

	public constructor(
		private readonly target: AutomationTarget,
		private readonly fileSystem: ScriptFileSystem | null = null,
	) {}

	public getActiveDocument(): ScriptDocument {
		return this.wrapper("document", this.target.uiState.document.id, () =>
			this.createDocumentWrapper(),
		);
	}

	public getEditor(): ScriptEditor {
		const dom = this;
		return this.wrapper("editor", "editor", () => ({
			get selection() {
				return dom.getSelection();
			},
			select: (uids: string[]) => {
				this.pendingSelection = [...new Set(uids)];
			},
			clearSelection: () => {
				this.pendingSelection = [];
			},
		}));
	}

	public getFileSystem(): ScriptFileSystem | null {
		return this.fileSystem;
	}

	public begin(): void {
		this.patches.clear();
		this.pendingSelection = null;
		this.buffering = true;
	}

	public commit(): void {
		if (!this.buffering) return;

		const patches = [...this.patches.values()];
		this.validate(patches);
		this.target.commands.stopUndoCapture();
		try {
			this.target.commands.transact((commands) => {
				for (const patch of patches) {
					const entity = this.baseEntity(patch.kind, patch.id);
					if (!entity) continue;
					const updates = materializeUpdates(patch, entity);
					switch (patch.kind) {
						case "element": {
							const layerId =
								findContainingLayerId(this.target.uiState.document, patch.id) ??
								"";
							commands.updateElement(
								layerId,
								patch.id,
								updates as Partial<AnyArtObject>,
							);
							break;
						}
						case "layer":
							commands.updateLayer(patch.id, updates as Partial<Layer>);
							break;
						case "artboard":
							commands.updateArtboard(patch.id, updates as Partial<Artboard>);
							break;
						case "document": {
							if (updates.hdr) {
								commands.setHdr(updates.hdr as Partial<HdrSettings>);
							}
							if (updates.colorProfile) {
								commands.setColorProfile(
									updates.colorProfile as Partial<ColorProfileSettings>,
								);
							}
							if (typeof updates.rasterizationDpi === "number") {
								commands.setRasterizationDpi(updates.rasterizationDpi);
							}
						}
					}
				}
			});
		} finally {
			this.target.commands.stopUndoCapture();
		}

		this.applySelection();
		this.finish();
	}

	public rollback(): void {
		this.finish();
	}

	private createDocumentWrapper(): ScriptDocument {
		const dom = this;
		return {
			get uid() {
				return dom.target.uiState.document.id;
			},
			get title() {
				return dom.target.uiState.document.id;
			},
			get viewport() {
				return dom.target.uiState.document.viewport;
			},
			get hdr() {
				return dom.wrapNested(
					"document",
					dom.target.uiState.document.id,
					["hdr"],
					dom.target.uiState.document.hdr,
				);
			},
			set hdr(value) {
				dom.setPath("document", dom.target.uiState.document.id, ["hdr"], value);
			},
			get colorProfile() {
				return dom.wrapNested(
					"document",
					dom.target.uiState.document.id,
					["colorProfile"],
					dom.target.uiState.document.colorProfile,
				);
			},
			set colorProfile(value) {
				dom.setPath(
					"document",
					dom.target.uiState.document.id,
					["colorProfile"],
					value,
				);
			},
			get rasterizationDpi() {
				return dom.target.uiState.document.rasterizationDpi;
			},
			set rasterizationDpi(value) {
				dom.setPath(
					"document",
					dom.target.uiState.document.id,
					["rasterizationDpi"],
					value,
				);
			},
			get schemaVersion() {
				return dom.target.uiState.document.schemaVersion;
			},
			findArtObject: (uid) => dom.getArtObject(uid),
			artObjects: () =>
				Object.keys(dom.target.uiState.document.objects).map((uid) =>
					dom.requireArtObject(uid),
				),
			findLayer: (uid) => dom.getLayer(uid),
			layers: () =>
				dom.target.uiState.document.layers.map((layer) =>
					dom.requireLayer(layer.id),
				),
			findArtboard: (uid) => dom.getArtboard(uid),
			artboards: () =>
				dom.target.uiState.document.artboards.map((artboard) =>
					dom.requireArtboard(artboard.id),
				),
		};
	}

	private getArtObject(uid: string): ScriptArtObject | null {
		if (!this.target.uiState.document.objects[uid]) return null;
		return this.requireArtObject(uid);
	}

	private requireArtObject(uid: string): ScriptArtObject {
		return this.wrapper("element", uid, () =>
			this.createEntityProxy("element", uid),
		) as ScriptArtObject;
	}

	private getLayer(uid: string): ScriptLayer | null {
		if (!this.target.uiState.document.layers.some((layer) => layer.id === uid))
			return null;
		return this.requireLayer(uid);
	}

	private requireLayer(uid: string): ScriptLayer {
		return this.wrapper("layer", uid, () => {
			const proxy = this.createEntityProxy("layer", uid) as ScriptLayer;
			Object.defineProperty(proxy, "artObjects", {
				value: () => {
					const layer = this.resolveEntity("layer", uid) as Layer | undefined;
					return (
						layer?.elementIds.map((elementId) =>
							this.requireArtObject(elementId),
						) ?? []
					);
				},
			});
			return proxy;
		}) as ScriptLayer;
	}

	private getArtboard(uid: string): ScriptArtboard | null {
		if (
			!this.target.uiState.document.artboards.some(
				(artboard) => artboard.id === uid,
			)
		)
			return null;
		return this.requireArtboard(uid);
	}

	private requireArtboard(uid: string): ScriptArtboard {
		return this.wrapper("artboard", uid, () =>
			this.createEntityProxy("artboard", uid),
		) as ScriptArtboard;
	}

	private createEntityProxy(kind: EntityKind, id: string): object {
		const dom = this;
		const target = {};
		return new Proxy(target, {
			get(_target, property) {
				if (property === "uid") return id;
				if (typeof property !== "string") return undefined;
				const entity = dom.resolveEntity(kind, id);
				if (kind === "element" && property === "bounds" && entity) {
					const bounds = calculateElementBounds(
						entity as unknown as AnyArtObject,
						new Map(Object.entries(dom.target.uiState.document.objects)),
					);
					return {
						...bounds,
						x: (bounds.minX + bounds.maxX) / 2,
						y: (bounds.minY + bounds.maxY) / 2,
					};
				}
				const value = entity?.[property as keyof typeof entity];
				if (property === "name") return value ?? "";
				if (property === "visible") return value ?? true;
				if (property === "locked") return value ?? false;
				if (property === "blendMode") return value ?? "normal";
				if (property === "childIds" || property === "objectIds") {
					return value ?? [];
				}
				return dom.wrapNested(kind, id, [property], value);
			},
			set(_target, property, value) {
				if (
					typeof property !== "string" ||
					property === "id" ||
					property === "bounds"
				) {
					return false;
				}
				dom.setPath(kind, id, [property], value);
				return true;
			},
		});
	}

	private wrapNested<T>(
		kind: EntityKind,
		id: string,
		path: string[],
		value: T,
	): T {
		if (!isPlainObject(value)) return deepClone(value) as T;
		const key = `${kind}:${id}:${path.join(".")}`;
		return this.wrapper("nested", key, () => {
			const dom = this;
			return new Proxy(
				{},
				{
					get(_target, property) {
						if (typeof property !== "string") return undefined;
						const current = getPath(dom.resolveEntity(kind, id), [
							...path,
							property,
						]);
						return dom.wrapNested(kind, id, [...path, property], current);
					},
					set(_target, property, nextValue) {
						if (typeof property !== "string") return false;
						dom.setPath(kind, id, [...path, property], nextValue);
						return true;
					},
				},
			);
		}) as T;
	}

	private resolveEntity(
		kind: EntityKind,
		id: string,
	): Record<string, unknown> | undefined {
		const entity = this.baseEntity(kind, id);
		if (!entity) return undefined;
		return mergeDeep(entity, this.patches.get(`${kind}:${id}`)?.updates ?? {});
	}

	private baseEntity(
		kind: EntityKind,
		id: string,
	): Record<string, unknown> | undefined {
		const document = this.target.uiState.document;
		const entity =
			kind === "document"
				? document
				: kind === "element"
					? document.objects[id]
					: kind === "layer"
						? document.layers.find((layer) => layer.id === id)
						: document.artboards.find((artboard) => artboard.id === id);
		if (!entity) return undefined;
		return entity as unknown as Record<string, unknown>;
	}

	private setPath(
		kind: EntityKind,
		id: string,
		path: string[],
		value: unknown,
	): void {
		if (!this.buffering) {
			throw new Error(
				"Automation mutations are only allowed while a script runs",
			);
		}
		const entity = this.resolveEntity(kind, id);
		if (!entity) return;
		const [root, ...rest] = path;
		if (!root || root === "uid" || root === "type") return;

		const key = `${kind}:${id}`;
		const patch = this.patches.get(key) ?? {
			kind,
			id,
			updates: {},
			paths: new Map(),
		};
		if (rest.length === 0) {
			patch.updates[root] = deepClone(value);
		} else {
			const current = deepClone(entity[root]);
			patch.updates[root] = setPath(current, rest, deepClone(value));
		}
		patch.paths.set(path.join("."), deepClone(value));
		this.patches.set(key, patch);
	}

	private getSelection(): ScriptArtObject[] {
		return (this.pendingSelection ?? this.target.uiState.selectedElementIds)
			.filter((id) => this.target.uiState.document.objects[id])
			.map((id) => this.requireArtObject(id));
	}

	private applySelection(): void {
		if (this.pendingSelection === null) return;
		this.target.selection.clear();
		if (this.pendingSelection.length > 0) {
			this.target.selection.selectMultiple(this.pendingSelection);
		}
	}

	private validate(patches: BufferedPatch[]): void {
		for (const patch of patches) {
			const opacity = patch.updates.opacity;
			if (
				opacity !== undefined &&
				(typeof opacity !== "number" ||
					!Number.isFinite(opacity) ||
					opacity < 0 ||
					opacity > 1)
			) {
				throw new RangeError(
					"opacity must be a finite number from 0 through 1",
				);
			}
			validateFiniteNumbers(patch.updates, patch.kind);
		}
	}

	private finish(): void {
		this.patches.clear();
		this.pendingSelection = null;
		this.buffering = false;
	}

	private wrapper<T extends object>(
		kind: string,
		id: string,
		create: () => T,
	): T {
		const key = `${kind}:${id}`;
		const existing = this.wrapperCache.get(key);
		if (existing) return existing as T;
		const created = create();
		this.wrapperCache.set(key, created);
		return created;
	}
}

function findContainingLayerId(
	document: Document,
	targetId: string,
): string | null {
	const contains = (id: string, visited: Set<string>): boolean => {
		if (id === targetId) return true;
		if (visited.has(id)) return false;
		visited.add(id);
		const object = document.objects[id];
		if (!object) return false;
		const childIds = referencedObjectIds(object, document.objects);
		return childIds.some((childId) => contains(childId, visited));
	};

	return (
		document.layers.find((layer) =>
			layer.elementIds.some((id) => contains(id, new Set())),
		)?.id ?? null
	);
}

function referencedObjectIds(
	value: unknown,
	objects: Document["objects"],
	result = new Set<string>(),
): string[] {
	if (typeof value === "string") {
		if (objects[value]) result.add(value);
		return [...result];
	}
	if (Array.isArray(value)) {
		for (const item of value) referencedObjectIds(item, objects, result);
		return [...result];
	}
	if (!isPlainObject(value)) return [...result];
	for (const child of Object.values(value)) {
		referencedObjectIds(child, objects, result);
	}
	return [...result];
}

function materializeUpdates(
	patch: BufferedPatch,
	entity: Record<string, unknown>,
): Record<string, unknown> {
	const updates: Record<string, unknown> = {};
	for (const [serializedPath, value] of patch.paths) {
		const [root, ...rest] = serializedPath.split(".");
		if (!root) continue;
		if (rest.length === 0) {
			updates[root] = deepClone(value);
			continue;
		}
		const current = updates[root] ?? deepClone(entity[root]);
		updates[root] = setPath(current, rest, deepClone(value));
	}
	return updates;
}

function mergeDeep(
	base: Record<string, unknown>,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(updates)) {
		result[key] =
			isPlainObject(result[key]) && isPlainObject(value)
				? mergeDeep(result[key], value)
				: deepClone(value);
	}
	return result;
}

function getPath(value: unknown, path: string[]): unknown {
	return path.reduce<unknown>(
		(current, key) => (isPlainObject(current) ? current[key] : undefined),
		value,
	);
}

function setPath(value: unknown, path: string[], nextValue: unknown): unknown {
	const root = isPlainObject(value) ? deepClone(value) : {};
	let current = root;
	for (const [index, key] of path.entries()) {
		if (index === path.length - 1) {
			current[key] = nextValue;
			break;
		}
		const child = isPlainObject(current[key]) ? deepClone(current[key]) : {};
		current[key] = child;
		current = child;
	}
	return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function validateFiniteNumbers(value: unknown, path: string): void {
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new RangeError(`${path} contains a non-finite number`);
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			validateFiniteNumbers(item, `${path}.${index}`);
		});
		return;
	}
	if (!isPlainObject(value)) return;
	for (const [key, child] of Object.entries(value)) {
		validateFiniteNumbers(child, `${path}.${key}`);
	}
}

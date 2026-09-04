import { useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import { usePaplico } from "@/contexts/PaplicoContext";
import { readStoredBrushSize, withStoredBrushSize } from "@/core/brush/access";
import {
	resolveBrushTextureUid,
	withTextureFileUid,
} from "@/core/brush/brushSource";
import {
	BUILTIN_BRUSH_IDS,
	type BuiltinBrushId,
	type EmbeddedFile,
	generateUid,
} from "@/core/schema";
import { createBrushTextureFile } from "@/core/utils/embeddedFile";
import { FileSystem } from "@/infra/filesystem";
import { parsePapb, serializePapb } from "@/infra/papb";
import { useTranslation } from "@/locales";
import {
	brushPresetsRepo,
	clonePersistedBrushPreset,
	createBrushPresetDefaults,
	createBuiltinBrushPreviewSource,
	createEmbeddedFileFromBrushPreset,
	createPersistedBrushPreset,
	createPersistedBrushPreviewSource,
	getBuiltinBrushFiles,
	getBuiltinBrushPresets,
	isSamePersistedBrushPreset,
	type PersistedBrushPreset,
} from "@/repos/brushPresets";
import { documentManagerState } from "@/stores/documentStore";
import { setSelectedBrushPresetUid, useUIState } from "@/stores/uiStore";
import { useAsyncEffect, useEventCallback } from "@/utils/hooks";

export function useBrushPresets() {
	const t = useTranslation();
	const paplico = usePaplico();
	const tools = paplico.tools;
	const commands = paplico.commands;
	const store = paplico.uiState;

	const docSnap = useSnapshot(store);
	const toolSnap = useSnapshot(tools.state);
	const uiSnap = useUIState();
	const docManagerSnap = useSnapshot(documentManagerState);
	const currentDocumentId = docManagerSnap.currentDocumentId;

	const builtinPresets = useMemo(() => getBuiltinBrushPresets(), []);
	const [builtinFiles, setBuiltinFiles] = useState<EmbeddedFile[]>([]);
	const [persistedPresets, setPersistedPresets] = useState<
		PersistedBrushPreset[]
	>([]);

	const migratedDocumentIdRef = useRef<string | null>(null);
	const migratedPresetIdsRef = useRef<Set<string>>(new Set());

	const refreshPersistedPresets = useEventCallback(async () => {
		const presets = await brushPresetsRepo.list();
		setPersistedPresets(presets);
	});

	useAsyncEffect(async (signal) => {
		const files = await getBuiltinBrushFiles();
		if (signal.aborted) return;
		setBuiltinFiles(files);
	}, []);

	useAsyncEffect(async () => {
		await refreshPersistedPresets();
	}, []);

	useEffect(() => {
		if (currentDocumentId == null) {
			setSelectedBrushPresetUid(null);
			return;
		}
		setSelectedBrushPresetUid(null);
	}, [currentDocumentId]);

	useEffect(() => {
		if (migratedDocumentIdRef.current === currentDocumentId) return;
		migratedDocumentIdRef.current = currentDocumentId;
		migratedPresetIdsRef.current = new Set();
	}, [currentDocumentId]);

	useAsyncEffect(
		async (signal) => {
			if (!currentDocumentId || docSnap.document.brushPresets.length === 0) {
				return;
			}

			const builtinFileMap = new Map(
				(await getBuiltinBrushFiles()).map((file) => [file.uid, file]),
			);
			let hasChanges = false;

			// Iterate the store, not the snapshot: the persisted copy takes the
			// settings object as stored.
			for (const docPreset of store.document.brushPresets) {
				if (signal.aborted) return;
				if (migratedPresetIdsRef.current.has(docPreset.uid)) continue;

				const presetSettings = docPreset.settings;
				const presetTextureUid = resolveBrushTextureUid(presetSettings);
				const sourceFile = presetTextureUid
					? (builtinFileMap.get(presetTextureUid) ??
						docSnap.document.files.find(
							(file) => file.uid === presetTextureUid,
						))
					: undefined;
				migratedPresetIdsRef.current.add(docPreset.uid);
				if (!sourceFile || !presetTextureUid) continue;

				const nextPreset = createPersistedBrushPreset({
					uid: docPreset.uid,
					name: docPreset.name,
					defaultSettings: presetSettings,
					file: sourceFile,
					sourceBuiltinUid: builtinFileMap.has(presetTextureUid)
						? (presetTextureUid as BuiltinBrushId)
						: undefined,
				});
				const existingPreset = await brushPresetsRepo.get(docPreset.uid);

				if (
					existingPreset &&
					isSamePersistedBrushPreset(existingPreset, nextPreset)
				) {
					continue;
				}

				await brushPresetsRepo.save(
					existingPreset
						? {
								...nextPreset,
								uid: generateUid("brush-preset"),
								createdAt: Date.now(),
								updatedAt: Date.now(),
							}
						: nextPreset,
				);
				hasChanges = true;
			}

			if (!signal.aborted && hasChanges) {
				await refreshPersistedPresets();
			}
		},
		[
			currentDocumentId,
			docSnap.document.brushPresets,
			docSnap.document.files,
			refreshPersistedPresets,
		],
	);

	const customTextureFiles = useMemo(() => {
		return docSnap.document.files.filter(
			(file) =>
				!isBuiltinTextureUid(file.uid) &&
				file.uid !== BUILTIN_BRUSH_IDS.svg &&
				file.type.startsWith("image/"),
		);
	}, [docSnap.document.files]);

	// Read through the snapshot so this hook re-runs on brush edits; the
	// getter hands back the stored settings object.
	const brushTextureFileUid = toolSnap.strokeAppearance?.paramData.params
		.brushSettings
		? (resolveBrushTextureUid(tools.storedBrushSettings) ?? undefined)
		: undefined;

	const currentCustomTextureFile = useMemo(() => {
		if (
			!brushTextureFileUid ||
			isBuiltinTextureUid(brushTextureFileUid) ||
			brushTextureFileUid === BUILTIN_BRUSH_IDS.svg
		) {
			return null;
		}

		return (
			customTextureFiles.find((file) => file.uid === brushTextureFileUid) ??
			null
		);
	}, [customTextureFiles, brushTextureFileUid]);

	const activePersistedPreset =
		persistedPresets.find(
			(preset) => preset.uid === uiSnap.selectedBrushPresetUid,
		) ?? null;
	const activeBuiltinPreset =
		builtinPresets.find(
			(preset) => preset.uid === uiSnap.selectedBrushPresetUid,
		) ?? null;
	const builtinPresetPreviewSources = useMemo(() => {
		return new Map(
			builtinPresets.map((preset) => {
				const textureUid = resolveBrushTextureUid(preset.settings);
				return [
					preset.uid,
					createBuiltinBrushPreviewSource(
						preset,
						builtinFiles.find((file) => file.uid === textureUid) ?? null,
					),
				];
			}),
		);
	}, [builtinFiles, builtinPresets]);
	const persistedPresetPreviewSources = useMemo(() => {
		return new Map(
			persistedPresets.map((preset) => [
				preset.uid,
				createPersistedBrushPreviewSource(preset),
			]),
		);
	}, [persistedPresets]);
	const activePresetPreviewSource =
		(activePersistedPreset
			? persistedPresetPreviewSources.get(activePersistedPreset.uid)
			: activeBuiltinPreset
				? builtinPresetPreviewSources.get(activeBuiltinPreset.uid)
				: null) ?? null;

	const applyBrushPreset = useEventCallback(async (presetUid: string) => {
		// A preset carries no width (see withoutStoredBrushSize), so the user's
		// working width is carried over onto the preset's settings.
		const currentSize = readStoredBrushSize(tools.storedBrushSettings);
		const keepWidth = <T>(settings: T): T =>
			currentSize != null
				? withStoredBrushSize(settings, currentSize)
				: settings;

		const builtinPreset = builtinPresets.find(
			(preset) => preset.uid === presetUid,
		);
		if (builtinPreset) {
			// Builtin preset settings already reference their builtin texture source.
			tools.setBrushSettings(keepWidth(builtinPreset.settings));
			setSelectedBrushPresetUid(builtinPreset.uid);
			return;
		}

		const preset =
			persistedPresets.find((item) => item.uid === presetUid) ??
			(await brushPresetsRepo.get(presetUid));
		if (!preset) return;

		const textureFileUid = materializeBrushPresetTexture({
			preset,
			addEmbeddedFile: (file) => commands.addEmbeddedFile(file),
		});

		tools.setBrushSettings(
			keepWidth(withTextureFileUid(preset.defaultSettings, textureFileUid)),
		);
		setSelectedBrushPresetUid(preset.uid);
	});

	const applyBuiltinTexture = useEventCallback(
		(textureFileUid: BuiltinBrushId) => {
			tools.setBrushSettings({
				tipSource: { kind: "file", fileUid: textureFileUid },
			});
			setSelectedBrushPresetUid(null);
		},
	);

	const importCustomTexture = useEventCallback(async () => {
		const handle = await FileSystem.openFileDialog({
			id: "brush-texture-import",
			types: [
				{
					description: "Image Files",
					accept: { "image/*": [".png", ".jpg", ".jpeg", ".webp"] },
				},
			],
		});
		if (!handle) return;

		const embeddedFile = await createBrushTextureFile(handle.file);
		const textureFileUid = commands.addEmbeddedFile(embeddedFile);

		tools.setBrushSettings({
			tipSource: { kind: "file", fileUid: textureFileUid },
		});
		setSelectedBrushPresetUid(null);
	});

	const saveCurrentBrushPreset = useEventCallback(async (name: string) => {
		const source = await resolveCurrentTextureSource({
			builtinFiles,
			documentFiles: store.document.files,
			textureFileUid: resolveBrushTextureUid(tools.storedBrushSettings),
		});
		if (!source) return null;

		const preset = createPersistedBrushPreset({
			name,
			defaultSettings: createBrushPresetDefaults(tools.storedBrushSettings),
			file: source.file,
			sourceBuiltinUid: source.sourceBuiltinUid,
		});

		await brushPresetsRepo.save(preset);
		await refreshPersistedPresets();
		setSelectedBrushPresetUid(preset.uid);
		return preset.uid;
	});

	const duplicateBrushPreset = useEventCallback(async (presetUid: string) => {
		const persistedPreset =
			persistedPresets.find((preset) => preset.uid === presetUid) ??
			(await brushPresetsRepo.get(presetUid));
		if (persistedPreset) {
			const nextPreset = clonePersistedBrushPreset(
				persistedPreset,
				createDuplicatedPresetName(
					persistedPreset.name,
					t("toolbar.duplicateSuffix"),
				),
			);
			await brushPresetsRepo.save(nextPreset);
			await refreshPersistedPresets();
			setSelectedBrushPresetUid(nextPreset.uid);
			return nextPreset.uid;
		}

		const builtinPreset = builtinPresets.find(
			(preset) => preset.uid === presetUid,
		);
		if (!builtinPreset) return null;

		const builtinTextureUid = resolveBrushTextureUid(builtinPreset.settings);
		const builtinFilesList = await getBuiltinBrushFiles();
		const builtinFile = builtinFilesList.find(
			(file) => file.uid === builtinTextureUid,
		);
		if (!builtinFile || !builtinTextureUid) return null;

		const nextPreset = createPersistedBrushPreset({
			name: createDuplicatedPresetName(
				builtinPreset.name,
				t("toolbar.duplicateSuffix"),
			),
			defaultSettings: builtinPreset.settings,
			file: builtinFile,
			sourceBuiltinUid: builtinTextureUid as BuiltinBrushId,
		});

		await brushPresetsRepo.save(nextPreset);
		await refreshPersistedPresets();
		setSelectedBrushPresetUid(nextPreset.uid);
		return nextPreset.uid;
	});

	const updateBrushPreset = useEventCallback(async (presetUid: string) => {
		const existingPreset =
			persistedPresets.find((p) => p.uid === presetUid) ??
			(await brushPresetsRepo.get(presetUid));
		if (!existingPreset) return;

		const source = await resolveCurrentTextureSource({
			builtinFiles,
			documentFiles: store.document.files,
			textureFileUid: resolveBrushTextureUid(tools.storedBrushSettings),
		});
		if (!source) return;

		const updatedPreset = createPersistedBrushPreset({
			uid: existingPreset.uid,
			name: existingPreset.name,
			defaultSettings: createBrushPresetDefaults(tools.storedBrushSettings),
			file: source.file,
			sourceBuiltinUid: source.sourceBuiltinUid,
			createdAt: existingPreset.createdAt,
			updatedAt: Date.now(),
		});

		await brushPresetsRepo.save(updatedPreset);
		await refreshPersistedPresets();
		setSelectedBrushPresetUid(presetUid);
	});

	const renameBrushPreset = useEventCallback(
		async (presetUid: string, name: string) => {
			const trimmedName = name.trim();
			if (!trimmedName) return;
			await brushPresetsRepo.rename(presetUid, trimmedName);
			await refreshPersistedPresets();
		},
	);

	const deleteBrushPreset = useEventCallback(async (presetUid: string) => {
		await brushPresetsRepo.delete(presetUid);
		await refreshPersistedPresets();
		if (uiSnap.selectedBrushPresetUid === presetUid) {
			setSelectedBrushPresetUid(null);
		}
	});

	const importPapbToBrushPresets = useEventCallback(async () => {
		const handle = await FileSystem.openFileDialog({
			id: "papb-import",
			types: [
				{
					description: "Paplico Brush Preset",
					accept: { "application/octet-stream": [".papb"] },
				},
			],
		});
		if (!handle) return null;

		const payload = parsePapb(await handle.file.arrayBuffer());
		const existingPreset = await brushPresetsRepo.get(payload.brushPreset.uid);
		const importedPreset = existingPreset
			? {
					...payload.brushPreset,
					uid: generateUid("brush-preset"),
					createdAt: Date.now(),
					updatedAt: Date.now(),
				}
			: {
					...payload.brushPreset,
					updatedAt: Date.now(),
				};

		await brushPresetsRepo.save(importedPreset);
		await refreshPersistedPresets();
		return importedPreset.uid;
	});

	const exportBrushPresetAsPapb = useEventCallback(
		async (presetUid: string) => {
			const preset =
				persistedPresets.find((item) => item.uid === presetUid) ??
				(await brushPresetsRepo.get(presetUid));
			if (!preset) return;

			const bytes = serializePapb(preset);
			const arrayBuffer = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			) as ArrayBuffer;
			const blob = new Blob([arrayBuffer], {
				type: "application/octet-stream",
			});
			await FileSystem.exportFile(
				blob,
				`${preset.name || "brush-preset"}.papb`,
			);
		},
	);

	return {
		builtinFiles,
		builtinPresets,
		persistedPresets,
		customTextureFiles,
		currentCustomTextureFile,
		activePersistedPreset,
		activeBuiltinPreset,
		activePresetPreviewSource,
		selectedBrushPresetUid: uiSnap.selectedBrushPresetUid,
		applyBrushPreset,
		applyBuiltinTexture,
		importCustomTexture,
		saveCurrentBrushPreset,
		updateBrushPreset,
		duplicateBrushPreset,
		renameBrushPreset,
		deleteBrushPreset,
		importPapbToBrushPresets,
		exportBrushPresetAsPapb,
		refreshPersistedPresets,
		getBuiltinPresetPreviewSource: (presetUid: string) =>
			builtinPresetPreviewSources.get(presetUid) ?? null,
		getPersistedPresetPreviewSource: (presetUid: string) =>
			persistedPresetPreviewSources.get(presetUid) ?? null,
	};
}

export function materializeBrushPresetTexture({
	preset,
	addEmbeddedFile,
	createFileUid = () => generateUid("file"),
}: {
	preset: PersistedBrushPreset;
	addEmbeddedFile: (file: EmbeddedFile) => string;
	createFileUid?: () => string;
}): string {
	return addEmbeddedFile(
		createEmbeddedFileFromBrushPreset(preset, createFileUid()),
	);
}

async function resolveCurrentTextureSource({
	builtinFiles,
	documentFiles,
	textureFileUid,
}: {
	builtinFiles: EmbeddedFile[];
	documentFiles: EmbeddedFile[];
	textureFileUid: string | null;
}): Promise<{ file: EmbeddedFile; sourceBuiltinUid?: BuiltinBrushId } | null> {
	if (textureFileUid == null || textureFileUid === BUILTIN_BRUSH_IDS.svg) {
		return null;
	}

	const builtinFile =
		builtinFiles.find((file) => file.uid === textureFileUid) ??
		(await getBuiltinBrushFiles()).find((file) => file.uid === textureFileUid);
	if (builtinFile) {
		return {
			file: builtinFile,
			sourceBuiltinUid: builtinFile.uid as BuiltinBrushId,
		};
	}

	const customFile = documentFiles.find((file) => file.uid === textureFileUid);
	if (!customFile) {
		return null;
	}

	return { file: customFile };
}

function isBuiltinTextureUid(
	textureFileUid: string,
): textureFileUid is BuiltinBrushId {
	return Object.values(BUILTIN_BRUSH_IDS).includes(
		textureFileUid as BuiltinBrushId,
	);
}

function createDuplicatedPresetName(name: string, suffix: string): string {
	return `${name} ${suffix}`.trim();
}

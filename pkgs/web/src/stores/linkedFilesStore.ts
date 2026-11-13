import type { Paplico } from "@paplico/core";
import { createEmbeddedImageFile } from "@paplico/core/document";
import type {
	AnyArtObject,
	Document,
	EmbeddedFile,
} from "@paplico/core/schema";
import { proxy, type Snapshot, snapshot } from "valtio";
import { FileSystem, nativePathOf } from "@/infra/filesystem";
import {
	fileName,
	isLocalPath,
	type LinkedImageStat,
	readLinkedImage,
	resolveLinkedSourcePath,
	statLinkedImages,
	toLinkedSourcePath,
} from "@/infra/linkedFiles.tauri";
import { documentPath, documentSessionState } from "./documentSessionStore";

/** How a linked file differs from the bytes the document holds. */
type LinkedFileStatus = "missing" | "changed";

/** The part of a document that says which files its elements show. */
type AssetSource = Snapshot<Pick<Document, "objects" | "references3d">>;

/**
 * Image types the app links to and takes as a replacement, by file
 * extension. `read_linked_image` of the desktop app accepts the same
 * extensions; keep pkgs/desktop/src-tauri/src/linked_files.rs equal to this.
 */
const LINKED_IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	avif: "image/avif",
};

/** Linked files that differ from their source, by EmbeddedFile.uid. */
export const linkedFilesState = proxy<{
	status: Record<string, LinkedFileStatus>;
}>({ status: {} });

/**
 * What the last check read from the source of each linked file, by
 * EmbeddedFile.uid. A source whose path, date and size still match is not
 * read again.
 */
const seenSources = new Map<
	string,
	LinkedImageStat & { path: string; hash: string }
>();

/** The document session `seenSources` belongs to. */
let seenIdentity: string | null = null;

/**
 * Places images dropped from the OS at a viewport position in CSS pixels,
 * each linked to the file it came from.
 */
export async function placeDroppedImages(
	paplico: Paplico,
	paths: string[],
	position: { x: number; y: number },
): Promise<void> {
	for (const path of paths) {
		const type = linkedImageType(path);
		if (!type) continue;

		const file = await readLinkedImage(path, { name: fileName(path), type });
		if (!file) continue;

		await paplico.dropImageFile(
			file,
			position.x,
			position.y,
			toLinkedSourcePath(path, documentPath()),
		);
	}
}

/**
 * Compares the linked files the elements show with their sources and records
 * the outcome in `linkedFilesState`. Returns the files whose source now holds
 * other bytes, each with the hash of those bytes. A check that another
 * document opened during records and returns nothing.
 */
export async function checkLinkedFiles(
	paplico: Paplico,
): Promise<Array<{ file: EmbeddedFile; sourceHash: string }>> {
	const { identity } = documentSessionState;
	if (seenIdentity !== identity) {
		seenSources.clear();
		seenIdentity = identity;
	}

	const { document } = snapshot(paplico.uiState);
	const used = collectAssetFileUids(document);
	const fromPath = documentPath();
	const linked = document.files
		.filter((file) => file.sourcePath && used.has(file.uid))
		.map((file) => ({ file, path: readablePath(file, fromPath) }));
	const stats = await statLinkedImages(
		linked.flatMap(({ path }) => (path === null ? [] : [path])),
	);

	const status: Record<string, LinkedFileStatus> = {};
	const changed: Array<{ file: EmbeddedFile; sourceHash: string }> = [];
	let statIndex = 0;

	for (const { file, path } of linked) {
		const stat = path === null ? null : stats[statIndex++];
		const hash = path && stat && (await sourceHash(file, path, stat));
		if (!hash) {
			status[file.uid] = "missing";
			continue;
		}
		if (hash === file.hash) continue;

		status[file.uid] = "changed";
		changed.push({ file: file as EmbeddedFile, sourceHash: hash });
	}

	if (documentSessionState.identity !== identity) return [];

	linkedFilesState.status = status;
	return changed;
}

/** Shows the current bytes of the source in every image that uses the file. */
export async function updateLinkedFile(
	paplico: Paplico,
	file: EmbeddedFile,
): Promise<void> {
	const path = readablePath(file, documentPath());
	const source =
		path && (await readLinkedImage(path, { name: file.name, type: file.type }));
	if (!source) return;

	replaceFile(paplico, file.uid, {
		...(await createEmbeddedImageFile(source)),
		sourcePath: file.sourcePath,
	});
}

/**
 * Lets the user pick the image that takes the place of `file`. A linked file
 * stays linked, to the picked image, where the platform names its path.
 */
export async function replaceAssetFile(
	paplico: Paplico,
	file: EmbeddedFile,
): Promise<void> {
	const picked = await FileSystem.openFileDialog({
		id: "asset-replace",
		types: [
			{
				description: "Image Files",
				accept: {
					"image/*": Object.keys(LINKED_IMAGE_TYPES).map(
						(extension): `.${string}` => `.${extension}`,
					),
				},
			},
		],
	});
	if (!picked) return;

	const path = nativePathOf(picked);
	const image = new File([picked.file], picked.file.name, {
		type: picked.file.type || linkedImageType(picked.file.name) || file.type,
	});
	replaceFile(paplico, file.uid, {
		...(await createEmbeddedImageFile(image)),
		sourcePath:
			file.sourcePath && path
				? toLinkedSourcePath(path, documentPath())
				: undefined,
	});
}

/**
 * Uids of the files the elements of a document show: images and the models
 * of 3D scenes. Brush textures are left out.
 */
export function collectAssetFileUids(document: AssetSource): Set<string> {
	return new Set(
		Object.values(document.objects).flatMap((element) =>
			assetFileUidsOf(element, document),
		),
	);
}

/**
 * Ids of the elements that show the file `uid`: its images and the 3D
 * elements whose scene holds it as a model.
 */
export function collectAssetElementIds(
	document: AssetSource,
	uid: string,
): string[] {
	return Object.values(document.objects)
		.filter((element) => assetFileUidsOf(element, document).includes(uid))
		.map((element) => element.id);
}

/** Uids of the files one element shows. */
function assetFileUidsOf(
	element: Snapshot<AnyArtObject>,
	document: AssetSource,
): string[] {
	if (element.type === "image") return [element.fileUid];
	if (element.type !== "reference3d") return [];

	return (document.references3d?.[element.sceneId]?.nodes ?? []).flatMap(
		(node) => (node.kind === "primitive" ? [] : [node.fileUid]),
	);
}

/** The MIME type of an image the app links to, or undefined for any other file. */
function linkedImageType(path: string): string | undefined {
	return LINKED_IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
}

/**
 * The native path the source of a linked file is read from. `null` when the
 * path cannot be resolved, and for a stored path that may start at another
 * machine: a document could name any server there, and reading connects to
 * it. A relative path from a document on a shared folder is still read.
 */
function readablePath(
	file: Pick<EmbeddedFile, "sourcePath">,
	fromPath: string | null,
): string | null {
	if (!file.sourcePath || !isLocalPath(file.sourcePath)) return null;
	return resolveLinkedSourcePath(file.sourcePath, fromPath);
}

/**
 * The hash of the bytes at the source of a linked file, read only when the
 * source changed since the last check. `null` when it cannot be read.
 */
async function sourceHash(
	file: Pick<EmbeddedFile, "uid" | "name" | "type">,
	path: string,
	stat: LinkedImageStat,
): Promise<string | null> {
	const seen = seenSources.get(file.uid);
	if (
		seen?.path === path &&
		seen.modifiedAt === stat.modifiedAt &&
		seen.size === stat.size
	) {
		return seen.hash;
	}

	const source = await readLinkedImage(path, {
		name: file.name,
		type: file.type,
	});
	if (!source) return null;

	const { hash } = await createEmbeddedImageFile(source);
	seenSources.set(file.uid, { ...stat, path, hash });
	return hash;
}

/**
 * Shows `replacement` in every image that uses the file `uid`. Nothing
 * happens when the document holding the file was closed while the
 * replacement was being read or picked.
 */
function replaceFile(
	paplico: Paplico,
	uid: string,
	replacement: EmbeddedFile,
): void {
	if (!paplico.uiState.document.files.some((file) => file.uid === uid)) return;

	paplico.commands.replaceEmbeddedFile(uid, replacement);

	delete linkedFilesState.status[uid];
}

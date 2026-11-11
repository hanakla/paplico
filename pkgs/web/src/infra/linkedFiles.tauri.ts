/** What tells an edited linked image from an untouched one without reading it. */
export interface LinkedImageStat {
	/** Milliseconds since the Unix epoch. */
	modifiedAt: number;
	size: number;
}

/**
 * Reads a linked image from a native path as a file of the given name and
 * type. `null` when the file cannot be read.
 */
export async function readLinkedImage(
	path: string,
	{ name, type }: { name: string; type: string },
): Promise<File | null> {
	const { invoke } = await import("@tauri-apps/api/core");

	try {
		// A raw response arrives as an ArrayBuffer over the custom protocol and
		// as a number array over the postMessage fallback
		const body = await invoke<ArrayBuffer | number[]>("read_linked_image", {
			path,
		});
		const bytes = Array.isArray(body) ? new Uint8Array(body) : body;
		return new File([bytes], name, { type });
	} catch {
		return null;
	}
}

/**
 * Stats linked images by native path, in the order of `paths`. `null` stands
 * for an image that cannot be read.
 */
export async function statLinkedImages(
	paths: string[],
): Promise<Array<LinkedImageStat | null>> {
	if (paths.length === 0) return [];

	const { invoke } = await import("@tauri-apps/api/core");
	return invoke("stat_linked_images", { paths });
}

/**
 * The path to store for a linked file: relative to the folder of the
 * document file, or absolute while the document has no file or sits on
 * another drive.
 */
export function toLinkedSourcePath(
	filePath: string,
	documentPath: string | null,
): string {
	if (documentPath === null) return filePath;

	const from = segments(documentPath).slice(0, -1);
	const to = segments(filePath);
	if (from[0] !== to[0]) return filePath;

	const shared = from.findIndex((segment, i) => segment !== to[i]);
	const sharedLength = shared === -1 ? from.length : shared;

	return [
		...from.slice(sharedLength).map(() => ".."),
		...to.slice(sharedLength),
	].join("/");
}

/**
 * The native path a stored source path points at. `null` for a relative path
 * while the document has no file to start from.
 */
export function resolveLinkedSourcePath(
	sourcePath: string,
	documentPath: string | null,
): string | null {
	if (isAbsolutePath(sourcePath)) return sourcePath;
	if (documentPath === null) return null;

	const resolved = segments(documentPath).slice(0, -1);
	for (const segment of segments(sourcePath)) {
		if (segment === "..") resolved.pop();
		else resolved.push(segment);
	}
	return resolved.join("/");
}

/**
 * Whether a path names a folder on another machine: `\\server\share` or
 * `//server/share`. Reading one connects to that machine.
 */
export function isNetworkPath(path: string): boolean {
	return /^[/\\]{2}/.test(path);
}

function isAbsolutePath(path: string): boolean {
	return /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path);
}

/** Path segments; the first one is the root, empty for POSIX and the drive for Windows. */
function segments(path: string): string[] {
	return path.split(/[/\\]/);
}

/** The last segment of a native path, split at either kind of separator. */
export function fileName(path: string): string {
	return segments(path).at(-1) ?? path;
}

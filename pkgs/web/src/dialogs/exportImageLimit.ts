import type { Document, EmbeddedFile } from "@paplico/core/schema";

type PixelSize = { width: number; height: number };

/** Count the image files drawn by `document` whose longer side exceeds
 *  `maxSide`. The renderer draws such an image scaled down to that side. */
export async function countImagesOverSide(
	document: Pick<Document, "objects" | "files">,
	maxSide: number,
	readPixelSize: (
		file: EmbeddedFile,
	) => Promise<PixelSize | null> = readImagePixelSize,
): Promise<number> {
	const fileUids = new Set(
		Object.values(document.objects).flatMap((object) =>
			object.type === "image" ? [object.fileUid] : [],
		),
	);

	let count = 0;
	for (const file of document.files) {
		if (!fileUids.has(file.uid)) continue;
		const size = await readPixelSize(file);
		if (size && Math.max(size.width, size.height) > maxSide) count++;
	}
	return count;
}

const pixelSizeByHash = new Map<string, Promise<PixelSize | null>>();

/** Pixel size of an embedded image, or `null` when the browser cannot read it. */
function readImagePixelSize(file: EmbeddedFile): Promise<PixelSize | null> {
	let size = pixelSizeByHash.get(file.hash);
	if (!size) {
		size = loadPixelSize(file);
		pixelSizeByHash.set(file.hash, size);
	}
	return size;
}

// An <img> reports its size once the header is parsed. `createImageBitmap`
// would decode every pixel of an image that is too large to begin with.
function loadPixelSize(file: EmbeddedFile): Promise<PixelSize | null> {
	const url = URL.createObjectURL(
		new Blob([file.bin as BlobPart], { type: file.type }),
	);
	const { promise, resolve } = Promise.withResolvers<PixelSize | null>();
	const image = new Image();
	image.onload = () =>
		resolve({ width: image.naturalWidth, height: image.naturalHeight });
	image.onerror = () => resolve(null);
	image.src = url;
	return promise.finally(() => URL.revokeObjectURL(url));
}

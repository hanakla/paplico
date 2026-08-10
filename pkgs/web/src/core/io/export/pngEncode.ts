/**
 * Encode an ImageData into an image Blob through OffscreenCanvas. Single
 * definition of the putImageData → convertToBlob dance every exporter uses.
 */
export async function imageDataToBlob(
	imageData: ImageData,
	type = "image/png",
	quality?: number,
): Promise<Blob | null> {
	const canvas = new OffscreenCanvas(imageData.width, imageData.height);
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.putImageData(imageData, 0, 0);
	return canvas.convertToBlob({ type, quality });
}

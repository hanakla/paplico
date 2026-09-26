import { convertImageRgbToRgb } from "../../color/ColorEngine";

/** ICC profile to embed into an exported raster image. */
export interface OutputIccProfile {
	data: Uint8Array;
	name: string;
}

/**
 * Converts rendered pixels from the working space into the output profile's
 * space. Pixels pass through unchanged unless both profiles are known.
 */
export async function convertToOutputProfile(
	imageData: ImageData,
	iccProfile: OutputIccProfile | undefined,
	sourceProfileBytes: Uint8Array | undefined,
): Promise<ImageData> {
	if (!iccProfile || !sourceProfileBytes) return imageData;

	const converted = await convertImageRgbToRgb(imageData.data, {
		srcProfileBytes: sourceProfileBytes,
		dstProfileBytes: iccProfile.data,
		intent: "relative-colorimetric",
	});
	return new ImageData(
		new Uint8ClampedArray(
			converted.buffer as ArrayBuffer,
			converted.byteOffset,
			converted.length,
		),
		imageData.width,
		imageData.height,
	);
}

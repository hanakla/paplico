import type { EmbeddedFile } from "../schema";

/** カスタムブラシ画像のリサイズ段階（降順） */
const BRUSH_TEXTURE_STEPS = [1024, 768, 512, 256, 128] as const;

/**
 * ブラシ用画像ファイルを段階的にリサイズしてEmbeddedFileを生成する。
 * 元画像の長辺に基づき、それ以下で最大の段階サイズにリサイズ（アスペクト比保持）。
 */
export async function createBrushTextureFile(
	file: File,
): Promise<EmbeddedFile> {
	const original = await createImageBitmap(file);
	const longerSide = Math.max(original.width, original.height);
	const aspect = original.width / original.height;
	original.close();

	const targetLong =
		BRUSH_TEXTURE_STEPS.find((s) => s <= longerSide) ??
		BRUSH_TEXTURE_STEPS.at(-1)!;

	// Preserve aspect ratio: long side = targetLong, short side proportional (rounded to even)
	const resizeWidth =
		aspect >= 1 ? targetLong : Math.round((targetLong * aspect) / 2) * 2 || 2;
	const resizeHeight =
		aspect >= 1 ? Math.round(targetLong / aspect / 2) * 2 || 2 : targetLong;

	const resized = await createImageBitmap(file, {
		resizeWidth,
		resizeHeight,
	});

	const canvas = new OffscreenCanvas(resizeWidth, resizeHeight);
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(resized, 0, 0);
	resized.close();

	const blob = await canvas.convertToBlob({ type: "image/png" });
	const bin = new Uint8Array(await blob.arrayBuffer());

	const hashBuffer = await crypto.subtle.digest("SHA-256", bin);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

	return {
		uid: `file-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		name: file.name || "brush-texture",
		type: "image/png",
		hash,
		bin,
	};
}

export function normalizeBrushTextureMaskInPlace(
	data: Uint8ClampedArray,
	width?: number,
	height?: number,
): void {
	let hasTransparency = false;
	for (let i = 3; i < data.length; i += 4) {
		if (data[i] < 255) {
			hasTransparency = true;
			break;
		}
	}

	if (hasTransparency) {
		for (let i = 0; i < data.length; i += 4) {
			const mask = data[i + 3];
			data[i] = mask;
			data[i + 1] = mask;
			data[i + 2] = mask;
			data[i + 3] = 255;
		}
		return;
	}

	let invertLuminance = false;
	if (width && height && width > 1 && height > 1) {
		const corners = [
			0,
			(width - 1) * 4,
			(height - 1) * width * 4,
			((height - 1) * width + (width - 1)) * 4,
		];
		let cornerLuminanceSum = 0;
		for (const cornerIdx of corners) {
			cornerLuminanceSum +=
				(data[cornerIdx] + data[cornerIdx + 1] + data[cornerIdx + 2]) / 3;
		}
		invertLuminance = cornerLuminanceSum / corners.length > 127;
	}

	let maxMask = 0;
	for (let i = 0; i < data.length; i += 4) {
		const luminance = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
		const mask = invertLuminance ? 255 - luminance : luminance;
		if (mask > maxMask) maxMask = mask;

		data[i] = mask;
		data[i + 1] = mask;
		data[i + 2] = mask;
		data[i + 3] = 255;
	}

	if (maxMask > 0) return;

	// Fallback: if chosen direction produced a fully transparent mask, flip it.
	for (let i = 0; i < data.length; i += 4) {
		const luminance = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
		const mask = 255 - luminance;
		data[i] = mask;
		data[i + 1] = mask;
		data[i + 2] = mask;
		data[i + 3] = 255;
	}
}

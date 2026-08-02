/**
 * BrushTextureManager - ブラシテクスチャの読み込みと管理
 *
 * Base64エンコードされたPNGテクスチャをGPUTextureに変換し、
 * ブラシタイプごとにキャッシュする
 */

import { airBrush, pencil } from "../../../../assets";
import type { DefSourceResolver } from "../../../../brush/brushSource";
import { BUILTIN_BRUSH_IDS } from "../../../../schema";

// ビルトインブラシ（プログラム生成）のテクスチャサイズ
const BUILTIN_TEXTURE_SIZE = 128;

export class BrushTextureManager implements DefSourceResolver {
	private device: GPUDevice;
	private textureCache: Map<string, GPUTexture> = new Map();
	private textureSizes: Map<string, { width: number; height: number }> =
		new Map();
	/** defId → currently registered rasterized texture uid (`def:…`). */
	private defAliases = new Map<string, string>();
	/** Uids whose GPUTexture is owned by DefRasterizer — never destroyed here. */
	private defOwnedUids = new Set<string>();
	private sampler: GPUSampler;
	private initialized = false;

	public constructor(device: GPUDevice) {
		this.device = device;
		this.sampler = device.createSampler({
			magFilter: "linear",
			minFilter: "linear",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		});
	}

	/**
	 * デフォルトのブラシテクスチャを読み込む
	 */
	public async loadDefaultTextures(): Promise<void> {
		if (this.initialized) return;

		try {
			await Promise.all([
				this.loadFromBase64(BUILTIN_BRUSH_IDS.pencil, pencil),
				this.loadFromBase64(BUILTIN_BRUSH_IDS.airbrush, airBrush),
			]);
		} catch (error) {
			// In Node.js test environment, createImageBitmap and copyExternalImageToTexture may not be fully supported
			// Skip base64 texture loading but continue with programmatic texture generation
			console.warn(
				"Failed to load base64 brush textures (expected in test environment):",
				error,
			);
		}

		this.createHardCircleTexture(
			BUILTIN_BRUSH_IDS.hardCircle,
			BUILTIN_TEXTURE_SIZE,
		);
		this.createSoftCircleTexture(
			BUILTIN_BRUSH_IDS.softCircle,
			BUILTIN_TEXTURE_SIZE,
		);

		this.initialized = true;
	}

	/**
	 * Base64エンコードされたPNGをGPUTextureに変換
	 */
	private async loadFromBase64(key: string, base64: string): Promise<void> {
		// Base64 → Uint8Array
		const binaryString = atob(base64);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		const blob = new Blob([bytes], { type: "image/png" });
		const imageBitmap = await createImageBitmap(blob);

		const texture = this.device.createTexture({
			label: `brush-texture-${key}`,
			size: [imageBitmap.width, imageBitmap.height, 1],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				// COPY_SRC: BrushTextureArrayBuilder copies brush textures into
				// the scatter/start/end texture array.
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});

		try {
			this.device.queue.copyExternalImageToTexture(
				{ source: imageBitmap },
				{ texture },
				[imageBitmap.width, imageBitmap.height],
			);
		} catch {
			// Node.js webgpu package doesn't support copyExternalImageToTexture with ImageBitmap polyfill.
			// Decode PNG with pngjs and write raw RGBA pixels via writeTexture instead.
			const { PNG } = await import("pngjs");
			const png = PNG.sync.read(Buffer.from(bytes));
			const pixelData = Uint8Array.from(png.data);
			this.device.queue.writeTexture(
				{ texture },
				pixelData,
				{
					bytesPerRow: png.width * 4,
					rowsPerImage: png.height,
				},
				[png.width, png.height, 1],
			);
		}

		this.textureCache.set(key, texture);
		this.textureSizes.set(key, {
			width: imageBitmap.width,
			height: imageBitmap.height,
		});
		imageBitmap.close();
	}

	/**
	 * ハードエッジ円形テクスチャをプログラム生成
	 * 従来のソリッドライン相当（グラデーションなし）
	 */
	private createHardCircleTexture(key: string, size: number): void {
		const data = new Uint8Array(size * size * 4);
		const center = size / 2;
		const radius = size / 2 - 1;

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const dx = x - center + 0.5;
				const dy = y - center + 0.5;
				const dist = Math.sqrt(dx * dx + dy * dy);

				// ハードエッジ: 半径内は完全に不透明
				const alpha = dist <= radius ? 255 : 0;

				const idx = (y * size + x) * 4;
				// シェーダーの輝度ベースアルファ変換に合わせる
				data[idx] = alpha; // R
				data[idx + 1] = alpha; // G
				data[idx + 2] = alpha; // B
				data[idx + 3] = 255; // A (常に不透明、輝度で制御)
			}
		}

		const texture = this.device.createTexture({
			label: `brush-texture-${key}`,
			size: [size, size, 1],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC,
		});

		this.device.queue.writeTexture(
			{ texture },
			data,
			{ bytesPerRow: size * 4, rowsPerImage: size },
			[size, size, 1],
		);

		this.textureCache.set(key, texture);
		this.textureSizes.set(key, { width: size, height: size });
	}

	/**
	 * ソフトサークルテクスチャをプログラム生成
	 * ガウシアン風のフォールオフを持つ円形グラデーション
	 */
	private createSoftCircleTexture(key: string, size: number): void {
		const data = new Uint8Array(size * size * 4);
		const center = size / 2;

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const dx = (x - center + 0.5) / center;
				const dy = (y - center + 0.5) / center;
				const dist = Math.sqrt(dx * dx + dy * dy);

				// ガウシアン風のフォールオフ（シグマ = 0.4程度）
				// dist=0でalpha=1、dist=1でalpha≈0
				const sigma = 0.4;
				const alpha =
					dist < 1 ? Math.exp((-dist * dist) / (2 * sigma * sigma)) : 0;
				const alphaU8 = Math.round(alpha * 255);

				const idx = (y * size + x) * 4;
				// 輝度ベースのアルファ変換に合わせてRGB=白、A=alphaで格納
				// シェーダーで (R+G+B)/3 = 1.0 * alpha となる
				data[idx] = alphaU8; // R
				data[idx + 1] = alphaU8; // G
				data[idx + 2] = alphaU8; // B
				data[idx + 3] = 255; // A (常に不透明、輝度で制御)
			}
		}

		const texture = this.device.createTexture({
			label: `brush-texture-${key}`,
			size: [size, size, 1],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC,
		});

		this.device.queue.writeTexture(
			{ texture },
			data,
			{ bytesPerRow: size * 4, rowsPerImage: size },
			[size, size, 1],
		);

		this.textureCache.set(key, texture);
		this.textureSizes.set(key, { width: size, height: size });
	}

	/**
	 * ブラシタイプに対応するテクスチャを取得
	 */
	public getTexture(uid: string): GPUTexture | null {
		return this.textureCache.get(uid) ?? null;
	}

	public hasTexture(uid: string): boolean {
		return this.textureCache.has(uid);
	}

	public getTextureSize(uid: string): { width: number; height: number } | null {
		return this.textureSizes.get(uid) ?? null;
	}

	/** Returns width/height ratio. Falls back to 1.0 for unknown textures. */
	public getTextureAspectRatio(uid: string): number {
		const size = this.textureSizes.get(uid);
		if (!size) return 1.0;
		return size.width / size.height;
	}

	/** Load a brush texture from an embedded file's binary data */
	public async loadFromEmbeddedFile(
		uid: string,
		bin: Uint8Array<ArrayBuffer>,
		mimeType = "image/png",
	): Promise<void> {
		const blob = new Blob([bin], { type: mimeType });
		const imageBitmap = await createImageBitmap(blob);
		const source = imageBitmap;

		const texture = this.device.createTexture({
			label: `brush-texture-${uid}`,
			size: [imageBitmap.width, imageBitmap.height, 1],
			format: "rgba8unorm",
			usage:
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_DST |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.RENDER_ATTACHMENT,
		});

		this.device.queue.copyExternalImageToTexture({ source }, { texture }, [
			imageBitmap.width,
			imageBitmap.height,
		]);

		this.textureCache.set(uid, texture);
		this.textureSizes.set(uid, {
			width: imageBitmap.width,
			height: imageBitmap.height,
		});
		imageBitmap.close();
	}

	/**
	 * Register a DefRasterizer-rasterized texture so the stamp/ribbon pipelines
	 * can bind it like any other brush texture. Ownership stays with
	 * DefRasterizer — removal paths here never call `texture.destroy()`.
	 */
	public registerDefTexture(
		defId: string,
		textureUid: string,
		texture: GPUTexture,
		width: number,
		height: number,
	): void {
		this.textureCache.set(textureUid, texture);
		this.textureSizes.set(textureUid, { width, height });
		this.defOwnedUids.add(textureUid);
		this.defAliases.set(defId, textureUid);
	}

	/**
	 * Drop a def texture from the cache maps (called when DefRasterizer evicts
	 * or invalidates the entry). The texture itself is destroyed by its owner.
	 */
	public removeDefTexture(textureUid: string): void {
		this.textureCache.delete(textureUid);
		this.textureSizes.delete(textureUid);
		this.defOwnedUids.delete(textureUid);
		for (const [defId, uid] of this.defAliases) {
			if (uid === textureUid) this.defAliases.delete(defId);
		}
	}

	/** DefSourceResolver: translate a def id to its live rasterized texture uid. */
	public resolveDefTextureUid(defId: string): string | null {
		const uid = this.defAliases.get(defId);
		if (!uid) return null;
		return this.textureCache.has(uid) ? uid : null;
	}

	/**
	 * サンプラーを取得
	 */
	public getSampler(): GPUSampler {
		return this.sampler;
	}

	/**
	 * リソースを解放
	 */
	public destroy(): void {
		for (const [uid, texture] of this.textureCache) {
			// Def textures are owned (and destroyed) by DefRasterizer.
			if (this.defOwnedUids.has(uid)) continue;
			texture.destroy();
		}
		this.textureCache.clear();
		this.textureSizes.clear();
		this.defAliases.clear();
		this.defOwnedUids.clear();
		this.initialized = false;
	}
}

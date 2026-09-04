import { proxy, snapshot } from "valtio";
import { describe, expect, it } from "vitest";
import {
	isPaplicoError,
	type PaplicoError,
	type PaplicoErrorCode,
} from "../../errors";
import type {
	BrushPreset,
	BrushSettings,
	Document,
	EmbeddedFile,
	Viewport,
} from "../../schema";
import { TRANSIENT_LAYER_KIND } from "../../schema";
import type { TimelapseData } from "../../timelapse/types";
import { openPapf, PapfFile } from "./reader";
import { Codec, FOOTER_BYTES, SECTION_HEADER_BYTES } from "./types";
import { serializeDocument } from "./writer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };

function makeMinimalDoc(overrides: Partial<Document> = {}): Document {
	return {
		id: "test-doc-id",
		objects: {},
		layers: [],
		viewport: defaultViewport,
		files: [],
		artboards: [],
		brushPresets: [],
		...overrides,
	};
}

function makeFile(
	uid: string,
	data: Uint8Array,
	mime = "application/octet-stream",
): EmbeddedFile {
	return {
		uid,
		name: `${uid}.bin`,
		type: mime,
		hash: `sha256-${uid}`,
		bin: data,
	};
}

function makeTimelapse(count: number): TimelapseData {
	return {
		version: 2,
		entries: Array.from({ length: count }, (_, i) => ({
			t: i * 100,
			u: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
		})),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PAPF format", () => {
	async function expectPapfErrorCode(
		promise: Promise<unknown>,
		code: PaplicoErrorCode,
	): Promise<void> {
		const error = await promise.then(
			() => null,
			(e: unknown) => e,
		);
		expect(isPaplicoError(error)).toBe(true);
		expect((error as PaplicoError).code).toBe(code);
	}

	describe("roundtrip", () => {
		it("serializes and deserializes a minimal document without files or timelapse", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.id).toBe("test-doc-id");
			expect(restored.layers).toEqual([]);
			expect(restored.files).toEqual([]);
			expect(restored.timelapse).toBeUndefined();
		});

		// rendererStore.document is a Valtio proxy in production.
		// structuredClone / deepClone on a proxy breaks TypedArrays or throws DataCloneError.
		// Paplico.exportDocument() uses snapshot() to unwrap the proxy first.
		// This test verifies that path works end-to-end.
		it("roundtrips a Valtio-proxied document via snapshot (matches exportDocument path)", async () => {
			const store = proxy({
				document: makeMinimalDoc({
					files: [makeFile("proxy-test", new Uint8Array([1, 2, 3]))],
				}),
			});

			const doc = {
				...snapshot(store).document,
				timelapse: undefined,
			};
			const blob = await serializeDocument(doc as Document);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.id).toBe("test-doc-id");
			expect(restored.files).toHaveLength(1);
			expect(restored.files[0].bin).toEqual(new Uint8Array([1, 2, 3]));
		});

		it("serializes and deserializes a document with embedded files", async () => {
			const fileA = makeFile("file-a", new Uint8Array([1, 2, 3, 4, 5]));
			const fileB = makeFile("file-b", new Uint8Array([10, 20, 30]));
			const doc = makeMinimalDoc({ files: [fileA, fileB] });

			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.files).toHaveLength(2);

			const restoredA = restored.files.find((f) => f.uid === "file-a")!;
			expect(restoredA.bin).toEqual(new Uint8Array([1, 2, 3, 4, 5]));

			const restoredB = restored.files.find((f) => f.uid === "file-b")!;
			expect(restoredB.bin).toEqual(new Uint8Array([10, 20, 30]));
		});

		it("serializes and deserializes a document with timelapse data", async () => {
			const timelapse = makeTimelapse(5);
			const doc = makeMinimalDoc({ timelapse });

			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.timelapse).toBeDefined();
			expect(restored.timelapse!.version).toBe(2);
			expect(restored.timelapse!.entries).toHaveLength(5);

			for (let i = 0; i < 5; i++) {
				expect(restored.timelapse!.entries[i].t).toBe(timelapse.entries[i].t);
				expect(restored.timelapse!.entries[i].u).toEqual(
					timelapse.entries[i].u,
				);
			}
		});

		it("should round-trip the timelapse dirty-rect index", async () => {
			const timelapse = makeTimelapse(3);
			timelapse.index = {
				rects: [[0, 0, 10, 10], null, [-5, -5, 5, 5]],
			};

			const blob = await serializeDocument(makeMinimalDoc({ timelapse }));
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.timelapse!.index).toEqual(timelapse.index);
		});

		it("should round-trip the positions where the recording starts over", async () => {
			const timelapse = makeTimelapse(4);
			timelapse.baselines = [2];

			const blob = await serializeDocument(makeMinimalDoc({ timelapse }));
			const restored = await (await openPapf(blob)).toDocument();

			// Losing these would replay a switched-away document on top of the
			// current one, stacking every layer twice.
			expect(restored.timelapse!.baselines).toEqual([2]);
		});

		it("should report no starting-over positions for an unbroken recording", async () => {
			const blob = await serializeDocument(
				makeMinimalDoc({ timelapse: makeTimelapse(3) }),
			);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.timelapse!.baselines).toBeUndefined();
		});

		it("should report no index when the recording predates it", async () => {
			const blob = await serializeDocument(
				makeMinimalDoc({ timelapse: makeTimelapse(3) }),
			);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.timelapse!.index).toBeUndefined();
		});

		it("should drop an index whose length disagrees with the entries", async () => {
			const timelapse = makeTimelapse(3);
			timelapse.index = { rects: [[0, 0, 10, 10]] };

			const blob = await serializeDocument(makeMinimalDoc({ timelapse }));
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.timelapse!.index).toBeUndefined();
		});

		it("should round-trip HDR settings through papf", async () => {
			const doc = makeMinimalDoc({
				hdr: { enabled: true, exposure: 1.5 },
			});

			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.hdr).toEqual({ enabled: true, exposure: 1.5 });
		});

		it("should round-trip color profile settings through papf", async () => {
			const doc = makeMinimalDoc({
				colorProfile: {
					workingSpace: "srgb",
					proofProfile: { kind: "builtin", id: "display-p3" },
					proofIntent: "perceptual",
				},
			});

			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.colorProfile).toEqual({
				workingSpace: "srgb",
				proofProfile: { kind: "builtin", id: "display-p3" },
				proofIntent: "perceptual",
			});
		});

		it("serializes and deserializes a document with files and timelapse", async () => {
			const doc = makeMinimalDoc({
				files: [makeFile("img", new Uint8Array([0xff, 0xd8]))],
				timelapse: makeTimelapse(3),
			});

			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.files).toHaveLength(1);
			expect(restored.timelapse!.entries).toHaveLength(3);
		});

		it("preserves file metadata (name, type, hash) through roundtrip", async () => {
			const file = makeFile("meta-test", new Uint8Array([42]), "image/png");
			file.name = "screenshot.png";
			file.hash = "sha256-deadbeef";

			const doc = makeMinimalDoc({ files: [file] });
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			const rf = restored.files[0];
			expect(rf.uid).toBe("meta-test");
			expect(rf.name).toBe("screenshot.png");
			expect(rf.type).toBe("image/png");
			expect(rf.hash).toBe("sha256-deadbeef");
		});
	});

	describe("reader validation", () => {
		it("rejects files that are too small", async () => {
			const tooSmall = new Blob([new Uint8Array(10)]);
			await expect(openPapf(tooSmall)).rejects.toThrow();
		});

		it("rejects files with invalid header magic", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const buf = new Uint8Array(await blob.arrayBuffer());
			buf[0] = 0x00; // corrupt PAPF magic
			const corrupted = new Blob([buf]);
			await expect(openPapf(corrupted)).rejects.toThrow();
		});

		it("rejects files with invalid footer magic", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const buf = new Uint8Array(await blob.arrayBuffer());
			// Footer is at the end, PEND magic is at buf.length - FOOTER_BYTES
			const footerStart = buf.length - FOOTER_BYTES;
			buf[footerStart] = 0x00; // corrupt PEND magic
			const corrupted = new Blob([buf]);
			await expect(openPapf(corrupted)).rejects.toThrow();
		});

		it("rejects files with CRC mismatch", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const buf = new Uint8Array(await blob.arrayBuffer());
			// CRC-32 is at footer offset + 20
			const footerStart = buf.length - FOOTER_BYTES;
			buf[footerStart + 20] ^= 0xff; // flip CRC bits
			const corrupted = new Blob([buf]);
			await expect(openPapf(corrupted)).rejects.toThrow();
		});
	});

	describe("coded errors", () => {
		it("should reject a file with tampered CRC with code PAPF_CORRUPTED", async () => {
			const blob = await serializeDocument(makeMinimalDoc());
			const buf = new Uint8Array(await blob.arrayBuffer());
			// tocPayloadCrc32 lives at footer offset 36
			const footerStart = buf.length - FOOTER_BYTES;
			buf[footerStart + 36] ^= 0xff;

			await expectPapfErrorCode(openPapf(new Blob([buf])), "PAPF_CORRUPTED");
		});

		it("should reject a file with invalid header magic with code PAPF_INVALID_FILE", async () => {
			const blob = await serializeDocument(makeMinimalDoc());
			const buf = new Uint8Array(await blob.arrayBuffer());
			buf[0] = 0x00; // corrupt "PAPF" magic

			await expectPapfErrorCode(openPapf(new Blob([buf])), "PAPF_INVALID_FILE");
		});

		it("should reject a newer TOC major version with code PAPF_UNSUPPORTED_VERSION", async () => {
			const blob = await serializeDocument(makeMinimalDoc());
			const buf = new Uint8Array(await blob.arrayBuffer());
			const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
			// tocSectionOffset lives at footer offset 12; the TOC payload begins
			// after the 16-byte section header, and tocMajor is its first uint16.
			const footerStart = buf.length - FOOTER_BYTES;
			const tocSectionOffset = Number(dv.getBigUint64(footerStart + 12, true));
			dv.setUint16(tocSectionOffset + SECTION_HEADER_BYTES, 2, true);

			await expectPapfErrorCode(
				openPapf(new Blob([buf])),
				"PAPF_UNSUPPORTED_VERSION",
			);
		});
	});

	describe("lazy loading", () => {
		it("openPapf returns PapfFile without loading file binaries", async () => {
			const doc = makeMinimalDoc({
				files: [makeFile("lazy-test", new Uint8Array(1024))],
			});
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			expect(papf).toBeInstanceOf(PapfFile);
			expect(papf.meta.fileManifest).toHaveLength(1);
			expect(papf.meta.fileManifest[0].uid).toBe("lazy-test");
		});

		it("getEmbeddedFile loads a specific file by UID", async () => {
			const doc = makeMinimalDoc({
				files: [
					makeFile("a", new Uint8Array([1])),
					makeFile("b", new Uint8Array([2])),
				],
			});
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			const fileB = await papf.getEmbeddedFile("b");
			expect(fileB.uid).toBe("b");
			expect(fileB.bin).toEqual(new Uint8Array([2]));
		});

		it("getTimelapseData returns null when no timelapse exists", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			const timelapse = await papf.getTimelapseData();
			expect(timelapse).toBeNull();
		});
	});

	describe("compression", () => {
		it("compresses META section with deflate", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			const metaEntry = papf.toc.metaEntry;
			expect(metaEntry.codec).toBe(Codec.Deflate);
		});

		it("does not compress already-compressed file types (png, jpeg)", async () => {
			const doc = makeMinimalDoc({
				files: [
					makeFile(
						"img",
						new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
						"image/png",
					),
				],
			});
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			const fileEntry = papf.toc.fileByUid.get("img")!;
			expect(fileEntry.codec).toBe(Codec.None);
		});

		it("compresses non-compressed file types with deflate", async () => {
			const doc = makeMinimalDoc({
				files: [
					makeFile("data", new Uint8Array([1, 2, 3]), "application/json"),
				],
			});
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);

			const fileEntry = papf.toc.fileByUid.get("data")!;
			expect(fileEntry.codec).toBe(Codec.Deflate);
		});
	});

	describe("error handling", () => {
		it("rejects files with size mismatch in footer", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const buf = new Uint8Array(await blob.arrayBuffer());
			// Corrupt fileBytes field in footer (offset 28 from footer start)
			const footerStart = buf.length - FOOTER_BYTES;
			buf[footerStart + 28] ^= 0x01;
			const corrupted = new Blob([buf]);
			await expect(openPapf(corrupted)).rejects.toThrow("fileBytes");
		});

		it("rejects files with version mismatch between header and footer", async () => {
			const doc = makeMinimalDoc();
			const blob = await serializeDocument(doc);
			const buf = new Uint8Array(await blob.arrayBuffer());
			// Corrupt formatMajor in footer (offset 4 from footer start)
			const footerStart = buf.length - FOOTER_BYTES;
			buf[footerStart + 4] = 99;
			const corrupted = new Blob([buf]);
			await expect(openPapf(corrupted)).rejects.toThrow("version mismatch");
		});
	});

	describe("edge cases", () => {
		it("handles a document with empty timelapse entries (no TMLB written)", async () => {
			const doc = makeMinimalDoc({
				timelapse: { version: 2, entries: [] },
			});
			const blob = await serializeDocument(doc);
			const papf = await openPapf(blob);
			const restored = await papf.toDocument();

			expect(restored.timelapse).toBeUndefined();
		});
	});

	describe("defs", () => {
		it("roundtrips Document.defs through serialize / open / toDocument", async () => {
			const doc = makeMinimalDoc({
				defs: {
					"def-1": {
						id: "def-1",
						kind: "pattern",
						name: "Stripes",
						rootElementIds: ["p1"],
						tile: { width: 128, height: 64 },
					},
					"def-2": {
						id: "def-2",
						kind: "vector-brush",
						rootElementIds: [],
					},
				},
			});

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.defs).toEqual(doc.defs);
		});

		it("defaults defs to {} when reading a legacy doc that never had the field", async () => {
			const doc = makeMinimalDoc();
			// makeMinimalDoc does not set defs intentionally.
			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();
			expect(restored.defs).toEqual({});
		});

		it("excludes transient layers (transientKind set) from the persisted output", async () => {
			const doc = makeMinimalDoc({
				layers: [
					{
						id: "layer-real",
						name: "Real",
						visible: true,
						locked: false,
						opacity: 1,
						elementIds: [],
					},
					{
						id: "layer-transient",
						name: "Pattern Edit",
						visible: true,
						locked: false,
						opacity: 1,
						elementIds: [],
						transientKind: TRANSIENT_LAYER_KIND.PATTERN_EDIT,
						ownerClientId: "peer-9",
					},
				],
			});

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();
			expect(restored.layers).toHaveLength(1);
			expect(restored.layers[0]!.id).toBe("layer-real");
		});
	});

	describe("object masks", () => {
		it("persists mask content that belongs to no layer", async () => {
			const doc = makeMinimalDoc({
				objects: {
					owner: {
						type: "image",
						id: "owner",
						opacity: 1,
						blendMode: "normal",
						fileUid: "file-1",
						x: 0,
						y: 0,
						width: 100,
						height: 100,
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
						mask: { elementIds: ["mask-shape"], inverted: true },
					},
					"mask-shape": {
						type: "path",
						id: "mask-shape",
						opacity: 1,
						blendMode: "normal",
						segments: [],
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
					},
				},
				layers: [
					{
						id: "layer-1",
						name: "Layer 1",
						visible: true,
						locked: false,
						opacity: 1,
						// "mask-shape" is deliberately absent: mask content is
						// reachable only through owner.mask.
						elementIds: ["owner"],
					},
				],
			});

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.objects["mask-shape"]).toBeDefined();
			expect(restored.objects.owner?.mask).toEqual({
				elementIds: ["mask-shape"],
				inverted: true,
			});
		});
	});

	describe("references3d", () => {
		it("roundtrips Document.references3d through serialize / open / toDocument", async () => {
			const doc = makeMinimalDoc({
				references3d: {
					"scene-1": {
						id: "scene-1",
						name: "Room",
						nodes: [
							{
								id: "node-box",
								kind: "primitive",
								shape: "box",
								transform: {
									position: [0, 0.5, 0],
									rotation: [0, 0, 0, 1],
									scale: [1, 1, 1],
								},
							},
							{
								id: "node-mesh",
								kind: "mesh",
								fileUid: "mesh-file",
								transform: {
									position: [0, 0, 0],
									rotation: [0, 0, 0, 1],
									scale: [1, 1, 1],
								},
							},
						],
					},
				},
			});

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.references3d).toEqual(doc.references3d);
		});

		it("defaults references3d to {} when reading a doc that never had the field", async () => {
			const doc = makeMinimalDoc();
			// makeMinimalDoc does not set references3d intentionally.
			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();
			expect(restored.references3d).toEqual({});
		});
	});

	describe("brush presets", () => {
		it("migrates a union preset to BrushSettings and round-trips it stably", async () => {
			const doc = makeMinimalDoc({
				brushPresets: [
					{
						uid: "brush-preset-v2",
						name: "Pen (SVG)",
						// Pre-v2 stored shape; the reader migrates it.
						settings: {
							type: "stroke",
							size: 4,
							sizeByPressure: 0.5,
							opacity: 1,
							opacityByPressure: 0.3,
							randomSeed: 0,
						} as unknown as BrushSettings,
					},
				],
			});

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.brushPresets).toHaveLength(1);
			const settings = restored.brushPresets[0]!.settings;
			if (!("version" in settings)) throw new Error("expected v2 settings");
			expect(settings.version).toBe(2);
			expect(settings.engine).toBe("geometric");
			expect(settings.properties.size?.base).toBe(4);

			// A second save/load cycle must be a fixed point (idempotent migration).
			const restoredTwice = await (
				await openPapf(await serializeDocument(restored))
			).toDocument();
			expect(restoredTwice.brushPresets[0]).toEqual(restored.brushPresets[0]);
		});

		it("migrates a pre-v2 preset (textureFileUid + defaultSettings) so it survives round-tripping", async () => {
			// Simulates a document saved before the V1BrushSettings union existed.
			// The writer always emits doc.brushPresets verbatim (it doesn't
			// re-shape them), so injecting a pre-v2 record here exercises
			// exactly what the reader's migration must convert.
			const legacyPreset = {
				uid: "brush-preset-legacy",
				name: "Legacy Ink",
				textureFileUid: "builtin-brush-soft-circle",
				defaultSettings: { size: 24, opacity: 0.8, spacing: 0.1, flow: 1 },
			} as unknown as BrushPreset;
			const doc = makeMinimalDoc({ brushPresets: [legacyPreset] });

			const blob = await serializeDocument(doc);
			const restored = await (await openPapf(blob)).toDocument();

			expect(restored.brushPresets).toHaveLength(1);
			const preset = restored.brushPresets[0]!;
			expect(preset.uid).toBe("brush-preset-legacy");
			const settings = preset.settings;
			if (!("version" in settings)) throw new Error("expected v2 settings");
			expect(settings.version).toBe(2);
			expect(settings.engine).toBe("dab");
			expect(settings.properties.size?.base).toBe(24);
			// opacity x flow folds into flow.base (design §13-8).
			expect(settings.properties.flow?.base).toBeCloseTo(0.8, 10);
			if (settings.tip?.kind !== "image") throw new Error("expected image tip");
			expect(settings.tip.sources[0]).toEqual({
				kind: "file",
				fileUid: "builtin-brush-soft-circle",
			});
			// The pre-v2 flat fields must not survive the migration.
			expect("defaultSettings" in preset).toBe(false);
			expect("textureFileUid" in preset).toBe(false);
		});
	});
});

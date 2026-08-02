import { initializeCanvas, readPsd, writePsd } from "ag-psd";
import { beforeAll, describe, expect, it } from "vitest";
import { injectIccProfileIntoPsd } from "./psdIcc";

const ICC_PROFILE_RESOURCE_ID = 1039;

describe("injectIccProfileIntoPsd", () => {
	// Odd length to exercise the even-padding of resource block data
	const profile = Uint8Array.from({ length: 137 }, (_, i) => (i * 7) % 256);

	beforeAll(() => {
		// happy-dom has no canvas codecs; give ag-psd a plain ImageData factory
		// so readPsd can decode pixel data without a real canvas.
		initializeCanvas(
			() => {
				throw new Error("createCanvas is not supported in tests");
			},
			(width, height) =>
				({
					width,
					height,
					data: new Uint8ClampedArray(width * height * 4),
				}) as ImageData,
		);
	});

	it("should throw on an invalid 8BPS signature", () => {
		expect(() => injectIccProfileIntoPsd(new Uint8Array(64), profile)).toThrow(
			"8BPS",
		);
	});

	it("should keep the PSD readable by ag-psd after injection", () => {
		const result = injectIccProfileIntoPsd(buildPsdFixture(), profile);

		const psd = readPsd(result, { useImageData: true });
		expect(psd.width).toBe(4);
		expect(psd.height).toBe(4);
		expect(psd.children?.length).toBe(1);
	});

	it("should store the profile in image resource 1039", () => {
		const result = injectIccProfileIntoPsd(buildPsdFixture(), profile);

		const blocks = parseResourceBlocks(result);
		const iccBlock = blocks.find((b) => b.id === ICC_PROFILE_RESOURCE_ID);
		expect(iccBlock?.data).toEqual(profile);
	});

	it("should place the ICC resource before the first higher resource ID", () => {
		const result = injectIccProfileIntoPsd(buildPsdFixture(), profile);

		const ids = parseResourceBlocks(result).map((b) => b.id);
		// Fixture provides resources below (1005) and above (1057) the ICC ID
		expect(ids).toContain(1005);
		expect(ids).toContain(ICC_PROFILE_RESOURCE_ID);
		expect(ids).toContain(1057);

		// ag-psd does not emit its own resources in ID order, so the full list
		// cannot be sorted; the ICC block goes ahead of the first higher ID.
		const iccIndex = ids.indexOf(ICC_PROFILE_RESOURCE_ID);
		expect(ids.slice(0, iccIndex)).toEqual(
			ids.slice(0, iccIndex).filter((id) => id < ICC_PROFILE_RESOURCE_ID),
		);
		expect(ids[iccIndex + 1]).toBeGreaterThan(ICC_PROFILE_RESOURCE_ID);
	});

	it("should replace an existing 1039 resource", () => {
		const otherProfile = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
		const once = injectIccProfileIntoPsd(buildPsdFixture(), profile);

		const twice = injectIccProfileIntoPsd(once, otherProfile);

		const iccBlocks = parseResourceBlocks(twice).filter(
			(b) => b.id === ICC_PROFILE_RESOURCE_ID,
		);
		expect(iccBlocks.length).toBe(1);
		expect(iccBlocks[0].data).toEqual(otherProfile);
		expect(readPsd(twice, { useImageData: true }).width).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a real 4x4 PSD via ag-psd with resources 1005 and 1057. */
function buildPsdFixture(): Uint8Array {
	const imageData = {
		width: 4,
		height: 4,
		data: new Uint8ClampedArray(4 * 4 * 4).fill(128),
	} as ImageData;

	const buffer = writePsd(
		{
			width: 4,
			height: 4,
			imageData,
			children: [{ name: "Layer 1", imageData }],
			imageResources: {
				resolutionInfo: {
					horizontalResolution: 72,
					horizontalResolutionUnit: "PPI",
					widthUnit: "Inches",
					verticalResolution: 72,
					verticalResolutionUnit: "PPI",
					heightUnit: "Inches",
				},
				versionInfo: {
					hasRealMergedData: true,
					writerName: "test",
					readerName: "test",
					fileVersion: 1,
				},
			},
		},
		{ generateThumbnail: false },
	);
	return new Uint8Array(buffer);
}

/** Parse 8BIM image resource blocks from a PSD byte stream. */
function parseResourceBlocks(psd: Uint8Array): {
	id: number;
	data: Uint8Array;
}[] {
	const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
	const colorModeDataLength = view.getUint32(26);
	const resourcesLengthOffset = 26 + 4 + colorModeDataLength;
	const resourcesLength = view.getUint32(resourcesLengthOffset);
	const resourcesEnd = resourcesLengthOffset + 4 + resourcesLength;

	const blocks: { id: number; data: Uint8Array }[] = [];
	let offset = resourcesLengthOffset + 4;

	while (offset < resourcesEnd) {
		const signature = String.fromCharCode(...psd.subarray(offset, offset + 4));
		expect(signature).toBe("8BIM");
		const id = view.getUint16(offset + 4);
		const nameLength = psd[offset + 6];
		const paddedNameLength =
			(1 + nameLength) % 2 ? 2 + nameLength : 1 + nameLength;
		const size = view.getUint32(offset + 6 + paddedNameLength);
		const dataStart = offset + 6 + paddedNameLength + 4;
		blocks.push({ id, data: psd.subarray(dataStart, dataStart + size) });
		offset = dataStart + size + (size % 2);
	}

	return blocks;
}

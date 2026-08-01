/**
 * PSD ICC profile injection.
 * Inserts an ICC profile into a PSD byte stream as an Image Resource
 * block with ID 1039, keeping resource blocks sorted by ID.
 */

interface PsdResourceBlock {
	id: number;
	bytes: Uint8Array;
}

/** Photoshop header: signature(4) + version(2) + reserved(6) + channels(2) + height(4) + width(4) + depth(2) + colorMode(2). */
const PSD_HEADER_LENGTH = 26;

/** Image resource ID for the ICC profile. */
const ICC_PROFILE_RESOURCE_ID = 1039;

/**
 * Inject an ICC profile into a PSD as image resource 1039.
 * An existing 1039 resource is replaced; otherwise the new block is
 * inserted at the position that keeps resource IDs in ascending order.
 */
export function injectIccProfileIntoPsd(
	psd: Uint8Array,
	profile: Uint8Array,
): Uint8Array<ArrayBuffer> {
	if (
		psd.length < PSD_HEADER_LENGTH + 4 ||
		psd[0] !== 0x38 || // "8"
		psd[1] !== 0x42 || // "B"
		psd[2] !== 0x50 || // "P"
		psd[3] !== 0x53 // "S"
	) {
		throw new Error("PSD: invalid 8BPS signature");
	}

	const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
	const colorModeDataLength = view.getUint32(PSD_HEADER_LENGTH);
	const resourcesLengthOffset = PSD_HEADER_LENGTH + 4 + colorModeDataLength;
	if (resourcesLengthOffset + 4 > psd.length) {
		throw new Error("PSD: truncated Image Resources section");
	}
	const resourcesLength = view.getUint32(resourcesLengthOffset);
	const resourcesStart = resourcesLengthOffset + 4;
	const resourcesEnd = resourcesStart + resourcesLength;
	if (resourcesEnd > psd.length) {
		throw new Error("PSD: Image Resources section exceeds file size");
	}

	const blocks = parseResourceBlocks(psd, view, resourcesStart, resourcesEnd);
	const iccBlock: PsdResourceBlock = {
		id: ICC_PROFILE_RESOURCE_ID,
		bytes: buildResourceBlock(ICC_PROFILE_RESOURCE_ID, profile),
	};

	const keptBlocks = blocks.filter(
		(block) => block.id !== ICC_PROFILE_RESOURCE_ID,
	);
	const insertIndex = keptBlocks.findIndex(
		(block) => block.id > ICC_PROFILE_RESOURCE_ID,
	);
	const newBlocks =
		insertIndex === -1
			? [...keptBlocks, iccBlock]
			: [
					...keptBlocks.slice(0, insertIndex),
					iccBlock,
					...keptBlocks.slice(insertIndex),
				];

	const newResourcesLength = newBlocks.reduce(
		(sum, block) => sum + block.bytes.length,
		0,
	);

	const result = new Uint8Array(
		resourcesLengthOffset +
			4 +
			newResourcesLength +
			(psd.length - resourcesEnd),
	);
	result.set(psd.subarray(0, resourcesLengthOffset), 0);
	new DataView(result.buffer).setUint32(
		resourcesLengthOffset,
		newResourcesLength,
	);
	let offset = resourcesStart;
	for (const block of newBlocks) {
		result.set(block.bytes, offset);
		offset += block.bytes.length;
	}
	result.set(psd.subarray(resourcesEnd), offset);
	return result;
}

/**
 * Parse 8BIM resource blocks: signature(4) + id(2 BE) + pascal name
 * (padded to even length) + size(4 BE) + data (padded to even length).
 */
function parseResourceBlocks(
	psd: Uint8Array,
	view: DataView,
	start: number,
	end: number,
): PsdResourceBlock[] {
	const blocks: PsdResourceBlock[] = [];
	let offset = start;

	while (offset < end) {
		if (offset + 12 > end) {
			throw new Error("PSD: truncated resource block header");
		}
		if (
			psd[offset] !== 0x38 || // "8"
			psd[offset + 1] !== 0x42 || // "B"
			psd[offset + 2] !== 0x49 || // "I"
			psd[offset + 3] !== 0x4d // "M"
		) {
			throw new Error("PSD: invalid resource block signature");
		}
		const id = view.getUint16(offset + 4);
		const nameLength = psd[offset + 6];
		const paddedNameLength =
			(1 + nameLength) % 2 ? 2 + nameLength : 1 + nameLength;
		const size = view.getUint32(offset + 6 + paddedNameLength);
		const totalLength = 4 + 2 + paddedNameLength + 4 + size + (size % 2);
		if (offset + totalLength > end) {
			throw new Error("PSD: truncated resource block data");
		}
		blocks.push({ id, bytes: psd.subarray(offset, offset + totalLength) });
		offset += totalLength;
	}

	return blocks;
}

/** Build an 8BIM resource block with an empty pascal name. */
function buildResourceBlock(id: number, data: Uint8Array): Uint8Array {
	// signature(4) + id(2) + empty pascal name(2) + size(4) + data + pad
	const block = new Uint8Array(12 + data.length + (data.length % 2));
	const view = new DataView(block.buffer);
	block[0] = 0x38; // "8"
	block[1] = 0x42; // "B"
	block[2] = 0x49; // "I"
	block[3] = 0x4d; // "M"
	view.setUint16(4, id);
	// bytes 6-7 stay 0x00 0x00 (empty pascal name + pad)
	view.setUint32(8, data.length);
	block.set(data, 12);
	return block;
}

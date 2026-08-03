// "web " prefix enables custom MIME types via Chromium-based Clipboard API.
// Safari and Firefox do not support "web " custom MIME types, so we encode
// custom type data into text/html as a fallback (HTML comment with base64 payload).
// This keeps image/png free for rendered preview images.
export const PAPLICO_ELEMENTS_MIME = "web application/x-paplico-elements";
/** Rich text-run payload copied from in-text selections (runs + charOverrides) */
export const PAPLICO_TEXT_MIME = "web application/x-paplico-text";

/**
 * Clipboard abstraction that transparently handles "web " prefixed custom
 * MIME types across all browsers.
 *
 * - write(): If items contain "web " custom types and the browser doesn't
 *   support them, the data is encoded into text/html automatically.
 *   On Chromium, text/html fallback is also added for cross-browser paste.
 *
 * - read(): If text/html in the clipboard contains PAPL-prefixed encoded data,
 *   the returned ClipboardItem is augmented with the original "web " custom
 *   type so callers can use item.types/getType() uniformly.
 */
export const Clipboard = {
	write(items: ClipboardItem[]): Promise<void> {
		if (supportsWebCustomFormats()) {
			// Chromium: web custom types work natively.
			// Also add text/html with encoded data for cross-browser compatibility
			// (e.g., copy on Chromium, paste on Safari).
			// Use Promise<Blob> to avoid awaiting before
			// navigator.clipboard.write() (Safari transient activation).
			const augmented: ClipboardItem[] = [];

			for (const item of items) {
				if (!hasWebCustomType(item) || item.types.includes("text/html")) {
					augmented.push(item);
					continue;
				}

				const webTypes = getWebCustomTypes(item);
				const newData: Record<string, Blob | Promise<Blob>> = {
					"text/html": encodeWebTypeToHTML(item, webTypes[0]),
				};
				for (const type of item.types) {
					newData[type] = item.getType(type);
				}
				augmented.push(new ClipboardItem(newData));
			}

			return navigator.clipboard.write(augmented);
		}

		// Non-Chromium fallback: encode "web " custom type data into text/html.
		// Pass Promise<Blob> to ClipboardItem so navigator.clipboard.write()
		// is called synchronously within user activation context.
		const rewritten: ClipboardItem[] = [];

		for (const item of items) {
			if (!hasWebCustomType(item)) {
				rewritten.push(item);
				continue;
			}

			const webTypes = getWebCustomTypes(item);
			const newData: Record<string, Blob | Promise<Blob>> = {
				"text/html": encodeWebTypeToHTML(item, webTypes[0]),
			};

			for (const type of item.types) {
				if (type.startsWith(WEB_PREFIX) || type === "text/html") continue;
				newData[type] = item.getType(type);
			}

			rewritten.push(new ClipboardItem(newData));
		}

		return navigator.clipboard.write(rewritten);
	},

	async read(): Promise<ClipboardItem[]> {
		const items = await navigator.clipboard.read();

		// If any item already has a "web " custom type, return as-is (Chromium)
		if (items.some((item) => hasWebCustomType(item))) {
			return items;
		}

		// Fallback: check if any text/html contains PAPL-encoded custom type data
		const result: ClipboardItem[] = [];

		for (const item of items) {
			if (!item.types.includes("text/html")) {
				result.push(item);
				continue;
			}

			const htmlBlob = await item.getType("text/html");
			const html = await htmlBlob.text();
			const decoded = decodeFromHTML(html);

			if (!decoded) {
				result.push(item);
				continue;
			}

			// Augment: add the original "web " custom type back
			const augmentedData: Record<string, Blob> = {};
			for (const type of item.types) {
				augmentedData[type] = await item.getType(type);
			}
			augmentedData[decoded.mime] = new Blob([decoded.data.slice()], {
				type: decoded.mime,
			});

			result.push(new ClipboardItem(augmentedData));
		}

		return result;
	},
};

// --- HTML encode/decode helpers ---

const WEB_PREFIX = "web ";
const MAGIC = new Uint8Array([0x50, 0x41, 0x50, 0x4c]); // "PAPL"
const MAGIC_SIZE = 4;
const PAPL_ATTR = "data-papl";

function hasWebCustomType(item: ClipboardItem): boolean {
	return item.types.some((t) => t.startsWith(WEB_PREFIX));
}

function getWebCustomTypes(item: ClipboardItem): string[] {
	return item.types.filter((t) => t.startsWith(WEB_PREFIX));
}

function supportsWebCustomFormats(): boolean {
	try {
		return (
			typeof ClipboardItem !== "undefined" &&
			"supports" in ClipboardItem &&
			ClipboardItem.supports(PAPLICO_ELEMENTS_MIME)
		);
	} catch {
		return false;
	}
}

async function encodeWebTypeToHTML(
	item: ClipboardItem,
	mime: string,
): Promise<Blob> {
	const blob = await item.getType(mime);
	const data = new Uint8Array(await blob.arrayBuffer());
	const payload = buildPayload(mime, data);
	const html = encodePayloadToHTML(payload);
	return new Blob([html], { type: "text/html" });
}

// Header layout: MAGIC(4) + mimeLen(u16 BE) + mime(UTF-8) + dataLen(u32 BE) + data
export function buildPayload(mime: string, data: Uint8Array): Uint8Array {
	const mimeBytes = new TextEncoder().encode(mime);
	const headerSize = MAGIC_SIZE + 2 + mimeBytes.length + 4;
	const payload = new Uint8Array(headerSize + data.length);

	let offset = 0;
	payload.set(MAGIC, offset);
	offset += MAGIC_SIZE;

	new DataView(payload.buffer).setUint16(offset, mimeBytes.length, false);
	offset += 2;

	payload.set(mimeBytes, offset);
	offset += mimeBytes.length;

	new DataView(payload.buffer).setUint32(offset, data.length, false);
	offset += 4;

	payload.set(data, offset);
	return payload;
}

export function parsePayload(
	raw: Uint8Array,
): { mime: string; data: Uint8Array } | null {
	if (
		raw.length < MAGIC_SIZE + 2 ||
		raw[0] !== MAGIC[0] ||
		raw[1] !== MAGIC[1] ||
		raw[2] !== MAGIC[2] ||
		raw[3] !== MAGIC[3]
	) {
		return null;
	}

	let offset = MAGIC_SIZE;
	const mimeLen = new DataView(
		raw.buffer,
		raw.byteOffset,
		raw.byteLength,
	).getUint16(offset, false);
	offset += 2;

	if (raw.length < offset + mimeLen + 4) return null;

	const mime = new TextDecoder().decode(raw.subarray(offset, offset + mimeLen));
	offset += mimeLen;

	if (!mime.startsWith(WEB_PREFIX)) return null;

	const dataLen = new DataView(
		raw.buffer,
		raw.byteOffset,
		raw.byteLength,
	).getUint32(offset, false);
	offset += 4;

	if (raw.length < offset + dataLen) return null;

	return { mime, data: raw.subarray(offset, offset + dataLen) };
}

export function encodePayloadToHTML(payload: Uint8Array): string {
	return `<span ${PAPL_ATTR}="${uint8ToBase64(payload)}"></span>`;
}

export function decodePayloadFromHTML(
	html: string,
): { mime: string; data: Uint8Array } | null {
	return decodeFromHTML(html);
}

function decodeFromHTML(
	html: string,
): { mime: string; data: Uint8Array } | null {
	const match = html.match(new RegExp(`${PAPL_ATTR}="([^"]+)"`));
	if (!match) return null;

	try {
		const raw = base64ToUint8(match[1]);
		return parsePayload(raw);
	} catch {
		return null;
	}
}

function uint8ToBase64(bytes: Uint8Array): string {
	const CHUNK = 8192;
	const parts: string[] = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
	}
	return btoa(parts.join(""));
}

function base64ToUint8(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

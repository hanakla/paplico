import { DEFAULT_LENGTH_UNIT } from "../document/units";
import type { AnyArtObject, Document } from "../schema";
import {
	applyMigrations,
	LATEST_SCHEMA_VERSION,
	UNVERSIONED_SCHEMA_BASELINE,
} from "./migrations";

// The "web " prefix marks a custom type for the Chromium Clipboard API; on
// other browsers infra/Clipboard tucks the same bytes into text/html.
/** Clipboard entry carrying Paplico elements together with their schema version. */
export const PAPLICO_ELEMENTS_MIME = "web application/x-paplico-elements-v2";
/** Clipboard entry older clients wrote: a bare element array with no version. */
export const LEGACY_PAPLICO_ELEMENTS_MIME =
	"web application/x-paplico-elements";

interface ElementsPayload {
	version: number;
	objects: AnyArtObject[];
}

/** Serialize elements for the clipboard, stamped with this client's schema version. */
export function encodeElementsPayload(objects: AnyArtObject[]): string {
	return JSON.stringify({
		version: LATEST_SCHEMA_VERSION,
		objects,
	} satisfies ElementsPayload);
}

/**
 * The elements a Paplico clipboard entry carries, brought up to this client's
 * schema. A legacy entry is taken to be at UNVERSIONED_SCHEMA_BASELINE.
 * Returns null for an entry written by a newer client, which this one cannot
 * read.
 */
export function decodeElementsPayload(
	mime: string,
	json: string,
): AnyArtObject[] | null {
	const payload: ElementsPayload =
		mime === LEGACY_PAPLICO_ELEMENTS_MIME
			? { version: UNVERSIONED_SCHEMA_BASELINE, objects: JSON.parse(json) }
			: JSON.parse(json);
	if (payload.version > LATEST_SCHEMA_VERSION) return null;
	if (payload.version === LATEST_SCHEMA_VERSION) return payload.objects;

	// Migrations walk a document, so the elements travel through one holding
	// only them. An element a migration drops leaves the paste with it.
	const doc: Document = {
		id: "",
		objects: Object.fromEntries(payload.objects.map((obj) => [obj.id, obj])),
		layers: [],
		viewport: { x: 0, y: 0, zoom: 1, rotation: 0 },
		files: [],
		artboards: [],
		brushPresets: [],
		units: DEFAULT_LENGTH_UNIT,
		schemaVersion: payload.version,
	};
	applyMigrations(doc);
	return payload.objects.flatMap((obj) => doc.objects[obj.id] ?? []);
}

/**
 * The elements of the first Paplico entry among clipboard items, or null when
 * no item carries one this client can read.
 */
export async function readClipboardElements(
	items: readonly ClipboardItem[],
): Promise<AnyArtObject[] | null> {
	for (const item of items) {
		const mime = [PAPLICO_ELEMENTS_MIME, LEGACY_PAPLICO_ELEMENTS_MIME].find(
			(candidate) => item.types.includes(candidate),
		);
		if (!mime) continue;
		const blob = await item.getType(mime);
		const elements = decodeElementsPayload(mime, await blob.text());
		if (elements?.length) return elements;
	}
	return null;
}

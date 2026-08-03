import { decode, encode } from "cbor-x";
import { normalizeStoredBrushSettings } from "@/core/brush/migrate";
import {
	type PersistedBrushPreset,
	snapshotPersistedBrushPreset,
} from "@/repos/brushPresets";
export const PAPB_SCHEMA_VERSION = 2;

/** Versions parsePapb accepts. v1 payloads carry v1 brush settings, which
 * normalizeStoredBrushSettings still reads; new files are written as v2. */
const READABLE_PAPB_SCHEMA_VERSIONS = new Set([1, PAPB_SCHEMA_VERSION]);

export interface PapbPayload {
	schemaVersion: number;
	brushPreset: PersistedBrushPreset;
}

export function serializePapb(brushPreset: PersistedBrushPreset): Uint8Array {
	return encode({
		schemaVersion: PAPB_SCHEMA_VERSION,
		brushPreset: snapshotPersistedBrushPreset(brushPreset),
	}) as Uint8Array;
}

export function parsePapb(source: ArrayBuffer | Uint8Array): PapbPayload {
	const decoded = decode(
		source instanceof Uint8Array ? source : new Uint8Array(source),
	) as Record<string, unknown>;

	if (!READABLE_PAPB_SCHEMA_VERSIONS.has(decoded.schemaVersion as number)) {
		throw new Error(
			`Unsupported papb schema version: ${decoded.schemaVersion}`,
		);
	}

	return {
		schemaVersion: PAPB_SCHEMA_VERSION,
		brushPreset: normalizePersistedBrushPreset(decoded.brushPreset),
	};
}

function normalizePersistedBrushPreset(value: unknown): PersistedBrushPreset {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid papb payload: brushPreset is missing");
	}

	const record = value as Record<string, unknown>;
	if (typeof record.uid !== "string" || typeof record.name !== "string") {
		throw new Error("Invalid papb payload: brushPreset id or name is invalid");
	}
	if (!record.defaultSettings || typeof record.defaultSettings !== "object") {
		throw new Error("Invalid papb payload: defaultSettings is missing");
	}

	return {
		uid: record.uid,
		name: record.name,
		// Format-preserving: legacy flat records become a union value, stored
		// v2 stays v2 so curves and v2-only config survive the roundtrip.
		defaultSettings: normalizeStoredBrushSettings(record.defaultSettings),
		textureName: expectString(record.textureName, "textureName"),
		textureMime: expectString(record.textureMime, "textureMime"),
		textureHash: expectString(record.textureHash, "textureHash"),
		textureBin: toUint8Array(record.textureBin, "textureBin"),
		...(record.sourceBuiltinUid
			? {
					sourceBuiltinUid: expectString(
						record.sourceBuiltinUid,
						"sourceBuiltinUid",
					),
				}
			: {}),
		createdAt: expectNumber(record.createdAt, "createdAt"),
		updatedAt: expectNumber(record.updatedAt, "updatedAt"),
	};
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`Invalid papb payload: ${field} is invalid`);
	}
	return value;
}

function expectNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		throw new Error(`Invalid papb payload: ${field} is invalid`);
	}
	return value;
}

function toUint8Array(value: unknown, field: string): Uint8Array {
	if (value instanceof Uint8Array) {
		return new Uint8Array(value);
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (Array.isArray(value)) {
		return Uint8Array.from(value);
	}
	throw new Error(`Invalid papb payload: ${field} is invalid`);
}

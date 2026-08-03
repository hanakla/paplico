import { decode, encode } from "cbor-x";
import { normalizeBrushSettings } from "@/core/brush/normalize";
import {
	type PersistedBrushPreset,
	snapshotPersistedBrushPreset,
} from "@/repos/brushPresets";
export const PAPB_SCHEMA_VERSION = 1;

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

	if (decoded.schemaVersion !== PAPB_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported papb schema version: ${decoded.schemaVersion}`,
		);
	}

	return {
		schemaVersion: decoded.schemaVersion as number,
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
		// Normalizes legacy flat records written by pre-union code paths so
		// callers never observe a `type`-less BrushSettings shape.
		defaultSettings: normalizeBrushSettings(record.defaultSettings),
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

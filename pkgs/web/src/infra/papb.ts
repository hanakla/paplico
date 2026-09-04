import { decode, encode } from "cbor-x";
import { withoutStoredBrushSize } from "@/core/brush/access";
import { migrateBrushSettingsToV2 } from "@/core/io/migrations/brushV2/convert";
import type { BrushSettings } from "@/core/schema";
import {
	type PersistedBrushPreset,
	snapshotPersistedBrushPreset,
} from "@/repos/brushPresets";
export const PAPB_SCHEMA_VERSION = 2;

/** Versions parsePapb accepts. Version 1 payloads carry pre-v2 brush settings
 * and are migrated on read; new files are written as v2. */
const READABLE_PAPB_SCHEMA_VERSIONS = new Set([1, PAPB_SCHEMA_VERSION]);

export interface PapbPayload {
	schemaVersion: number;
	brushPreset: PersistedBrushPreset;
}

export function serializePapb(brushPreset: PersistedBrushPreset): Uint8Array {
	const snapshot = snapshotPersistedBrushPreset(brushPreset);
	return encode({
		schemaVersion: PAPB_SCHEMA_VERSION,
		brushPreset: {
			...snapshot,
			// Presets stored before the width-neutral rule may still carry a
			// width; the file format never does.
			defaultSettings: withoutStoredBrushSize(snapshot.defaultSettings),
		},
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
		brushPreset: readPersistedBrushPreset(
			decoded.brushPreset,
			decoded.schemaVersion === 1,
		),
	};
}

function readPersistedBrushPreset(
	value: unknown,
	migrateBrushSettings: boolean,
): PersistedBrushPreset {
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
		// Old files may carry a width; strip it so imports never re-record one.
		defaultSettings: withoutStoredBrushSize(
			migrateBrushSettings
				? migrateBrushSettingsToV2(record.defaultSettings)
				: (record.defaultSettings as BrushSettings),
		),
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

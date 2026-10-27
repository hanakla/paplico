/**
 * Single source of truth for the records `StripCoverage` writes and the
 * coverage kernels read. Each table lists the u32 fields of one WGSL struct
 * by offset, and the struct is generated from it, so both sides change
 * together.
 */

/**
 * Where one batch sits in the frame's buffers. `firstLocation`,
 * `locationEnd` and `firstBand` index the frame-wide arrays; the `*Base`
 * fields are added to the batch-local indices its records hold; `entryEnd`
 * and `triEntryEnd` end its last location's entries, batch-local.
 */
export const COVERAGE_BATCH_FIELDS = {
	firstLocation: 0,
	locationEnd: 1,
	firstBand: 2,
	firstSlot: 3,
	lineBase: 4,
	entryBase: 5,
	entryEnd: 6,
	triBase: 7,
	triEntryBase: 8,
	triEntryEnd: 9,
	/** 1 when the batch carries stroke gradient params. */
	hasParams: 10,
} as const;
export const COVERAGE_BATCH_U32S = Object.keys(COVERAGE_BATCH_FIELDS).length;

/** Uniforms of one dispatch: the bands or locations it covers. */
export const COVERAGE_DISPATCH_FIELDS = {
	first: 0,
	count: 1,
	/** Invocations per workgroup row of a dispatch split across two dimensions. */
	rowStride: 2,
	batchCount: 3,
} as const;

/** WGSL struct of a table's u32 fields in offset order. */
export function u32StructWgsl(
	name: string,
	fields: Record<string, number>,
): string {
	const body = Object.entries(fields)
		.sort((a, b) => a[1] - b[1])
		.map(([field]) => `\t${field}: u32,`)
		.join("\n");
	return `struct ${name} {\n${body}\n}`;
}

/** Write one record at `at`; the type requires a value for every field. */
export function writeU32Record<F extends Record<string, number>>(
	target: Uint32Array,
	at: number,
	fields: F,
	values: Record<keyof F, number>,
): void {
	for (const field in fields) target[at + fields[field]] = values[field];
}

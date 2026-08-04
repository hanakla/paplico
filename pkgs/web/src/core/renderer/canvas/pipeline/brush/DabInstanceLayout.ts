/**
 * Single source of truth for the dab instance buffer ABI.
 *
 * The layout is fixed at 24 floats (96 bytes, 16-byte aligned) from phase 1
 * on and never changes in later phases (design §7). CPU writers, the WGSL
 * struct declaration and tests all derive from this module so the two sides
 * cannot drift apart. Wet fields are written as 0 while wet is disabled.
 */

/** Field order IS the offset order. packedMeta carries u32 bits as a float. */
export const DAB_FIELD_OFFSETS = {
	positionX: 0,
	positionY: 1,
	sizeX: 2,
	/** Dab alpha (flow, linearize-corrected in buildup mode). */
	alpha: 3,
	rotation: 4,
	pathT: 5,
	/** Packed u32: pathIndex (lower bits) + texture layer (upper bits). */
	packedMeta: 6,
	sizeY: 7,
	side1Width: 8,
	side2Width: 9,
	normalX: 10,
	normalY: 11,
	strokeDirX: 12,
	strokeDirY: 13,
	motionSpeed: 14,
	motionAccel: 15,
	/** pack2x16snorm(hueShift, satShift); zero bits mean no shift. */
	packedColorShift0: 16,
	/** pack2x16snorm(valShift, 0). */
	packedColorShift1: 17,
	/** Quantized falloff LUT layer: round(hardness * 31), 0..31. */
	hardnessLutIndex: 18,
	grainStrength: 19,
	wetness: 20,
	directionality: 21,
	grainAmount: 22,
	reserved: 23,
} as const;

export type DabFieldName = keyof typeof DAB_FIELD_OFFSETS;

export const DAB_INSTANCE_FLOATS = 24;
export const DAB_INSTANCE_STRIDE_BYTES = DAB_INSTANCE_FLOATS * 4;

export function writeDabField(
	data: Float32Array,
	dabIndex: number,
	field: DabFieldName,
	value: number,
): void {
	data[dabIndex * DAB_INSTANCE_FLOATS + DAB_FIELD_OFFSETS[field]] = value;
}

export function readDabField(
	data: Float32Array,
	dabIndex: number,
	field: DabFieldName,
): number {
	return data[dabIndex * DAB_INSTANCE_FLOATS + DAB_FIELD_OFFSETS[field]];
}

/**
 * Generate the WGSL struct declaration for this layout. Field order follows
 * the offsets; packedMeta is declared as u32 (same 4-byte slot).
 */
export function generateDabInstanceWgsl(structName: string): string {
	const fields = (Object.entries(DAB_FIELD_OFFSETS) as [DabFieldName, number][])
		.sort((a, b) => a[1] - b[1])
		.map(([name]) => {
			const type = name === "packedMeta" ? "u32" : "f32";
			return `\t${name}: ${type},`;
		})
		.join("\n");
	return `struct ${structName} {\n${fields}\n}`;
}

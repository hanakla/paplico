import {
	DAB_FIELD_OFFSETS,
	DAB_INSTANCE_FLOATS,
	DAB_INSTANCE_STRIDE_BYTES,
	generateDabInstanceWgsl,
	readDabField,
	writeDabField,
} from "./DabInstanceLayout";

describe("DabInstanceLayout", () => {
	it("should be fixed at 24 floats (96 bytes, 16-byte aligned)", () => {
		expect(DAB_INSTANCE_FLOATS).toBe(24);
		expect(DAB_INSTANCE_STRIDE_BYTES).toBe(96);
		expect(DAB_INSTANCE_STRIDE_BYTES % 16).toBe(0);
	});

	it("should assign every offset uniquely and contiguously", () => {
		const offsets = Object.values(DAB_FIELD_OFFSETS);
		expect(offsets.length).toBe(DAB_INSTANCE_FLOATS);
		expect([...offsets].sort((a, b) => a - b)).toEqual(
			Array.from({ length: DAB_INSTANCE_FLOATS }, (_, i) => i),
		);
	});

	it("should keep the legacy 16-float prefix stable", () => {
		expect(DAB_FIELD_OFFSETS.positionX).toBe(0);
		expect(DAB_FIELD_OFFSETS.positionY).toBe(1);
		expect(DAB_FIELD_OFFSETS.sizeX).toBe(2);
		expect(DAB_FIELD_OFFSETS.alpha).toBe(3);
		expect(DAB_FIELD_OFFSETS.rotation).toBe(4);
		expect(DAB_FIELD_OFFSETS.pathT).toBe(5);
		expect(DAB_FIELD_OFFSETS.packedMeta).toBe(6);
		expect(DAB_FIELD_OFFSETS.sizeY).toBe(7);
		expect(DAB_FIELD_OFFSETS.side1Width).toBe(8);
		expect(DAB_FIELD_OFFSETS.side2Width).toBe(9);
		expect(DAB_FIELD_OFFSETS.normalX).toBe(10);
		expect(DAB_FIELD_OFFSETS.normalY).toBe(11);
		expect(DAB_FIELD_OFFSETS.strokeDirX).toBe(12);
		expect(DAB_FIELD_OFFSETS.strokeDirY).toBe(13);
		expect(DAB_FIELD_OFFSETS.motionSpeed).toBe(14);
		expect(DAB_FIELD_OFFSETS.motionAccel).toBe(15);
	});

	it("should round-trip known values through every field offset", () => {
		const dabCount = 3;
		const data = new Float32Array(DAB_INSTANCE_FLOATS * dabCount);
		const fields = Object.keys(
			DAB_FIELD_OFFSETS,
		) as (keyof typeof DAB_FIELD_OFFSETS)[];

		for (let dab = 0; dab < dabCount; dab++) {
			for (const [i, field] of fields.entries()) {
				writeDabField(data, dab, field, dab * 100 + i + 0.5);
			}
		}
		for (let dab = 0; dab < dabCount; dab++) {
			for (const [i, field] of fields.entries()) {
				expect(readDabField(data, dab, field)).toBeCloseTo(
					dab * 100 + i + 0.5,
					5,
				);
			}
		}
	});

	it("should generate a WGSL struct that matches the layout exactly", () => {
		const wgsl = generateDabInstanceWgsl("DabInstance");
		const fieldLines = wgsl
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^\w+: (f32|u32),$/.test(line));

		expect(fieldLines.length).toBe(DAB_INSTANCE_FLOATS);
		// Declaration order must follow the offsets so the storage buffer view
		// and the WGSL struct never drift apart.
		const declaredOrder = fieldLines.map((line) => line.split(":")[0]);
		const expectedOrder = Object.entries(DAB_FIELD_OFFSETS)
			.sort((a, b) => a[1] - b[1])
			.map(([name]) => name);
		expect(declaredOrder).toEqual(expectedOrder);
		expect(wgsl).toContain("packedMeta: u32,");
		expect(wgsl).toContain("struct DabInstance {");
	});
});

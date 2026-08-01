import { describe, expect, it, vi } from "vitest";
import type { BuiltinIccProfileId } from "./color/types";
import { resolveProofProfileBytes } from "./Paplico";
import type { EmbeddedFile } from "./schema";

describe("resolveProofProfileBytes", () => {
	it("should return the embedded bytes when the ref points to a CMYK profile", async () => {
		const loader = createLoader();
		const cmyk = buildIccHeader("CMYK");
		const files = [
			createFile("other-file", buildIccHeader("RGB ")),
			createFile("proof-icc", cmyk),
		];

		const bytes = await resolveProofProfileBytes(
			{ kind: "embedded", fileUid: "proof-icc" },
			files,
			loader,
		);

		expect(bytes).toBe(cmyk);
		expect(loader).not.toHaveBeenCalled();
	});

	it("should return the embedded bytes regardless of color space", async () => {
		const loader = createLoader();
		const rgb = buildIccHeader("RGB ");
		const files = [createFile("proof-icc", rgb)];

		const bytes = await resolveProofProfileBytes(
			{ kind: "embedded", fileUid: "proof-icc" },
			files,
			loader,
		);

		// Color space is not gated here; the picker excludes unsupported ones.
		expect(bytes).toBe(rgb);
	});

	it("should return null when the embedded file is missing", async () => {
		const loader = createLoader();

		const bytes = await resolveProofProfileBytes(
			{ kind: "embedded", fileUid: "missing-file" },
			[createFile("other-file", buildIccHeader("RGB "))],
			loader,
		);

		expect(bytes).toBeNull();
	});

	it("should return null when no proof profile is set", async () => {
		const loader = createLoader();

		const bytes = await resolveProofProfileBytes(undefined, [], loader);

		expect(bytes).toBeNull();
	});

	it("should return the loaded bytes for a builtin ref", async () => {
		const rgb = buildIccHeader("RGB ");
		const loader = vi.fn(async () => rgb);

		const bytes = await resolveProofProfileBytes(
			{ kind: "builtin", id: "display-p3" },
			[],
			loader,
		);

		expect(loader).toHaveBeenCalledWith("display-p3");
		expect(bytes).toBe(rgb);
	});
});

function createLoader() {
	return vi.fn(async (_id: BuiltinIccProfileId) => buildIccHeader("RGB "));
}

function createFile(uid: string, bin: Uint8Array): EmbeddedFile {
	return {
		uid,
		name: `${uid}.icc`,
		type: "application/vnd.iccprofile",
		hash: "",
		bin,
	};
}

/** Minimal 128-byte ICC header: data color space at offset 16, 'acsp' at 36. */
function buildIccHeader(colorSpace: "RGB " | "CMYK"): Uint8Array {
	const bytes = new Uint8Array(128);
	writeSignature(bytes, 16, colorSpace);
	writeSignature(bytes, 36, "acsp");
	return bytes;
}

function writeSignature(bytes: Uint8Array, offset: number, sig: string): void {
	for (let i = 0; i < 4; i++) bytes[offset + i] = sig.charCodeAt(i);
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readIccProfileDescription } from "@/core/color/ColorEngine";
import { inspectIccProfile } from "@/core/color/IccProfileRegistry";
import { BUILTIN_ICC_PROFILES } from "@/infra/builtinIccProfiles";

const ICC_ASSET_DIR = join(process.cwd(), "public", "assets", "icc");

describe("BUILTIN_ICC_PROFILES", () => {
	it("should ship every profile file it lists", async () => {
		for (const profile of BUILTIN_ICC_PROFILES) {
			const bytes = await readProfileBytes(profile.fileName);
			expect(inspectIccProfile(bytes)).not.toBeNull();
		}
	});

	it("should read a description string out of every bundled profile", async () => {
		for (const profile of BUILTIN_ICC_PROFILES) {
			const bytes = await readProfileBytes(profile.fileName);

			expect(await readIccProfileDescription(bytes)).toBeTruthy();
		}
	});

	it("should declare the color space its file actually reports", async () => {
		for (const profile of BUILTIN_ICC_PROFILES) {
			const bytes = await readProfileBytes(profile.fileName);

			expect(inspectIccProfile(bytes)?.colorSpace).toBe(profile.colorSpace);
		}
	});
});

async function readProfileBytes(fileName: string): Promise<Uint8Array> {
	return new Uint8Array(await readFile(join(ICC_ASSET_DIR, fileName)));
}

import type { BuiltinIccProfileId } from "@/core/color/types";

/** Metadata for an ICC profile bundled under /assets/icc/. */
interface BuiltinIccProfileInfo {
	id: BuiltinIccProfileId;
	fileName: string;
	/**
	 * Shown in profile pickers. These files carry deliberately terse ICC
	 * description strings ("sP3C"), so the label is written for readability
	 * rather than taken from the file.
	 */
	label: string;
	colorSpace: "rgb" | "cmyk";
}

export const BUILTIN_ICC_PROFILES: readonly BuiltinIccProfileInfo[] = [
	{ id: "srgb", label: "sRGB", fileName: "sRGB-v4.icc", colorSpace: "rgb" },
	{
		id: "display-p3",
		label: "Display P3",
		fileName: "DisplayP3Compat-v4.icc",
		colorSpace: "rgb",
	},
];

const ICC_ASSET_BASE_PATH = "/assets/icc/";

const profileBytesCache = new Map<BuiltinIccProfileId, Promise<Uint8Array>>();

/** Fetches (and caches) the raw bytes of a builtin profile from /assets/icc/. */
export async function getBuiltinProfileBytes(
	id: BuiltinIccProfileId,
): Promise<Uint8Array> {
	const cached = profileBytesCache.get(id);
	if (cached) return cached;

	const info = BUILTIN_ICC_PROFILES.find((profile) => profile.id === id);
	if (!info) throw new Error(`Unknown builtin ICC profile: ${id}`);

	const promise = (async () => {
		const response = await fetch(`${ICC_ASSET_BASE_PATH}${info.fileName}`);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch ICC profile "${info.fileName}": ${response.status}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	})();
	profileBytesCache.set(id, promise);
	promise.catch(() => profileBytesCache.delete(id));
	return promise;
}

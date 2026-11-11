import { decodeTimelapseBlock } from "../io/papf/reader";
import type { TimelapseData, TimelapseEntry } from "../timelapse/types";

/** Every entry of a recording, with its packed blocks expanded. */
export async function expandTimelapseEntries(
	timelapse: TimelapseData,
): Promise<TimelapseEntry[]> {
	const packed = await Promise.all(
		(timelapse.packedBlocks ?? []).map(decodeTimelapseBlock),
	);
	return [...packed.flat(), ...timelapse.entries];
}

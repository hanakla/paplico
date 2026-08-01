/**
 * GC script for papf documents.
 *
 * Removes:
 *  - Orphaned ArtObjects: entries in `doc.objects` unreachable from
 *    `layer.elementIds` roots and `doc.defs[].rootElementIds` roots, walked
 *    through container/reference edges (Group.childIds/clipPathId,
 *    BlendObject.objectIds/spineSourceId, CompoundPath.sources[].id,
 *    TextElement.axisBinding.pathObjectId/clipPathId/flow.nextTextElementId).
 *  - Orphaned embedded files: `doc.files` entries whose `uid` is not
 *    referenced by any `fileUid` field reachable from the surviving objects,
 *    `doc.brushPresets`, `doc.colorProfile`, or `doc.references3d`.
 *
 * Optionally clears all timelapse data with `--clear-timelapse`.
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import { gcDocument } from "../src/core/io/papf/gc";
import { openPapf } from "../src/core/io/papf/reader";
import { serializeDocument } from "../src/core/io/papf/writer";
import type { Document } from "../src/core/schema";

async function main() {
	const args = process.argv.slice(2);
	const filePath = args.find((a) => !a.startsWith("--"));
	const clearTimelapse = args.includes("--clear-timelapse");

	if (!filePath) {
		console.error(
			"Usage: tsx pkgs/web/scripts/gc-papf.ts <file.papf> [--clear-timelapse]",
		);
		process.exit(1);
		return;
	}

	const beforeBytes = (await stat(filePath)).size;
	const blob = new Blob([await readFile(filePath)]);
	const papf = await openPapf(blob);
	const doc = await papf.toDocument();

	// 1 & 2. Sweep unreachable ArtObjects and unreferenced embedded files.
	const { document: gced, deletedObjectIds, deletedFileUids } = gcDocument(doc);

	const deletedByType = new Map<string, number>();
	for (const id of deletedObjectIds) {
		const type = doc.objects[id].type;
		deletedByType.set(type, (deletedByType.get(type) ?? 0) + 1);
	}
	const deletedObjectCount = deletedObjectIds.length;
	const deletedFileCount = deletedFileUids.length;

	// 3. Optionally clear timelapse data.
	const timelapseEntryCount = doc.timelapse?.entries.length ?? 0;
	const timelapseCleared = clearTimelapse && timelapseEntryCount > 0;

	// Report
	console.log(`GC report for ${filePath}`);
	console.log(`  Deleted ArtObjects: ${deletedObjectCount}`);
	for (const [type, count] of [...deletedByType.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		console.log(`    ${type}: ${count}`);
	}
	console.log(`  Deleted embedded files: ${deletedFileCount}`);
	if (clearTimelapse) {
		console.log(
			timelapseCleared
				? `  Timelapse: cleared (${timelapseEntryCount} update entries)`
				: "  Timelapse: --clear-timelapse given but no timelapse data present",
		);
	} else if (timelapseEntryCount > 0) {
		console.log(
			`  Timelapse: ${timelapseEntryCount} update entries present (pass --clear-timelapse to remove)`,
		);
	}

	if (deletedObjectCount === 0 && deletedFileCount === 0 && !timelapseCleared) {
		console.log("No orphaned data found. File not modified.");
		return;
	}

	const gcedDoc: Document = { ...gced };
	if (timelapseCleared) {
		gcedDoc.timelapse = undefined;
	}

	const outBlob = await serializeDocument(gcedDoc);
	const afterBytes = outBlob.size;
	await writeFile(filePath, Buffer.from(await outBlob.arrayBuffer()));

	console.log(`  Before: ${beforeBytes} bytes`);
	console.log(`  After: ${afterBytes} bytes`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

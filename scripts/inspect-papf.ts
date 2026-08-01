/**
 * Inspect a .papf file for duplicate IDs, abnormal data, and potential
 * viewport-culling issues (e.g. extreme coordinates, NaN, Infinity).
 */
import { readFile } from "node:fs/promises";
import { openPapf } from "../pkgs/web/src/core/io/papf-reader";

async function main() {
	const filePath = process.argv[2];
	if (!filePath) {
		console.error("Usage: tsx scripts/inspect-papf.ts <file.papf>");
		process.exit(1);
	}

	const blob = new Blob([await readFile(filePath)]);
	const papf = await openPapf(blob);
	const doc = await papf.toDocument();

	console.log(`Document ID: ${doc.id}`);
	console.log(`Layers: ${doc.layers.length}`);
	console.log(`Objects: ${Object.keys(doc.objects).length}`);

	// Collect all elements across layers
	type ElemInfo = {
		layerIdx: number;
		layerId: string;
		id: string;
		type: string;
		transform: unknown;
		opacity: number;
		blendMode: string;
		extra: Record<string, unknown>;
	};

	const allElems: ElemInfo[] = [];

	for (let li = 0; li < doc.layers.length; li++) {
		const layer = doc.layers[li];
		for (const elemId of layer.elementIds) {
			const el = doc.objects[elemId];
			if (!el) {
				console.log(
					`  WARNING: layer[${li}] references elementId "${elemId}" but not found in objects`,
				);
				continue;
			}
			const extra: Record<string, unknown> = {};

			if ("segments" in el) {
				extra.segmentCount = (el as any).segments?.length ?? 0;
				const segs = (el as any).segments ?? [];
				for (let si = 0; si < segs.length; si++) {
					const seg = segs[si];
					for (const key of ["start", "cp1", "cp2", "end"]) {
						const pt = seg[key];
						if (pt) {
							if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
								extra[`segment[${si}].${key}_NaN`] = { x: pt.x, y: pt.y };
							}
						}
					}
				}
			}
			if ("childIds" in el) extra.childIds = (el as any).childIds;
			if ("fileUid" in el) extra.fileUid = (el as any).fileUid;
			if ("width" in el && "height" in el) {
				extra.width = (el as any).width;
				extra.height = (el as any).height;
			}
			if ("x" in el && "y" in el) {
				extra.x = (el as any).x;
				extra.y = (el as any).y;
			}
			if ("content" in el)
				extra.contentLength = ((el as any).content ?? "").length;

			allElems.push({
				layerIdx: li,
				layerId: layer.id,
				id: el.id,
				type: (el as any).type ?? "unknown",
				transform: el.transform,
				opacity: el.opacity,
				blendMode: el.blendMode,
				extra,
			});
		}
	}

	console.log(`\nTotal elements: ${allElems.length}\n`);

	// 1. Duplicate ID check
	const idCounts = new Map<string, ElemInfo[]>();
	for (const e of allElems) {
		const arr = idCounts.get(e.id) ?? [];
		arr.push(e);
		idCounts.set(e.id, arr);
	}

	const dupes = [...idCounts.entries()].filter(([, v]) => v.length > 1);
	if (dupes.length > 0) {
		console.log("=== DUPLICATE IDs ===");
		for (const [id, elems] of dupes) {
			console.log(`  ID "${id}" appears ${elems.length} times:`);
			for (const e of elems) {
				console.log(
					`    layer[${e.layerIdx}] type=${e.type} transform=`,
					e.transform,
				);
			}
		}
	} else {
		console.log("=== No duplicate IDs found ===");
	}

	// 2. Abnormal data check
	console.log("\n=== DATA ANOMALIES ===");
	let anomalyCount = 0;

	for (const e of allElems) {
		const issues: string[] = [];
		const t = e.transform as any;

		if (!t) {
			issues.push("transform is null/undefined");
		} else {
			if (!Number.isFinite(t.x) || !Number.isFinite(t.y))
				issues.push(`transform pos NaN/Inf: (${t.x}, ${t.y})`);
			if (!Number.isFinite(t.rotation))
				issues.push(`transform rotation NaN/Inf: ${t.rotation}`);
			if (!Number.isFinite(t.scaleX) || !Number.isFinite(t.scaleY))
				issues.push(`transform scale NaN/Inf: (${t.scaleX}, ${t.scaleY})`);
			if (t.scaleX === 0 || t.scaleY === 0)
				issues.push(`transform scale is zero: (${t.scaleX}, ${t.scaleY})`);

			// Large coordinates that could cause culling issues at high zoom
			const LARGE_COORD = 10000;
			if (Math.abs(t.x) > LARGE_COORD || Math.abs(t.y) > LARGE_COORD) {
				issues.push(`transform has large coords: (${t.x}, ${t.y})`);
			}
		}

		if (!Number.isFinite(e.opacity))
			issues.push(`opacity NaN/Inf: ${e.opacity}`);
		if (e.opacity < 0 || e.opacity > 1)
			issues.push(`opacity out of range: ${e.opacity}`);

		// Check extra fields for anomalies
		if (e.extra.width !== undefined) {
			if (
				!Number.isFinite(e.extra.width as number) ||
				(e.extra.width as number) <= 0
			) {
				issues.push(`width anomaly: ${e.extra.width}`);
			}
		}
		if (e.extra.height !== undefined) {
			if (
				!Number.isFinite(e.extra.height as number) ||
				(e.extra.height as number) <= 0
			) {
				issues.push(`height anomaly: ${e.extra.height}`);
			}
		}

		// Check for NaN in segment points
		for (const [k, v] of Object.entries(e.extra)) {
			if (k.endsWith("_NaN")) {
				issues.push(`segment point ${k}: ${JSON.stringify(v)}`);
			}
		}

		if (issues.length > 0) {
			anomalyCount++;
			console.log(`  [${e.type}] id="${e.id}" layer[${e.layerIdx}]:`);
			for (const issue of issues) {
				console.log(`    - ${issue}`);
			}
		}
	}

	if (anomalyCount === 0) {
		console.log("  No anomalies found");
	}

	// 3. Print all elements summary for manual inspection
	console.log("\n=== ALL ELEMENTS SUMMARY ===");
	for (const e of allElems) {
		const t = e.transform as any;
		const pos = t ? `(${t.x}, ${t.y})` : "null";
		const scale = t ? `scale(${t.scaleX}, ${t.scaleY})` : "";
		const rot = t ? `rot=${t.rotation}` : "";
		console.log(
			`  layer[${e.layerIdx}] ${e.type.padEnd(14)} id=${e.id.slice(0, 8)}.. pos=${pos} ${scale} ${rot} opacity=${e.opacity}`,
			Object.keys(e.extra).length > 0 ? JSON.stringify(e.extra) : "",
		);
	}

	// 4. Check objects referenced in document but not in layers (orphans in objects map)
	if (doc.objects) {
		const layerElemIds = new Set(allElems.map((e) => e.id));
		const objectKeys = Object.keys(doc.objects);
		console.log(`\n=== OBJECTS MAP (${objectKeys.length} entries) ===`);

		const orphans = objectKeys.filter((k) => !layerElemIds.has(k));
		if (orphans.length > 0) {
			console.log(
				`  Orphaned objects (in objects map but not in any layer): ${orphans.length}`,
			);
			for (const id of orphans) {
				const obj = (doc.objects as any)[id];
				console.log(`    id=${id.slice(0, 8)}.. type=${obj?.type ?? "?"}`);
			}
		}

		// Check for elements in layers but not in objects map
		const missing = allElems.filter((e) => !objectKeys.includes(e.id));
		if (missing.length > 0) {
			console.log(
				`  Elements in layers but missing from objects map: ${missing.length}`,
			);
			for (const e of missing) {
				console.log(
					`    id=${e.id.slice(0, 8)}.. type=${e.type} layer[${e.layerIdx}]`,
				);
			}
		}
	}

	// 5. Viewport culling analysis - compute bounding info for each element
	console.log("\n=== VIEWPORT CULLING RISK ===");
	console.log(
		"  Elements with extreme bounds that may be culled at high zoom:",
	);

	for (const e of allElems) {
		const t = e.transform as any;
		if (!t) continue;

		// For paths, compute actual bounds from segments
		if (e.extra.segmentCount && (e.extra.segmentCount as number) > 0) {
			// Path elements - transform position is usually their anchor
			// At high zoom, if the path data extends far from the transform origin,
			// culling based on transform alone could clip it
		}

		// For images, check if dimensions are reasonable relative to position
		if (e.extra.width !== undefined && e.extra.height !== undefined) {
			const w = e.extra.width as number;
			const h = e.extra.height as number;
			if (w > 5000 || h > 5000) {
				console.log(
					`  [${e.type}] id=${e.id.slice(0, 8)}.. LARGE dimensions: ${w}x${h} at (${t.x}, ${t.y})`,
				);
			}
		}
	}
} // end main

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

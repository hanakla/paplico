import { readFile } from "node:fs/promises";
import { openPapf } from "../pkgs/web/src/core/io/papf-reader";

async function main() {
	const blob = new Blob([
		await readFile(process.argv[2] ?? "paplico-2026-03-04T22-14-58-845Z.papf"),
	]);
	const papf = await openPapf(blob);
	const doc = await papf.toDocument();

	// Find group named "ハルさん"
	for (const [id, obj] of Object.entries(doc.objects)) {
		if (obj.name === "ハルさん") {
			console.log(`Found: id=${id} type=${obj.type}`);
			console.log(`  transform:`, obj.transform);
			console.log(`  opacity: ${obj.opacity}, blendMode: ${obj.blendMode}`);

			if (obj.type === "group") {
				console.log(`  childIds: ${obj.childIds.length}`);

				// Compute bounds of all children
				let gMinX = Infinity,
					gMinY = Infinity,
					gMaxX = -Infinity,
					gMaxY = -Infinity;

				for (const cid of obj.childIds) {
					const child = doc.objects[cid];
					if (!child) {
						console.log(`    MISSING child: ${cid}`);
						continue;
					}
					const ct = child.transform;
					let cMinX = Infinity,
						cMinY = Infinity,
						cMaxX = -Infinity,
						cMaxY = -Infinity;

					if (child.type === "path") {
						let prevEnd: any;
						for (const seg of child.segments) {
							const start = seg.start ?? prevEnd;
							// cp1/cp2 are relative offsets
							const cp1x = start ? start.x + seg.cp1.x : seg.cp1.x;
							const cp1y = start ? start.y + seg.cp1.y : seg.cp1.y;
							const cp2x = seg.end.x + seg.cp2.x;
							const cp2y = seg.end.y + seg.cp2.y;

							if (start) {
								cMinX = Math.min(cMinX, start.x);
								cMinY = Math.min(cMinY, start.y);
								cMaxX = Math.max(cMaxX, start.x);
								cMaxY = Math.max(cMaxY, start.y);
							}
							cMinX = Math.min(cMinX, cp1x, cp2x, seg.end.x);
							cMinY = Math.min(cMinY, cp1y, cp2y, seg.end.y);
							cMaxX = Math.max(cMaxX, cp1x, cp2x, seg.end.x);
							cMaxY = Math.max(cMaxY, cp1y, cp2y, seg.end.y);
							prevEnd = seg.end;
						}
					}

					// Apply child's own transform to raw bounds
					const rawCx = (cMinX + cMaxX) / 2;
					const rawCy = (cMinY + cMaxY) / 2;
					const cos = Math.cos(ct.rotation);
					const sin = Math.sin(ct.rotation);
					const corners = [
						[cMinX, cMinY],
						[cMaxX, cMinY],
						[cMaxX, cMaxY],
						[cMinX, cMaxY],
					] as const;
					let tMinX = Infinity,
						tMinY = Infinity,
						tMaxX = -Infinity,
						tMaxY = -Infinity;
					for (const [px, py] of corners) {
						const lx = (px - rawCx) * ct.scaleX;
						const ly = (py - rawCy) * ct.scaleY;
						const rx = lx * cos - ly * sin + rawCx + ct.x;
						const ry = lx * sin + ly * cos + rawCy + ct.y;
						tMinX = Math.min(tMinX, rx);
						tMinY = Math.min(tMinY, ry);
						tMaxX = Math.max(tMaxX, rx);
						tMaxY = Math.max(tMaxY, ry);
					}

					console.log(
						`    child ${cid.slice(0, 20)}.. type=${child.type} rawBounds=[${cMinX.toFixed(1)},${cMinY.toFixed(1)} ~ ${cMaxX.toFixed(1)},${cMaxY.toFixed(1)}] transformedBounds=[${tMinX.toFixed(1)},${tMinY.toFixed(1)} ~ ${tMaxX.toFixed(1)},${tMaxY.toFixed(1)}]`,
					);

					gMinX = Math.min(gMinX, tMinX);
					gMinY = Math.min(gMinY, tMinY);
					gMaxX = Math.max(gMaxX, tMaxX);
					gMaxY = Math.max(gMaxY, tMaxY);
				}

				console.log(
					`\n  Children union bounds (local): [${gMinX.toFixed(1)},${gMinY.toFixed(1)} ~ ${gMaxX.toFixed(1)},${gMaxY.toFixed(1)}]`,
				);
				console.log(
					`  Children union size: ${(gMaxX - gMinX).toFixed(1)} x ${(gMaxY - gMinY).toFixed(1)}`,
				);

				// Apply group transform
				const gt = obj.transform;
				const gcx = (gMinX + gMaxX) / 2;
				const gcy = (gMinY + gMaxY) / 2;
				const gcos = Math.cos(gt.rotation);
				const gsin = Math.sin(gt.rotation);
				const gCorners = [
					[gMinX, gMinY],
					[gMaxX, gMinY],
					[gMaxX, gMaxY],
					[gMinX, gMaxY],
				] as const;
				let wMinX = Infinity,
					wMinY = Infinity,
					wMaxX = -Infinity,
					wMaxY = -Infinity;
				for (const [px, py] of gCorners) {
					const lx = (px - gcx) * gt.scaleX;
					const ly = (py - gcy) * gt.scaleY;
					const rx = lx * gcos - ly * gsin + gcx + gt.x;
					const ry = lx * gsin + ly * gcos + gcy + gt.y;
					wMinX = Math.min(wMinX, rx);
					wMinY = Math.min(wMinY, ry);
					wMaxX = Math.max(wMaxX, rx);
					wMaxY = Math.max(wMaxY, ry);
				}

				console.log(
					`  World bounds (after group transform): [${wMinX.toFixed(1)},${wMinY.toFixed(1)} ~ ${wMaxX.toFixed(1)},${wMaxY.toFixed(1)}]`,
				);
				console.log(
					`  World size: ${(wMaxX - wMinX).toFixed(1)} x ${(wMaxY - wMinY).toFixed(1)}`,
				);

				// Simulate culling at high zoom
				const canvasW = 1920,
					canvasH = 1080;
				// Viewport centered on the group
				const vpX = (wMinX + wMaxX) / 2;
				const vpY = (wMinY + wMaxY) / 2;
				for (const zoom of [1, 5, 10, 20, 50, 100]) {
					const halfW = canvasW / 2 / zoom;
					const halfH = canvasH / 2 / zoom;
					const vpLeft = vpX - halfW;
					const vpRight = vpX + halfW;
					const vpBottom = vpY - halfH;
					const vpTop = vpY + halfH;

					let visibleCount = 0;
					let culledCount = 0;
					for (const cid of obj.childIds) {
						const child = doc.objects[cid];
						if (!child || child.type !== "path") continue;
						// Recompute child world bounds (simplified)
						const ct = child.transform;
						let cMinX2 = Infinity,
							cMinY2 = Infinity,
							cMaxX2 = -Infinity,
							cMaxY2 = -Infinity;
						let prevEnd2: any;
						for (const seg of child.segments) {
							const start = seg.start ?? prevEnd2;
							const cp1x = start ? start.x + seg.cp1.x : seg.cp1.x;
							const cp1y = start ? start.y + seg.cp1.y : seg.cp1.y;
							const cp2x = seg.end.x + seg.cp2.x;
							const cp2y = seg.end.y + seg.cp2.y;
							if (start) {
								cMinX2 = Math.min(cMinX2, start.x);
								cMinY2 = Math.min(cMinY2, start.y);
								cMaxX2 = Math.max(cMaxX2, start.x);
								cMaxY2 = Math.max(cMaxY2, start.y);
							}
							cMinX2 = Math.min(cMinX2, cp1x, cp2x, seg.end.x);
							cMinY2 = Math.min(cMinY2, cp1y, cp2y, seg.end.y);
							cMaxX2 = Math.max(cMaxX2, cp1x, cp2x, seg.end.x);
							cMaxY2 = Math.max(cMaxY2, cp1y, cp2y, seg.end.y);
							prevEnd2 = seg.end;
						}
						// Apply child transform
						const rc = [(cMinX2 + cMaxX2) / 2, (cMinY2 + cMaxY2) / 2];
						const cc = Math.cos(ct.rotation),
							sc = Math.sin(ct.rotation);
						const cn = [
							[cMinX2, cMinY2],
							[cMaxX2, cMinY2],
							[cMaxX2, cMaxY2],
							[cMinX2, cMaxY2],
						];
						let a1 = Infinity,
							a2 = Infinity,
							a3 = -Infinity,
							a4 = -Infinity;
						for (const [px, py] of cn) {
							const lx = (px - rc[0]) * ct.scaleX,
								ly = (py - rc[1]) * ct.scaleY;
							const rx = lx * cc - ly * sc + rc[0] + ct.x,
								ry = lx * sc + ly * cc + rc[1] + ct.y;
							a1 = Math.min(a1, rx);
							a2 = Math.min(a2, ry);
							a3 = Math.max(a3, rx);
							a4 = Math.max(a4, ry);
						}
						// Apply group world transform
						const grc = [(a1 + a3) / 2, (a2 + a4) / 2];
						const gcc = Math.cos(gt.rotation),
							gsc = Math.sin(gt.rotation);
						const gcn = [
							[a1, a2],
							[a3, a2],
							[a3, a4],
							[a1, a4],
						];
						let w1 = Infinity,
							w2 = Infinity,
							w3 = -Infinity,
							w4 = -Infinity;
						for (const [px, py] of gcn) {
							const lx = (px - grc[0]) * gt.scaleX,
								ly = (py - grc[1]) * gt.scaleY;
							const rx = lx * gcc - ly * gsc + grc[0] + gt.x,
								ry = lx * gsc + ly * gcc + grc[1] + gt.y;
							w1 = Math.min(w1, rx);
							w2 = Math.min(w2, ry);
							w3 = Math.max(w3, rx);
							w4 = Math.max(w4, ry);
						}
						const intersects = !(
							w3 < vpLeft ||
							w1 > vpRight ||
							w4 < vpBottom ||
							w2 > vpTop
						);
						if (intersects) visibleCount++;
						else culledCount++;
					}
					console.log(
						`  zoom=${zoom}: visible=${visibleCount}, culled=${culledCount}, viewport=[${vpLeft.toFixed(1)},${vpBottom.toFixed(1)} ~ ${vpRight.toFixed(1)},${vpTop.toFixed(1)}]`,
					);
				}
			}
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

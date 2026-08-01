import { snapshot } from "valtio";
import type { Paplico } from "@/core/Paplico";
import type { AnyArtObject } from "@/core/schema";
import { calculateElementBounds } from "@/core/utils/geometry/bounds";

const THUMBNAIL_MAX_LONG_EDGE = 512;

/**
 * Compute scale factor so the longest edge equals maxLongEdge.
 */
export function computeThumbnailScale(
	width: number,
	height: number,
	maxLongEdge: number = THUMBNAIL_MAX_LONG_EDGE,
): number {
	const longEdge = Math.max(width, height);
	if (longEdge <= 0) return 1;
	return maxLongEdge / longEdge;
}

/**
 * Compute combined bounding box of all elements in world space.
 * Returns null if no elements exist.
 */
export function computeAllElementsBounds(
	objects: Record<string, AnyArtObject>,
): { centerX: number; centerY: number; width: number; height: number } | null {
	const entries = Object.values(objects);
	if (entries.length === 0) return null;

	const elementsMap = new Map(Object.entries(objects));
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const el of entries) {
		const b = calculateElementBounds(el, elementsMap);
		if (b.minX < minX) minX = b.minX;
		if (b.minY < minY) minY = b.minY;
		if (b.maxX > maxX) maxX = b.maxX;
		if (b.maxY > maxY) maxY = b.maxY;
	}

	if (!Number.isFinite(minX)) return null;

	const width = maxX - minX;
	const height = maxY - minY;
	if (width <= 0 || height <= 0) return null;

	return {
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
		width,
		height,
	};
}

/**
 * Generate a thumbnail for the current document.
 * Uses the first artboard if available, otherwise renders all elements.
 */
export async function generateDocumentThumbnail(
	paplico: Paplico,
): Promise<Blob | null> {
	const doc = snapshot(paplico.uiState).document;
	const exporter = paplico.exporter;
	if (!exporter) return null;

	try {
		// Try first artboard
		if (doc.artboards.length > 0) {
			const artboard = doc.artboards[0];
			const scale = computeThumbnailScale(artboard.width, artboard.height);
			const result = await exporter.renderArtboardToPNG(artboard.id, {
				scale,
				backgroundColor: { r: 0.95, g: 0.95, b: 0.95, a: 1 },
			});
			return result?.blob ?? null;
		}

		// Fallback: render all elements
		const elementIds = Object.keys(doc.objects);
		if (elementIds.length === 0) return null;

		const bounds = computeAllElementsBounds(
			doc.objects as Record<string, AnyArtObject>,
		);
		if (!bounds) return null;

		const scale = computeThumbnailScale(bounds.width, bounds.height);
		const result = await exporter.renderElementsToPNG(elementIds, doc as any, {
			scale,
			backgroundColor: { r: 0.95, g: 0.95, b: 0.95, a: 1 },
		});
		return result?.blob ?? null;
	} catch (e) {
		console.warn("[generateDocumentThumbnail] Failed:", e);
		return null;
	}
}

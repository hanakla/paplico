import type { UIPrimitive } from "../primitives";
import type { UITheme } from "../theme";

/**
 * Text flow / overflow overlays:
 * - ■ flow handle at a region's bottom-right corner (click starts flow linking)
 * - red "…" overflow badge when text does not fit the region/path
 * - region-drag preview rectangle
 * - flow-link preview (source handle → cursor line + target highlight)
 */

/** hitId prefix for the flow handle (suffix = text element id) */
export const TEXT_FLOW_HANDLE_HIT_PREFIX = "flow-handle:";
/** hitId prefix for the overflow badge (suffix = text element id) */
export const TEXT_OVERFLOW_BADGE_HIT_PREFIX = "overflow-badge:";

export interface TextFlowHandleData {
	textId: string;
	/** World-space bottom-right corner of the region bounds */
	corner: { x: number; y: number };
	/** Whether the region already flows into another region */
	linked: boolean;
}

export function buildTextFlowHandles(
	handles: readonly TextFlowHandleData[],
	theme: UITheme,
): UIPrimitive[] {
	const size = theme.handleSize.selection;
	return handles.map((handle) => ({
		kind: "rect" as const,
		cx: handle.corner.x,
		cy: handle.corner.y,
		width: { screen: size },
		height: { screen: size },
		// Screen offsets act along world axes (Y-up): outward of the corner
		screenOffset: { x: 5, y: -5 },
		fill: {
			color: handle.linked ? theme.colors.selectionBounds : theme.colors.white,
		},
		stroke: {
			color: theme.colors.selectionBounds,
			width: theme.strokeWidth.default,
		},
		hitId: `${TEXT_FLOW_HANDLE_HIT_PREFIX}${handle.textId}`,
		hitPadding: { screen: 4 },
	}));
}

export interface TextOverflowBadgeData {
	textId: string;
	/** World-space anchor (bottom-right of the laid-out bounds) */
	anchor: { x: number; y: number };
}

export function buildTextOverflowBadges(
	badges: readonly TextOverflowBadgeData[],
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	for (const badge of badges) {
		prims.push({
			kind: "rect",
			cx: badge.anchor.x,
			cy: badge.anchor.y,
			width: { screen: 16 },
			height: { screen: 12 },
			screenOffset: { x: 14, y: -12 },
			fill: { color: theme.colors.textOverflowBadge },
			hitId: `${TEXT_OVERFLOW_BADGE_HIT_PREFIX}${badge.textId}`,
			hitPadding: { screen: 4 },
		});
		for (const dotOffset of [-4, 0, 4]) {
			prims.push({
				kind: "circle",
				cx: badge.anchor.x,
				cy: badge.anchor.y,
				radius: { screen: 1.3 },
				screenOffset: { x: 14 + dotOffset, y: -12 },
				fill: { color: theme.colors.white },
			});
		}
	}
	return prims;
}

export function buildFontMissingOutlines(
	bounds: readonly WorldBounds[],
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	for (const b of bounds) {
		prims.push({
			kind: "rect",
			cx: (b.minX + b.maxX) / 2,
			cy: (b.minY + b.maxY) / 2,
			width: b.maxX - b.minX,
			height: b.maxY - b.minY,
			stroke: {
				color: theme.colors.textOverflowBadge,
				width: theme.strokeWidth.default,
			},
		});
	}
	return prims;
}

interface TextRegionPreviewData {
	/** World-space drag rectangle corners (any orientation) */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export function buildTextRegionPreview(
	data: TextRegionPreviewData,
	theme: UITheme,
): UIPrimitive[] {
	return [
		{
			kind: "rect",
			cx: (data.x0 + data.x1) / 2,
			cy: (data.y0 + data.y1) / 2,
			width: Math.abs(data.x1 - data.x0),
			height: Math.abs(data.y1 - data.y0),
			fill: { color: theme.colors.marqueeFill },
			stroke: {
				color: theme.colors.marqueeOutline,
				width: theme.strokeWidth.default,
			},
		},
	];
}

export interface WorldBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface TextFlowLinkPreviewData {
	/** World-space source handle position */
	from: { x: number; y: number };
	/** World-space cursor position */
	to: { x: number; y: number };
	/** World bounds of a valid link target under the cursor (opaque) */
	targetBounds?: WorldBounds | null;
	/** World bounds of the other text elements (translucent candidates) */
	candidateBounds?: readonly WorldBounds[];
}

export function buildTextFlowLinkPreview(
	data: TextFlowLinkPreviewData,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [
		{
			kind: "line",
			x1: data.from.x,
			y1: data.from.y,
			x2: data.to.x,
			y2: data.to.y,
			stroke: { color: theme.colors.selectionBounds, width: 1.5 },
		},
	];
	for (const b of data.candidateBounds ?? []) {
		prims.push({
			kind: "rect",
			cx: (b.minX + b.maxX) / 2,
			cy: (b.minY + b.maxY) / 2,
			width: b.maxX - b.minX,
			height: b.maxY - b.minY,
			stroke: {
				color: theme.colors.textFlowCandidate,
				width: theme.strokeWidth.default,
			},
		});
	}
	if (data.targetBounds) {
		const b = data.targetBounds;
		prims.push({
			kind: "rect",
			cx: (b.minX + b.maxX) / 2,
			cy: (b.minY + b.maxY) / 2,
			width: b.maxX - b.minX,
			height: b.maxY - b.minY,
			stroke: {
				color: theme.colors.selectionBounds,
				width: theme.strokeWidth.path,
			},
		});
	}
	return prims;
}

interface TextFlowChainLink {
	/** World-space start (upstream region's out corner) */
	from: { x: number; y: number };
	/** World-space end (downstream region's in corner) */
	to: { x: number; y: number };
}

/**
 * Dashed connectors between chained regions, shown while any chain member
 * is hovered or edited. dashLength is in world units (caller divides a
 * screen-px length by zoom for a roughly zoom-stable pattern).
 */
export function buildTextFlowChainLinks(
	links: readonly TextFlowChainLink[],
	dashLength: number,
	theme: UITheme,
): UIPrimitive[] {
	const prims: UIPrimitive[] = [];
	for (const link of links) {
		const dx = link.to.x - link.from.x;
		const dy = link.to.y - link.from.y;
		const length = Math.hypot(dx, dy);
		if (length < 1e-6) continue;
		const step = Math.max(dashLength, 1e-3);
		for (let t = 0; t < length; t += step * 2) {
			const t2 = Math.min(t + step, length);
			prims.push({
				kind: "line",
				x1: link.from.x + (dx * t) / length,
				y1: link.from.y + (dy * t) / length,
				x2: link.from.x + (dx * t2) / length,
				y2: link.from.y + (dy * t2) / length,
				stroke: {
					color: theme.colors.textFlowChain,
					width: theme.strokeWidth.default,
				},
			});
		}
	}
	return prims;
}

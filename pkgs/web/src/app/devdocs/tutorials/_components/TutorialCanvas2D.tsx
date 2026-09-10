"use client";

import { useEffect, useRef } from "react";

export type Vec2 = { x: number; y: number };

export type CubicBezier = {
	p0: Vec2;
	p1: Vec2;
	p2: Vec2;
	p3: Vec2;
};

export type AABB = {
	min: Vec2;
	max: Vec2;
};

type DrawOpts = {
	color?: string;
	width?: number;
};

export type CanvasHelpers = {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	worldUnit: number;
	worldToScreen: (p: Vec2) => Vec2;
	screenToWorld: (p: Vec2) => Vec2;
	clear: (background?: string) => void;
	drawAxes: (opts?: { color?: string; gridSize?: number }) => void;
	drawPoint: (
		p: Vec2,
		opts?: DrawOpts & { radius?: number; label?: string },
	) => void;
	drawLine: (a: Vec2, b: Vec2, opts?: DrawOpts & { dash?: number[] }) => void;
	drawPath: (
		points: Vec2[],
		opts?: DrawOpts & { closed?: boolean; fill?: string },
	) => void;
	drawBezier: (
		c: CubicBezier,
		opts?: DrawOpts & { showHandles?: boolean },
	) => void;
	drawAABB: (box: AABB, opts?: DrawOpts & { fill?: string }) => void;
	drawText: (
		p: Vec2,
		text: string,
		opts?: {
			color?: string;
			size?: number;
			anchor?: CanvasTextAlign;
		},
	) => void;
};

type Props = {
	width?: number;
	height?: number;
	worldUnit?: number;
	draw: (h: CanvasHelpers) => void;
};

export function TutorialCanvas2D({
	width = 600,
	height = 400,
	worldUnit = 1,
	draw,
}: Props) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const cx = width / 2;
		const cy = height / 2;

		const helpers: CanvasHelpers = {
			ctx,
			width,
			height,
			worldUnit,
			worldToScreen: (p) => ({
				x: cx + p.x * worldUnit,
				y: cy - p.y * worldUnit,
			}),
			screenToWorld: (p) => ({
				x: (p.x - cx) / worldUnit,
				y: -(p.y - cy) / worldUnit,
			}),
			clear: (background) => {
				if (background) {
					ctx.fillStyle = background;
					ctx.fillRect(0, 0, width, height);
				} else {
					ctx.clearRect(0, 0, width, height);
				}
			},
			drawAxes: ({ color = "rgb(127 127 127 / 0.5)", gridSize = 50 } = {}) => {
				ctx.save();
				ctx.strokeStyle = "rgb(127 127 127 / 0.18)";
				ctx.lineWidth = 1;
				const startX = cx - Math.floor(cx / gridSize) * gridSize;
				const startY = cy - Math.floor(cy / gridSize) * gridSize;
				for (let x = startX; x <= width; x += gridSize) {
					ctx.beginPath();
					ctx.moveTo(x, 0);
					ctx.lineTo(x, height);
					ctx.stroke();
				}
				for (let y = startY; y <= height; y += gridSize) {
					ctx.beginPath();
					ctx.moveTo(0, y);
					ctx.lineTo(width, y);
					ctx.stroke();
				}
				ctx.strokeStyle = color;
				ctx.lineWidth = 1.5;
				ctx.beginPath();
				ctx.moveTo(0, cy);
				ctx.lineTo(width, cy);
				ctx.moveTo(cx, 0);
				ctx.lineTo(cx, height);
				ctx.stroke();
				ctx.restore();
			},
			drawPoint: (p, { color = "#e0457b", radius = 5, label } = {}) => {
				const s = helpers.worldToScreen(p);
				ctx.save();
				ctx.fillStyle = color;
				ctx.beginPath();
				ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
				ctx.fill();
				if (label) {
					ctx.fillStyle = color;
					ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
					ctx.textBaseline = "middle";
					ctx.fillText(label, s.x + radius + 6, s.y);
				}
				ctx.restore();
			},
			drawLine: (a, b, { color = "#666", width: lw = 1.5, dash } = {}) => {
				const sa = helpers.worldToScreen(a);
				const sb = helpers.worldToScreen(b);
				ctx.save();
				ctx.strokeStyle = color;
				ctx.lineWidth = lw;
				if (dash) ctx.setLineDash(dash);
				ctx.beginPath();
				ctx.moveTo(sa.x, sa.y);
				ctx.lineTo(sb.x, sb.y);
				ctx.stroke();
				ctx.restore();
			},
			drawPath: (
				points,
				{ color = "#2a9d8f", width: lw = 2, closed = false, fill } = {},
			) => {
				if (points.length < 2) return;
				ctx.save();
				ctx.strokeStyle = color;
				ctx.lineWidth = lw;
				ctx.lineJoin = "round";
				ctx.lineCap = "round";
				ctx.beginPath();
				const first = helpers.worldToScreen(points[0]);
				ctx.moveTo(first.x, first.y);
				for (let i = 1; i < points.length; i++) {
					const s = helpers.worldToScreen(points[i]);
					ctx.lineTo(s.x, s.y);
				}
				if (closed) ctx.closePath();
				if (fill) {
					ctx.fillStyle = fill;
					ctx.fill();
				}
				ctx.stroke();
				ctx.restore();
			},
			drawBezier: (
				c,
				{ color = "#3a86ff", width: lw = 2.5, showHandles = false } = {},
			) => {
				const p0 = helpers.worldToScreen(c.p0);
				const p1 = helpers.worldToScreen(c.p1);
				const p2 = helpers.worldToScreen(c.p2);
				const p3 = helpers.worldToScreen(c.p3);
				ctx.save();
				ctx.strokeStyle = color;
				ctx.lineWidth = lw;
				ctx.beginPath();
				ctx.moveTo(p0.x, p0.y);
				ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
				ctx.stroke();
				if (showHandles) {
					ctx.strokeStyle = "rgb(127 127 127 / 0.6)";
					ctx.lineWidth = 1;
					ctx.setLineDash([4, 3]);
					ctx.beginPath();
					ctx.moveTo(p0.x, p0.y);
					ctx.lineTo(p1.x, p1.y);
					ctx.moveTo(p3.x, p3.y);
					ctx.lineTo(p2.x, p2.y);
					ctx.stroke();
					ctx.setLineDash([]);
					ctx.fillStyle = "#888";
					for (const h of [p1, p2]) {
						ctx.beginPath();
						ctx.arc(h.x, h.y, 3, 0, Math.PI * 2);
						ctx.fill();
					}
					ctx.fillStyle = color;
					for (const a of [p0, p3]) {
						ctx.beginPath();
						ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
						ctx.fill();
					}
				}
				ctx.restore();
			},
			drawAABB: (box, { color = "#f4a261", width: lw = 1.5, fill } = {}) => {
				const tl = helpers.worldToScreen({ x: box.min.x, y: box.max.y });
				const br = helpers.worldToScreen({ x: box.max.x, y: box.min.y });
				const w = br.x - tl.x;
				const h = br.y - tl.y;
				ctx.save();
				if (fill) {
					ctx.fillStyle = fill;
					ctx.fillRect(tl.x, tl.y, w, h);
				}
				ctx.strokeStyle = color;
				ctx.lineWidth = lw;
				ctx.setLineDash([5, 4]);
				ctx.strokeRect(tl.x, tl.y, w, h);
				ctx.restore();
			},
			drawText: (p, text, { color, size = 12, anchor = "start" } = {}) => {
				const s = helpers.worldToScreen(p);
				ctx.save();
				ctx.fillStyle = color ?? "currentColor";
				ctx.font = `${size}px ui-sans-serif, system-ui, sans-serif`;
				ctx.textAlign = anchor;
				ctx.textBaseline = "middle";
				ctx.fillText(text, s.x, s.y);
				ctx.restore();
			},
		};

		helpers.clear();
		draw(helpers);
	}, [width, height, worldUnit, draw]);

	return (
		<canvas
			ref={canvasRef}
			className="block rounded-lg border border-border bg-background"
		/>
	);
}

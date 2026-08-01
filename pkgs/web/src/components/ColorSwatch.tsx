import type { CSSProperties } from "react";
import {
	colorToRawRGBA,
	type FillColor,
	type StrokeColor,
} from "@/core/schema";
import { twm } from "@/utils/tailwind";

/**
 * Compact color swatch preview.
 *
 * - variant="fill": background is filled with the color/gradient.
 * - variant="stroke": background is white, border shows the color.
 *
 * Accepts FillColor (solid, linear, radial, free) or StrokeColor (solid, stroke-gradient).
 */
export function ColorSwatch({
	color,
	variant = "fill",
	size = 14,
	className,
}: {
	color: FillColor | StrokeColor | null;
	variant?: "fill" | "stroke";
	size?: number;
	className?: string;
}) {
	const style: CSSProperties = { width: size, height: size };

	if (variant === "stroke") {
		style.backgroundColor = "white";
		if (color?.type === "solid") {
			const c = colorToRawRGBA(color.color);
			style.border = `${Math.max(2, size / 5)}px solid rgba(${c.r * 255},${c.g * 255},${c.b * 255},${c.a})`;
		} else {
			const firstStop = color ? getGradientStops(color)?.[0] : undefined;
			if (firstStop) {
				const c = colorToRawRGBA(firstStop.color);
				style.border = `${Math.max(2, size / 5)}px solid rgba(${c.r * 255},${c.g * 255},${c.b * 255},1)`;
			} else {
				style.border = `${Math.max(2, size / 5)}px solid transparent`;
			}
		}
	} else {
		applyFillStyle(color, style);
	}

	const isEmpty = !color;

	return (
		<span
			className={twm(
				"inline-block rounded-sm overflow-hidden shrink-0 relative",
				variant === "fill" && "bg-white",
				className,
			)}
			style={style}
		>
			{isEmpty && (
				<span className="absolute inset-0 flex items-center justify-center">
					<span className="block w-full h-px bg-red-500 rotate-45 scale-150" />
				</span>
			)}
		</span>
	);
}

function getGradientStops(color: FillColor | StrokeColor) {
	switch (color.type) {
		case "linear":
		case "radial":
		case "free":
			return color.stops;
		case "stroke-gradient":
			return color.gradient.stops;
		default:
			return null;
	}
}

function applyFillStyle(
	color: FillColor | StrokeColor | null,
	style: CSSProperties,
) {
	if (!color) return;

	if (color.type === "solid") {
		const c = colorToRawRGBA(color.color);
		style.backgroundColor = `rgba(${c.r * 255},${c.g * 255},${c.b * 255},${c.a})`;
		return;
	}

	if (color.type === "free" || color.type === "mesh") {
		style.background = "linear-gradient(135deg, #f06, #09f, #0f6, #ff0)";
		return;
	}

	if (color.type === "pattern" || color.type === "stroke-pattern") {
		// Checkerboard placeholder until per-def thumbnails are wired in.
		style.background =
			"repeating-conic-gradient(#bbb 0% 25%, #f5f5f5 0% 50%) 0 0 / 12px 12px";
		return;
	}

	const stops =
		color.type === "stroke-gradient" ? color.gradient.stops : color.stops;
	if (stops.length === 0) return;

	const stopsCss = stops
		.map((s) => {
			const c = colorToRawRGBA(s.color);
			return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a}) ${s.offset * 100}%`;
		})
		.join(", ");

	if (color.type === "radial") {
		style.background = `radial-gradient(circle, ${stopsCss})`;
		return;
	}

	style.background = `linear-gradient(to right, ${stopsCss})`;
}

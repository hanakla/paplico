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

/** Checkerboard backdrop that reveals transparency in the layered color. */
const CHECKERBOARD_CSS =
	"repeating-conic-gradient(#bbb 0% 25%, #f5f5f5 0% 50%) 0 0 / 12px 12px";

function applyFillStyle(
	color: FillColor | StrokeColor | null,
	style: CSSProperties,
) {
	if (!color) return;

	if (color.type === "solid") {
		const c = colorToRawRGBA(color.color);
		const rgba = `rgba(${c.r * 255},${c.g * 255},${c.b * 255},${c.a})`;
		// Layer translucent colors over a checkerboard — an alpha-0 fill used
		// to look identical to both solid white and "no fill".
		style.background =
			c.a < 1 ? `linear-gradient(${rgba}, ${rgba}), ${CHECKERBOARD_CSS}` : rgba;
		return;
	}

	if (color.type === "free" || color.type === "mesh") {
		style.background = "linear-gradient(135deg, #f06, #09f, #0f6, #ff0)";
		return;
	}

	if (color.type === "pattern" || color.type === "stroke-pattern") {
		// Checkerboard placeholder until per-def thumbnails are wired in.
		style.background = CHECKERBOARD_CSS;
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

	const gradientCss =
		color.type === "radial"
			? `radial-gradient(circle, ${stopsCss})`
			: `linear-gradient(to right, ${stopsCss})`;
	const hasTranslucentStop = stops.some((s) => colorToRawRGBA(s.color).a < 1);
	style.background = hasTranslucentStop
		? `${gradientCss}, ${CHECKERBOARD_CSS}`
		: gradientCss;
}

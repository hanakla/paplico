/** Positions are percentages of the parent; sizes are pixels. */
const BUBBLES = [
	{ left: 4, top: 18, size: 90, duration: 16, dx: 18, dy: -50 },
	{ left: 12, top: 62, size: 46, duration: 12, dx: -10, dy: -36 },
	{ left: 44, top: 8, size: 30, duration: 10, dx: 8, dy: -24 },
	{ left: 70, top: 72, size: 120, duration: 20, dx: -20, dy: -60 },
	{ left: 88, top: 22, size: 56, duration: 14, dx: 12, dy: -40 },
	{ left: 93, top: 58, size: 24, duration: 9, dx: -6, dy: -20 },
];

/** Drifting glossy bubbles that decorate the section behind them. */
export function Bubbles() {
	return (
		<div aria-hidden className="pointer-events-none absolute inset-0">
			{BUBBLES.map((bubble) => (
				<span
					key={`${bubble.left}-${bubble.top}`}
					className="aero-bubble"
					style={
						{
							left: `${bubble.left}%`,
							top: `${bubble.top}%`,
							width: bubble.size,
							height: bubble.size,
							"--aero-bubble-duration": `${bubble.duration}s`,
							"--aero-bubble-dx": `${bubble.dx}px`,
							"--aero-bubble-dy": `${bubble.dy}px`,
						} as React.CSSProperties
					}
				/>
			))}
		</div>
	);
}

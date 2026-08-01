import { memo } from "react";

export const LiquidGlassFilter = memo(function LiquidGlassFilter() {
	return (
		<svg
			aria-hidden="true"
			style={{
				position: "absolute",
				width: 0,
				height: 0,
				visibility: "hidden",
			}}
		>
			<defs>
				<filter id="liquid-glass-frosted">
					<feTurbulence
						type="fractalNoise"
						baseFrequency="0.015 0.02"
						numOctaves="4"
						seed="42"
						result="noise"
					/>
					<feDisplacementMap
						in="SourceGraphic"
						in2="noise"
						scale="60"
						xChannelSelector="R"
						yChannelSelector="G"
						result="distorted"
					/>
					<feGaussianBlur in="distorted" stdDeviation="1.5" />
				</filter>
			</defs>
		</svg>
	);
});

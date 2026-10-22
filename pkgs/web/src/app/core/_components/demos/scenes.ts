/** Starting artwork of the hero demo. */
export const HERO_SCENE = `
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
	<defs>
		<radialGradient id="bubble" cx="0.35" cy="0.3" r="0.75">
			<stop offset="0" stop-color="#ffffff"/>
			<stop offset="0.4" stop-color="#bfeaff"/>
			<stop offset="1" stop-color="#14a2dc"/>
		</radialGradient>
		<linearGradient id="leaf" x1="0" y1="0" x2="1" y2="1">
			<stop offset="0" stop-color="#c4f27a"/>
			<stop offset="1" stop-color="#3f8f13"/>
		</linearGradient>
	</defs>
	<path d="M30 300 C 190 190, 330 360, 610 110" fill="none" stroke="#14a2dc" stroke-width="12" stroke-linecap="round" stroke-opacity="0.5"/>
	<circle cx="480" cy="120" r="72" fill="url(#bubble)"/>
	<circle cx="575" cy="240" r="34" fill="url(#bubble)"/>
	<circle cx="400" cy="250" r="18" fill="url(#bubble)"/>
	<path d="M90 140 C 130 50, 250 40, 300 110 C 230 130, 160 170, 90 140 Z" fill="url(#leaf)"/>
	<path d="M95 138 C 160 110, 230 100, 298 110" fill="none" stroke="#ffffff" stroke-width="3" stroke-opacity="0.7"/>
</svg>`;

/** Starting artwork of the filter and export demos. */
export const FILTER_SCENE = `
<svg xmlns="http://www.w3.org/2000/svg" width="560" height="300" viewBox="0 0 560 300">
	<defs>
		<radialGradient id="orb" cx="0.35" cy="0.3" r="0.75">
			<stop offset="0" stop-color="#ffffff"/>
			<stop offset="0.45" stop-color="#7fd3f7"/>
			<stop offset="1" stop-color="#0b5f9e"/>
		</radialGradient>
		<linearGradient id="grass" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#b6ef6a"/>
			<stop offset="1" stop-color="#3f8f13"/>
		</linearGradient>
	</defs>
	<circle cx="170" cy="140" r="95" fill="url(#orb)"/>
	<path d="M300 230 C 330 120, 420 60, 520 70 C 500 170, 420 230, 300 230 Z" fill="url(#grass)"/>
	<path d="M330 40 l 14 30 33 4 -24 23 6 33 -29 -16 -29 16 6 -33 -24 -23 33 -4 Z" fill="#ffb020"/>
</svg>`;

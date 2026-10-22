"use client";

import type { Paplico } from "@paplico/core";
import type { BrushPreset } from "@paplico/core/schema";
import { Eraser, Undo2 } from "lucide-react";
import { useState } from "react";
import { LiveCanvas } from "../LiveCanvas";
import {
	builtinBrush,
	clearLayer,
	hexToSolidColor,
	seedSvg,
} from "./demoSetup";
import { HERO_SCENE } from "./scenes";

const BRUSHES = ["G-Pen", "Pencil", "Watercolor", "Airbrush", "Marker"].flatMap(
	(name) => builtinBrush(name) ?? [],
);

const COLORS = ["#0b5f9e", "#14a2dc", "#7cc82a", "#ff6fae", "#ffb020"];

/** The hero's drawable window: brushes and colors over a seeded scene. */
export function HeroDemo() {
	const [paplico, setPaplico] = useState<Paplico | null>(null);
	const [brushUid, setBrushUid] = useState(BRUSHES[0]?.uid);
	const [color, setColor] = useState(COLORS[0]);

	const handleReady = async (p: Paplico) => {
		await seedSvg(p, HERO_SCENE);
		if (BRUSHES[0]) p.tools.setBrushSettings(BRUSHES[0].settings);
		p.tools.setStrokeColor(hexToSolidColor(color));
		setPaplico(p);
	};

	const selectBrush = (preset: BrushPreset) => {
		setBrushUid(preset.uid);
		paplico?.tools.setCurrentTool("pen");
		paplico?.tools.setBrushSettings(preset.settings);
	};

	const selectColor = (hex: string) => {
		setColor(hex);
		paplico?.tools.setStrokeColor(hexToSolidColor(hex));
	};

	return (
		<div className="aero-window">
			<div className="aero-titlebar">
				<span className="aero-titlebar-dot" />
				<span>Untitled — @paplico/core</span>
				<span className="ml-auto text-[0.7rem] font-normal text-sky-900/60">
					live · WebGPU
				</span>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-b border-white/70 bg-white/40 px-3 py-2">
				{BRUSHES.map((preset) => (
					<button
						key={preset.uid}
						type="button"
						className="aero-chip"
						aria-pressed={brushUid === preset.uid}
						onClick={() => selectBrush(preset)}
					>
						{preset.name}
					</button>
				))}
				<span className="mx-1 h-5 w-px bg-sky-900/15" />
				{COLORS.map((hex) => (
					<button
						key={hex}
						type="button"
						aria-label={`Color ${hex}`}
						aria-pressed={color === hex}
						className="aero-orb"
						style={{ "--aero-orb": hex } as React.CSSProperties}
						onClick={() => selectColor(hex)}
					/>
				))}
				<span className="ml-auto flex gap-1">
					<button
						type="button"
						aria-label="Undo"
						className="aero-chip"
						onClick={() => paplico?.commands.undo()}
					>
						<Undo2 className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="Clear"
						className="aero-chip"
						onClick={() => paplico && clearLayer(paplico)}
					>
						<Eraser className="size-3.5" />
					</button>
				</span>
			</div>
			<LiveCanvas
				className="h-[360px] sm:h-[420px]"
				onReady={handleReady}
				hint="Draw here — this is the real engine"
			/>
		</div>
	);
}

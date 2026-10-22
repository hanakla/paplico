"use client";

import type { Paplico } from "@paplico/core";
import type { ToolType } from "@paplico/core/tools";
import { Download, Eraser, Upload } from "lucide-react";
import { useState } from "react";
import { LiveCanvas } from "../LiveCanvas";
import { clearLayer } from "./demoSetup";

const TOOLS: { tool: ToolType; label: string }[] = [
	{ tool: "pen", label: "Pen" },
	{ tool: "shape", label: "Shape" },
	{ tool: "select", label: "Select" },
	{ tool: "eraser", label: "Eraser" },
];

/**
 * The Getting Started code running as is: switch tools, then round-trip the
 * document through a papf Blob with exportDocument and importDocument.
 */
// lint-unused-ignore
export function QuickstartDemo() {
	const [paplico, setPaplico] = useState<Paplico | null>(null);
	const [tool, setTool] = useState<ToolType>("pen");
	const [saved, setSaved] = useState<Blob | null>(null);

	const selectTool = (next: ToolType) => {
		setTool(next);
		paplico?.tools.setCurrentTool(next);
	};

	const save = async () => {
		if (paplico) setSaved(await paplico.exportDocument());
	};

	const load = async () => {
		if (paplico && saved) await paplico.importDocument(saved);
	};

	return (
		<div className="aero-window my-6">
			<div className="flex flex-wrap items-center gap-2 border-b border-white/70 bg-white/40 px-3 py-2">
				{TOOLS.map((item) => (
					<button
						key={item.tool}
						type="button"
						className="aero-chip"
						aria-pressed={tool === item.tool}
						onClick={() => selectTool(item.tool)}
					>
						{item.label}
					</button>
				))}
				<span className="ml-auto flex flex-wrap gap-1">
					<button type="button" className="aero-chip" onClick={save}>
						<Download className="size-3.5" />
						exportDocument()
					</button>
					<button
						type="button"
						className="aero-chip"
						onClick={() => paplico && clearLayer(paplico)}
					>
						<Eraser className="size-3.5" />
						Clear
					</button>
					<button
						type="button"
						className="aero-chip disabled:opacity-50"
						disabled={!saved}
						onClick={load}
					>
						<Upload className="size-3.5" />
						importDocument()
					</button>
				</span>
			</div>
			<LiveCanvas
				className="h-[320px]"
				onReady={setPaplico}
				hint="Draw, save, clear, then load it back"
			/>
			<p className="border-t border-white/70 bg-white/40 px-3 py-1.5 text-xs text-sky-950/70">
				{saved
					? `Saved a papf Blob of ${(saved.size / 1024).toFixed(1)} KB.`
					: "Nothing saved yet."}
			</p>
		</div>
	);
}

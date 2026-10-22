"use client";

import type { Paplico } from "@paplico/core";
import {
	type IExporter,
	JPEGExporter,
	PNGExporter,
	SVGExporter,
} from "@paplico/core/export";
import { generateUid } from "@paplico/core/schema";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { LiveCanvas } from "../LiveCanvas";
import { seedSvg } from "./demoSetup";
import { FILTER_SCENE } from "./scenes";

const ARTBOARD = { width: 600, height: 340 };

const FORMATS: { label: string; extension: string; create: () => IExporter }[] =
	[
		{ label: "PNG", extension: "png", create: () => new PNGExporter() },
		{
			label: "JPEG",
			extension: "jpg",
			create: () => new JPEGExporter({ quality: 0.85 }),
		},
		{ label: "SVG", extension: "svg", create: () => new SVGExporter() },
	];

type Output = {
	url: string;
	extension: string;
	label: string;
	width: number;
	height: number;
	size: number;
};

/** Exports an artboard of a live document and previews the file it made. */
// lint-unused-ignore
export function ExportDemo() {
	const [paplico, setPaplico] = useState<Paplico | null>(null);
	const [artboardId, setArtboardId] = useState<string | null>(null);
	const [output, setOutput] = useState<Output | null>(null);

	useEffect(() => {
		if (!output) return;
		return () => URL.revokeObjectURL(output.url);
	}, [output]);

	const handleReady = async (p: Paplico) => {
		await seedSvg(p, FILTER_SCENE);
		const id = generateUid("artboard");
		p.commands.addArtboard({ id, name: "Export me", x: 0, y: 0, ...ARTBOARD });
		setArtboardId(id);
		setPaplico(p);
	};

	const exportAs = async (format: (typeof FORMATS)[number]) => {
		if (!paplico || !artboardId) return;
		const result = await paplico.exportArtboard(format.create(), artboardId);
		if (!result) return;
		setOutput({
			url: URL.createObjectURL(result.blob),
			extension: format.extension,
			label: format.label,
			width: result.width,
			height: result.height,
			size: result.blob.size,
		});
	};

	return (
		<div className="aero-window my-6">
			<div className="flex flex-wrap items-center gap-2 border-b border-white/70 bg-white/40 px-3 py-2">
				<span className="text-xs font-semibold text-sky-950/70">
					exportArtboard(
				</span>
				{FORMATS.map((format) => (
					<button
						key={format.label}
						type="button"
						className="aero-chip"
						aria-pressed={output?.label === format.label}
						onClick={() => exportAs(format)}
					>
						new {format.label}Exporter()
					</button>
				))}
				<span className="text-xs font-semibold text-sky-950/70">)</span>
			</div>
			<LiveCanvas
				className="h-[300px]"
				onReady={handleReady}
				hint="Draw inside the artboard, then export"
			/>
			{output && (
				<div className="flex flex-wrap items-center gap-4 border-t border-white/70 bg-white/50 p-3">
					<img
						src={output.url}
						alt={`Exported ${output.label}`}
						className="h-24 rounded-md border border-sky-900/10 bg-white shadow"
					/>
					<div className="text-sm">
						<p className="font-semibold">
							{output.label} · {output.width}×{output.height} ·{" "}
							{(output.size / 1024).toFixed(1)} KB
						</p>
						<a
							href={output.url}
							download={`paplico-export.${output.extension}`}
							className="mt-1 inline-flex items-center gap-1 text-sky-700 underline"
						>
							<Download className="size-3.5" /> Download
						</a>
					</div>
				</div>
			)}
		</div>
	);
}

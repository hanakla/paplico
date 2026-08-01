import { HardDrive } from "lucide-react";
import { useMemo } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type { MemorySnapshot, ResourceType } from "../../../../types";

const TYPE_COLORS: Partial<Record<ResourceType, string>> = {
	GPUBuffer: "#60a5fa",
	GPUTexture: "#34d399",
};

const TYPE_BAR_CLASSES: Partial<Record<ResourceType, string>> = {
	GPUBuffer: "bg-blue-400",
	GPUTexture: "bg-emerald-400",
};

export function MemoryPanel({ snapshots }: { snapshots: MemorySnapshot[] }) {
	const current = snapshots.at(-1);
	const peak = useMemo(
		() => snapshots.reduce((max, s) => Math.max(max, s.totalBytes), 0),
		[snapshots],
	);

	if (snapshots.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<HardDrive size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No memory data recorded</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Create GPU buffers or textures to see memory usage
				</p>
			</div>
		);
	}

	const maxBytes = Math.max(peak, 1);

	return (
		<ScrollArea className="h-full">
			<div className="p-4">
				<div className="space-y-6">
					{/* Summary cards */}
					<div className="grid grid-cols-4 gap-3">
						<SummaryCard
							label="Current"
							value={formatSize(current?.totalBytes ?? 0)}
						/>
						<SummaryCard label="Peak" value={formatSize(peak)} />
						<SummaryCard
							label="Buffers"
							value={formatSize(current?.byType.GPUBuffer ?? 0)}
							color="text-blue-400"
						/>
						<SummaryCard
							label="Textures"
							value={formatSize(current?.byType.GPUTexture ?? 0)}
							color="text-emerald-400"
						/>
					</div>

					{/* Timeline chart */}
					<section>
						<h3 className="mb-2 text-xs font-semibold text-muted">
							Memory Usage Timeline ({snapshots.length} snapshots)
						</h3>
						<div className="rounded border border-border bg-background p-3">
							<div className="relative h-40">
								{/* Y-axis labels */}
								<div className="absolute left-0 top-0 flex h-full w-16 flex-col justify-between text-right font-mono text-[10px] text-muted-foreground">
									<span>{formatSize(maxBytes)}</span>
									<span>{formatSize(maxBytes / 2)}</span>
									<span>0</span>
								</div>
								{/* Chart area */}
								<div className="ml-18 h-full">
									<svg
										viewBox={`0 0 ${snapshots.length} 100`}
										preserveAspectRatio="none"
										className="h-full w-full"
										role="img"
										aria-label="Memory usage timeline"
									>
										{/* Texture area (stacked below buffer) */}
										<polygon
											points={buildAreaPoints(
												snapshots,
												maxBytes,
												(s) => s.totalBytes,
											)}
											fill={TYPE_COLORS.GPUTexture}
											fillOpacity={0.3}
											stroke={TYPE_COLORS.GPUTexture}
											strokeWidth={0.5}
											vectorEffect="non-scaling-stroke"
										/>
										{/* Buffer area */}
										<polygon
											points={buildAreaPoints(
												snapshots,
												maxBytes,
												(s) => s.byType.GPUBuffer ?? 0,
											)}
											fill={TYPE_COLORS.GPUBuffer}
											fillOpacity={0.4}
											stroke={TYPE_COLORS.GPUBuffer}
											strokeWidth={0.5}
											vectorEffect="non-scaling-stroke"
										/>
									</svg>
								</div>
							</div>
							<div className="ml-18 mt-1 flex items-center gap-4 text-[10px] text-muted">
								<span className="flex items-center gap-1">
									<span className="inline-block h-2 w-2 rounded-sm bg-blue-400" />
									Buffer
								</span>
								<span className="flex items-center gap-1">
									<span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" />
									Texture
								</span>
							</div>
						</div>
					</section>

					{/* Type breakdown */}
					{current && (
						<section>
							<h3 className="mb-2 text-xs font-semibold text-muted">
								Current Breakdown
							</h3>
							<div className="space-y-2">
								{(Object.entries(current.byType) as [ResourceType, number][])
									.sort(([, a], [, b]) => b - a)
									.map(([type, bytes]) => (
										<div key={type}>
											<div className="mb-0.5 flex items-center justify-between text-xs">
												<span className="text-foreground">
													{type.replace("GPU", "")}
												</span>
												<span className="font-mono text-muted">
													{formatSize(bytes)} (
													{((bytes / (current.totalBytes || 1)) * 100).toFixed(
														1,
													)}
													%)
												</span>
											</div>
											<div className="h-2 w-full rounded-full bg-surface-hover">
												<div
													className={`h-full rounded-full ${TYPE_BAR_CLASSES[type] ?? "bg-muted"}`}
													style={{
														width: `${(bytes / (current.totalBytes || 1)) * 100}%`,
													}}
												/>
											</div>
										</div>
									))}
							</div>
						</section>
					)}

					{/* Snapshot table */}
					<section>
						<h3 className="mb-2 text-xs font-semibold text-muted">
							Recent Snapshots
						</h3>
						<table className="w-full text-xs">
							<thead className="sticky top-0 bg-background">
								<tr className="text-left text-muted">
									<th className="px-3 py-1.5 font-medium">Time</th>
									<th className="px-3 py-1.5 font-medium">Total</th>
									<th className="px-3 py-1.5 font-medium">Buffers</th>
									<th className="px-3 py-1.5 font-medium">Textures</th>
								</tr>
							</thead>
							<tbody>
								{[...snapshots]
									.reverse()
									.slice(0, 50)
									.map((s, i) => (
										<tr
											key={`${s.timestamp}-${i}`}
											className="border-b border-border/50 hover:bg-surface-hover/50"
										>
											<td className="px-3 py-1 font-mono text-muted-foreground">
												{s.timestamp.toFixed(1)}ms
											</td>
											<td className="px-3 py-1 font-mono text-foreground">
												{formatSize(s.totalBytes)}
											</td>
											<td className="px-3 py-1 font-mono text-blue-400">
												{formatSize(s.byType.GPUBuffer ?? 0)}
											</td>
											<td className="px-3 py-1 font-mono text-emerald-400">
												{formatSize(s.byType.GPUTexture ?? 0)}
											</td>
										</tr>
									))}
							</tbody>
						</table>
					</section>
				</div>
			</div>
		</ScrollArea>
	);
}

function SummaryCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string;
	color?: string;
}) {
	return (
		<div className="rounded border border-border bg-background p-3">
			<div className="text-[10px] uppercase tracking-wider text-muted">
				{label}
			</div>
			<div
				className={`mt-1 font-mono text-lg font-semibold ${color ?? "text-foreground"}`}
			>
				{value}
			</div>
		</div>
	);
}

function buildAreaPoints(
	snapshots: MemorySnapshot[],
	maxBytes: number,
	getValue: (s: MemorySnapshot) => number,
): string {
	const len = snapshots.length;
	const points = snapshots.map(
		(s, i) => `${i},${100 - (getValue(s) / maxBytes) * 100}`,
	);
	return `0,100 ${points.join(" ")} ${len - 1},100`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

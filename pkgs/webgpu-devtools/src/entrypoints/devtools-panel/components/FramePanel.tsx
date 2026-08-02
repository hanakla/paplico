import { BarChart3 } from "lucide-react";
import { useMemo } from "react";
import { InfoTooltip } from "@/components/InfoTooltip";
import { ScrollArea } from "@/components/ScrollArea";
import type { FrameInfo } from "../../../../types";

export function FramePanel({ frames }: { frames: FrameInfo[] }) {
	const stats = useMemo(() => {
		if (frames.length === 0) return null;
		const draws = frames.map((f) => f.drawCalls);
		const dispatches = frames.map((f) => f.dispatchCalls);
		const commands = frames.map((f) => f.commandCount);
		return {
			avgDraw: (draws.reduce((a, b) => a + b, 0) / draws.length).toFixed(1),
			maxDraw: Math.max(...draws),
			avgDispatch: (
				dispatches.reduce((a, b) => a + b, 0) / dispatches.length
			).toFixed(1),
			maxDispatch: Math.max(...dispatches),
			avgCommands: (
				commands.reduce((a, b) => a + b, 0) / commands.length
			).toFixed(1),
			maxCommands: Math.max(...commands),
		};
	}, [frames]);

	if (frames.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<BarChart3 size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No frame data recorded</p>
			</div>
		);
	}

	const maxDrawCalls = Math.max(...frames.map((f) => f.drawCalls), 1);
	const maxDispatchCalls = Math.max(...frames.map((f) => f.dispatchCalls), 1);
	const recentFrames = frames.slice(-100);

	return (
		<div className="flex h-full flex-col">
			{stats && (
				<div className="grid grid-cols-3 gap-4 border-b border-border p-4">
					<StatCard
						label="Draw Calls"
						info="draw / drawIndexed / drawIndirect / drawIndexedIndirect calls per frame"
						avg={stats.avgDraw}
						max={stats.maxDraw}
						color="text-emerald-400"
					/>
					<StatCard
						label="Dispatches"
						info="dispatchWorkgroups / dispatchWorkgroupsIndirect calls per frame"
						avg={stats.avgDispatch}
						max={stats.maxDispatch}
						color="text-blue-400"
					/>
					<StatCard
						label="Commands"
						info="Total GPU commands recorded per frame (draws + dispatches + copies + passes)"
						avg={stats.avgCommands}
						max={stats.maxCommands}
						color="text-amber-400"
					/>
				</div>
			)}

			<div className="border-b border-border p-4">
				<h3 className="mb-2 text-xs font-semibold text-muted">
					Draw Calls / Frame (last {recentFrames.length})
				</h3>
				<div className="flex h-24 items-end gap-px">
					{recentFrames.map((frame) => (
						<div
							key={frame.frameNumber}
							className="group relative flex-1"
							title={`Frame ${frame.frameNumber}: ${frame.drawCalls} draws, ${frame.dispatchCalls} dispatches`}
						>
							<div
								className="w-full rounded-t-sm bg-emerald-500/60 transition-colors group-hover:bg-emerald-400"
								style={{
									height: `${(frame.drawCalls / maxDrawCalls) * 100}%`,
									minHeight: frame.drawCalls > 0 ? "2px" : "0",
								}}
							/>
						</div>
					))}
				</div>
			</div>

			<div className="border-b border-border p-4">
				<h3 className="mb-2 text-xs font-semibold text-muted">
					Dispatches / Frame (last {recentFrames.length})
				</h3>
				<div className="flex h-24 items-end gap-px">
					{recentFrames.map((frame) => (
						<div
							key={frame.frameNumber}
							className="group relative flex-1"
							title={`Frame ${frame.frameNumber}: ${frame.dispatchCalls} dispatches`}
						>
							<div
								className="w-full rounded-t-sm bg-blue-500/60 transition-colors group-hover:bg-blue-400"
								style={{
									height: `${(frame.dispatchCalls / maxDispatchCalls) * 100}%`,
									minHeight: frame.dispatchCalls > 0 ? "2px" : "0",
								}}
							/>
						</div>
					))}
				</div>
			</div>

			<ScrollArea className="flex-1">
				<table className="w-full text-xs">
					<thead className="sticky top-0 bg-background">
						<tr className="text-left text-muted">
							<th className="px-3 py-1.5 font-medium">#</th>
							<th className="px-3 py-1.5 font-medium">Time</th>
							<th className="px-3 py-1.5 font-medium">Draws</th>
							<th className="px-3 py-1.5 font-medium">Dispatches</th>
							<th className="px-3 py-1.5 font-medium">Commands</th>
						</tr>
					</thead>
					<tbody>
						{[...recentFrames].reverse().map((f) => (
							<tr
								key={f.frameNumber}
								className="border-b border-border/50 hover:bg-surface-hover/50"
							>
								<td className="px-3 py-1 font-mono text-muted">
									{f.frameNumber}
								</td>
								<td className="px-3 py-1 font-mono text-muted">
									{f.timestamp.toFixed(1)}ms
								</td>
								<td className="px-3 py-1 font-mono text-emerald-400">
									{f.drawCalls}
								</td>
								<td className="px-3 py-1 font-mono text-blue-400">
									{f.dispatchCalls}
								</td>
								<td className="px-3 py-1 font-mono text-foreground">
									{f.commandCount}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</ScrollArea>
		</div>
	);
}

function StatCard({
	label,
	info,
	avg,
	max,
	color,
}: {
	label: string;
	info?: string;
	avg: string;
	max: number;
	color: string;
}) {
	return (
		<div className="rounded border border-border bg-background p-3">
			<div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted">
				{label}
				{info && <InfoTooltip text={info} />}
			</div>
			<div className={`mt-1 font-mono text-lg font-semibold ${color}`}>
				{avg}
			</div>
			<div className="mt-0.5 text-[10px] text-muted">
				max: <span className="text-muted">{max}</span>
			</div>
		</div>
	);
}

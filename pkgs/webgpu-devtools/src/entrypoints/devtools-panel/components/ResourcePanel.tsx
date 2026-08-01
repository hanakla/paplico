import { Database } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import { Select, SelectItem } from "@/components/Select";
import type { ResourceInfo, ResourceType } from "../../../../types";

const RESOURCE_TYPE_COLORS: Partial<Record<ResourceType, string>> = {
	GPUBuffer: "text-blue-400",
	GPUTexture: "text-emerald-400",
	GPUShaderModule: "text-violet-400",
	GPURenderPipeline: "text-amber-400",
	GPUComputePipeline: "text-orange-400",
	GPUSampler: "text-cyan-400",
	GPUBindGroup: "text-pink-400",
};

export function ResourcePanel({ resources }: { resources: ResourceInfo[] }) {
	const [typeFilter, setTypeFilter] = useState<string>("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const types = useMemo(() => {
		const set = new Set(resources.map((r) => r.type));
		return [...set].sort();
	}, [resources]);

	const filtered = useMemo(
		() =>
			typeFilter === "all"
				? resources
				: resources.filter((r) => r.type === typeFilter),
		[resources, typeFilter],
	);

	const selected = resources.find((r) => r.id === selectedId);

	if (resources.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Database size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No resources tracked</p>
			</div>
		);
	}

	const typeCounts = Object.groupBy(resources, (r) => r.type);

	return (
		<div className="flex h-full flex-col">
			<div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
				{Object.entries(typeCounts).map(([type, items]) => (
					<span key={type} className="text-[10px] text-muted">
						<span
							className={
								RESOURCE_TYPE_COLORS[type as ResourceType] ?? "text-foreground"
							}
						>
							{items?.length}
						</span>{" "}
						{type.replace("GPU", "")}
					</span>
				))}
			</div>

			<div className="border-b border-border px-3 py-1.5">
				<Select
					value={typeFilter}
					onValueChange={(val) => setTypeFilter(val)}
					placeholder="All types"
				>
					<SelectItem value="all">All types</SelectItem>
					{types.map((t) => (
						<SelectItem key={t} value={t}>
							{t.replace("GPU", "")}
						</SelectItem>
					))}
				</Select>
			</div>

			<div className="flex flex-1 overflow-hidden">
				<ScrollArea className="flex-1 border-r border-border">
					<table className="w-full text-xs">
						<thead className="sticky top-0 bg-background">
							<tr className="text-left text-muted">
								<th className="px-3 py-1.5 font-medium">Type</th>
								<th className="px-3 py-1.5 font-medium">Label</th>
								<th className="px-3 py-1.5 font-medium">ID</th>
								<th className="px-3 py-1.5 font-medium">Info</th>
							</tr>
						</thead>
						<tbody>
							{filtered.map((r) => (
								<tr
									key={r.id}
									onClick={() => setSelectedId(r.id)}
									className={`cursor-pointer border-b border-border/50 ${
										selectedId === r.id
											? "bg-blue-600/10"
											: "hover:bg-surface-hover/50"
									}`}
								>
									<td className="px-3 py-1.5">
										<span
											className={
												RESOURCE_TYPE_COLORS[r.type] ?? "text-foreground"
											}
										>
											{r.type.replace("GPU", "")}
										</span>
									</td>
									<td className="px-3 py-1.5 text-foreground">
										{r.label || "\u2014"}
									</td>
									<td className="px-3 py-1.5 font-mono text-muted">{r.id}</td>
									<td className="px-3 py-1.5 font-mono text-muted">
										{formatResourceInfo(r)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</ScrollArea>

				{selected && (
					<ScrollArea className="w-80 shrink-0">
						<div className="p-3">
							<h3 className="mb-2 text-xs font-semibold text-foreground">
								{selected.type}
							</h3>
							<pre className="whitespace-pre-wrap break-all rounded bg-surface-hover p-2 font-mono text-[10px] text-foreground">
								{JSON.stringify(selected.properties, null, 2)}
							</pre>
						</div>
					</ScrollArea>
				)}
			</div>
		</div>
	);
}

function formatResourceInfo(r: ResourceInfo): string {
	const p = r.properties;
	switch (r.type) {
		case "GPUBuffer":
			return formatSize(p.size as number);
		case "GPUTexture": {
			const size = p.size as
				| {
						width: number;
						height: number;
						depthOrArrayLayers?: number;
				  }
				| number[]
				| undefined;
			if (Array.isArray(size))
				return `${size[0]}x${size[1]}${size[2] ? `x${size[2]}` : ""} ${p.format ?? ""}`;
			if (size)
				return `${size.width}x${size.height}${size.depthOrArrayLayers && size.depthOrArrayLayers > 1 ? `x${size.depthOrArrayLayers}` : ""} ${p.format ?? ""}`;
			return String(p.format ?? "");
		}
		default:
			return "";
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

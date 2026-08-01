import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	FrameRelationEntry,
	ResourceInfo,
	ResourceType,
} from "../../../../types";

const TYPE_COLORS: Partial<Record<ResourceType, string>> = {
	GPUBuffer: "#60a5fa",
	GPUTexture: "#34d399",
	GPUShaderModule: "#a78bfa",
	GPURenderPipeline: "#fbbf24",
	GPUComputePipeline: "#fb923c",
	GPUSampler: "#22d3ee",
	GPUBindGroup: "#f472b6",
	GPUBindGroupLayout: "#e879f9",
	GPUPipelineLayout: "#c084fc",
	GPUTextureView: "#6ee7b7",
};

const TYPE_TEXT_COLORS: Partial<Record<ResourceType, string>> = {
	GPUBuffer: "text-blue-400",
	GPUTexture: "text-emerald-400",
	GPUShaderModule: "text-violet-400",
	GPURenderPipeline: "text-amber-400",
	GPUComputePipeline: "text-orange-400",
	GPUSampler: "text-cyan-400",
	GPUBindGroup: "text-pink-400",
	GPUBindGroupLayout: "text-fuchsia-400",
	GPUPipelineLayout: "text-purple-400",
};

interface GraphNode {
	id: string;
	type: ResourceType;
	label: string;
	x: number;
	y: number;
}

interface GraphEdge {
	from: string;
	to: string;
	role: string;
}

export function RelationsPanel({
	resources,
	frameRelations,
}: {
	resources: ResourceInfo[];
	frameRelations?: FrameRelationEntry[];
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filter, setFilter] = useState<ResourceType | "all">("all");

	const containerRef = useRef<HTMLDivElement>(null);
	const [viewBox, setViewBox] = useState({ x: 0, y: 0, w: 800, h: 500 });
	const dragRef = useRef<{
		startX: number;
		startY: number;
		vbX: number;
		vbY: number;
	} | null>(null);

	const resourcesWithRelations = useMemo(() => {
		if (frameRelations && frameRelations.length > 0) {
			// Use frame-scoped relations: build ResourceInfo-like objects
			return frameRelations
				.filter((fr) => fr.relations.length > 0)
				.map(
					(fr) =>
						({
							id: fr.id,
							type: fr.type as ResourceType,
							label: fr.label,
							relations: fr.relations,
						}) as ResourceInfo,
				);
		}
		return resources.filter((r) => r.relations && r.relations.length > 0);
	}, [resources, frameRelations]);

	const resourceMap = useMemo(() => {
		const map = new Map<string, ResourceInfo>();
		for (const r of resources) map.set(r.id, r);
		return map;
	}, [resources]);

	const { nodes, edges } = useMemo(() => {
		const nodeSet = new Set<string>();
		const edgeList: GraphEdge[] = [];

		const relevant =
			filter === "all"
				? resourcesWithRelations
				: resourcesWithRelations.filter((r) => r.type === filter);

		for (const r of relevant) {
			nodeSet.add(r.id);
			for (const rel of r.relations ?? []) {
				if (!resourceMap.has(rel.targetId)) continue;
				nodeSet.add(rel.targetId);
				edgeList.push({ from: r.id, to: rel.targetId, role: rel.role });
			}
		}

		if (selectedId) {
			const connected = new Set<string>();
			for (const e of edgeList) {
				if (e.from === selectedId || e.to === selectedId) {
					connected.add(e.from);
					connected.add(e.to);
				}
			}
			if (connected.size > 0) {
				const filteredEdges = edgeList.filter(
					(e) => connected.has(e.from) || connected.has(e.to),
				);
				const filteredNodes = new Set<string>();
				for (const e of filteredEdges) {
					filteredNodes.add(e.from);
					filteredNodes.add(e.to);
				}
				return {
					nodes: layoutNodes([...filteredNodes], resourceMap),
					edges: filteredEdges,
				};
			}
		}

		return {
			nodes: layoutNodes([...nodeSet], resourceMap),
			edges: edgeList,
		};
	}, [resourcesWithRelations, resourceMap, filter, selectedId]);

	// Fit viewBox to content when nodes change
	useEffect(() => {
		if (nodes.length === 0) return;
		const margin = 100;
		const minX = Math.min(...nodes.map((n) => n.x)) - margin;
		const minY = Math.min(...nodes.map((n) => n.y)) - margin;
		const maxX = Math.max(...nodes.map((n) => n.x)) + margin;
		const maxY = Math.max(...nodes.map((n) => n.y)) + margin;
		setViewBox({ x: minX, y: minY, w: maxX - minX, h: maxY - minY });
	}, [nodes]);

	const types = useMemo(() => {
		const set = new Set<ResourceType>();
		for (const r of resourcesWithRelations) set.add(r.type);
		return [...set].sort();
	}, [resourcesWithRelations]);

	// Pan: pointer drag
	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			if ((e.target as Element).closest("[data-node]")) return;
			(e.currentTarget as Element).setPointerCapture(e.pointerId);
			dragRef.current = {
				startX: e.clientX,
				startY: e.clientY,
				vbX: viewBox.x,
				vbY: viewBox.y,
			};
		},
		[viewBox.x, viewBox.y],
	);

	const handlePointerMove = useCallback((e: React.PointerEvent) => {
		const drag = dragRef.current;
		if (!drag) return;
		const dx = e.clientX - drag.startX;
		const dy = e.clientY - drag.startY;
		setViewBox((vb) => ({
			...vb,
			x: drag.vbX - dx,
			y: drag.vbY - dy,
		}));
	}, []);

	const handlePointerUp = useCallback(() => {
		dragRef.current = null;
	}, []);

	// Zoom: wheel (registered as non-passive to allow preventDefault)
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const svg = el.querySelector("svg");
			if (!svg) return;
			const rect = svg.getBoundingClientRect();
			const factor = e.deltaY > 0 ? 1.1 : 0.9;

			setViewBox((vb) => {
				const mouseX = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
				const mouseY = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
				const newW = vb.w * factor;
				const newH = vb.h * factor;
				return {
					x: mouseX - ((mouseX - vb.x) / vb.w) * newW,
					y: mouseY - ((mouseY - vb.y) / vb.h) * newH,
					w: newW,
					h: newH,
				};
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	if (resources.length === 0 || resourcesWithRelations.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<GitBranch size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No resource relations detected</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Create pipelines or bind groups to see dependency graphs
				</p>
			</div>
		);
	}

	const nodeMap = new Map(nodes.map((n) => [n.id, n]));

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center gap-3 border-b border-border px-3 py-2">
				<span className="text-xs text-muted">Filter:</span>
				<button
					type="button"
					onClick={() => {
						setFilter("all");
						setSelectedId(null);
					}}
					className={`rounded px-2 py-0.5 text-xs ${filter === "all" ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-hover"}`}
				>
					All
				</button>
				{types.map((t) => (
					<button
						type="button"
						key={t}
						onClick={() => {
							setFilter(t);
							setSelectedId(null);
						}}
						className={`rounded px-2 py-0.5 text-xs ${filter === t ? "bg-accent text-accent-foreground" : "text-muted hover:bg-surface-hover"}`}
					>
						{t.replace("GPU", "")}
					</button>
				))}
				{selectedId && (
					<button
						type="button"
						onClick={() => setSelectedId(null)}
						className="ml-auto rounded px-2 py-0.5 text-xs text-muted hover:bg-surface-hover"
					>
						Clear selection
					</button>
				)}
				<span className="ml-auto text-[10px] text-muted-foreground">
					Drag to pan, scroll to zoom
				</span>
			</div>

			{/* Graph viewport */}
			<div
				ref={containerRef}
				className="flex-1 cursor-grab select-none overflow-hidden active:cursor-grabbing"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			>
				<svg
					className="h-full w-full select-none bg-background"
					viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
					role="img"
					aria-label="Resource relations graph"
				>
					<defs>
						<marker
							id="arrowhead"
							markerWidth="8"
							markerHeight="6"
							refX="8"
							refY="3"
							orient="auto"
						>
							<polygon points="0 0, 8 3, 0 6" className="fill-muted" />
						</marker>
					</defs>

					{/* Edges */}
					{edges.map((e, i) => {
						const from = nodeMap.get(e.from);
						const to = nodeMap.get(e.to);
						if (!from || !to) return null;
						const midX = (from.x + to.x) / 2;
						const midY = (from.y + to.y) / 2 - 20;
						return (
							<g key={`${e.from}-${e.to}-${i}`}>
								<path
									d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
									fill="none"
									stroke="var(--muted)"
									strokeWidth={1.5}
									strokeOpacity={0.4}
									markerEnd="url(#arrowhead)"
								/>
								<text
									x={midX}
									y={midY - 4}
									textAnchor="middle"
									fontSize={9}
									fill="var(--muted-foreground)"
								>
									{e.role}
								</text>
							</g>
						);
					})}

					{/* Nodes */}
					{nodes.map((node) => {
						const color = TYPE_COLORS[node.type] ?? "#9ca3af";
						const isSelected = selectedId === node.id;
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: SVG <g> used as interactive graph node
							<g
								key={node.id}
								data-node
								onClick={(e) => {
									e.stopPropagation();
									setSelectedId(selectedId === node.id ? null : node.id);
								}}
								className="cursor-pointer"
							>
								<rect
									x={node.x - 70}
									y={node.y - 20}
									width={140}
									height={40}
									rx={6}
									fill={isSelected ? color : "var(--surface)"}
									fillOpacity={isSelected ? 0.3 : 1}
									stroke={color}
									strokeWidth={isSelected ? 2 : 1}
								/>
								<text
									x={node.x}
									y={node.y - 4}
									textAnchor="middle"
									fontSize={10}
									fontWeight={600}
									fill={color}
								>
									{node.type.replace("GPU", "")}
								</text>
								<text
									x={node.x}
									y={node.y + 10}
									textAnchor="middle"
									fontSize={9}
									fill="var(--muted)"
								>
									{node.label.length > 16
										? `${node.label.slice(0, 16)}…`
										: node.label}
								</text>
							</g>
						);
					})}
				</svg>
			</div>

			{/* Details */}
			{(() => {
				const sel = selectedId ? resourceMap.get(selectedId) : undefined;
				return sel ? (
					<DetailsBar resource={sel} resourceMap={resourceMap} />
				) : null;
			})()}
		</div>
	);
}

function DetailsBar({
	resource,
	resourceMap,
}: {
	resource: ResourceInfo;
	resourceMap: Map<string, ResourceInfo>;
}) {
	return (
		<div className="border-t border-border bg-background p-3">
			<div className="flex items-center gap-2">
				<span
					className={`text-xs font-semibold ${TYPE_TEXT_COLORS[resource.type] ?? "text-foreground"}`}
				>
					{resource.type}
				</span>
				<span className="text-xs text-foreground">
					{resource.label ?? resource.id}
				</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					{resource.id}
				</span>
			</div>
			{resource.relations && resource.relations.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-2">
					{resource.relations.map((rel, i) => {
						const target = resourceMap.get(rel.targetId);
						return (
							<span
								key={`${rel.targetId}-${i}`}
								className="rounded border border-border bg-surface-hover px-2 py-0.5 text-[10px]"
							>
								<span className="text-muted-foreground">{rel.role}→</span>{" "}
								<span
									className={
										TYPE_TEXT_COLORS[rel.targetType as ResourceType] ??
										"text-foreground"
									}
								>
									{(rel.targetType as string).replace("GPU", "")}
								</span>{" "}
								<span className="text-muted">
									{target?.label ?? rel.targetId}
								</span>
							</span>
						);
					})}
				</div>
			)}
		</div>
	);
}

function layoutNodes(
	ids: string[],
	resourceMap: Map<string, ResourceInfo>,
): GraphNode[] {
	const byType = new Map<string, string[]>();
	for (const id of ids) {
		const res = resourceMap.get(id);
		const type = res?.type ?? "unknown";
		if (!byType.has(type)) byType.set(type, []);
		byType.get(type)?.push(id);
	}

	const typeOrder = [
		"GPURenderPipeline",
		"GPUComputePipeline",
		"GPUPipelineLayout",
		"GPUBindGroup",
		"GPUBindGroupLayout",
		"GPUShaderModule",
		"GPUBuffer",
		"GPUTexture",
		"GPUSampler",
		"GPUTextureView",
	];

	const nodes: GraphNode[] = [];
	let col = 0;
	for (const type of typeOrder) {
		const group = byType.get(type);
		if (!group) continue;
		for (let row = 0; row < group.length; row++) {
			const id = group[row];
			const res = resourceMap.get(id);
			nodes.push({
				id,
				type: (res?.type ?? type) as ResourceType,
				label: res?.label ?? id,
				x: 120 + col * 200,
				y: 60 + row * 60,
			});
		}
		col++;
	}

	return nodes;
}

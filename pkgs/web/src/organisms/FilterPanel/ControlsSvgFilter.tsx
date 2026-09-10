import {
	ChevronDown,
	ChevronUp,
	Eye,
	EyeOff,
	Plus,
	Trash2,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { IconButton } from "@/components/IconButton";
import { SimpleSelect } from "@/components/SimpleSelect";
import type {
	SvgFilterGraphFilter,
	SvgFilterNode,
} from "@/core/renderer/filters";
import { FILTER_CATALOG } from "@/core/renderer/filters/filterCatalog";
import { isSvgFilterNodeEnabled } from "@/core/renderer/filters/svg/SvgFilterGraphHandler";
import { type Filter, generateUid } from "@/core/schema";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { FILTER_TEXT_KEYS, getFilterIcon } from "./constants";
import { createDefaultFilter } from "./createDefaultFilter";
import { SvgInputRefsContext } from "./SvgInputSelect";
import { SvgPrimitiveControls } from "./SvgPrimitiveControls";

/** Primitives a graph node can be; the graph itself is not nestable. */
const NODE_PROCESSORS = FILTER_CATALOG.filter(
	(e) => e.category === "SVG" && e.processor !== "svg:filter",
).map((e) => e.processor);

/**
 * Editor for an `svg:filter` graph: an ordered node list where every node
 * exposes its primitive's controls, and the input selectors of later nodes
 * can reference earlier ones.
 */
export const SvgFilterGraphControls = memo(function SvgFilterGraphControls({
	filter,
	onUpdate,
}: {
	filter: SvgFilterGraphFilter;
	onUpdate: (p: Record<string, unknown>) => void;
}) {
	const t = useTranslation();
	const handleUpdate = useEventCallback(onUpdate);
	const nodes = filter.paramData.params.nodes;
	const [pendingProcessor, setPendingProcessor] = useState(NODE_PROCESSORS[0]);

	const processorItems = useMemo(
		() =>
			NODE_PROCESSORS.map((processor) => ({
				value: processor,
				label: t(FILTER_TEXT_KEYS[processor as keyof typeof FILTER_TEXT_KEYS]),
			})),
		[t],
	);
	const nodeLabel = useEventCallback(
		(node: SvgFilterNode, index: number) =>
			`${index + 1}. ${t(FILTER_TEXT_KEYS[node.processor as keyof typeof FILTER_TEXT_KEYS])}`,
	);

	// Params update by shallow merge, so the node list is written whole.
	const setNodes = useEventCallback((next: SvgFilterNode[]) =>
		handleUpdate({ nodes: next }),
	);
	const handleAdd = useEventCallback(() => {
		const defaults = createDefaultFilter(pendingProcessor);
		if (!defaults) return;
		setNodes([
			...nodes,
			{
				id: generateUid("node"),
				processor: pendingProcessor,
				params: { ...defaults.paramData.params },
			},
		]);
	});
	const handleRemove = useEventCallback((index: number) =>
		setNodes(nodes.filter((_, i) => i !== index)),
	);
	const handleMove = useEventCallback((index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= nodes.length) return;
		const next = [...nodes];
		[next[index], next[target]] = [next[target], next[index]];
		setNodes(next);
	});
	const handleToggle = useEventCallback((index: number) =>
		setNodes(
			nodes.map((node, i) =>
				i === index
					? { ...node, enabled: !isSvgFilterNodeEnabled(node) }
					: node,
			),
		),
	);
	const handleNodeParams = useEventCallback(
		(index: number, params: Record<string, unknown>) =>
			setNodes(
				nodes.map((node, i) =>
					i === index
						? { ...node, params: { ...node.params, ...params } }
						: node,
				),
			),
	);

	return (
		<div className="space-y-3">
			<div className="text-muted-foreground text-xs">
				{t("filterPanel.svgNodes")}
			</div>
			{nodes.map((node, index) => (
				<SvgInputRefsContext.Provider
					key={node.id}
					value={nodes.slice(0, index).map((earlier, i) => ({
						id: earlier.id,
						label: nodeLabel(earlier, i),
					}))}
				>
					<div
						className={`space-y-2 rounded border border-border-dim p-2 ${
							isSvgFilterNodeEnabled(node) ? "" : "opacity-60"
						}`}
					>
						<div className="flex items-center gap-1 text-xs">
							{getFilterIcon(node.processor)}
							<span className="flex-1 truncate">{nodeLabel(node, index)}</span>
							<IconButton
								$variant="ghost"
								$size="xs"
								aria-label={t("filterPanel.svgToggleNode")}
								onClick={() => handleToggle(index)}
							>
								{isSvgFilterNodeEnabled(node) ? (
									<Eye className="size-3.5" />
								) : (
									<EyeOff className="size-3.5" />
								)}
							</IconButton>
							<IconButton
								$variant="ghost"
								$size="xs"
								aria-label={t("filterPanel.svgMoveNodeUp")}
								disabled={index === 0}
								onClick={() => handleMove(index, -1)}
							>
								<ChevronUp className="size-3.5" />
							</IconButton>
							<IconButton
								$variant="ghost"
								$size="xs"
								aria-label={t("filterPanel.svgMoveNodeDown")}
								disabled={index === nodes.length - 1}
								onClick={() => handleMove(index, 1)}
							>
								<ChevronDown className="size-3.5" />
							</IconButton>
							<IconButton
								$variant="ghost"
								$size="xs"
								aria-label={t("filterPanel.svgRemoveNode")}
								onClick={() => handleRemove(index)}
							>
								<Trash2 className="size-3.5" />
							</IconButton>
						</div>
						<SvgPrimitiveControls
							filter={nodeAsFilter(filter, node)}
							onUpdate={(params) => handleNodeParams(index, params)}
						/>
					</div>
				</SvgInputRefsContext.Provider>
			))}
			<div className="flex items-center gap-1">
				<SimpleSelect
					$size="sm"
					className="flex-1"
					items={processorItems}
					value={pendingProcessor}
					onValueChange={(value) => setPendingProcessor(value as string)}
				/>
				<IconButton
					$variant="ghost"
					$size="xs"
					aria-label={t("filterPanel.svgAddNode")}
					onClick={handleAdd}
				>
					<Plus className="size-3.5" />
				</IconButton>
			</div>
		</div>
	);
});

/** The node as the Filter its primitive controls expect. */
function nodeAsFilter(filter: Filter, node: SvgFilterNode): Filter {
	return {
		...filter,
		uid: node.id,
		processor: node.processor,
		paramData: { version: filter.paramData.version, params: node.params },
	};
}

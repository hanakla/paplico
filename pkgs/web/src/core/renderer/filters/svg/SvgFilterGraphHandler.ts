import type { Appearance, Color, Filter } from "../../../schema";
import type {
	FilterHandler,
	FilterProcessorContext,
	FilterRenderRequirements,
} from "../../canvas/pipeline/FilterRenderer";
import { ScratchTexturePool } from "../ScratchTexturePool";
import {
	needsSourceGraphic,
	type SvgFilterInput,
	type SvgFilterInput2Params,
	type SvgNodeProcessorContext,
	svgInputNodeRef,
} from "./svgFilterInput";

/** One primitive inside an `svg:filter` graph. */
export interface SvgFilterNode {
	id: string;
	/** A registered `svg:*` primitive processor. */
	processor: string;
	params: Record<string, unknown>;
	/** A disabled node passes its "previous" input through; undefined = enabled. */
	enabled?: boolean;
}

export function isSvgFilterNodeEnabled(node: SvgFilterNode): boolean {
	return node.enabled !== false;
}

/**
 * feFilter as a whole: a directed graph of SVG primitives whose nodes read
 * "previous", the chain input, or any earlier node through `ref:<id>`. The
 * last node is the graph's output.
 */
export interface SvgFilterGraphParams {
	nodes: SvgFilterNode[];
}

export interface SvgFilterGraphFilter extends Appearance<SvgFilterGraphParams> {
	processor: "svg:filter";
}

/**
 * Runs the graph's nodes in order through the same handlers that serve the
 * standalone `svg:*` filters. A node's output stays alive only until its last
 * reader has run; its texture then returns to the scratch pool for a later
 * node, so the graph needs as many textures as it has simultaneously live
 * results.
 */
export class SvgFilterGraphHandler implements FilterHandler {
	private device: GPUDevice | null = null;

	public constructor(
		private readonly primitives: ReadonlyMap<string, FilterHandler>,
		private readonly scratch: ScratchTexturePool = new ScratchTexturePool(),
	) {}

	public async initialize(device: GPUDevice): Promise<void> {
		this.device = device;
	}

	public getRenderConfigure(filter: Filter): Partial<FilterRenderRequirements> {
		return {
			needsSourceGraphic: this.nodes(filter).some(
				(node) =>
					isSvgFilterNodeEnabled(node) &&
					needsSourceGraphic(node.params as Partial<SvgFilterInput2Params>),
			),
		};
	}

	public postProcess(context: FilterProcessorContext, filter: Filter): void {
		const nodes = this.nodes(filter);
		const { width, height } = context.sceneInfo.textureSize;
		const copy = (from: GPUTexture, to: GPUTexture) =>
			context.commandEncoder.copyTextureToTexture(
				{ texture: from },
				{ texture: to },
				{ width, height },
			);
		if (nodes.length === 0 || !this.device) {
			copy(context.sourceTexture, context.targetTexture);
			return;
		}

		const lastUse = lastUseIndices(nodes);
		const nodeOutputs = new Map<string, GPUTexture>();
		let previous = context.sourceTexture;
		for (const [index, node] of nodes.entries()) {
			const isLast = index === nodes.length - 1;
			if (!isSvgFilterNodeEnabled(node)) {
				// A disabled node forwards its input: references to it read the
				// same texture, and as the graph's last node it copies through.
				nodeOutputs.set(node.id, previous);
				if (isLast) copy(previous, context.targetTexture);
				continue;
			}
			const handler = this.primitives.get(node.processor);
			const target = isLast
				? context.targetTexture
				: this.scratch.acquireLike(
						this.device,
						context.targetTexture,
						"SVG Filter Graph Node",
					);
			const nodeContext: SvgNodeProcessorContext = {
				...context,
				sourceTexture: previous,
				targetTexture: target,
				nodeOutputs,
			};
			if (handler?.postProcess) {
				handler.postProcess(nodeContext, this.nodeFilter(filter, node));
			} else {
				// An unknown primitive passes its input through so the rest
				// of the graph keeps rendering.
				copy(previous, target);
			}
			nodeOutputs.set(node.id, target);
			previous = target;
			// Results nobody reads after this node go back to the pool.
			for (const [id, last] of lastUse) {
				if (last !== index) continue;
				const texture = nodeOutputs.get(id);
				if (texture && texture !== context.targetTexture) {
					this.scratch.release(texture);
				}
			}
		}
	}

	public getExpansionMargin(
		filter: Filter,
		bounds?: { width: number; height: number },
	): number {
		// Paint travels along the dependency edges, so the output reaches as far
		// as the longest input path. Summing every node would also count
		// branches that never feed each other.
		const nodes = this.nodes(filter);
		const reach = new Map<string, number>();
		let previous = 0;
		for (const node of nodes) {
			if (!isSvgFilterNodeEnabled(node)) {
				reach.set(node.id, previous);
				continue;
			}
			const own =
				this.primitives
					.get(node.processor)
					?.getExpansionMargin(this.nodeFilter(filter, node), bounds) ?? 0;
			const inputs = nodeInputs(node).map((input) => {
				if (input === "previous") return previous;
				const ref = svgInputNodeRef(input);
				if (ref === null) return 0;
				// A dangling reference reads the previous result on the GPU.
				return reach.get(ref) ?? previous;
			});
			previous = own + Math.max(0, ...inputs);
			reach.set(node.id, previous);
		}
		return previous;
	}

	public onScaleFilter(filter: Filter, scale: [number, number]): Filter {
		const nodes = this.nodes(filter).map((node) => {
			const handler = this.primitives.get(node.processor);
			if (!handler) return node;
			const scaled = handler.onScaleFilter(
				this.nodeFilter(filter, node),
				scale,
			);
			return {
				...node,
				params: scaled.paramData.params as SvgFilterNode["params"],
			};
		});
		return {
			...filter,
			paramData: { ...filter.paramData, params: { nodes } },
		};
	}

	public onAdjustColor(
		params: unknown,
		adjustColor: (color: Color) => Color,
	): unknown {
		const { nodes } = params as SvgFilterGraphParams;
		return {
			nodes: nodes.map((node) => {
				const handler = this.primitives.get(node.processor);
				if (!handler?.onAdjustColor) return node;
				return {
					...node,
					params: handler.onAdjustColor(
						node.params,
						adjustColor,
					) as SvgFilterNode["params"],
				};
			}),
		};
	}

	public flushPendingDestroy(): void {
		this.scratch.flushPendingDestroy();
	}

	public destroy(): void {
		this.scratch.destroy();
	}

	private nodes(filter: Filter): SvgFilterNode[] {
		return (filter.paramData.params as SvgFilterGraphParams).nodes ?? [];
	}

	/** The node as the Filter its primitive handler expects. */
	private nodeFilter(filter: Filter, node: SvgFilterNode): Filter {
		return {
			...filter,
			uid: node.id,
			processor: node.processor,
			paramData: { version: filter.paramData.version, params: node.params },
		};
	}
}

/** The declared inputs of a node; primitives without `in` read nothing. */
function nodeInputs(node: SvgFilterNode): SvgFilterInput[] {
	const { in: input, in2 } = node.params as Partial<SvgFilterInput2Params>;
	return [input, in2].filter((value): value is SvgFilterInput => !!value);
}

/**
 * Index of the last node that reads each enabled node's result. Every node
 * counts as a reader of the one before it, since a dangling `ref:` falls back
 * to that result inside the primitive. A disabled node has no texture of its
 * own, so reads of it count against the enabled node it forwards.
 */
function lastUseIndices(nodes: SvgFilterNode[]): Map<string, number> {
	// The enabled node whose texture each node id resolves to.
	const producer = new Map<string, string>();
	let latest: string | null = null;
	for (const node of nodes) {
		if (isSvgFilterNodeEnabled(node)) latest = node.id;
		if (latest !== null) producer.set(node.id, latest);
	}
	const lastUse = new Map<string, number>();
	const read = (id: string | undefined, index: number) => {
		const owner = id === undefined ? undefined : producer.get(id);
		if (owner !== undefined) lastUse.set(owner, index);
	};
	for (const [index, node] of nodes.entries()) {
		if (isSvgFilterNodeEnabled(node)) lastUse.set(node.id, index);
		read(nodes[index - 1]?.id, index);
		for (const input of nodeInputs(node)) {
			read(svgInputNodeRef(input) ?? undefined, index);
		}
	}
	return lastUse;
}

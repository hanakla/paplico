import { Database } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type { BufferDataResponse, ResourceInfo } from "../../../../types";

type ViewMode = "hex" | "float32" | "uint32" | "int16";

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
	hex: "Hex",
	float32: "Float32",
	uint32: "Uint32",
	int16: "Int16",
};

const ROW_HEIGHT = 20;
const OVERSCAN = 10;

export function BufferPanel({
	buffers,
	onRequestData,
}: {
	buffers: ResourceInfo[];
	onRequestData: (resourceId: string) => Promise<BufferDataResponse>;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [data, setData] = useState<BufferDataResponse | null>(null);
	const [viewMode, setViewMode] = useState<ViewMode>("hex");

	useEffect(() => {
		if (!selectedId) {
			setData(null);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setData(null);

		onRequestData(selectedId).then(
			(response) => {
				if (!cancelled) {
					setData(response);
					setLoading(false);
				}
			},
			(err) => {
				if (!cancelled) {
					setData({
						resourceId: selectedId,
						data: "",
						byteLength: 0,
						error: err instanceof Error ? err.message : String(err),
					});
					setLoading(false);
				}
			},
		);

		return () => {
			cancelled = true;
		};
	}, [selectedId, onRequestData]);

	if (buffers.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Database size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No buffers created</p>
			</div>
		);
	}

	const bytes = data?.data ? base64ToBytes(data.data) : null;

	return (
		<div className="flex h-full">
			<div className="flex w-56 shrink-0 flex-col border-r border-border">
				<ScrollArea className="flex-1">
					{buffers.map((b, i) => (
						<button
							type="button"
							key={b.id}
							onClick={() => setSelectedId(b.id)}
							className={`w-full px-3 py-2 text-left text-xs ${
								selectedId === b.id
									? "bg-blue-600/20 text-blue-400"
									: "text-foreground hover:bg-surface-hover"
							}`}
						>
							<div className="flex items-center justify-between gap-2">
								<span className="max-w-32 overflow-auto font-medium">
									{b.label || `Buffer #${i + 1}`}
								</span>
								<span className="font-mono text-right text-muted-foreground">
									{formatSize((b.properties.size as number) ?? 0)}
								</span>
							</div>
							<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
								{b.id}
							</div>
						</button>
					))}
				</ScrollArea>
			</div>

			<div className="flex min-h-0 flex-1 flex-col">
				{!selectedId && (
					<div className="flex h-full items-center justify-center text-muted">
						<p className="text-sm">Select a buffer to inspect</p>
					</div>
				)}

				{selectedId && loading && (
					<div className="flex h-full items-center justify-center text-muted">
						<p className="text-sm">Loading buffer data...</p>
					</div>
				)}

				{selectedId && !loading && data?.error && (
					<div className="flex h-full items-center justify-center text-red-400">
						<p className="text-sm">{data.error}</p>
					</div>
				)}

				{selectedId && !loading && bytes && (
					<>
						<div className="flex items-center justify-between border-b border-border px-4 py-2">
							<span className="text-xs text-muted-foreground">
								{formatSize(data?.byteLength ?? 0)}
							</span>
							<div className="flex gap-1">
								{(Object.entries(VIEW_MODE_LABELS) as [ViewMode, string][]).map(
									([mode, label]) => (
										<button
											type="button"
											key={mode}
											onClick={() => setViewMode(mode)}
											className={`rounded px-2 py-0.5 text-[10px] font-medium ${
												viewMode === mode
													? "bg-blue-600/20 text-blue-400"
													: "text-muted-foreground hover:bg-surface-hover"
											}`}
										>
											{label}
										</button>
									),
								)}
							</div>
						</div>

						<VirtualHexView bytes={bytes} viewMode={viewMode} />
					</>
				)}
			</div>
		</div>
	);
}

function VirtualHexView({
	bytes,
	viewMode,
}: {
	bytes: Uint8Array;
	viewMode: ViewMode;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [containerHeight, setContainerHeight] = useState(0);

	const { totalRows, renderLine } = useMemo(
		() => getViewConfig(bytes, viewMode),
		[bytes, viewMode],
	);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const obs = new ResizeObserver(([entry]) => {
			setContainerHeight(entry.contentRect.height);
		});
		obs.observe(el);
		return () => obs.disconnect();
	}, []);

	const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
		setScrollTop(e.currentTarget.scrollTop);
	}, []);

	const totalHeight = totalRows * ROW_HEIGHT;
	const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
	const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
	const endRow = Math.min(totalRows, startRow + visibleCount);

	const rows: React.ReactNode[] = [];
	for (let i = startRow; i < endRow; i++) {
		rows.push(
			<div
				key={i}
				style={{
					position: "absolute",
					top: i * ROW_HEIGHT,
					height: ROW_HEIGHT,
					left: 16,
					right: 16,
				}}
			>
				{renderLine(i)}
			</div>,
		);
	}

	return (
		<div
			ref={containerRef}
			className="flex-1 overflow-auto"
			onScroll={handleScroll}
		>
			<pre
				className="relative font-mono text-xs leading-5"
				style={{ height: totalHeight }}
			>
				{rows}
			</pre>
		</div>
	);
}

function getViewConfig(
	bytes: Uint8Array,
	viewMode: ViewMode,
): {
	totalRows: number;
	bytesPerRow: number;
	renderLine: (row: number) => string;
} {
	if (viewMode === "hex") {
		const bytesPerRow = 16;
		const totalRows = Math.ceil(bytes.length / bytesPerRow);
		return {
			totalRows,
			bytesPerRow,
			renderLine: (row) => {
				const offset = row * bytesPerRow;
				const chunk = bytes.subarray(
					offset,
					Math.min(offset + bytesPerRow, bytes.length),
				);
				const offsetStr = offset.toString(16).padStart(8, "0");

				const hexParts: string[] = [];
				for (let i = 0; i < 16; i++) {
					hexParts.push(
						i < chunk.length ? chunk[i].toString(16).padStart(2, "0") : "  ",
					);
				}

				const asciiStr = Array.from(chunk)
					.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
					.join("")
					.padEnd(16);

				return `${offsetStr}  ${hexParts.join(" ")}  |${asciiStr}|`;
			},
		};
	}

	let bytesPerElement: number;
	let valuesPerRow: number;
	let formatter: (v: number) => string;
	let TypedArray: {
		new (
			buffer: ArrayBuffer,
			byteOffset: number,
			length: number,
		): {
			length: number;
			[i: number]: number;
		};
	};

	switch (viewMode) {
		case "float32":
			TypedArray = Float32Array as never;
			bytesPerElement = 4;
			valuesPerRow = 4;
			formatter = (v) => v.toExponential(4).padStart(14);
			break;
		case "uint32":
			TypedArray = Uint32Array as never;
			bytesPerElement = 4;
			valuesPerRow = 8;
			formatter = (v) => v.toString().padStart(12);
			break;
		case "int16":
			TypedArray = Int16Array as never;
			bytesPerElement = 2;
			valuesPerRow = 8;
			formatter = (v) => v.toString().padStart(8);
			break;
		default:
			return { totalRows: 1, bytesPerRow: 1, renderLine: () => "Unsupported" };
	}

	const totalElements = Math.floor(bytes.length / bytesPerElement);
	const totalRows = Math.ceil(totalElements / valuesPerRow);
	const bytesPerRow = valuesPerRow * bytesPerElement;

	return {
		totalRows,
		bytesPerRow,
		renderLine: (row) => {
			const elemStart = row * valuesPerRow;
			const byteOffset = bytes.byteOffset + elemStart * bytesPerElement;
			const count = Math.min(valuesPerRow, totalElements - elemStart);
			const view = new TypedArray(bytes.buffer, byteOffset, count);

			const offset = elemStart * bytesPerElement;
			const offsetStr = offset.toString(16).padStart(8, "0");
			const values: string[] = [];
			for (let j = 0; j < view.length; j++) {
				values.push(formatter(view[j]));
			}
			return `${offsetStr}  ${values.join("  ")}`;
		},
	};
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

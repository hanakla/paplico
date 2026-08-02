import { Image } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type { ResourceInfo, TextureDataResponse } from "../../../../types";
import { usePersistedState } from "../hooks/usePersistedState";

export function TexturePanel({
	textures,
	onRequestData,
}: {
	textures: ResourceInfo[];
	onRequestData: (resourceId: string) => Promise<TextureDataResponse>;
}) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [data, setData] = useState<TextureDataResponse | null>(null);
	const [minBytes, setMinBytes] = usePersistedState("textureMinBytes", 0);
	const [sortBySize, setSortBySize] = usePersistedState(
		"textureSortBySize",
		false,
	);
	const canvasRef = useRef<HTMLCanvasElement>(null);

	const selected = textures.find((t) => t.id === selectedId);
	const filteredTextures = (() => {
		let list =
			minBytes > 0
				? textures.filter(
						(t) => ((t.properties.estimatedBytes as number) ?? 0) >= minBytes,
					)
				: textures;
		if (sortBySize) {
			list = [...list].sort(
				(a, b) =>
					((b.properties.estimatedBytes as number) ?? 0) -
					((a.properties.estimatedBytes as number) ?? 0),
			);
		}
		return list;
	})();

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
				if (cancelled) return;
				setData(response);
				setLoading(false);
			},
			(err) => {
				if (cancelled) return;
				const errMsg = err instanceof Error ? err.message : String(err);
				setData({
					resourceId: selectedId,
					data: "",
					width: 0,
					height: 0,
					error: errMsg,
				});
				setLoading(false);
			},
		);

		return () => {
			cancelled = true;
		};
	}, [selectedId, onRequestData]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !data || data.error || !data.data) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		canvas.width = data.width;
		canvas.height = data.height;

		const bytes = base64ToBytes(data.data);
		const imageData = new ImageData(
			new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			data.width,
			data.height,
		);
		ctx.putImageData(imageData, 0, 0);
	}, [data]);

	if (textures.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Image size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No textures tracked</p>
			</div>
		);
	}

	return (
		<div className="flex h-full">
			<div className="flex w-56 shrink-0 flex-col border-r border-border">
				<div className="flex flex-col gap-1 border-b border-border px-3 py-1.5">
					<div className="flex items-center gap-1.5">
						<span className="text-[10px] text-muted">Min:</span>
						<select
							value={minBytes}
							onChange={(e) => setMinBytes(Number(e.target.value))}
							className="rounded border border-border bg-surface px-1 py-0.5 text-[10px] text-foreground"
						>
							<option value={0}>All</option>
							<option value={1024}>1 KB</option>
							<option value={10240}>10 KB</option>
							<option value={102400}>100 KB</option>
							<option value={1048576}>1 MB</option>
							<option value={10485760}>10 MB</option>
						</select>
					</div>
					<label className="flex items-center gap-1.5 text-[10px] text-muted">
						<input
							type="checkbox"
							checked={sortBySize}
							onChange={(e) => setSortBySize(e.target.checked)}
							className="accent-accent"
						/>
						Sort by size
					</label>
				</div>
				<ScrollArea className="min-h-0 flex-1">
					{filteredTextures.map((tex, index) => {
						const props = tex.properties;
						const w = (props.width as number) ?? 0;
						const h = (props.height as number) ?? 0;
						const d = (props.depthOrArrayLayers as number) ?? 1;
						const format = props.format as string | undefined;
						const estBytes = (props.estimatedBytes as number) ?? 0;
						return (
							<button
								type="button"
								key={tex.id}
								onClick={() => setSelectedId(tex.id)}
								className={`w-full cursor-pointer border-b border-border/50 px-3 py-2 text-left ${
									selectedId === tex.id
										? "bg-blue-600/10"
										: "hover:bg-surface-hover"
								}`}
							>
								<div className="flex items-center justify-between gap-2 text-xs text-foreground">
									<span className="max-w-32 overflow-auto">
										{tex.label || `Texture #${index + 1}`}
									</span>
									{estBytes > 0 && (
										<span className="font-mono text-right text-muted-foreground">
											{formatSize(estBytes)}
										</span>
									)}
								</div>
								<div className="mt-0.5 text-[10px] text-muted">
									{w}x{h}
									{d > 1 ? `x${d}` : ""}
									{format ? ` ${format}` : ""}
								</div>
								<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
									{tex.id}
								</div>
							</button>
						);
					})}
				</ScrollArea>
			</div>

			<div className="flex flex-1 flex-col overflow-hidden">
				{!selected && (
					<div className="flex h-full items-center justify-center text-sm text-muted">
						Select a texture to preview
					</div>
				)}

				{selected && loading && (
					<div className="flex h-full items-center justify-center text-sm text-muted">
						Loading texture data...
					</div>
				)}

				{selected && !loading && data?.error && (
					<div className="flex h-full items-center justify-center p-4 text-sm text-red-400">
						{data.error}
					</div>
				)}

				{selected && !loading && data && !data.error && (
					<ScrollArea className="flex-1">
						<div className="flex flex-col items-center p-4">
							<div
								className="inline-block max-h-[512px] max-w-full overflow-hidden rounded border border-border"
								style={{
									backgroundImage:
										"repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%)",
									backgroundSize: "16px 16px",
								}}
							>
								<canvas
									ref={canvasRef}
									className="block max-h-[512px] max-w-full object-contain"
								/>
							</div>
						</div>

						<div className="border-t border-border px-4 py-3">
							<h3 className="mb-2 text-xs font-semibold text-foreground">
								Texture Info
							</h3>
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
								<dt className="text-muted">Dimensions</dt>
								<dd className="font-mono text-foreground">
									{String(selected.properties.width ?? "?")} x{" "}
									{String(selected.properties.height ?? "?")}
									{((selected.properties.depthOrArrayLayers as number) ?? 1) > 1
										? ` x ${String(selected.properties.depthOrArrayLayers)}`
										: ""}
								</dd>

								<dt className="text-muted">Format</dt>
								<dd className="font-mono text-foreground">
									{String(selected.properties.format ?? "unknown")}
								</dd>

								<dt className="text-muted">Usage</dt>
								<dd className="font-mono text-foreground">
									{formatTextureUsage(
										(selected.properties.usage as number) ?? 0,
									)}
								</dd>

								<dt className="text-muted">Mip Levels</dt>
								<dd className="font-mono text-foreground">
									{String(selected.properties.mipLevelCount ?? "1")}
								</dd>

								<dt className="text-muted">Sample Count</dt>
								<dd className="font-mono text-foreground">
									{String(selected.properties.sampleCount ?? "1")}
								</dd>

								<dt className="text-muted">Size</dt>
								<dd className="font-mono text-foreground">
									{data.data
										? formatSize(Math.ceil((data.data.length * 3) / 4))
										: "N/A"}
								</dd>
							</dl>
						</div>
					</ScrollArea>
				)}
			</div>
		</div>
	);
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
	if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const TEXTURE_USAGE_FLAGS: [number, string][] = [
	[0x01, "COPY_SRC"],
	[0x02, "COPY_DST"],
	[0x04, "TEXTURE_BINDING"],
	[0x08, "STORAGE_BINDING"],
	[0x10, "RENDER_ATTACHMENT"],
];

function formatTextureUsage(usage: number): string {
	const flags = TEXTURE_USAGE_FLAGS.filter(([bit]) => usage & bit).map(
		([, name]) => name,
	);
	return flags.length > 0 ? flags.join(" | ") : "NONE";
}

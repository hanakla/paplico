import {
	Camera,
	ChevronDown,
	ChevronUp,
	Pause,
	Play,
	Trash2,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type {
	CapturedResource,
	CaptureRule,
	CaptureSettings,
} from "../../../../types";

type SortKey = "type" | "label" | "size" | "info" | "status" | "time";
type SortDir = "asc" | "desc";

export function CapturePanel({
	captures,
	captureSettings,
	isPaused,
	onTogglePause,
	onUpdateSettings,
	onClear,
}: {
	captures: CapturedResource[];
	captureSettings: CaptureSettings;
	isPaused: boolean;
	onTogglePause: () => void;
	onUpdateSettings: (settings: CaptureSettings) => void;
	onClear: () => void;
}) {
	const rules = Array.isArray(captureSettings?.rules)
		? captureSettings.rules
		: [];
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sortKey, setSortKey] = useState<SortKey>("time");
	const [sortDir, setSortDir] = useState<SortDir>("desc");
	const selected = captures.find((c) => c.resource.id === selectedId);

	const toggleSort = (key: SortKey) => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			setSortDir("desc");
		}
	};

	const sorted = useMemo(() => {
		const mul = sortDir === "asc" ? 1 : -1;
		return [...captures].sort((a, b) => {
			switch (sortKey) {
				case "type":
					return mul * a.resource.type.localeCompare(b.resource.type);
				case "label":
					return (
						mul *
						(a.resource.label || a.resource.id).localeCompare(
							b.resource.label || b.resource.id,
						)
					);
				case "size":
					return (
						mul *
						(((a.resource.properties.estimatedBytes as number) ?? 0) -
							((b.resource.properties.estimatedBytes as number) ?? 0))
					);
				case "info":
					return mul * getCaptureInfo(a).localeCompare(getCaptureInfo(b));
				case "status":
					return mul * (Number(a.destroyed) - Number(b.destroyed));
				case "time":
					return mul * (a.capturedAt - b.capturedAt);
				default:
					return 0;
			}
		});
	}, [captures, sortKey, sortDir]);

	const addRule = () => {
		onUpdateSettings({
			rules: [
				...rules,
				{
					id: crypto.randomUUID(),
					enabled: true,
					type: "both",
					minBytes: 1_048_576,
				},
			],
		});
	};

	const removeRule = (id: string) => {
		onUpdateSettings({ rules: rules.filter((r) => r.id !== id) });
	};

	const updateRule = (id: string, patch: Partial<CaptureRule>) => {
		onUpdateSettings({
			rules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
		});
	};

	return (
		<div className="flex h-full flex-col">
			{/* Rules config */}
			<div className="border-b border-border px-3 py-2">
				<div className="mb-1.5 flex items-center gap-2">
					<span className="text-xs font-semibold text-muted">
						Capture Rules
					</span>
					<button
						type="button"
						onClick={addRule}
						className="rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-hover hover:text-foreground"
					>
						Add
					</button>
					<div className="ml-auto flex items-center gap-1">
						<button
							type="button"
							onClick={onTogglePause}
							className={`rounded p-1 ${isPaused ? "text-amber-400 hover:bg-amber-500/10" : "text-muted hover:bg-surface-hover hover:text-foreground"}`}
							title={isPaused ? "Resume capture" : "Pause capture"}
						>
							{isPaused ? <Play size={12} /> : <Pause size={12} />}
						</button>
						{captures.length > 0 && (
							<button
								type="button"
								onClick={onClear}
								className="rounded p-1 text-muted hover:bg-surface-hover hover:text-foreground"
								title="Clear captures"
							>
								<Trash2 size={12} />
							</button>
						)}
					</div>
				</div>
				{isPaused && (
					<p className="mb-1 text-[10px] font-medium text-amber-400">
						Capture paused
					</p>
				)}
				{rules.length === 0 ? (
					<p className="text-[10px] text-muted-foreground">
						No rules. Click + to add a capture rule.
					</p>
				) : (
					<div className="flex flex-col gap-1">
						{rules.map((rule) => (
							<div
								key={rule.id}
								className="flex items-center gap-2 rounded border border-border/50 bg-surface px-2 py-1"
							>
								<input
									type="checkbox"
									checked={rule.enabled}
									onChange={(e) =>
										updateRule(rule.id, { enabled: e.target.checked })
									}
									className="accent-accent"
								/>
								<div className="flex rounded border border-border text-[10px]">
									{(
										[
											["both", "Both"],
											["GPUTexture", "Tex"],
											["GPUBuffer", "Buf"],
										] as const
									).map(([value, label]) => (
										<button
											key={value}
											type="button"
											onClick={() => updateRule(rule.id, { type: value })}
											className={`px-1.5 py-0.5 ${
												rule.type === value
													? "bg-blue-600/30 text-blue-400"
													: "text-muted hover:bg-surface-hover hover:text-foreground"
											} ${value !== "both" ? "border-l border-border" : ""}`}
										>
											{label}
										</button>
									))}
								</div>
								<span className="text-[10px] text-muted">≥</span>
								<SizeInput
									value={rule.minBytes}
									onChange={(bytes) => updateRule(rule.id, { minBytes: bytes })}
								/>
								<button
									type="button"
									onClick={() => removeRule(rule.id)}
									className="ml-auto rounded p-0.5 text-muted hover:text-red-400"
								>
									<X size={10} />
								</button>
							</div>
						))}
					</div>
				)}
			</div>

			{/* Capture list + detail */}
			{captures.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center text-muted">
					<Camera size={48} strokeWidth={1} />
					<p className="mt-3 text-sm">
						{rules.length === 0
							? "Add rules to start capturing"
							: rules.some((r) => r.enabled)
								? "Waiting for matching resources..."
								: "All rules are disabled"}
					</p>
				</div>
			) : (
				<div className="flex min-h-0 flex-1">
					{/* List */}
					<div className="flex min-w-0 flex-1 flex-col">
						<div className="border-b border-border px-3 py-1">
							<span className="text-[10px] text-muted-foreground">
								{captures.length} captured
								{" · "}
								{captures.filter((c) => c.destroyed).length} destroyed
							</span>
						</div>
						<ScrollArea className="min-h-0 flex-1">
							<table className="w-full text-xs">
								<thead className="sticky top-0 bg-background">
									<tr className="text-left text-muted">
										<SortTh
											k="type"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Type
										</SortTh>
										<SortTh
											k="label"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Label
										</SortTh>
										<SortTh
											k="size"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Size
										</SortTh>
										<SortTh
											k="info"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Info
										</SortTh>
										<SortTh
											k="status"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Status
										</SortTh>
										<SortTh
											k="time"
											current={sortKey}
											dir={sortDir}
											onClick={toggleSort}
										>
											Time
										</SortTh>
									</tr>
								</thead>
								<tbody>
									{sorted.map((c) => {
										const p = c.resource.properties;
										const bytes = (p.estimatedBytes as number) ?? 0;
										const isTexture = c.resource.type === "GPUTexture";
										const isSelected = selectedId === c.resource.id;
										return (
											<tr
												key={c.resource.id}
												onClick={() =>
													setSelectedId(isSelected ? null : c.resource.id)
												}
												className={`cursor-pointer border-b border-border/50 ${
													isSelected
														? "bg-blue-600/10"
														: "hover:bg-surface-hover/50"
												} ${c.destroyed ? "opacity-50" : ""}`}
											>
												<td
													className={`px-3 py-1.5 font-medium ${isTexture ? "text-emerald-400" : "text-blue-400"}`}
												>
													{c.resource.type.replace("GPU", "")}
												</td>
												<td className="max-w-48 overflow-hidden text-ellipsis whitespace-nowrap px-3 py-1.5 text-foreground">
													{c.resource.label || c.resource.id}
												</td>
												<td className="px-3 py-1.5 font-mono text-foreground">
													{formatSize(bytes)}
												</td>
												<td className="px-3 py-1.5 font-mono text-muted-foreground">
													{isTexture
														? `${formatDimensions(p)} ${p.format ?? ""}`
														: formatBufferUsage((p.usage as number) ?? 0)}
												</td>
												<td className="px-3 py-1.5">
													{c.destroyed ? (
														<span className="text-red-400">destroyed</span>
													) : (
														<span className="text-emerald-400">live</span>
													)}
												</td>
												<td className="px-3 py-1.5 font-mono text-muted-foreground">
													{c.capturedAt.toFixed(0)}ms
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</ScrollArea>
					</div>

					{/* Detail panel */}
					{selected && (
						<div className="w-72 shrink-0 border-l border-border">
							<ScrollArea className="h-full">
								<div className="p-3">
									<CaptureDetail capture={selected} />
								</div>
							</ScrollArea>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function CaptureDetail({ capture }: { capture: CapturedResource }) {
	const r = capture.resource;
	const p = r.properties;
	const isTexture = r.type === "GPUTexture";

	return (
		<div>
			<h3
				className={`text-xs font-semibold ${isTexture ? "text-emerald-400" : "text-blue-400"}`}
			>
				{r.type}
			</h3>
			<p className="mt-0.5 text-xs text-foreground">{r.label || r.id}</p>
			<p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
				{r.id}
			</p>

			<dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
				<dt className="text-muted">Status</dt>
				<dd>
					{capture.destroyed ? (
						<span className="text-red-400">destroyed</span>
					) : (
						<span className="text-emerald-400">live</span>
					)}
				</dd>

				<dt className="text-muted">Size</dt>
				<dd className="font-mono text-foreground">
					{formatSize((p.estimatedBytes as number) ?? 0)}
				</dd>

				{isTexture ? (
					<>
						<dt className="text-muted">Dimensions</dt>
						<dd className="font-mono text-foreground">
							{String(p.width ?? "?")} x {String(p.height ?? "?")}
							{((p.depthOrArrayLayers as number) ?? 1) > 1
								? ` x ${String(p.depthOrArrayLayers)}`
								: ""}
						</dd>

						<dt className="text-muted">Format</dt>
						<dd className="font-mono text-foreground">
							{String(p.format ?? "unknown")}
						</dd>

						<dt className="text-muted">Usage</dt>
						<dd className="font-mono text-foreground">
							{formatTextureUsage((p.usage as number) ?? 0)}
						</dd>

						<dt className="text-muted">Mip Levels</dt>
						<dd className="font-mono text-foreground">
							{String(p.mipLevelCount ?? "1")}
						</dd>

						<dt className="text-muted">Sample Count</dt>
						<dd className="font-mono text-foreground">
							{String(p.sampleCount ?? "1")}
						</dd>

						{p.dimension && (
							<>
								<dt className="text-muted">Dimension</dt>
								<dd className="font-mono text-foreground">
									{String(p.dimension)}
								</dd>
							</>
						)}
					</>
				) : (
					<>
						<dt className="text-muted">Byte Size</dt>
						<dd className="font-mono text-foreground">
							{formatSize((p.size as number) ?? 0)}
						</dd>

						<dt className="text-muted">Usage</dt>
						<dd className="font-mono text-foreground">
							{formatBufferUsage((p.usage as number) ?? 0)}
						</dd>

						{p.mappedAtCreation != null && (
							<>
								<dt className="text-muted">Mapped at Creation</dt>
								<dd className="font-mono text-foreground">
									{String(p.mappedAtCreation)}
								</dd>
							</>
						)}
					</>
				)}

				<dt className="text-muted">Captured At</dt>
				<dd className="font-mono text-foreground">
					{capture.capturedAt.toFixed(1)}ms
				</dd>

				{capture.destroyed && capture.destroyedAt != null && (
					<>
						<dt className="text-muted">Destroyed At</dt>
						<dd className="font-mono text-foreground">
							{capture.destroyedAt.toFixed(1)}ms
						</dd>

						<dt className="text-muted">Lifetime</dt>
						<dd className="font-mono text-foreground">
							{(capture.destroyedAt - capture.capturedAt).toFixed(1)}ms
						</dd>
					</>
				)}
			</dl>

			{/* Raw properties */}
			<details className="mt-3">
				<summary className="cursor-pointer text-[10px] text-muted hover:text-foreground">
					Raw Properties
				</summary>
				<pre className="mt-1 whitespace-pre-wrap break-all rounded bg-surface-hover p-2 font-mono text-[10px] text-foreground">
					{JSON.stringify(p, null, 2)}
				</pre>
			</details>
		</div>
	);
}

function SortTh({
	k,
	current,
	dir,
	onClick,
	children,
}: {
	k: SortKey;
	current: SortKey;
	dir: SortDir;
	onClick: (key: SortKey) => void;
	children: React.ReactNode;
}) {
	const active = current === k;
	return (
		<th
			className="cursor-pointer select-none px-3 py-1.5 font-medium hover:text-foreground"
			onClick={() => onClick(k)}
		>
			<span className="inline-flex items-center gap-0.5">
				{children}
				{active &&
					(dir === "asc" ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
			</span>
		</th>
	);
}

function getCaptureInfo(c: CapturedResource): string {
	const p = c.resource.properties;
	if (c.resource.type === "GPUTexture") {
		return `${formatDimensions(p)} ${p.format ?? ""}`;
	}
	return formatBufferUsage((p.usage as number) ?? 0);
}

function formatDimensions(p: Record<string, unknown>): string {
	const w = (p.width as number) ?? 0;
	const h = (p.height as number) ?? 0;
	const d = (p.depthOrArrayLayers as number) ?? 1;
	return d > 1 ? `${w}x${h}x${d}` : `${w}x${h}`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

const BUFFER_USAGE_FLAGS: [number, string][] = [
	[0x01, "MAP_READ"],
	[0x02, "MAP_WRITE"],
	[0x04, "COPY_SRC"],
	[0x08, "COPY_DST"],
	[0x10, "INDEX"],
	[0x20, "VERTEX"],
	[0x40, "UNIFORM"],
	[0x80, "STORAGE"],
	[0x100, "INDIRECT"],
	[0x200, "QUERY_RESOLVE"],
];

function formatBufferUsage(usage: number): string {
	const flags = BUFFER_USAGE_FLAGS.filter(([bit]) => usage & bit).map(
		([, name]) => name,
	);
	return flags.length > 0 ? flags.join(" | ") : "";
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

function SizeInput({
	value,
	onChange,
}: {
	value: number;
	onChange: (bytes: number) => void;
}) {
	const [draft, setDraft] = useState(formatSize(value));

	const commit = () => {
		const bytes = parseSize(draft);
		if (bytes != null) {
			onChange(bytes);
			setDraft(formatSize(bytes));
		} else {
			setDraft(formatSize(value));
		}
	};

	return (
		<input
			type="text"
			value={draft}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") commit();
			}}
			className="w-16 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground caret-current outline-none focus:border-blue-500"
			placeholder="e.g. 1MB"
		/>
	);
}

function parseSize(input: string): number | null {
	const trimmed = input.trim().toLowerCase();
	if (trimmed === "0" || trimmed === "all") return 0;
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/);
	if (!match) return null;
	const num = Number.parseFloat(match[1]);
	switch (match[2]) {
		case "gb":
		case "g":
			return Math.round(num * 1_073_741_824);
		case "mb":
		case "m":
			return Math.round(num * 1_048_576);
		case "kb":
		case "k":
			return Math.round(num * 1024);
		default:
			return Math.round(num);
	}
}

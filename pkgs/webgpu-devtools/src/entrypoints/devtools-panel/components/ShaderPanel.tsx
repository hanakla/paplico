import { Code } from "lucide-react";
import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type { ResourceInfo } from "../../../../types";

const WGSL_KEYWORDS =
	/\b(fn|var|let|const|struct|return|if|else|for|while|loop|break|continue|switch|case|default|discard|enable|alias|override|diagnostic)\b/g;
const WGSL_TYPES =
	/\b(f32|f16|i32|u32|bool|vec[234]f?|vec[234][iu]?|mat[234]x[234]f?|array|ptr|sampler|sampler_comparison|texture_[a-z_0-9]+)\b/g;
const WGSL_ATTRS = /@[a-z_]+/g;
const WGSL_NUMBERS = /\b(\d+\.?\d*[eE]?[+-]?\d*[fhiu]?|0x[0-9a-fA-F]+[iu]?)\b/g;
const WGSL_COMMENTS = /\/\/.*/g;

function highlightWGSL(code: string): React.ReactNode[] {
	const tokens: { start: number; end: number; cls: string }[] = [];

	const collect = (regex: RegExp, cls: string) => {
		for (const m of code.matchAll(regex)) {
			tokens.push({
				start: m.index ?? 0,
				end: (m.index ?? 0) + m[0].length,
				cls,
			});
		}
	};

	collect(WGSL_COMMENTS, "text-muted");
	collect(WGSL_KEYWORDS, "text-violet-400");
	collect(WGSL_TYPES, "text-cyan-400");
	collect(WGSL_ATTRS, "text-yellow-400");
	collect(WGSL_NUMBERS, "text-amber-400");

	tokens.sort((a, b) => a.start - b.start || (a.cls === "text-muted" ? -1 : 1));

	const merged: typeof tokens = [];
	let lastEnd = 0;
	for (const t of tokens) {
		if (t.start >= lastEnd) {
			merged.push(t);
			lastEnd = t.end;
		}
	}

	const parts: React.ReactNode[] = [];
	let pos = 0;
	for (const t of merged) {
		if (t.start > pos) parts.push(code.slice(pos, t.start));
		parts.push(
			<span key={t.start} className={t.cls}>
				{code.slice(t.start, t.end)}
			</span>,
		);
		pos = t.end;
	}
	if (pos < code.length) parts.push(code.slice(pos));
	return parts;
}

export function ShaderPanel({ shaders }: { shaders: ResourceInfo[] }) {
	const [selectedId, setSelectedId] = useState<string | null>(
		shaders[0]?.id ?? null,
	);

	const selected = shaders.find((s) => s.id === selectedId);
	const code = (selected?.properties.code as string) ?? "";
	const highlighted = useMemo(() => highlightWGSL(code), [code]);

	if (shaders.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Code size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No shader modules created</p>
			</div>
		);
	}

	return (
		<div className="flex h-full">
			<div className="w-52 shrink-0 border-r border-border">
				<ScrollArea className="h-full">
					{shaders.map((s, i) => (
						<button
							type="button"
							key={s.id}
							onClick={() => setSelectedId(s.id)}
							className={`w-full px-3 py-2 text-left text-xs ${
								selectedId === s.id
									? "bg-blue-600/20 text-blue-400"
									: "text-foreground hover:bg-surface-hover"
							}`}
						>
							<div className="font-medium">{s.label || `Shader #${i + 1}`}</div>
							<div className="mt-0.5 font-mono text-[10px] text-muted">
								{s.id}
							</div>
						</button>
					))}
				</ScrollArea>
			</div>

			<ScrollArea className="flex-1">
				<div className="p-4">
					<pre className="font-mono text-xs leading-5 text-foreground">
						<code>{highlighted}</code>
					</pre>
				</div>
			</ScrollArea>
		</div>
	);
}

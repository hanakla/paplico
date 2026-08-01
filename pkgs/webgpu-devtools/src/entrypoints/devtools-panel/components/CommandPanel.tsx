import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, Terminal } from "lucide-react";
import { ScrollArea } from "@/components/ScrollArea";
import type { CommandInfo } from "../../../../types";

const COMMAND_COLORS: Record<string, string> = {
	draw: "text-emerald-400",
	drawIndexed: "text-emerald-400",
	drawIndirect: "text-emerald-400",
	drawIndexedIndirect: "text-emerald-400",
	dispatchWorkgroups: "text-blue-400",
	dispatchWorkgroupsIndirect: "text-blue-400",
	beginRenderPass: "text-violet-400",
	endRenderPass: "text-violet-400",
	beginComputePass: "text-cyan-400",
	copyBufferToBuffer: "text-amber-400",
	copyBufferToTexture: "text-amber-400",
	copyTextureToBuffer: "text-amber-400",
	copyTextureToTexture: "text-amber-400",
	finish: "text-muted",
};

export function CommandPanel({ commands }: { commands: CommandInfo[] }) {
	if (commands.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Terminal size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No commands recorded</p>
			</div>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="divide-y divide-border/50">
				{commands.map((cmd) => (
					<Collapsible.Root key={cmd.id}>
						<Collapsible.Trigger className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-hover/50">
							<ChevronRight
								size={10}
								className="shrink-0 text-muted transition-transform group-data-open:rotate-90"
							/>
							<span className="font-mono text-[10px] text-muted-foreground">
								{cmd.timestamp.toFixed(1)}ms
							</span>
							<span
								className={`font-mono font-medium ${COMMAND_COLORS[cmd.type] ?? "text-foreground"}`}
							>
								{cmd.type}
							</span>
							<span className="ml-auto font-mono text-[10px] text-muted-foreground">
								{formatArgsSummary(cmd.args)}
							</span>
						</Collapsible.Trigger>
						<Collapsible.Panel className="bg-background/50 px-8 py-2">
							<pre className="font-mono text-[10px] text-muted">
								{JSON.stringify(cmd.args, null, 2)}
							</pre>
						</Collapsible.Panel>
					</Collapsible.Root>
				))}
			</div>
		</ScrollArea>
	);
}

function formatArgsSummary(args: Record<string, unknown>): string {
	const entries = Object.entries(args).filter(([, v]) => v != null);
	if (entries.length === 0) return "";
	return entries.map(([k, v]) => `${k}=${v}`).join(" ");
}

import { Collapsible } from "@base-ui/react/collapsible";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ScrollArea";
import type { ErrorInfo } from "../../../../types";

const ERROR_COLORS: Record<ErrorInfo["type"], string> = {
	validation: "text-amber-400",
	"out-of-memory": "text-red-400",
	internal: "text-red-400",
	lost: "text-red-500",
};

const ERROR_BG: Record<ErrorInfo["type"], string> = {
	validation: "bg-amber-500/5 border-amber-500/20",
	"out-of-memory": "bg-red-500/5 border-red-500/20",
	internal: "bg-red-500/5 border-red-500/20",
	lost: "bg-red-500/10 border-red-500/30",
};

export function ErrorPanel({ errors }: { errors: ErrorInfo[] }) {
	if (errors.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<AlertTriangle size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No errors detected</p>
				<p className="mt-1 text-xs text-muted-foreground">
					WebGPU validation, OOM, and device lost errors appear here
				</p>
			</div>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-3">
				<div className="space-y-1.5">
					{errors.map((err) => (
						<Collapsible.Root key={err.id}>
							<div className={`rounded border ${ERROR_BG[err.type]}`}>
								<Collapsible.Trigger className="group flex w-full items-start gap-2 px-3 py-2 text-left text-xs">
									<ChevronRight
										size={10}
										className="mt-0.5 shrink-0 text-muted transition-transform group-data-open:rotate-90"
									/>
									<AlertTriangle
										size={12}
										className={`mt-0.5 shrink-0 ${ERROR_COLORS[err.type]}`}
									/>
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<span
												className={`font-mono text-[10px] font-semibold uppercase ${ERROR_COLORS[err.type]}`}
											>
												{err.type}
											</span>
											<span className="font-mono text-[10px] text-muted-foreground">
												{err.timestamp.toFixed(1)}ms
											</span>
										</div>
										<p className="mt-0.5 break-all text-foreground">
											{err.message.length > 200
												? `${err.message.slice(0, 200)}...`
												: err.message}
										</p>
									</div>
								</Collapsible.Trigger>
								<Collapsible.Panel className="border-t border-border/50 px-8 py-2">
									<pre className="whitespace-pre-wrap break-all font-mono text-[10px] text-muted">
										{err.message}
									</pre>
									<div className="mt-2 text-[10px] text-muted-foreground">
										Device: {err.deviceId}
									</div>
								</Collapsible.Panel>
							</div>
						</Collapsible.Root>
					))}
				</div>
			</div>
		</ScrollArea>
	);
}

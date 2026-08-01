import { Input } from "@base-ui/react/input";
import { Cpu, Search } from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "@/components/ScrollArea";
import type { DeviceInfo } from "../../../../types";

export function DevicePanel({ devices }: { devices: DeviceInfo[] }) {
	const [limitFilter, setLimitFilter] = useState("");

	if (devices.length === 0) {
		return (
			<div className="flex h-full flex-col items-center justify-center text-muted">
				<Cpu size={48} strokeWidth={1} />
				<p className="mt-3 text-sm">No GPU device detected</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Navigate to a page using WebGPU to inspect its device
				</p>
			</div>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="p-4">
				{devices.map((device) => (
					<div key={device.id} className="space-y-4">
						<section>
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
								Adapter Info
							</h2>
							<div className="rounded-md border border-border bg-background">
								<InfoRow label="Vendor" value={device.adapterInfo.vendor} />
								<InfoRow
									label="Architecture"
									value={device.adapterInfo.architecture}
								/>
								<InfoRow label="Device" value={device.adapterInfo.device} />
								<InfoRow
									label="Description"
									value={device.adapterInfo.description}
								/>
								{device.label && <InfoRow label="Label" value={device.label} />}
							</div>
						</section>

						<section>
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
								Features ({device.features.length})
							</h2>
							<div className="flex flex-wrap gap-1.5">
								{device.features.map((f) => (
									<span
										key={f}
										className="rounded-sm border border-border bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-foreground"
									>
										{f}
									</span>
								))}
							</div>
						</section>

						<section>
							<h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
								Limits
							</h2>
							<div className="relative mb-2">
								<Search
									size={12}
									className="absolute left-2 top-1/2 -translate-y-1/2 text-muted"
								/>
								<Input
									className="w-full rounded border border-border bg-surface-hover py-1 pl-7 pr-2 font-mono text-xs text-foreground outline-none focus:border-blue-500"
									placeholder="Filter limits..."
									value={limitFilter}
									onChange={(e) => setLimitFilter(e.target.value)}
								/>
							</div>
							<div className="rounded-md border border-border bg-background">
								{Object.entries(device.limits)
									.filter(([key]) =>
										key.toLowerCase().includes(limitFilter.toLowerCase()),
									)
									.map(([key, value]) => (
										<InfoRow
											key={key}
											label={key}
											value={value.toLocaleString()}
											mono
										/>
									))}
							</div>
						</section>
					</div>
				))}
			</div>
		</ScrollArea>
	);
}

function InfoRow({
	label,
	value,
	mono,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="flex items-center border-b border-border px-3 py-1.5 last:border-b-0">
			<span className="w-72 shrink-0 text-xs text-muted">{label}</span>
			<span className={`text-xs text-foreground ${mono ? "font-mono" : ""}`}>
				{value || "\u2014"}
			</span>
		</div>
	);
}

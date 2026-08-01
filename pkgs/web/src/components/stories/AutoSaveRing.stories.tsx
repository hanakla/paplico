import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useSnapshot } from "valtio";
import { AUTO_SAVE_INTERVAL_MS, AUTO_SAVE_SLOW_INTERVAL_MS } from "@/configs";
import { autoSaveState } from "@/stores/autoSave";
import { AutoSaveRing } from "../AutoSaveRing";

const meta = {
	title: "Components/AutoSaveRing",
	component: AutoSaveRing,
} satisfies Meta<typeof AutoSaveRing>;

export default meta;

type Story = StoryObj<typeof meta>;

function AutoSaveRingShowcase() {
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-3 rounded-md border border-border p-3">
				<AutoSaveRing />
				<div className="flex flex-col gap-0.5">
					<p className="text-xs text-muted-foreground">
						Live indicator driven by the module-level autoSaveState store. Click
						a button below to change state.
					</p>
					<AutoSaveStateReadout />
				</div>
			</div>
			<div className="flex flex-wrap gap-2">
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-muted hover:bg-muted-hover"
					onClick={() => {
						autoSaveState.isSaving = false;
						autoSaveState.isSlowDocument = false;
						autoSaveState.intervalMs = AUTO_SAVE_INTERVAL_MS;
						autoSaveState.lastSaveTimestamp = Date.now();
						autoSaveState.nextSaveAt = Date.now() + AUTO_SAVE_INTERVAL_MS;
					}}
				>
					Idle
				</button>
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-muted hover:bg-muted-hover"
					onClick={() => {
						autoSaveState.isSaving = true;
					}}
				>
					Saving
				</button>
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-muted hover:bg-muted-hover"
					onClick={() => {
						autoSaveState.isSaving = false;
						autoSaveState.saveCount++;
						autoSaveState.lastSaveTimestamp = Date.now();
					}}
				>
					Just saved
				</button>
				<button
					type="button"
					className="rounded px-3 py-1.5 text-sm bg-muted hover:bg-muted-hover"
					onClick={() => {
						autoSaveState.isSlowDocument = true;
						autoSaveState.intervalMs = AUTO_SAVE_SLOW_INTERVAL_MS;
					}}
				>
					Slow document
				</button>
			</div>
		</div>
	);
}

function AutoSaveStateReadout() {
	const snap = useSnapshot(autoSaveState);
	return (
		<p className="text-[10px] text-muted-foreground/60">
			{`isSaving: ${snap.isSaving} / isSlowDocument: ${snap.isSlowDocument} / saveCount: ${snap.saveCount}`}
		</p>
	);
}

export const Playground: Story = {
	render: () => <AutoSaveRingShowcase />,
};

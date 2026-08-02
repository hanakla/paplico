import { Download, RotateCcw, Search, Upload } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { usePaplicoMaybe } from "@/contexts/PaplicoContext";
import {
	formatKeySpec,
	IS_MAC,
	type Keybinding,
	type KeySpec,
	type ShortcutCommand,
	type ShortcutsConfig,
} from "@/core/PaplicoShortcuts";
import { setShortcutOverrides } from "@/hooks/useAppConfig";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

// --- Types ---

interface RecordingState {
	commandId: string;
	when?: Record<string, boolean>;
	captured: KeySpec | null;
	conflict: Keybinding | null;
}

// --- Helpers ---

function keySpecFromEvent(e: KeyboardEvent): KeySpec | null {
	// Ignore bare modifier keys
	if (
		e.code === "ShiftLeft" ||
		e.code === "ShiftRight" ||
		e.code === "ControlLeft" ||
		e.code === "ControlRight" ||
		e.code === "AltLeft" ||
		e.code === "AltRight" ||
		e.code === "MetaLeft" ||
		e.code === "MetaRight"
	) {
		return null;
	}

	const spec: KeySpec = { code: e.code };
	if (IS_MAC ? e.metaKey : e.ctrlKey) spec.ctrlOrMeta = true;
	if (e.shiftKey) spec.shift = true;
	if (e.altKey) spec.alt = true;

	return spec;
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic locale key lookup
type AnyTransFn = (key: any) => string | null;

function resolveCommandTitle(id: string, t: AnyTransFn): string {
	// "paplico.deleteElements" → "shortcutCmd.deleteElements"
	return t(`shortcutCmd.${id.slice(8)}`) ?? id;
}

function resolveCategoryName(category: string, t: AnyTransFn): string {
	return t(`shortcutCategory.${category}`) ?? category;
}

function groupCommandsByCategory(
	commands: ShortcutCommand[],
): Map<string, ShortcutCommand[]> {
	const grouped = new Map<string, ShortcutCommand[]>();
	for (const cmd of commands) {
		const list = grouped.get(cmd.category);
		if (list) {
			list.push(cmd);
		} else {
			grouped.set(cmd.category, [cmd]);
		}
	}
	return grouped;
}

// --- Component ---

export const ShortcutsSettings = memo(function ShortcutsSettings() {
	const paplico = usePaplicoMaybe();
	const t = useTranslation();

	const [search, setSearch] = useState("");
	const [recording, setRecording] = useState<RecordingState | null>(null);
	const [, setTick] = useState(0);

	const fileInputRef = useRef<HTMLInputElement>(null);

	// Re-render when shortcuts change
	useEffect(() => {
		if (!paplico) return;

		const handler = () => setTick((n) => n + 1);
		paplico.shortcuts.on("change", handler);
		return () => {
			paplico.shortcuts.off("change", handler);
		};
	}, [paplico]);

	const handleSearchChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			setSearch(e.target.value);
		},
	);

	const handleStartRecording = useEventCallback(
		(commandId: string, when?: Record<string, boolean>) => {
			setRecording({ commandId, when, captured: null, conflict: null });
		},
	);

	const handleCancelRecording = useEventCallback(() => {
		setRecording(null);
	});

	const handleSaveRecording = useEventCallback(() => {
		if (!paplico || !recording?.captured) return;

		paplico.shortcuts.setUserKeybinding(
			recording.commandId,
			recording.captured,
			recording.when,
		);

		const config = paplico.shortcuts.exportConfig();
		setShortcutOverrides(config.keybindings.length > 0 ? config : null);

		setRecording(null);
	});

	const handleRemoveBinding = useEventCallback(
		(commandId: string, when?: Record<string, boolean>) => {
			if (!paplico) return;

			paplico.shortcuts.removeUserKeybinding(commandId, when);

			const config = paplico.shortcuts.exportConfig();
			setShortcutOverrides(config.keybindings.length > 0 ? config : null);

			setRecording(null);
		},
	);

	const handleExport = useEventCallback(() => {
		if (!paplico) return;

		const json = JSON.stringify(paplico.shortcuts.exportConfig(), null, 2);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);

		const a = document.createElement("a");
		a.href = url;
		a.download = "paplico-shortcuts.json";
		a.click();
		URL.revokeObjectURL(url);
	});

	const handleImport = useEventCallback(() => {
		fileInputRef.current?.click();
	});

	const handleFileChange = useEventCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (!paplico) return;

			const file = e.target.files?.[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = () => {
				try {
					const config = JSON.parse(reader.result as string) as ShortcutsConfig;
					paplico.shortcuts.importConfig(config);

					const exported = paplico.shortcuts.exportConfig();
					setShortcutOverrides(
						exported.keybindings.length > 0 ? exported : null,
					);
				} catch (err) {
					console.error("Failed to import shortcuts config:", err);
				}
			};
			reader.readAsText(file);

			// Reset the input so re-importing the same file triggers onChange
			e.target.value = "";
		},
	);

	const handleReset = useEventCallback(() => {
		if (!paplico) return;

		paplico.shortcuts.resetToDefaults();
		setShortcutOverrides(null);
		setRecording(null);
	});

	if (!paplico) return null;

	const allCommands = paplico.shortcuts.getCommands();
	const lowerSearch = search.toLowerCase();
	const filteredCommands = search
		? allCommands.filter(
				(cmd) =>
					cmd.category.toLowerCase().includes(lowerSearch) ||
					cmd.id.toLowerCase().includes(lowerSearch) ||
					resolveCommandTitle(cmd.id, t).toLowerCase().includes(lowerSearch) ||
					resolveCategoryName(cmd.category, t)
						.toLowerCase()
						.includes(lowerSearch),
			)
		: allCommands;

	const grouped = groupCommandsByCategory(filteredCommands);
	const sortedCategories = [...grouped.keys()].sort();

	return (
		<div className="flex flex-col h-full">
			{/* Search */}
			<div className="relative mb-4">
				<Search
					size={14}
					className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
				/>
				<Input
					$size="sm"
					value={search}
					onChange={handleSearchChange}
					placeholder={t("preferences.shortcutsSearch")}
					className="pl-8"
				/>
			</div>

			{/* Command list */}
			<div className="flex-1 overflow-y-auto -mx-6 px-6 space-y-5">
				{sortedCategories.length === 0 && (
					<div className="text-sm text-muted-foreground text-center py-8">
						{t("preferences.shortcutsNoResults")}
					</div>
				)}

				{sortedCategories.map((category) => {
					const commands = grouped.get(category)!;
					return (
						<div key={category}>
							<h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
								{resolveCategoryName(category, t)}
							</h3>
							<div className="space-y-1">
								{commands.map((cmd) => (
									<CommandRow
										key={cmd.id}
										command={cmd}
										bindings={paplico.shortcuts.getBindingsForCommand(cmd.id)}
										recording={recording}
										paplico={paplico}
										onStartRecording={handleStartRecording}
										onCancelRecording={handleCancelRecording}
										onSaveRecording={handleSaveRecording}
										onRemoveBinding={handleRemoveBinding}
										setRecording={setRecording}
									/>
								))}
							</div>
						</div>
					);
				})}
			</div>

			{/* Action bar */}
			<div className="flex items-center gap-2 pt-4 mt-4 border-t border-border/30">
				<Button $variant="ghost" $size="sm" onClick={handleExport}>
					<Download size={14} />
					{t("preferences.shortcutsExport")}
				</Button>
				<Button $variant="ghost" $size="sm" onClick={handleImport}>
					<Upload size={14} />
					{t("preferences.shortcutsImport")}
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept=".json"
					className="hidden"
					onChange={handleFileChange}
				/>
				<div className="flex-1" />
				<Button $variant="ghost" $size="sm" onClick={handleReset}>
					<RotateCcw size={14} />
					{t("preferences.shortcutsReset")}
				</Button>
			</div>
		</div>
	);
});

// --- CommandRow ---

const CommandRow = memo(function CommandRow({
	command,
	bindings,
	recording,
	paplico,
	onStartRecording,
	onCancelRecording,
	onSaveRecording,
	onRemoveBinding,
	setRecording,
}: {
	command: ShortcutCommand;
	bindings: Keybinding[];
	recording: RecordingState | null;
	paplico: NonNullable<ReturnType<typeof usePaplicoMaybe>>;
	onStartRecording: (commandId: string, when?: Record<string, boolean>) => void;
	onCancelRecording: () => void;
	onSaveRecording: () => void;
	onRemoveBinding: (commandId: string, when?: Record<string, boolean>) => void;
	setRecording: React.Dispatch<React.SetStateAction<RecordingState | null>>;
}) {
	const t = useTranslation();
	const isRecordingThis = recording?.commandId === command.id;

	const keyRecorderRef = useRef<HTMLDivElement>(null);

	// Listen for keydown when recording this command
	useEffect(() => {
		if (!isRecordingThis) return;

		const handler = (e: KeyboardEvent) => {
			const spec = keySpecFromEvent(e);
			if (!spec) return; // Let bare modifier keys propagate naturally

			e.preventDefault();
			e.stopPropagation();

			const conflict = paplico.shortcuts.findConflict(
				spec,
				recording?.when,
				command.id,
			);

			setRecording((prev) =>
				prev ? { ...prev, captured: spec, conflict } : null,
			);
		};

		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [isRecordingThis, command.id, paplico, recording?.when, setRecording]);

	// Focus the recorder element when recording starts
	useEffect(() => {
		if (isRecordingThis) {
			keyRecorderRef.current?.focus();
		}
	}, [isRecordingThis]);

	const binding = bindings[0] ?? null;

	if (isRecordingThis) {
		return (
			<div className="rounded-md bg-accent/5 border border-accent/20 p-3">
				<div className="flex items-center justify-between mb-2">
					<span className="text-sm font-medium text-foreground">
						{resolveCommandTitle(command.id, t)}
					</span>
				</div>

				{/* Key capture area */}
				<div
					ref={keyRecorderRef}
					tabIndex={-1}
					className={twm(
						"h-9 rounded-md border border-dashed border-accent/40 bg-background/50",
						"flex items-center justify-center text-sm text-muted-foreground",
						"outline-none focus:border-accent focus:ring-1 focus:ring-accent/30",
					)}
				>
					{recording.captured ? (
						<KbdBadge spec={recording.captured} />
					) : (
						t("preferences.shortcutsRecordingHint")
					)}
				</div>

				{/* Conflict warning */}
				{recording.conflict && (
					<div className="mt-2 text-xs text-danger">
						{t("preferences.shortcutsConflict")}{" "}
						<span className="font-medium">
							{(() => {
								const conflictCmd = paplico.shortcuts
									.getCommands()
									.find((c) => c.id === recording.conflict!.commandId);
								return conflictCmd
									? resolveCommandTitle(conflictCmd.id, t)
									: recording.conflict!.commandId;
							})()}
						</span>
					</div>
				)}

				{/* Recording actions */}
				<div className="flex items-center gap-2 mt-3">
					<Button
						$size="sm"
						disabled={!recording.captured}
						onClick={onSaveRecording}
					>
						{t("preferences.shortcutsSave")}
					</Button>
					<Button $variant="ghost" $size="sm" onClick={onCancelRecording}>
						{t("preferences.shortcutsCancel")}
					</Button>
					<div className="flex-1" />
					{binding && (
						<Button
							$variant="ghost"
							$size="sm"
							onClick={() => onRemoveBinding(command.id, recording.when)}
						>
							{t("preferences.shortcutsRemove")}
						</Button>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-foreground/5 group">
			<span className="text-sm text-foreground">
				{resolveCommandTitle(command.id, t)}
			</span>
			<div className="flex items-center gap-2">
				{binding ? (
					<KbdBadge spec={binding.key} />
				) : (
					<span className="text-xs text-muted-foreground/50">
						{t("preferences.shortcutsUnbound")}
					</span>
				)}
				<button
					type="button"
					onClick={() => onStartRecording(command.id, binding?.when)}
					className={twm(
						"text-xs text-muted-foreground hover:text-foreground transition-colors",
						"opacity-0 group-hover:opacity-100",
					)}
				>
					{t("preferences.shortcutsEdit")}
				</button>
			</div>
		</div>
	);
});

// --- KbdBadge ---

function KbdBadge({ spec }: { spec: KeySpec }) {
	return (
		<kbd
			className={twm(
				"inline-flex items-center px-1.5 py-0.5 rounded",
				"bg-foreground/8 border border-border/50",
				"text-xs font-mono text-foreground/80 whitespace-nowrap",
			)}
		>
			{formatKeySpec(spec)}
		</kbd>
	);
}

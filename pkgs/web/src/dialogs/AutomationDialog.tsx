"use client";

import {
	ChevronDown,
	ChevronRight,
	CircleStop,
	Play,
	Plus,
	Save,
	Trash2,
	X,
} from "lucide-react";
import type { editor } from "monaco-editor";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type {
	AutomationDiagnostic,
	AutomationPromptRequest,
	AutomationPromptResponse,
	AutomationRuntimeAdapter,
	AutomationRuntimeFactory,
	AutomationScript,
	AutomationScriptRepository,
} from "@/automation/types";
import { Button } from "@/components/Button";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";
import { twm } from "@/utils/tailwind";

const AutomationCodeEditor = dynamic(() => import("./AutomationCodeEditor"), {
	ssr: false,
	loading: () => (
		<div className="grid h-full place-items-center bg-[#1e1e1e] text-sm text-white/60">
			Loading editor…
		</div>
	),
});

// lint-unused-ignore: loaded through next/dynamic, which the linter can't follow
export default function AutomationPanel({
	onClose,
	repository,
	createRuntime,
	runtimeKey,
	variant = "desktop",
	side = "left",
}: {
	onClose: () => void;
	repository: AutomationScriptRepository;
	createRuntime?: AutomationRuntimeFactory;
	runtimeKey?: string;
	variant?: "desktop" | "mobile";
	side?: "left" | "right";
}) {
	const t = useTranslation();
	const [scripts, setScripts] = useState<AutomationScript[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<AutomationScript | null>(null);
	const [logs, setLogs] = useState<string[]>([]);
	const [diagnostics, setDiagnostics] = useState<AutomationDiagnostic[]>([]);
	const [isRunning, setIsRunning] = useState(false);
	// The editor eats the whole screen on a phone, so it starts folded away there.
	const [codeExpanded, setCodeExpanded] = useState(false);
	const [repositoryError, setRepositoryError] = useState<string | null>(null);
	const [pendingPrompt, setPendingPrompt] = useState<{
		id: number;
		request: AutomationPromptRequest;
	} | null>(null);
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const runtimeRef = useRef<AutomationRuntimeAdapter | null>(null);
	const stopRequestedRef = useRef(false);
	const promptIdRef = useRef(0);
	const promptResolveRef = useRef<
		((response: AutomationPromptResponse) => void) | null
	>(null);
	const promptAbortCleanupRef = useRef<(() => void) | null>(null);

	const toggleCodeExpanded = useEventCallback(() => {
		setCodeExpanded((current) => !current);
	});

	const selectScript = useEventCallback((script: AutomationScript) => {
		setSelectedId(script.id);
		setDraft({ ...script });
		setDiagnostics([]);
		setLogs([]);
	});

	const refreshScripts = useEventCallback(async (preferredId?: string) => {
		try {
			const nextScripts = await repository.list();
			setScripts(nextScripts);
			const selected =
				nextScripts.find(({ id }) => id === preferredId) ??
				nextScripts.find(({ id }) => id === selectedId) ??
				nextScripts[0] ??
				null;
			if (selected) selectScript(selected);
			setRepositoryError(null);
		} catch (error) {
			setRepositoryError(
				error instanceof Error ? error.message : String(error),
			);
		}
	});

	useEffect(() => {
		void refreshScripts();
	}, [refreshScripts]);

	useEffect(
		() => () => {
			void runtimeRef.current?.dispose();
			promptAbortCleanupRef.current?.();
			promptResolveRef.current?.(null);
			promptResolveRef.current = null;
		},
		[],
	);

	const finishPrompt = useEventCallback(
		(response: AutomationPromptResponse) => {
			const resolve = promptResolveRef.current;
			if (!resolve) return;
			promptResolveRef.current = null;
			promptAbortCleanupRef.current?.();
			promptAbortCleanupRef.current = null;
			setPendingPrompt(null);
			resolve(response);
		},
	);

	const handlePrompt = useEventCallback(
		(
			request: AutomationPromptRequest,
			signal: AbortSignal,
		): Promise<AutomationPromptResponse> => {
			if (signal.aborted) return Promise.resolve(null);
			finishPrompt(null);

			return new Promise((resolve) => {
				const handleAbort = () => finishPrompt(null);
				signal.addEventListener("abort", handleAbort, { once: true });
				promptAbortCleanupRef.current = () =>
					signal.removeEventListener("abort", handleAbort);
				promptResolveRef.current = resolve;
				setPendingPrompt({
					id: ++promptIdRef.current,
					request,
				});
			});
		},
	);

	// The runtime owns capabilities for one document session and must be recreated
	// when the session identity changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runtimeKey is the session identity trigger.
	useEffect(() => {
		const runtime = runtimeRef.current;
		runtimeRef.current = null;
		void runtime?.dispose();
	}, [runtimeKey]);

	const handleAdd = useEventCallback(async () => {
		const created = await repository.create({
			name: t("automation.untitledScript"),
			description: "",
			source: "// Write a Paplico automation script.\n",
		});
		await refreshScripts(created.id);
	});

	const handleSave = useEventCallback(async () => {
		if (!draft || draft.origin !== "user") return;
		await repository.update(draft);
		await refreshScripts(draft.id);
	});

	const handleDelete = useEventCallback(async () => {
		if (!draft || draft.origin !== "user") return;
		await repository.delete(draft.id);
		await refreshScripts();
	});

	const handleRun = useEventCallback(async () => {
		if (!draft || !createRuntime || isRunning) return;
		stopRequestedRef.current = false;
		setIsRunning(true);
		setLogs([]);
		setDiagnostics([]);

		try {
			runtimeRef.current ??= await createRuntime({
				onLog: (message) => setLogs((current) => [...current, message]),
				onPrompt: handlePrompt,
			});
			if (stopRequestedRef.current) {
				runtimeRef.current.stop();
				return;
			}
			const result = await runtimeRef.current.run(draft.source);
			setDiagnostics(result.diagnostics);
		} catch (error) {
			if (!stopRequestedRef.current) {
				setDiagnostics([
					{
						message: error instanceof Error ? error.message : String(error),
						severity: "error",
					},
				]);
			}
		} finally {
			finishPrompt(null);
			setIsRunning(false);
		}
	});

	const handleStop = useEventCallback(() => {
		stopRequestedRef.current = true;
		finishPrompt(null);
		runtimeRef.current?.stop();
		setIsRunning(false);
	});

	const handleEditorMount = useEventCallback(
		(mountedEditor: editor.IStandaloneCodeEditor) => {
			editorRef.current = mountedEditor;
		},
	);

	const handleDiagnosticClick = useEventCallback(
		(diagnostic: AutomationDiagnostic) => {
			if (!diagnostic.line) return;
			editorRef.current?.revealLineInCenter(diagnostic.line);
			editorRef.current?.setPosition({
				lineNumber: diagnostic.line,
				column: diagnostic.column ?? 1,
			});
			editorRef.current?.focus();
		},
	);

	const isMobile = variant === "mobile";
	const showEditor = !isMobile || codeExpanded;
	const editable = draft?.origin === "user";
	const getScriptDisplayMetadata = (
		script: AutomationScript,
	): Pick<AutomationScript, "name" | "description"> => {
		switch (script.id) {
			case "builtin:sequential-rename":
				return {
					name: t("automation.builtinSequentialRenameName"),
					description: t("automation.builtinSequentialRenameDescription"),
				};
			case "builtin:random-transform":
				return {
					name: t("automation.builtinRandomTransformName"),
					description: t("automation.builtinRandomTransformDescription"),
				};
			case "builtin:round-coordinates":
				return {
					name: t("automation.builtinRoundCoordinatesName"),
					description: t("automation.builtinRoundCoordinatesDescription"),
				};
			case "builtin:replace-selected-text":
				return {
					name: t("automation.builtinReplaceSelectedTextName"),
					description: t("automation.builtinReplaceSelectedTextDescription"),
				};
			case "builtin:select-text-by-content":
				return {
					name: t("automation.builtinSelectTextByContentName"),
					description: t("automation.builtinSelectTextByContentDescription"),
				};
			case "builtin:swap-positions":
				return {
					name: t("automation.builtinSwapPositionsName"),
					description: t("automation.builtinSwapPositionsDescription"),
				};
			default:
				return script;
		}
	};

	return (
		<div
			data-app-shortcuts="off"
			className={twm(
				"relative flex h-full flex-col overflow-hidden bg-background",
				variant === "desktop" &&
					"w-full border border-border/30 bg-background/86 shadow-2xl backdrop-liquid",
				variant === "desktop" &&
					side === "left" &&
					"rounded-r-xl rounded-l-none border-l-0",
				variant === "desktop" &&
					side === "right" &&
					"rounded-l-xl rounded-r-none border-r-0",
				variant === "mobile" && "w-full",
			)}
		>
			<header className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
				<div className="min-w-0 flex-1">
					<h2 className="text-lg font-medium text-foreground">
						{t("automation.title")}
					</h2>
					<p className="text-sm text-muted-foreground">
						{t("automation.description")}
					</p>
				</div>
				<button
					type="button"
					className="grid size-9 place-items-center rounded-full hover:bg-muted-hover"
					onClick={onClose}
					aria-label={t("automation.close")}
				>
					<X size={18} />
				</button>
			</header>

			<div className="flex min-h-0 flex-1 max-md:flex-col">
				<aside className="flex min-h-0 w-2/5 min-w-36 max-w-60 shrink-0 flex-col border-r border-border/60 max-md:w-full max-md:max-w-none max-md:border-r-0 max-md:border-b">
					<div className="flex items-center justify-between px-4 py-3">
						<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
							{t("automation.scripts")}
						</span>
						{repository.canManageUserScripts && (
							<Button
								$variant="ghost"
								$size="icon"
								className="size-8"
								onClick={handleAdd}
								aria-label={t("automation.addScript")}
							>
								<Plus size={16} />
							</Button>
						)}
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 max-md:flex max-md:max-h-28 max-md:overflow-x-auto">
						{scripts.map((script) => {
							const display = getScriptDisplayMetadata(script);
							return (
								<button
									key={script.id}
									type="button"
									className="w-full rounded-lg px-3 py-2.5 text-left hover:bg-muted-hover data-[selected=true]:bg-accent/15 max-md:w-56 max-md:shrink-0"
									data-selected={script.id === selectedId}
									onClick={() => selectScript(script)}
								>
									<span className="block truncate text-sm font-medium">
										{display.name}
									</span>
									<span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
										{display.description}
									</span>
								</button>
							);
						})}
					</div>
				</aside>

				<main
					className={twm(
						"grid min-h-0 min-w-0 flex-1",
						!isMobile && "grid-rows-[auto_minmax(0,1fr)_minmax(0,180px)]",
						isMobile &&
							(codeExpanded
								? "grid-rows-[auto_auto_minmax(0,1fr)_minmax(0,180px)]"
								: "grid-rows-[auto_auto_minmax(0,1fr)]"),
					)}
				>
					<div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
						<input
							className="min-w-32 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:text-muted-foreground"
							value={draft ? getScriptDisplayMetadata(draft).name : ""}
							disabled={!editable}
							aria-label={t("automation.scriptName")}
							onChange={(event) =>
								setDraft((current) =>
									current ? { ...current, name: event.target.value } : current,
								)
							}
						/>
						{editable && (
							<>
								<Button
									$variant="secondary"
									$size="sm"
									className="shrink-0"
									onClick={handleSave}
								>
									<Save size={15} />
									{t("automation.save")}
								</Button>
								<Button
									$variant="ghost"
									$size="icon"
									className="size-8 shrink-0 text-danger"
									onClick={handleDelete}
									aria-label={t("automation.delete")}
								>
									<Trash2 size={15} />
								</Button>
							</>
						)}
						{isRunning ? (
							<Button
								$variant="secondary"
								$size="sm"
								className="shrink-0"
								onClick={handleStop}
							>
								<CircleStop size={15} />
								{t("automation.stop")}
							</Button>
						) : (
							<Button
								$size="sm"
								className="shrink-0"
								onClick={handleRun}
								disabled={!draft || !createRuntime}
							>
								<Play size={15} />
								{t("automation.run")}
							</Button>
						)}
					</div>

					{isMobile && (
						<button
							type="button"
							className="flex items-center gap-1.5 border-b border-border/60 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
							aria-expanded={codeExpanded}
							onClick={toggleCodeExpanded}
						>
							{codeExpanded ? (
								<ChevronDown size={14} />
							) : (
								<ChevronRight size={14} />
							)}
							{t("automation.code")}
						</button>
					)}

					{showEditor && (
						<div className="min-h-0">
							{draft && (
								<AutomationCodeEditor
									value={draft.source}
									readOnly={!editable}
									onMount={handleEditorMount}
									onChange={(source) =>
										setDraft((current) =>
											current ? { ...current, source } : current,
										)
									}
								/>
							)}
						</div>
					)}

					<section className="grid min-h-0 grid-cols-2 border-t border-border/60 max-md:grid-cols-1">
						<div className="min-h-0 overflow-y-auto border-r border-border/60 p-3">
							<h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("automation.diagnostics")}
							</h3>
							{diagnostics.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									{t("automation.noDiagnostics")}
								</p>
							) : (
								diagnostics.map((diagnostic, index) => (
									<button
										key={`${diagnostic.message}:${index}`}
										type="button"
										className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-muted-hover"
										onClick={() => handleDiagnosticClick(diagnostic)}
									>
										<span
											className={
												diagnostic.severity === "error"
													? "text-danger"
													: "text-muted-foreground"
											}
										>
											{diagnostic.line ? `${diagnostic.line}: ` : ""}
											{diagnostic.message}
										</span>
									</button>
								))
							)}
							{repositoryError && (
								<p className="mt-2 text-xs text-danger">{repositoryError}</p>
							)}
						</div>
						<div className="min-h-0 overflow-y-auto p-3 font-mono">
							<h3 className="mb-2 font-sans text-xs font-semibold uppercase tracking-wide text-muted-foreground">
								{t("automation.log")}
							</h3>
							{logs.length === 0 ? (
								<p className="font-sans text-xs text-muted-foreground">
									{t("automation.noLogs")}
								</p>
							) : (
								logs.map((line, index) => (
									<div key={`${line}:${index}`} className="text-xs">
										{line}
									</div>
								))
							)}
						</div>
					</section>
				</main>
			</div>
			{pendingPrompt && (
				<AutomationPrompt
					key={pendingPrompt.id}
					request={pendingPrompt.request}
					onCancel={() => finishPrompt(null)}
					onSubmit={finishPrompt}
				/>
			)}
		</div>
	);
}

function AutomationPrompt({
	request,
	onCancel,
	onSubmit,
}: {
	request: AutomationPromptRequest;
	onCancel: () => void;
	onSubmit: (response: AutomationPromptResponse) => void;
}) {
	const t = useTranslation();
	const focusPromptInput = useEventCallback((element: HTMLElement | null) => {
		element?.focus();
	});
	const [value, setValue] = useState(() => {
		if (request.kind === "choice") {
			return request.choices.includes(request.defaultValue)
				? request.defaultValue
				: (request.choices[0] ?? "");
		}
		return "defaultValue" in request ? String(request.defaultValue) : "";
	});
	const numberValue = Number(value);
	const submitDisabled =
		(request.kind === "number" && !Number.isFinite(numberValue)) ||
		(request.kind === "choice" && !request.choices.includes(value));

	return (
		<div
			className="absolute inset-0 z-20 grid place-items-center bg-black/35 p-6"
			role="dialog"
			aria-modal="true"
			aria-label={request.message}
		>
			<form
				className="w-full max-w-sm rounded-xl border border-border bg-background p-5 shadow-2xl"
				onSubmit={(event) => {
					event.preventDefault();
					if (submitDisabled) return;
					onSubmit(
						request.kind === "alert"
							? null
							: request.kind === "confirm"
								? true
								: request.kind === "number"
									? numberValue
									: request.kind === "boolean"
										? value === "true"
										: value,
					);
				}}
			>
				<div className="block text-sm font-medium">
					<span className="mb-3 block">{request.message}</span>
					{request.kind === "alert" ||
					request.kind === "confirm" ? null : request.kind === "choice" ? (
						<select
							ref={focusPromptInput}
							aria-label={request.message}
							className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
							value={value}
							onChange={(event) => setValue(event.target.value)}
						>
							{request.choices.map((choice) => (
								<option key={choice} value={choice}>
									{choice}
								</option>
							))}
						</select>
					) : request.kind === "boolean" ? (
						<select
							ref={focusPromptInput}
							aria-label={request.message}
							className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
							value={value}
							onChange={(event) => setValue(event.target.value)}
						>
							<option value="true">{t("automation.promptTrue")}</option>
							<option value="false">{t("automation.promptFalse")}</option>
						</select>
					) : (
						<input
							ref={focusPromptInput}
							aria-label={request.message}
							className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
							type={request.kind === "number" ? "number" : "text"}
							step={request.kind === "number" ? "any" : undefined}
							value={value}
							onChange={(event) => setValue(event.target.value)}
						/>
					)}
				</div>
				<div className="mt-5 flex justify-end gap-2">
					{request.kind !== "alert" && (
						<Button
							$variant="secondary"
							type="button"
							onClick={() =>
								request.kind === "confirm" ? onSubmit(false) : onCancel()
							}
						>
							{t("automation.promptCancel")}
						</Button>
					)}
					<Button type="submit" disabled={submitDisabled}>
						{t(
							request.kind === "alert"
								? "automation.promptOk"
								: request.kind === "confirm"
									? "automation.promptConfirm"
									: "automation.promptSubmit",
						)}
					</Button>
				</div>
			</form>
		</div>
	);
}

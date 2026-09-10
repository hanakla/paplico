import {
	createScriptHost,
	type Diagnostic,
	type WorkerLike,
	type WorkerRunner,
} from "@paplico/syrup";
import type {
	AutomationPromptRequest,
	AutomationPromptResponse,
} from "@/automation/types";
import type { Paplico } from "@/core/Paplico";
import type { ScriptFileSystem } from "./api";
import { createScriptPrompt, registerPaplicoScriptingApi } from "./api";
import { PaplicoAutomationDom } from "./dom";

export interface AutomationRunResult {
	readonly diagnostics: Diagnostic[];
}

export interface PaplicoAutomationRuntime {
	run(source: string): Promise<AutomationRunResult>;
	stop(): void;
	dispose(): void;
}

export function createPaplicoAutomationRuntime({
	paplico,
	fileSystem = null,
	stdout,
	prompt = async () => null,
	createWorker = createAutomationWorker,
}: {
	paplico: Paplico;
	fileSystem?: ScriptFileSystem | null;
	stdout?: (text: string) => void;
	prompt?: (
		request: AutomationPromptRequest,
		signal: AbortSignal,
	) => Promise<AutomationPromptResponse>;
	createWorker?: () => WorkerLike;
}): PaplicoAutomationRuntime {
	const host = createScriptHost({ stdout });
	const dom = new PaplicoAutomationDom(paplico, fileSystem);
	let promptAbortController: AbortController | null = null;
	registerPaplicoScriptingApi(
		host,
		dom,
		createScriptPrompt((request) => {
			promptAbortController ??= new AbortController();
			return prompt(request, promptAbortController.signal);
		}),
	);

	let activeRunner: WorkerRunner | null = null;
	let disposed = false;

	return {
		run: async (source) => {
			if (disposed) throw new Error("Automation runtime is disposed");
			if (activeRunner)
				throw new Error("An automation script is already running");

			const output = await host.compile(source);
			if (!output.code) return { diagnostics: output.diagnostics };

			const runner = host.createWorkerRunner(createWorker(), {
				timeoutMs: 60_000,
			});
			promptAbortController = new AbortController();
			activeRunner = runner;
			dom.begin();
			try {
				await runner.run(output.code);
				dom.commit();
				return { diagnostics: output.diagnostics };
			} catch (error) {
				dom.rollback();
				throw error;
			} finally {
				promptAbortController.abort();
				promptAbortController = null;
				if (activeRunner === runner) activeRunner = null;
				runner.dispose();
			}
		},
		stop: () => {
			promptAbortController?.abort();
			activeRunner?.stop();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			promptAbortController?.abort();
			promptAbortController = null;
			activeRunner?.dispose();
			activeRunner = null;
			dom.rollback();
		},
	};
}

function createAutomationWorker(): WorkerLike {
	return new Worker(new URL("./worker.ts", import.meta.url), {
		type: "module",
	});
}

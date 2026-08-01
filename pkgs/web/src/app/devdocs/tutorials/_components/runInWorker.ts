type WorkerResponse =
	| { ok: true; result: unknown }
	| { ok: false; error: string };

type Options = {
	jsCode: string;
	harness: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export async function runInWorker<T = unknown>(opts: Options): Promise<T> {
	const { jsCode, harness, timeoutMs = 1500, signal } = opts;
	const wrappedCode = `${jsCode}\n;\n${harness}`;
	const blob = new Blob([wrappedCode], { type: "application/javascript" });
	const url = URL.createObjectURL(blob);
	const worker = new Worker(url, { type: "module" });

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			worker.terminate();
			URL.revokeObjectURL(url);
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`関数の実行が ${timeoutMs}ms を超えたよ。無限ループになっていないか確認してね`,
				),
			);
		}, timeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new DOMException("aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort);

		worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			cleanup();
			if (e.data?.ok) {
				resolve(e.data.result as T);
			} else {
				reject(new Error(e.data?.error ?? "Unknown worker error"));
			}
		};
		worker.onerror = (e) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			cleanup();
			reject(new Error(e.message || "Worker runtime error"));
		};
		worker.postMessage(null);
	});
}

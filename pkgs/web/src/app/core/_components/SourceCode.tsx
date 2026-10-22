import { readFile } from "node:fs/promises";
import path from "node:path";
import { Code } from "./Code";

/**
 * Shows a file of this app as it is, so a guide quoting working code can
 * never drift from the code that actually runs. `file` is relative to `src/`.
 */
// lint-unused-ignore
export async function SourceCode({ file }: { file: string }) {
	const code = await readFile(path.join(process.cwd(), "src", file), "utf8");
	return <Code code={code} lang={path.extname(file).slice(1)} title={file} />;
}

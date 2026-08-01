import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ClassDeclaration,
	Node,
	Project,
	type ReferencedSymbol,
	Scope,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(__dir, "../pkgs/web");
const REPO_ROOT = resolve(PROJECT, "..");
const APPLY_MODE = process.argv.includes("--apply");

const SKIP_NAMES = new Set([
	"constructor",
	"dispose",
	"destroy",
	"[Symbol.dispose]",
	"[Symbol.asyncDispose]",
	"[Symbol.iterator]",
	"[Symbol.asyncIterator]",
	"toString",
	"valueOf",
	"toJSON",
]);

const SKIP_FILE_PATTERNS = [
	/\/\.next\/(?:dev\/)?types\/routes\.d\.ts$/,
	/\/src\/instrumentation\.ts/,
	/\/src\/proxy\.ts/,
	/\/src\/app\/manifest\.ts/,
	/\/src\/app\/layout\.ts/,
	/\/src\/app\/(.*\/?)(page|route|global-error|layout|manifest)\.tsx?/,
	/\/src\/utils\/testDocument\.ts$/,
	/\/src\/stubs\//,
	/\/src\/mdx-components\.tsx$/,
];

function shouldSkipFile(filePath: string): boolean {
	return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

const IGNORE_COMMENT = "lint-unused-ignore";

function hasIgnoreComment(node: {
	getLeadingCommentRanges(): Array<{ getText(): string }>;
}): boolean {
	return node
		.getLeadingCommentRanges()
		.some((c) => c.getText().includes(IGNORE_COMMENT));
}

function isContractMember(cls: ClassDeclaration, name: string): boolean {
	for (const impl of cls.getImplements()) {
		try {
			if (impl.getType().getProperty(name)) return true;
		} catch {}
	}
	let base = cls.getBaseClass();
	while (base) {
		if (base.getInstanceMember(name) ?? base.getStaticMember(name)) return true;
		base = base.getBaseClass();
	}
	return false;
}

type Usage = "unused" | "private-only" | "used";
type PropertyAccessIndex = Map<string, Set<string>>;

function buildPropertyAccessIndex(files: SourceFile[]): PropertyAccessIndex {
	const index: PropertyAccessIndex = new Map();

	const add = (name: string, filePath: string) => {
		if (!name) return;
		const set = index.get(name);
		if (set) {
			set.add(filePath);
			return;
		}
		index.set(name, new Set([filePath]));
	};

	for (const sf of files) {
		const filePath = sf.getFilePath();

		for (const access of sf.getDescendantsOfKind(
			SyntaxKind.PropertyAccessExpression,
		)) {
			add(access.getName(), filePath);
		}

		for (const access of sf.getDescendantsOfKind(
			SyntaxKind.ElementAccessExpression,
		)) {
			const arg = access.getArgumentExpression();
			if (!arg) continue;
			if (
				Node.isStringLiteral(arg) ||
				Node.isNoSubstitutionTemplateLiteral(arg)
			) {
				add(arg.getLiteralText(), filePath);
			}
		}
	}

	return index;
}

function hasExternalPropertyAccess(
	index: PropertyAccessIndex,
	name: string,
	declFilePath: string,
): boolean {
	const files = index.get(name);
	if (!files) return false;
	for (const filePath of files) {
		if (filePath !== declFilePath) return true;
	}
	return false;
}

function analyzeUsage(node: {
	findReferences(): ReferencedSymbol[];
	getSourceFile(): { getFilePath(): string };
}): Usage {
	const declFile = node.getSourceFile().getFilePath();
	let hasAnyRef = false;
	let allRefsLocal = true;

	for (const group of node.findReferences()) {
		for (const ref of group.getReferences()) {
			if (ref.isDefinition()) continue;
			hasAnyRef = true;
			if (ref.getSourceFile().getFilePath() !== declFile) {
				allRefsLocal = false;
				break;
			}
		}
		if (!allRefsLocal) break;
	}

	if (!hasAnyRef) return "unused";
	if (allRefsLocal) return "private-only";
	return "used";
}

function analyzeMemberUsage(
	node: {
		findReferences(): ReferencedSymbol[];
	},
	owningClass: ClassDeclaration,
): Usage {
	let hasAnyRef = false;
	let allRefsInsideOwningClass = true;

	for (const group of node.findReferences()) {
		for (const ref of group.getReferences()) {
			if (ref.isDefinition()) continue;
			hasAnyRef = true;

			const refClass = ref
				.getNode()
				.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
			if (
				!refClass ||
				refClass.getSourceFile().getFilePath() !==
					owningClass.getSourceFile().getFilePath() ||
				refClass.getStart() !== owningClass.getStart()
			) {
				allRefsInsideOwningClass = false;
				break;
			}
		}
		if (!allRefsInsideOwningClass) break;
	}

	if (!hasAnyRef) return "unused";
	if (allRefsInsideOwningClass) return "private-only";
	return "used";
}

function runTypecheck(phase: "before" | "after"): void {
	try {
		execSync("yarn workspace pap typecheck --pretty false", {
			cwd: REPO_ROOT,
			stdio: "inherit",
		});
	} catch (error) {
		throw new Error(
			`[lint-unused] typecheck failed (${phase} apply): ${String(error)}`,
		);
	}
}

async function main() {
	if (APPLY_MODE) runTypecheck("before");

	const project = new Project({
		tsConfigFilePath: `${PROJECT}/tsconfig.json`,
	});

	const files = project
		.getSourceFiles()
		.filter(
			(sf) =>
				sf.getFilePath().startsWith(`${PROJECT}/`) &&
				!shouldSkipFile(sf.getFilePath()),
		);
	const propertyAccessIndex = buildPropertyAccessIndex(files);

	const result: Record<string, string[]> = {};
	const originalSources = new Map<string, string>();
	let removedCount = 0;
	let privatizedCount = 0;
	let unexportedCount = 0;

	const rememberOriginal = (sf: SourceFile) => {
		const filePath = sf.getFilePath();
		if (!originalSources.has(filePath)) {
			originalSources.set(filePath, sf.getFullText());
		}
	};

	for (const sf of files) {
		const rel = sf.getFilePath().replace(`${PROJECT}/`, "");

		const entries: string[] = [];

		// --- Interfaces ---
		for (const iface of sf.getInterfaces()) {
			if (hasIgnoreComment(iface)) continue;

			const usage = analyzeUsage(iface);
			if (usage === "unused") {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					iface.remove();
					removedCount += 1;
					continue;
				}
				entries.push(
					`[unused] interface ${iface.getName()}: L${iface.getStartLineNumber()}`,
				);
			} else if (
				usage === "private-only" &&
				iface.isExported() &&
				!iface.isDefaultExport()
			) {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					iface.setIsExported(false);
					unexportedCount += 1;
					continue;
				}
				entries.push(
					`[internal only usage] export interface ${iface.getName()}: L${iface.getStartLineNumber()}`,
				);
			}
		}

		// --- Type aliases ---
		for (const ta of sf.getTypeAliases()) {
			if (hasIgnoreComment(ta)) continue;

			const usage = analyzeUsage(ta);
			if (usage === "unused") {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					ta.remove();
					removedCount += 1;
					continue;
				}
				entries.push(
					`[unused] type ${ta.getName()}: L${ta.getStartLineNumber()}`,
				);
			} else if (
				usage === "private-only" &&
				ta.isExported() &&
				!ta.isDefaultExport()
			) {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					ta.setIsExported(false);
					unexportedCount += 1;
					continue;
				}
				entries.push(
					`[internal only usage] export type ${ta.getName()}: L${ta.getStartLineNumber()}`,
				);
			}
		}

		// --- Classes ---
		for (const cls of sf.getClasses()) {
			if (hasIgnoreComment(cls)) continue;

			const className = cls.getName() ?? "(anonymous)";
			const clsUsage = analyzeUsage(cls);

			if (clsUsage === "unused") {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					cls.remove();
					removedCount += 1;
					continue;
				}
				entries.push(
					`[unused] class ${className}: L${cls.getStartLineNumber()}`,
				);
				continue;
			}

			if (
				clsUsage === "private-only" &&
				cls.isExported() &&
				!cls.isDefaultExport()
			) {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					cls.setIsExported(false);
					unexportedCount += 1;
				} else {
					entries.push(
						`[internal only usage] export class ${className}: L${cls.getStartLineNumber()}`,
					);
				}
			}

			const members = [
				...cls.getMethods(),
				...cls.getProperties(),
				...cls.getGetAccessors(),
				...cls.getSetAccessors(),
			];

			for (const member of members) {
				if (hasIgnoreComment(member)) continue;

				const name = member.getName();
				if (SKIP_NAMES.has(name)) continue;
				if (isContractMember(cls, name)) continue;

				const usage = analyzeMemberUsage(member, cls);
				if (usage === "used") continue;

				const scope = name.startsWith("#")
					? "private"
					: (member.getScope() ?? "public");
				if (
					scope !== "private" &&
					hasExternalPropertyAccess(propertyAccessIndex, name, sf.getFilePath())
				) {
					continue;
				}
				const stat = member.isStatic() ? "static " : "";
				const line = member.getStartLineNumber();

				if (usage === "private-only" && scope !== "private") {
					if (APPLY_MODE) {
						rememberOriginal(sf);
						member.setScope(Scope.Private);
						privatizedCount += 1;
						continue;
					}
					entries.push(
						`[private only usage] ${scope} ${stat}${className}.${name}: L${line}`,
					);
				} else if (usage === "unused") {
					if (APPLY_MODE) {
						rememberOriginal(sf);
						member.remove();
						removedCount += 1;
						continue;
					}
					entries.push(
						`[unused] ${scope} ${stat}${className}.${name}: L${line}`,
					);
				}
			}
		}

		// --- Functions ---
		for (const fn of sf.getFunctions()) {
			if (hasIgnoreComment(fn)) continue;
			const name = fn.getName();
			if (!name) continue;
			const usage = analyzeUsage(fn);
			if (usage === "unused") {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					fn.remove();
					removedCount += 1;
					continue;
				}
				entries.push(`[unused] function ${name}: L${fn.getStartLineNumber()}`);
			} else if (
				usage === "private-only" &&
				fn.isExported() &&
				!fn.isDefaultExport()
			) {
				if (APPLY_MODE) {
					rememberOriginal(sf);
					fn.setIsExported(false);
					unexportedCount += 1;
					continue;
				}
				entries.push(
					`[internal only usage] export function ${name}: L${fn.getStartLineNumber()}`,
				);
			}
		}

		if (entries.length > 0) result[rel] = entries;
	}

	if (APPLY_MODE) {
		if (removedCount === 0 && privatizedCount === 0 && unexportedCount === 0) {
			console.log(
				JSON.stringify(
					{ removedCount, privatizedCount, unexportedCount, touchedFiles: 0 },
					null,
					2,
				),
			);
			return;
		}

		await project.save();

		try {
			runTypecheck("after");
		} catch (error) {
			for (const [path, content] of originalSources.entries()) {
				writeFileSync(path, content, "utf-8");
			}
			throw error;
		}

		console.log(
			JSON.stringify(
				{
					removedCount,
					privatizedCount,
					unexportedCount,
					touchedFiles: originalSources.size,
				},
				null,
				2,
			),
		);
		return;
	}

	for (const [file, entries] of Object.entries(result)) {
		console.log(`\n${file}:`);
		for (const entry of entries) {
			const prefix = entry.startsWith("[unused]") ? "error:" : "warn: ";
			console.log(`  ${prefix} ${entry}`);
		}
	}

	const allEntries = Object.values(result).flat();
	const total = allEntries.length;
	const unusedCount = allEntries.filter((e) => e.startsWith("[unused]")).length;
	console.log(`\n${total} entries in ${Object.keys(result).length} files`);

	if (unusedCount > 0) process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

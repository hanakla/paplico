/**
 * Regenerates the dependency list shown by the in-app Licenses dialog.
 *
 *   yarn licenses:update   rewrite the generated module
 *   yarn licenses:check    fail when the generated module is out of date
 *
 * Lists the direct runtime `dependencies` of pkgs/web. devDependencies never
 * reach a user, so listing them would overstate what Paplico distributes.
 *
 * Paplico's own workspace packages are not listed — the app already credits
 * itself — but their direct dependencies are, because a library reached
 * through @paplico/syrup ships just the same as one reached directly.
 */

import {
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface DependencyLicense {
	name: string;
	version: string;
	license: string;
	url: string;
}

const __dir = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
const ENTRY_MANIFEST = resolve(REPO_ROOT, "pkgs/web/package.json");
const OUTPUT_FILE = resolve(
	REPO_ROOT,
	"pkgs/web/src/dialogs/dependencyLicenses.generated.ts",
);

const CHECK_MODE = process.argv.includes("--check");

/** Titles trusted to identify a licence when the manifest declares none. */
const LICENSE_FILE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/\bMIT License\b/i, "MIT"],
	[/\bApache License,? Version 2\.0\b/i, "Apache-2.0"],
	[/\bISC License\b/i, "ISC"],
	[/\bBSD 3-Clause\b/i, "BSD-3-Clause"],
	[/\bBSD 2-Clause\b/i, "BSD-2-Clause"],
	[/\bMozilla Public License,? Version 2\.0\b/i, "MPL-2.0"],
];

const licenses = collectLicenses();
const generated = renderModule(licenses);

if (!CHECK_MODE) {
	writeFileSync(OUTPUT_FILE, generated, "utf8");
	console.log(`Wrote ${licenses.length} dependencies to ${OUTPUT_FILE}`);
	process.exit(0);
}

const committed = readFileSync(OUTPUT_FILE, "utf8");
if (committed === generated) {
	console.log(
		`Dependency licenses are up to date (${licenses.length} entries)`,
	);
	process.exit(0);
}

console.error(
	"Dependency licenses are out of date. Run `yarn licenses:update` and commit the result.",
);
process.exit(1);

function collectLicenses(): DependencyLicense[] {
	const entry = readManifest(ENTRY_MANIFEST);
	const pending = Object.keys(entry?.dependencies ?? {}).map((name) => ({
		name,
		fromDir: dirname(ENTRY_MANIFEST),
	}));

	const found = new Map<string, DependencyLicense>();

	while (pending.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: guarded by the loop condition
		const { name, fromDir } = pending.shift()!;

		const manifestPath = resolveManifest(name, fromDir);
		if (!manifestPath) continue;

		const manifest = readManifest(manifestPath);
		if (!manifest) continue;

		const packageDir = dirname(manifestPath);

		// A workspace package is Paplico's own code. Step through it so the
		// libraries it pulls in are credited at the same level as the rest.
		if (isWorkspacePackage(manifestPath)) {
			for (const child of Object.keys(manifest.dependencies ?? {})) {
				pending.push({ name: child, fromDir: packageDir });
			}
			continue;
		}

		found.set(manifest.name ?? name, {
			name: manifest.name ?? name,
			version: manifest.version ?? "",
			license: readLicense(manifest, packageDir),
			url: readUrl(manifest),
		});
	}

	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve `name` from `fromDir` upwards, mirroring Node's node_modules lookup. */
function resolveManifest(name: string, fromDir: string): string | null {
	let dir = fromDir;

	while (true) {
		const candidate = join(dir, "node_modules", name, "package.json");
		if (fileExists(candidate)) return candidate;

		const parent = dirname(dir);
		if (parent === dir || !dir.startsWith(REPO_ROOT)) return null;
		dir = parent;
	}
}

// biome-ignore lint/suspicious/noExplicitAny: package.json has no fixed shape
function readManifest(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function fileExists(path: string): boolean {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Yarn links workspaces into node_modules, so the path a package is found at
 * says nothing about where it lives. Resolve the link before deciding.
 */
function isWorkspacePackage(manifestPath: string): boolean {
	let realPath = manifestPath;
	try {
		realPath = realpathSync(manifestPath);
	} catch {
		return false;
	}

	return (
		realPath.startsWith(join(REPO_ROOT, "pkgs")) &&
		!realPath.includes("node_modules")
	);
}

// biome-ignore lint/suspicious/noExplicitAny: package.json has no fixed shape
function readLicense(manifest: any, packageDir: string): string {
	if (typeof manifest.license === "string" && manifest.license) {
		return manifest.license;
	}
	if (typeof manifest.license?.type === "string") return manifest.license.type;

	// Packages published before SPDX strings were standardised use an array.
	if (Array.isArray(manifest.licenses)) {
		const types = manifest.licenses
			.map((entry: { type?: string }) => entry?.type)
			.filter(Boolean);
		if (types.length > 0) return types.join(" OR ");
	}

	return readLicenseFromFile(packageDir) ?? "See package";
}

/**
 * Some packages ship the terms but forget the manifest field. Read the licence
 * file rather than reporting nothing, but only trust an unambiguous title.
 */
function readLicenseFromFile(packageDir: string): string | null {
	let fileName: string | undefined;
	try {
		fileName = readdirSync(packageDir).find((entry) =>
			/^(licen[cs]e|copying)(\.|$)/i.test(entry),
		);
	} catch {
		return null;
	}
	if (!fileName) return null;

	let head: string;
	try {
		head = readFileSync(join(packageDir, fileName), "utf8").slice(0, 400);
	} catch {
		return null;
	}

	for (const [pattern, spdx] of LICENSE_FILE_PATTERNS) {
		if (pattern.test(head)) return spdx;
	}
	return null;
}

// biome-ignore lint/suspicious/noExplicitAny: package.json has no fixed shape
function readUrl(manifest: any): string {
	const raw =
		(typeof manifest.repository === "string"
			? manifest.repository
			: manifest.repository?.url) ||
		manifest.homepage ||
		"";

	return normalizeRepositoryUrl(raw, manifest.name);
}

/** Turn the many shapes of a repository field into something a browser opens. */
function normalizeRepositoryUrl(raw: string, name: string): string {
	if (!raw) return `https://www.npmjs.com/package/${name}`;

	let url = raw
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/git@/, "https://")
		.replace(/^git@([^:]+):/, "https://$1/");

	// Shorthands such as "facebook/react" or "github:facebook/react".
	if (!url.includes("://")) {
		url = `https://github.com/${url.replace(/^github:/, "")}`;
	}

	return url;
}

function renderModule(entries: DependencyLicense[]): string {
	const body = entries
		.map(
			(entry) =>
				`\t{\n` +
				`\t\tname: ${JSON.stringify(entry.name)},\n` +
				`\t\tversion: ${JSON.stringify(entry.version)},\n` +
				`\t\tlicense: ${JSON.stringify(entry.license)},\n` +
				`\t\turl: ${JSON.stringify(entry.url)},\n` +
				`\t},`,
		)
		.join("\n");

	return `// Generated by scripts/gen-dependency-licenses.ts — do not edit by hand.
// Run \`yarn licenses:update\` after changing runtime dependencies.

export interface DependencyLicense {
	name: string;
	version: string;
	license: string;
	url: string;
}

export const DEPENDENCY_LICENSES: DependencyLicense[] = [
${body}
];
`;
}

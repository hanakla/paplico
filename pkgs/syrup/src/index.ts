// Public API of @paplico/syrup.
// Syrup: a Swift-flavored, statically typed scripting language that compiles
// to JavaScript. See specification.md for the language reference.

export type {
	AnalyzeOutput,
	CompileOutput,
	LoadedScriptModule,
	ModuleResolver,
	PackageRegistration,
	ScriptHostOptions,
	TestResult,
	WorkerRunner,
} from "./host/ScriptHost";
export { createScriptHost, ScriptHost } from "./host/ScriptHost";
export { registerSyrup, SYRUP_LANGUAGE_ID } from "./monaco/register";
export type { WorkerLike } from "./runner/types";
export type {
	CompletionItem,
	DefinitionInfo,
	HoverInfo,
	SignatureHelpInfo,
} from "./service/LanguageService";
export { LanguageService } from "./service/LanguageService";
export type { Diagnostic, Span } from "./syntax/ast";

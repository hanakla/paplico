import type * as Monaco from "monaco-editor";
import type { ScriptHost } from "../host/ScriptHost";
import type { CompletionItem } from "../service/LanguageService";
import { LanguageService } from "../service/LanguageService";
import type { Span } from "../syntax/ast";
import { syrupLanguageConfiguration } from "./languageConfiguration";
import { syrupMonarchLanguage } from "./monarch";

export const SYRUP_LANGUAGE_ID = "syrup";

/**
 * Register the Syrup language with a Monaco instance: highlighting,
 * diagnostics, completion, and hover, backed by `host`'s declarations.
 *
 * Monaco is injected (DI) so this package has no runtime dependency on
 * monaco-editor. Returns a disposer.
 */
export function registerSyrup(
	monaco: typeof Monaco,
	host: ScriptHost,
): () => void {
	monaco.languages.register({
		id: SYRUP_LANGUAGE_ID,
		extensions: [".syrup"],
	});
	const disposables: { dispose(): void }[] = [
		monaco.languages.setMonarchTokensProvider(
			SYRUP_LANGUAGE_ID,
			syrupMonarchLanguage,
		),
		monaco.languages.setLanguageConfiguration(
			SYRUP_LANGUAGE_ID,
			syrupLanguageConfiguration,
		),
	];

	const services = new WeakMap<Monaco.editor.ITextModel, LanguageService>();
	const serviceFor = (model: Monaco.editor.ITextModel): LanguageService => {
		let service = services.get(model);
		if (!service) {
			service = new LanguageService(host);
			services.set(model, service);
		}
		return service;
	};

	const validate = async (model: Monaco.editor.ITextModel): Promise<void> => {
		if (model.getLanguageId() !== SYRUP_LANGUAGE_ID) return;
		const version = model.getVersionId();
		const diagnostics = await serviceFor(model).update(model.getValue());
		// Drop stale results from concurrent edits.
		if (model.isDisposed() || model.getVersionId() !== version) return;
		monaco.editor.setModelMarkers(
			model,
			SYRUP_LANGUAGE_ID,
			diagnostics.map((d) => {
				const start = model.getPositionAt(d.span.start);
				const end = model.getPositionAt(d.span.end);
				return {
					severity:
						d.severity === "error"
							? monaco.MarkerSeverity.Error
							: monaco.MarkerSeverity.Warning,
					message: d.message,
					startLineNumber: start.lineNumber,
					startColumn: start.column,
					endLineNumber: end.lineNumber,
					endColumn: end.column,
				};
			}),
		);
	};

	for (const model of monaco.editor.getModels()) void validate(model);
	disposables.push(
		monaco.editor.onDidCreateModel((model) => {
			void validate(model);
			disposables.push(model.onDidChangeContent(() => void validate(model)));
		}),
	);
	for (const model of monaco.editor.getModels()) {
		disposables.push(model.onDidChangeContent(() => void validate(model)));
	}

	disposables.push(
		monaco.languages.registerCompletionItemProvider(SYRUP_LANGUAGE_ID, {
			triggerCharacters: [".", " ", '"', "{", "@"],
			provideCompletionItems: async (model, position, context) => {
				const service = serviceFor(model);
				await service.update(model.getValue());
				const offset = model.getOffsetAt(position);
				// Space / quote / brace only trigger module completion in `use`.
				const moduleItems = service.moduleCompletionsAt(offset);
				const trigger = context.triggerCharacter;
				if (
					(trigger === " " || trigger === '"' || trigger === "{") &&
					moduleItems === null
				) {
					return { suggestions: [] };
				}
				const lineBefore = model
					.getLineContent(position.lineNumber)
					.slice(0, position.column - 1);
				// Replace the whole typed specifier ("pkgs/ge" is not one word).
				const specifierMatch = /\bfrom\s+"([^"]*)$/.exec(lineBefore);
				const word = model.getWordUntilPosition(position);
				const range = new monaco.Range(
					position.lineNumber,
					specifierMatch
						? position.column - specifierMatch[1].length
						: word.startColumn,
					position.lineNumber,
					specifierMatch ? position.column : word.endColumn,
				);
				const items = moduleItems ?? service.completionsAt(offset);
				return {
					suggestions: items.map((item) => ({
						label: item.label,
						kind: completionKind(monaco, item),
						detail: item.detail,
						insertText: item.insertText ?? item.label,
						insertTextRules: item.insertTextIsSnippet
							? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
							: undefined,
						sortText: item.sortText,
						range,
					})),
				};
			},
		}),
	);

	disposables.push(
		monaco.languages.registerSignatureHelpProvider(SYRUP_LANGUAGE_ID, {
			signatureHelpTriggerCharacters: ["(", ","],
			signatureHelpRetriggerCharacters: [","],
			provideSignatureHelp: async (model, position) => {
				const service = serviceFor(model);
				await service.update(model.getValue());
				const help = service.signatureHelpAt(model.getOffsetAt(position));
				if (!help) return null;
				return {
					value: {
						signatures: [{ label: help.label, parameters: help.parameters }],
						activeSignature: 0,
						activeParameter: help.activeParameter,
					},
					dispose() {},
				};
			},
		}),
	);

	disposables.push(
		monaco.languages.registerDefinitionProvider(SYRUP_LANGUAGE_ID, {
			provideDefinition: async (model, position) => {
				const service = serviceFor(model);
				await service.update(model.getValue());
				const definition = service.definitionAt(model.getOffsetAt(position));
				if (!definition) return null;
				return [
					{
						uri: model.uri,
						range: spanToRange(model, definition.target),
						originSelectionRange: spanToRange(model, definition.origin),
					},
				];
			},
		}),
	);

	disposables.push(
		monaco.languages.registerHoverProvider(SYRUP_LANGUAGE_ID, {
			provideHover: async (model, position) => {
				const service = serviceFor(model);
				await service.update(model.getValue());
				const hover = service.hoverAt(model.getOffsetAt(position));
				if (!hover) return null;
				return {
					range: spanToRange(model, hover.span),
					contents: [{ value: `\`\`\`\n${hover.text}\n\`\`\`` }],
				};
			},
		}),
	);

	return () => {
		for (const disposable of disposables) disposable.dispose();
	};
}

function completionKind(
	monaco: typeof Monaco,
	item: CompletionItem,
): Monaco.languages.CompletionItemKind {
	switch (item.kind) {
		case "function":
			return monaco.languages.CompletionItemKind.Function;
		case "type":
			return monaco.languages.CompletionItemKind.Class;
		case "package":
			return monaco.languages.CompletionItemKind.Module;
		case "property":
			return monaco.languages.CompletionItemKind.Field;
		case "method":
			return monaco.languages.CompletionItemKind.Method;
		case "case":
			return monaco.languages.CompletionItemKind.EnumMember;
		case "keyword":
			return monaco.languages.CompletionItemKind.Keyword;
		default:
			return monaco.languages.CompletionItemKind.Variable;
	}
}

function spanToRange(
	model: Monaco.editor.ITextModel,
	span: Span,
): Monaco.IRange {
	const start = model.getPositionAt(span.start);
	const end = model.getPositionAt(span.end);
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

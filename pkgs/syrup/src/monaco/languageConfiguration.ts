import type * as Monaco from "monaco-editor";

export const syrupLanguageConfiguration: Monaco.languages.LanguageConfiguration =
	{
		comments: {
			lineComment: "//",
			blockComment: ["/*", "*/"],
		},
		brackets: [
			["{", "}"],
			["[", "]"],
			["(", ")"],
		],
		autoClosingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"', notIn: ["string", "comment"] },
		],
		surroundingPairs: [
			{ open: "{", close: "}" },
			{ open: "[", close: "]" },
			{ open: "(", close: ")" },
			{ open: '"', close: '"' },
		],
		indentationRules: {
			increaseIndentPattern: /[{([]\s*$/,
			decreaseIndentPattern: /^\s*[})\]]/,
		},
	};

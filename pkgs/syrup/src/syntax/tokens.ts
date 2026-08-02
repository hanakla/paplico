import {
	type CustomPatternMatcherReturn,
	createToken,
	Lexer,
} from "chevrotain";

// ---- String literal payload ----
// A string literal (including interpolations) is matched as one token by a
// custom pattern. Interpolated expression sources are re-parsed later.

export type StringSegment =
	| { kind: "text"; value: string }
	| { kind: "expr"; source: string; start: number };

export interface StringPayload {
	segments: StringSegment[];
	unterminated: boolean;
}

const ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	"0": "\0",
	"\\": "\\",
	'"': '"',
	"'": "'",
	// `\$` yields a literal `$` so `$(` can appear as text
	$: "$",
};

function matchStringLiteral(
	text: string,
	startOffset: number,
): CustomPatternMatcherReturn | null {
	if (text[startOffset] !== '"') return null;
	const segments: StringSegment[] = [];
	let value = "";
	let unterminated = false;
	let i = startOffset + 1;
	while (true) {
		const ch = text[i];
		if (ch === undefined || ch === "\n") {
			unterminated = true;
			break;
		}
		if (ch === '"') {
			i++;
			break;
		}
		if (ch === "$" && text[i + 1] === "(") {
			if (value !== "") {
				segments.push({ kind: "text", value });
				value = "";
			}
			const exprStart = i + 2;
			const exprEnd = scanInterpolationEnd(text, exprStart);
			if (exprEnd === -1) {
				unterminated = true;
				i = findLineEnd(text, exprStart);
				break;
			}
			segments.push({
				kind: "expr",
				source: text.slice(exprStart, exprEnd),
				start: exprStart,
			});
			i = exprEnd + 1;
			continue;
		}
		if (ch === "\\") {
			const next = text[i + 1];
			value += next === undefined ? "" : (ESCAPES[next] ?? next);
			i += next === undefined ? 1 : 2;
			continue;
		}
		value += ch;
		i++;
	}
	if (value !== "" || segments.length === 0) {
		segments.push({ kind: "text", value });
	}
	const result: CustomPatternMatcherReturn = [text.slice(startOffset, i)];
	result.payload = { segments, unterminated } satisfies StringPayload;
	return result;
}

/** Scan for the `)` closing an interpolation, honoring nested parens and strings. */
function scanInterpolationEnd(text: string, from: number): number {
	let depth = 0;
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const nested = matchStringLiteral(text, i);
			if (nested === null) return -1;
			i += nested[0].length;
			continue;
		}
		if (ch === "(") {
			depth++;
		} else if (ch === ")") {
			if (depth === 0) return i;
			depth--;
		} else if (ch === "\n") {
			return -1;
		}
		i++;
	}
	return -1;
}

function findLineEnd(text: string, from: number): number {
	const nl = text.indexOf("\n", from);
	return nl === -1 ? text.length : nl;
}

// ---- Tokens ----

export const Identifier = createToken({
	name: "Identifier",
	pattern: /[A-Za-z_][A-Za-z0-9_]*/,
});

function keyword(name: string, word: string) {
	return createToken({
		name,
		pattern: new RegExp(word),
		longer_alt: Identifier,
	});
}

export const Let = keyword("Let", "let");
export const Var = keyword("Var", "var");
export const Fn = keyword("Fn", "fn");
export const Struct = keyword("Struct", "struct");
export const Enum = keyword("Enum", "enum");
export const Case = keyword("Case", "case");
export const Default = keyword("Default", "default");
export const If = keyword("If", "if");
export const Else = keyword("Else", "else");
export const For = keyword("For", "for");
export const In = keyword("In", "in");
export const While = keyword("While", "while");
export const Return = keyword("Return", "return");
export const Break = keyword("Break", "break");
export const Continue = keyword("Continue", "continue");
export const Switch = keyword("Switch", "switch");
export const Nil = keyword("Nil", "nil");
export const True = keyword("True", "true");
export const False = keyword("False", "false");
export const Declare = keyword("Declare", "declare");
export const Use = keyword("Use", "use");
export const From = keyword("From", "from");
export const Export = keyword("Export", "export");
export const Async = keyword("Async", "async");
export const Await = keyword("Await", "await");
export const Guard = keyword("Guard", "guard");
export const Is = keyword("Is", "is");
export const Class = keyword("Class", "class");
export const Protocol = keyword("Protocol", "protocol");
export const Super = keyword("Super", "super");
export const Do = keyword("Do", "do");
export const Try = keyword("Try", "try");
export const Catch = keyword("Catch", "catch");
export const Throws = keyword("Throws", "throws");
export const Throw = keyword("Throw", "throw");

export const NumberLiteral = createToken({
	name: "NumberLiteral",
	pattern: /\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/,
});

export const StringLiteral = createToken({
	name: "StringLiteral",
	pattern: matchStringLiteral,
	line_breaks: false,
	start_chars_hint: ['"'],
});

export const DollarIdent = createToken({
	name: "DollarIdent",
	pattern: /\$\d+/,
});

export const At = createToken({ name: "At", pattern: /@/ });

export const Arrow = createToken({ name: "Arrow", pattern: /->/ });
export const RangeIncl = createToken({ name: "RangeIncl", pattern: /\.\.\./ });
export const RangeExcl = createToken({ name: "RangeExcl", pattern: /\.\.</ });
export const OptionalChain = createToken({
	name: "OptionalChain",
	pattern: /\?\./,
});
export const NilCoalesce = createToken({
	name: "NilCoalesce",
	pattern: /\?\?/,
});
export const Question = createToken({ name: "Question", pattern: /\?/ });
export const EqualsEquals = createToken({
	name: "EqualsEquals",
	pattern: /==/,
});
export const NotEquals = createToken({ name: "NotEquals", pattern: /!=/ });
export const LessEq = createToken({ name: "LessEq", pattern: /<=/ });
export const GreaterEq = createToken({ name: "GreaterEq", pattern: />=/ });
export const AndAnd = createToken({ name: "AndAnd", pattern: /&&/ });
export const OrOr = createToken({ name: "OrOr", pattern: /\|\|/ });
export const Pipe = createToken({ name: "Pipe", pattern: /\|/ });
export const PlusEq = createToken({ name: "PlusEq", pattern: /\+=/ });
export const MinusEq = createToken({ name: "MinusEq", pattern: /-=/ });
export const StarEq = createToken({ name: "StarEq", pattern: /\*=/ });
export const SlashEq = createToken({ name: "SlashEq", pattern: /\/=/ });
export const Equals = createToken({ name: "Equals", pattern: /=/ });
export const Bang = createToken({ name: "Bang", pattern: /!/ });
export const Less = createToken({ name: "Less", pattern: /</ });
export const Greater = createToken({ name: "Greater", pattern: />/ });
export const Plus = createToken({ name: "Plus", pattern: /\+/ });
export const Minus = createToken({ name: "Minus", pattern: /-/ });
export const Star = createToken({ name: "Star", pattern: /\*/ });
export const Slash = createToken({ name: "Slash", pattern: /\// });
export const Percent = createToken({ name: "Percent", pattern: /%/ });
export const LParen = createToken({ name: "LParen", pattern: /\(/ });
export const RParen = createToken({ name: "RParen", pattern: /\)/ });
export const LCurly = createToken({ name: "LCurly", pattern: /\{/ });
export const RCurly = createToken({ name: "RCurly", pattern: /\}/ });
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });
export const Colon = createToken({ name: "Colon", pattern: /:/ });
export const Semicolon = createToken({ name: "Semicolon", pattern: /;/ });
export const Dot = createToken({ name: "Dot", pattern: /\./ });

const WhiteSpace = createToken({
	name: "WhiteSpace",
	pattern: /\s+/,
	group: Lexer.SKIPPED,
});
const LineComment = createToken({
	name: "LineComment",
	pattern: /\/\/[^\n]*/,
	group: Lexer.SKIPPED,
});
const BlockComment = createToken({
	name: "BlockComment",
	pattern: /\/\*[\s\S]*?\*\//,
	group: Lexer.SKIPPED,
});

/** Ordered token list. Longer operators must precede their prefixes. */
export const allTokens = [
	WhiteSpace,
	LineComment,
	BlockComment,
	StringLiteral,
	NumberLiteral,
	DollarIdent,
	// Keywords (before Identifier, with longer_alt fallback)
	Let,
	Var,
	Fn,
	Struct,
	Enum,
	Case,
	Default,
	If,
	Else,
	// "from" must precede "for" so it doesn't lex as Identifier via longer_alt
	From,
	For,
	Protocol,
	In,
	While,
	Return,
	Break,
	Continue,
	Switch,
	Nil,
	True,
	False,
	Declare,
	Use,
	Export,
	Async,
	Await,
	Guard,
	Is,
	Class,
	Super,
	Do,
	Try,
	Catch,
	// "throws" must precede its prefix "throw"
	Throws,
	Throw,
	Identifier,
	// Multi-char operators before single-char prefixes
	Arrow,
	RangeIncl,
	RangeExcl,
	OptionalChain,
	NilCoalesce,
	EqualsEquals,
	NotEquals,
	LessEq,
	GreaterEq,
	AndAnd,
	OrOr,
	Pipe,
	PlusEq,
	MinusEq,
	StarEq,
	SlashEq,
	Question,
	Equals,
	Bang,
	Less,
	Greater,
	Plus,
	Minus,
	Star,
	Slash,
	Percent,
	LParen,
	RParen,
	LCurly,
	RCurly,
	LBracket,
	RBracket,
	Comma,
	Colon,
	Semicolon,
	Dot,
	At,
];

export const syrupLexer = new Lexer(allTokens, {
	positionTracking: "full",
});

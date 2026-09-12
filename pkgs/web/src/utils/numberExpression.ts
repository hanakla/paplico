import { toHalfWidth } from "./string";

/**
 * Evaluate a small arithmetic expression typed into a numeric field, so users
 * can enter `100/3` or `(12+4)*2` instead of the computed number.
 * Supports `+ - * / %`, parentheses and unary signs.
 * Digits and symbols typed with a Japanese IME are read as their half-width
 * equivalents, and a trailing decimal point is read as a zero fraction.
 * Returns null when the input is not a complete, finite expression.
 */
export function evaluateNumberExpression(input: string): number | null {
	const tokens = tokenize(toHalfWidth(input));
	if (!tokens) return null;

	const state = { tokens, index: 0 };
	const value = parseAdditive(state);
	if (value == null || state.index !== tokens.length) return null;
	return Number.isFinite(value) ? value : null;
}

type Token = { type: "number"; value: number } | { type: "op"; value: string };

type ParseState = { tokens: Token[]; index: number };

function tokenize(input: string): Token[] | null {
	const tokens: Token[] = [];
	let index = 0;

	while (index < input.length) {
		const char = input[index];

		if (char === " " || char === "\t") {
			index++;
			continue;
		}

		if ("+-*/%()".includes(char)) {
			tokens.push({ type: "op", value: char });
			index++;
			continue;
		}

		const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(
			input.slice(index),
		);
		if (!number) return null;

		tokens.push({ type: "number", value: Number(number[0]) });
		index += number[0].length;
	}

	return tokens;
}

function parseAdditive(state: ParseState): number | null {
	let left = parseMultiplicative(state);
	if (left == null) return null;

	while (peekOp(state, "+", "-")) {
		const op = takeOp(state);
		const right = parseMultiplicative(state);
		if (right == null) return null;
		left = op === "+" ? left + right : left - right;
	}

	return left;
}

function parseMultiplicative(state: ParseState): number | null {
	let left = parseUnary(state);
	if (left == null) return null;

	while (peekOp(state, "*", "/", "%")) {
		const op = takeOp(state);
		const right = parseUnary(state);
		if (right == null) return null;
		left = op === "*" ? left * right : op === "/" ? left / right : left % right;
	}

	return left;
}

function parseUnary(state: ParseState): number | null {
	if (peekOp(state, "+", "-")) {
		const op = takeOp(state);
		const value = parseUnary(state);
		if (value == null) return null;
		return op === "-" ? -value : value;
	}

	return parsePrimary(state);
}

function parsePrimary(state: ParseState): number | null {
	const token = state.tokens[state.index];
	if (!token) return null;

	if (token.type === "number") {
		state.index++;
		return token.value;
	}

	if (token.value !== "(") return null;
	state.index++;

	const value = parseAdditive(state);
	if (value == null) return null;
	if (!peekOp(state, ")")) return null;
	state.index++;

	return value;
}

function peekOp(state: ParseState, ...ops: string[]): boolean {
	const token = state.tokens[state.index];
	return token?.type === "op" && ops.includes(token.value);
}

function takeOp(state: ParseState): string {
	const token = state.tokens[state.index] as { type: "op"; value: string };
	state.index++;
	return token.value;
}

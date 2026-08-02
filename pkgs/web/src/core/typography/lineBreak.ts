/**
 * Line breaking rules for text wrapping.
 * Greedy break-opportunity detection (UAX#14 subset) with Japanese kinsoku:
 * - Break allowed anywhere between CJK characters
 * - No break before line-start prohibited chars (行頭禁則)
 * - No break after line-end prohibited chars (行末禁則)
 * - No break inside Latin words (break only after whitespace)
 */

/**
 * Whether a line break is allowed between `prev` and `next` characters.
 */
export function canBreakBetween(prev: string, next: string): boolean {
	if (!prev || !next) return false;
	if (LINE_END_PROHIBITED.has(prev)) return false;
	if (LINE_START_PROHIBITED.has(next)) return false;
	// Keep trailing whitespace attached to the current line
	if (isWhitespaceChar(next)) return false;
	if (isWhitespaceChar(prev)) return true;
	if (isCjkChar(prev) || isCjkChar(next)) return true;
	// Latin word interior
	return false;
}

function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}

function isCjkChar(char: string): boolean {
	const code = char.codePointAt(0);
	if (code === undefined) return false;
	return (
		(code >= 0x3000 && code <= 0x30ff) || // CJK punctuation, Hiragana, Katakana
		(code >= 0x31f0 && code <= 0x31ff) || // Katakana phonetic extensions
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
		(code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
		(code >= 0xff00 && code <= 0xffef) || // Halfwidth and fullwidth forms
		(code >= 0x20000 && code <= 0x2ffff) // CJK Ext B+
	);
}

/** 行頭禁則: characters that must not start a line */
const LINE_START_PROHIBITED = new Set([
	..."、。，．・：；？！゛゜ヽヾゝゞ々ー）］｝〕〉》」』】〙〗〟",
	..."ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ",
	..."…‥,.:;)]}!?",
]);

/** 行末禁則: characters that must not end a line */
const LINE_END_PROHIBITED = new Set([..."（［｛〔〈《「『【〘〖〝([{"]);

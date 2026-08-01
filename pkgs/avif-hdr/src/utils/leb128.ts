export function encodeLeb128(value: number): Uint8Array {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError("encodeLeb128() expects a non-negative safe integer");
	}

	const bytes: number[] = [];
	do {
		let byte = value % 0x80;
		value = Math.floor(value / 0x80);
		if (value !== 0) {
			byte += 0x80;
		}
		bytes.push(byte);
	} while (value !== 0);
	return new Uint8Array(bytes);
}

// Copyright (c) 2024-2025, The tinyavif contributors. All rights reserved.
// Ported from tinyavif entropycode.rs (BSD 2-Clause + AOM Patent License 1.0)
//
// Daala-based range coder.
// CDF convention: for N symbols, the CDF array has N-1 entries (indices 0..N-2).
// Implicit bounds: cdf[-1]=0, cdf[N-1]=32768.

export class EntropyWriter {
	private data: number[] = [];
	private low = 0n;
	private range = 0x8000;
	private count = -9;

	public writeSymbol(symbol: number, cdf: readonly number[]): void {
		const numSymbols = cdf.length + 1;

		const invHi = symbol === numSymbols - 1 ? 0 : 32768 - cdf[symbol];

		if (symbol === 0) {
			this.range -=
				(((this.range >> 8) * (invHi >> 6)) >> 1) + 4 * (numSymbols - 1);
		} else {
			const invLo = 32768 - cdf[symbol - 1];
			const u =
				(((this.range >> 8) * (invLo >> 6)) >> 1) + 4 * (numSymbols - symbol);
			const v =
				(((this.range >> 8) * (invHi >> 6)) >> 1) +
				4 * (numSymbols - symbol - 1);
			this.low += BigInt(this.range - u);
			this.range = u - v;
		}

		const d = 15 - floorLog2(this.range);
		let s = this.count + d;

		if (s >= 40) {
			const numBytesReady = (s >> 3) + 1;
			const c = this.count + 24 - (numBytesReady << 3);

			const output = this.low >> BigInt(c);
			this.low = this.low & ((1n << BigInt(c)) - 1n);

			const byteShift = BigInt(numBytesReady << 3);
			const carry = output & (1n << byteShift);
			const masked = output & ((1n << byteShift) - 1n);

			if (carry) {
				this.propagateCarry();
			}
			writeBigEndianBytes(this.data, masked, numBytesReady);

			s = c + d - 24;
		}

		this.low = this.low << BigInt(d);
		this.range = this.range << d;
		this.count = s;
	}

	public writeBit(value: number, pZero: number): void {
		this.writeSymbol(value, [pZero]);
	}

	public writeBool(value: boolean, pFalse: number): void {
		this.writeBit(value ? 1 : 0, pFalse);
	}

	public writeLiteral(value: number, nbits: number): void {
		for (let i = nbits - 1; i >= 0; i--) {
			this.writeBit((value >> i) & 1, 16384);
		}
	}

	public writeGolomb(value: number): void {
		const x = value + 1;
		const nbits = floorLog2(x);

		for (let i = 0; i < nbits; i++) {
			this.writeBit(0, 16384);
		}
		this.writeBit(1, 16384);
		for (let i = nbits - 1; i >= 0; i--) {
			this.writeBit((x >> i) & 1, 16384);
		}
	}

	public finalize(): Uint8Array {
		let s = this.count + 10;
		const m = 0x3fffn;
		let e = ((this.low + m) & ~m) | (m + 1n);
		let n = (1n << BigInt(this.count + 16)) - 1n;

		while (s > 0) {
			const val = Number(e >> BigInt(this.count + 16));
			if (val & 0x100) {
				this.propagateCarry();
			}
			this.data.push(val & 0xff);
			e = e & n;
			s -= 8;
			this.count -= 8;
			n >>= 8n;
		}

		return new Uint8Array(this.data);
	}

	public getBytes(): number[] {
		return this.data;
	}

	private propagateCarry(): void {
		let i = this.data.length - 1;
		while (i >= 0) {
			if (this.data[i] === 255) {
				this.data[i] = 0;
				i--;
			} else {
				this.data[i]++;
				return;
			}
		}
		this.data.unshift(1);
	}
}

export function floorLog2(value: number): number {
	if (value <= 0) return 0;
	return 31 - Math.clz32(value);
}

export function writeBigEndianBytes(
	data: number[],
	value: bigint | number,
	numBytes: number,
): void {
	const v = typeof value === "number" ? BigInt(value) : value;
	for (let i = numBytes - 1; i >= 0; i--) {
		data.push(Number((v >> BigInt(i * 8)) & 0xffn));
	}
}

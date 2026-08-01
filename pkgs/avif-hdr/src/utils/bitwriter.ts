export class BitWriter {
	private buffer: number[] = [];
	private currentByte = 0;
	private bitPos = 7; // MSB-first, counts down from 7 to 0

	public writeBit(bit: number): void {
		this.currentByte |= (bit & 1) << this.bitPos;
		this.bitPos--;
		if (this.bitPos < 0) {
			this.buffer.push(this.currentByte);
			this.currentByte = 0;
			this.bitPos = 7;
		}
	}

	public writeBits(value: number, nbits: number): void {
		for (let i = nbits - 1; i >= 0; i--) {
			this.writeBit((value >> i) & 1);
		}
	}

	public writeBool(value: boolean): void {
		this.writeBit(value ? 1 : 0);
	}

	public byteAlign(): void {
		if (this.bitPos < 7) {
			this.buffer.push(this.currentByte);
			this.currentByte = 0;
			this.bitPos = 7;
		}
	}

	public finalize(): Uint8Array {
		if (this.bitPos < 7) {
			this.buffer.push(this.currentByte);
		}
		return new Uint8Array(this.buffer);
	}
}

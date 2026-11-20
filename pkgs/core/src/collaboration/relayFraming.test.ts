import { encodeFrames, FrameAssembler } from "./relayFraming";

describe("relayFraming", () => {
	let assembler: FrameAssembler;

	beforeEach(() => {
		assembler = new FrameAssembler();
	});

	it("should deliver a small payload as one frame", () => {
		const payload = bytes(100);

		const frames = encodeFrames(payload, 1024);

		expect(frames).toHaveLength(1);
		expect(assembler.push(frames[0])).toEqual(payload);
	});

	it("should split a payload larger than the limit and restore it on the last frame", () => {
		const payload = bytes(2500);

		const frames = encodeFrames(payload, 1000);

		expect(frames).toHaveLength(3);
		expect(assembler.push(frames[0])).toBeNull();
		expect(assembler.push(frames[1])).toBeNull();
		expect(assembler.push(frames[2])).toEqual(payload);
	});

	it("should keep every frame within the limit plus its header", () => {
		const frames = encodeFrames(bytes(2500), 1000);

		for (const frame of frames) {
			expect(frame.length).toBeLessThanOrEqual(1000 + 13);
		}
	});

	it("should restore two payloads whose frames arrive interleaved", () => {
		const first = bytes(2500, 1);
		const second = bytes(2500, 2);
		const firstFrames = encodeFrames(first, 1000);
		const secondFrames = encodeFrames(second, 1000);

		const results = [
			firstFrames[0],
			secondFrames[0],
			firstFrames[1],
			secondFrames[1],
			firstFrames[2],
			secondFrames[2],
		]
			.map((frame) => assembler.push(frame))
			.filter((result) => result !== null);

		expect(results).toEqual([first, second]);
	});

	it("should ignore frames of an unknown kind", () => {
		expect(assembler.push(new Uint8Array([9, 1, 2, 3]))).toBeNull();
	});

	it("should forget a half-received payload when cleared", () => {
		const frames = encodeFrames(bytes(2500), 1000);
		assembler.push(frames[0]);
		assembler.push(frames[1]);

		assembler.clear();

		expect(assembler.push(frames[2])).toBeNull();
	});
});

function bytes(length: number, seed = 0): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (i + seed) % 251);
}

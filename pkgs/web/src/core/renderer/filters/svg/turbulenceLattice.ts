/**
 * CPU port of the feTurbulence reference `init(seed)` from the SVG Filter
 * Effects specification: the seeded linear congruential generator, the
 * shuffled lattice selector and the per-channel unit gradient table. The
 * tables are uploaded once per seed as a storage buffer and read by the
 * turbulence shader, so both sides see the same lattice as resvg.
 */

const RAND_M = 2_147_483_647;
const RAND_A = 16_807;
const RAND_Q = 127_773;
const RAND_R = 2_836;
const B_SIZE = 0x100;
const CHANNELS = 4;

/** Entries per lattice table: BSize + BSize + 2 in the reference code. */
export const TURBULENCE_LATTICE_SIZE = B_SIZE + B_SIZE + 2;

/** Offset the reference code adds before flooring a coordinate (PerlinN). */
export const TURBULENCE_PERLIN_N = 0x1000;

/** vec2f entries in the flattened [channel][index] gradient table. */
export const TURBULENCE_GRADIENT_COUNT = CHANNELS * TURBULENCE_LATTICE_SIZE;

interface TurbulenceLattice {
	lattice: Int32Array;
	/** [channel][index][xy] flattened. */
	gradient: Float32Array;
}

export function buildTurbulenceLattice(seed: number): TurbulenceLattice {
	const lattice = new Int32Array(TURBULENCE_LATTICE_SIZE);
	const gradient = new Float32Array(TURBULENCE_GRADIENT_COUNT * 2);
	let state = setupSeed(seed);

	for (let k = 0; k < CHANNELS; k++) {
		for (let i = 0; i < B_SIZE; i++) {
			lattice[i] = i;
			const at = (k * TURBULENCE_LATTICE_SIZE + i) * 2;
			for (let j = 0; j < 2; j++) {
				state = random(state);
				gradient[at + j] = ((state % (B_SIZE + B_SIZE)) - B_SIZE) / B_SIZE;
			}
			const length = Math.hypot(gradient[at], gradient[at + 1]);
			gradient[at] /= length;
			gradient[at + 1] /= length;
		}
	}

	for (let i = B_SIZE - 1; i > 0; i--) {
		state = random(state);
		const j = state % B_SIZE;
		const swapped = lattice[i];
		lattice[i] = lattice[j];
		lattice[j] = swapped;
	}

	for (let i = 0; i < B_SIZE + 2; i++) {
		lattice[B_SIZE + i] = lattice[i];
		for (let k = 0; k < CHANNELS; k++) {
			const from = (k * TURBULENCE_LATTICE_SIZE + i) * 2;
			const to = (k * TURBULENCE_LATTICE_SIZE + B_SIZE + i) * 2;
			gradient[to] = gradient[from];
			gradient[to + 1] = gradient[from + 1];
		}
	}

	return { lattice, gradient };
}

/**
 * The lattice laid out for the shader's `Lattice` storage struct:
 * `array<i32, 514>` followed directly by `array<vec2f, 2056>` — the selector
 * block is 2056 bytes, a multiple of the 8-byte vec2f alignment, so no
 * padding sits between them.
 */
export function packTurbulenceLattice({
	lattice,
	gradient,
}: TurbulenceLattice): ArrayBuffer {
	const buffer = new ArrayBuffer(lattice.byteLength + gradient.byteLength);
	new Int32Array(buffer, 0, lattice.length).set(lattice);
	new Float32Array(buffer, lattice.byteLength, gradient.length).set(gradient);
	return buffer;
}

function setupSeed(seed: number): number {
	let s = Math.trunc(seed);
	if (s <= 0) s = -(s % (RAND_M - 1)) + 1;
	if (s > RAND_M - 1) s = RAND_M - 1;
	return s;
}

function random(seed: number): number {
	let result = RAND_A * (seed % RAND_Q) - RAND_R * Math.trunc(seed / RAND_Q);
	if (result <= 0) result += RAND_M;
	return result;
}

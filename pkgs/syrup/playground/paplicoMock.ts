/**
 * Mock `paplico` host package for the playground and sample tests.
 * Pure data + plain functions: no monaco / DOM dependencies.
 */

export const PAPLICO_DECLARATIONS = `declare type Layer {
	let name: String
	var opacity: Number
	fn addRect(x: Number, y: Number, w: Number, h: Number) -> Void
	fn childCount() -> Number
}
declare fn addLayer(name: String) -> Layer
declare async fn loadAsset(name: String) -> Number
`;

export function createMockPaplicoRuntime(
	log: (text: string) => void,
): Record<string, unknown> {
	return {
		addLayer: (name: string) => {
			log(`paplico: addLayer(${JSON.stringify(name)})`);
			return createMockLayer(name, log);
		},
		loadAsset: async (name: string) => {
			log(`paplico: loadAsset(${JSON.stringify(name)})`);
			return name.length;
		},
	};
}

function createMockLayer(name: string, log: (text: string) => void) {
	let childCount = 0;
	return {
		name,
		opacity: 1,
		addRect: (x: number, y: number, w: number, h: number) => {
			childCount += 1;
			log(`paplico: ${name}.addRect(x: ${x}, y: ${y}, w: ${w}, h: ${h})`);
		},
		childCount: () => childCount,
	};
}

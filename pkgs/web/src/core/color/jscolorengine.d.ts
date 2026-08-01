/**
 * Hand-written ambient types for the untyped "jscolorengine" CJS package
 * (v1.4.4). Only the API surface used by core/color/ is declared.
 *
 * The package is CommonJS (`module.exports = { Profile, Transform, ... }`).
 * Node's CJS-to-ESM interop does NOT surface `Profile` / `Transform` as
 * named exports of `import("jscolorengine")`, so consumers MUST go through
 * the default export: `const jsce = (await import("jscolorengine")).default`.
 */
declare module "jscolorengine" {
	export interface JscProfileError {
		err: number;
		text: string;
	}

	/** An ICC profile parsed by jsColorEngine. */
	export interface JscProfile {
		loaded: boolean;
		loadError: boolean;
		lastError: JscProfileError;
		/** Human-readable profile name decoded from the ICC 'desc' tag. */
		name: string;
		/** Trimmed ICC data color space signature, e.g. "RGB", "CMYK", "GRAY". */
		colorSpace: string;
		/** Profile pipeline kind; one of the eProfileType values. */
		type: number;
		/** Major ICC version (2 or 4). */
		version: number;
		/**
		 * Device->PCS LUTs indexed [perceptual, relative, saturation].
		 * Slots are null when the profile has no table for that intent
		 * (only perceptual<-relative and saturation<-perceptual fallbacks
		 * are applied at load time; relative is never auto-filled).
		 */
		A2B: (object | null)[];
		/** PCS->Device LUTs indexed [perceptual, relative, saturation]. */
		B2A: (object | null)[];
		/**
		 * Decode a profile already in memory. Synchronous; `afterLoad` is
		 * invoked with the profile even on failure, so check `loaded`
		 * afterwards.
		 */
		loadBinary(
			binary: Uint8Array,
			afterLoad?: (profile: JscProfile) => void,
			searchForProfile?: boolean,
		): void;
	}

	/**
	 * Transform constructor options. Narrowed to the int8 flat-array
	 * surface used by core/color/.
	 */
	export interface JscTransformOptions {
		/** Prebuild a CLUT enabling the image fast path in transformArray(). */
		buildLut?: boolean;
		dataFormat?: "object" | "objectFloat" | "int8" | "int16" | "device";
		/** Black point compensation, global or per chain stage. */
		BPC?: boolean | boolean[];
		/** Grid points per axis for prebuilt 3D LUTs (default 33). */
		lutGridPoints3D?: number;
		/** Grid points per axis for prebuilt 4D (CMYK input) LUTs (default 17). */
		lutGridPoints4D?: number;
	}

	export interface JscTransform {
		/** Resolved LUT kernel after create(), e.g. "int-wasm-simd". */
		lutMode: string;
		/**
		 * Build a single source -> destination pipeline. Synchronous;
		 * throws a string on invalid profiles or intents.
		 */
		create(
			inputProfile: JscProfile | string,
			outputProfile: JscProfile | string,
			intent: number,
			customStages?: object[],
		): void;
		/**
		 * Build a multi-stage pipeline from an alternating
		 * [profile, intent, profile, intent, profile, ...] chain.
		 */
		createMultiStage(
			profileChain: (JscProfile | string | number)[],
			customStages?: object[],
		): void;
		/**
		 * Transform a flat pixel array. With dataFormat "int8" the values
		 * are 0-255 per channel; `outputFormat: "int8"` yields a
		 * Uint8ClampedArray (the prebuilt-LUT fast path always does).
		 */
		transformArray(
			inputArray: Uint8ClampedArray | Uint8Array,
			inputHasAlpha: boolean,
			outputHasAlpha: boolean,
			preserveAlpha?: boolean,
			pixelCount?: number,
			outputFormat?: "int8",
			outputArray?: Uint8ClampedArray,
		): Uint8ClampedArray;
	}

	export interface JsColorEngineModule {
		Profile: new (
			dataOrUrl?: Uint8Array | string,
			afterLoad?: (profile: JscProfile) => void,
		) => JscProfile;
		Transform: new (options?: JscTransformOptions) => JscTransform;
		eIntent: {
			readonly perceptual: 0;
			readonly relative: 1;
			readonly saturation: 2;
			readonly absolute: 3;
		};
		eProfileType: {
			readonly Lab: 0;
			readonly RGBMatrix: 1;
			readonly RGBLut: 2;
			readonly CMYK: 3;
			readonly Gray: 4;
			readonly Duo: 5;
			readonly XYZ: 6;
		};
	}

	const jsColorEngine: JsColorEngineModule;
	export default jsColorEngine;
}

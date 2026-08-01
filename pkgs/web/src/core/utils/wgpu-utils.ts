import {
	getSizeAndAlignmentOfUnsizedArrayElement,
	makeShaderDataDefinitions,
	makeStructuredView,
	type ShaderDataDefinitions,
	type StructuredView,
} from "webgpu-utils";

export type { ShaderDataDefinitions, StructuredView };

interface CompiledShaderModule {
	module: GPUShaderModule;
	info: Promise<GPUCompilationInfo>;
	definitions: ShaderDataDefinitions;
	uniformViews: Record</* uniform variable name */ string, StructuredView>;
	storageViews: Record</* storage variable name */ string, StructuredView>;
}

/** Compile shader module and check compilation info */
export function compileShaderModule(
	device: GPUDevice,
	{ code, label, compilationHints }: GPUShaderModuleDescriptor,
): CompiledShaderModule {
	const module = device.createShaderModule({
		code,
		label,
		compilationHints,
	});

	const defs = makeShaderDataDefinitions(code);
	const uniformViews = Object.keys(defs.uniforms).reduce<
		Record<string, StructuredView>
	>((acc, name) => {
		acc[name] = makeStructuredView(defs.uniforms[name]);
		return acc;
	}, {});

	const storageViews = Object.keys(defs.storages).reduce<
		Record<string, StructuredView>
	>((acc, name) => {
		const def = defs.storages[name];
		// Unsized arrays need an explicit ArrayBuffer since their size is runtime-determined
		const elemInfo = getSizeAndAlignmentOfUnsizedArrayElement(def);
		if (elemInfo.size > 0) {
			// Default to 16 elements for unsized arrays (callers can create their own views for other sizes)
			const buf = new ArrayBuffer(elemInfo.size * 16);
			acc[name] = makeStructuredView(def, buf);
		} else {
			acc[name] = makeStructuredView(def);
		}
		return acc;
	}, {});

	const info = module.getCompilationInfo();

	info.then((info) => {
		if (info.messages.length === 0) return;
		info.messages.forEach((msg) => {
			const type = (
				{
					error: "error",
					warning: "warn",
					info: "info",
				} as const
			)[msg.type];

			console[type](msg);
		});
	});

	return { module, definitions: defs, uniformViews, storageViews, info };
}

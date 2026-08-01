import { describe, expect, it } from "vitest";
import { createScriptHost, type ScriptHost } from "./ScriptHost";

function makeHost(): { host: ScriptHost; lines: string[] } {
	const lines: string[] = [];
	const host = createScriptHost({ stdout: (text) => lines.push(text) });
	return { host, lines };
}

describe("ScriptHost.loadModule", () => {
	it("should expose exported values and functions to the host", async () => {
		const { host } = makeHost();
		const module = await host.loadModule(`
			export let baseSize = 12

			export fn double(n: Number) -> Number {
				return n * 2
			}

			fn hidden() -> Number { return 1 }
		`);
		expect(module.get("baseSize")).toBe(12);
		expect(await module.call("double", [21])).toBe(42);
		expect(Object.keys(module.exports)).toEqual(["baseSize", "double"]);
		expect(module.get("hidden")).toBeUndefined();
	});

	it("should run top-level module code (host calls included) at load time", async () => {
		const { host, lines } = makeHost();
		const module = await host.loadModule(`
			print("loading")
			export fn ready() -> Bool { return true }
		`);
		expect(lines).toEqual(["loading"]);
		expect(await module.call("ready")).toBe(true);
	});

	it("should support async exports and host calls inside them", async () => {
		const { host, lines } = makeHost();
		host.registerPackage({
			name: "io",
			declarations: "declare async fn load(key: String) -> Number",
			runtime: { load: async (key: string) => key.length },
		});
		const module = await host.loadModule(`
			export async fn measure(key: String) -> Number {
				let n = await io.load(key)
				print("measured $(n)")
				return n * 10
			}
		`);
		expect(await module.call("measure", ["abcd"])).toBe(40);
		expect(lines).toEqual(["measured 4"]);
	});

	it("should resolve imports of the loaded module", async () => {
		const { host } = makeHost();
		host.setModuleResolver((specifier) =>
			specifier === "mathx"
				? "export fn square(n: Number) -> Number { return n * n }"
				: null,
		);
		const module = await host.loadModule(`
			use mathx from "mathx"
			export fn area(side: Number) -> Number {
				return mathx.square(side)
			}
		`);
		expect(await module.call("area", [9])).toBe(81);
	});

	it("should map Syrup values to the documented JS shapes", async () => {
		const { host } = makeHost();
		const module = await host.loadModule(`
			export fn config() -> [String: Number] {
				return [width: 800, height: 600]
			}
			export fn maybe(flag: Bool) -> Number? {
				if flag { return 1 }
				return nil
			}
		`);
		const config = (await module.call("config")) as Map<string, number>;
		expect(config).toBeInstanceOf(Map);
		expect(config.get("width")).toBe(800);
		expect(await module.call("maybe", [false])).toBeNull();
	});

	it("should throw on compile errors and unknown functions", async () => {
		const { host } = makeHost();
		await expect(host.loadModule('let broken: Number = "no"')).rejects.toThrow(
			/Syrup module compile failed/,
		);
		const module = await host.loadModule("export let v = 1");
		await expect(module.call("nope")).rejects.toThrow(
			/no exported function 'nope'/,
		);
	});
});

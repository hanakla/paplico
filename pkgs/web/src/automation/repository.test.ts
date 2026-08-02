import { BUILTIN_AUTOMATION_SCRIPTS } from "./builtins";
import { createAutomationScriptRepository } from "./repository";

describe("AutomationScriptRepository", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("should expose only built-in scripts in the browser", async () => {
		const repository = createAutomationScriptRepository({ isTauri: false });

		expect(repository.canManageUserScripts).toBe(false);
		expect(await repository.list()).toEqual(BUILTIN_AUTOMATION_SCRIPTS);
		await expect(
			repository.create({ name: "Test", description: "", source: "" }),
		).rejects.toThrow("only in Paplico Desktop");
	});

	it("should persist user scripts in Paplico Desktop", async () => {
		const repository = createAutomationScriptRepository({ isTauri: true });
		const created = await repository.create({
			name: "Test",
			description: "A test script",
			source: "print(1)",
		});

		await repository.update({ ...created, source: "print(2)" });

		expect(await repository.list()).toEqual([
			...BUILTIN_AUTOMATION_SCRIPTS,
			{ ...created, source: "print(2)" },
		]);

		await repository.delete(created.id);
		expect(await repository.list()).toEqual(BUILTIN_AUTOMATION_SCRIPTS);
	});
});

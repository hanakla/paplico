import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appearancePresetsDB,
	webAppearancePresetsRepo,
} from "./appearancePresetsDB.web";

const preset = (uid: string, updatedAt: number) => ({
	uid,
	name: uid,
	filters: [
		{
			uid: `${uid}-f`,
			processor: "blur",
			opacity: 1,
			blendMode: "normal" as const,
			paramData: { version: "1", params: { radius: 2 } },
		},
	],
	createdAt: updatedAt,
	updatedAt,
});

describe("webAppearancePresetsRepo", () => {
	beforeEach(async () => {
		await appearancePresetsDB.appearancePresets.clear();
	});

	it("should list saved presets newest first", async () => {
		await webAppearancePresetsRepo.save(preset("old", 1));
		await webAppearancePresetsRepo.save(preset("new", 2));

		const listed = await webAppearancePresetsRepo.list();

		expect(listed.map((p) => p.uid)).toEqual(["new", "old"]);
	});

	it("should return copies that do not share filter objects with later reads", async () => {
		await webAppearancePresetsRepo.save(preset("a", 1));

		const first = await webAppearancePresetsRepo.get("a");
		const second = await webAppearancePresetsRepo.get("a");

		expect(first).toEqual(second);
		expect(first?.filters[0]).not.toBe(second?.filters[0]);
	});

	it("should rename and delete by uid", async () => {
		await webAppearancePresetsRepo.save(preset("a", 1));

		await webAppearancePresetsRepo.rename("a", "Renamed");
		expect((await webAppearancePresetsRepo.get("a"))?.name).toBe("Renamed");

		await webAppearancePresetsRepo.delete("a");
		expect(await webAppearancePresetsRepo.get("a")).toBe(null);
	});

	it("should keep the list order when a preset is renamed", async () => {
		await webAppearancePresetsRepo.save(preset("old", 1));
		await webAppearancePresetsRepo.save(preset("new", 2));

		await webAppearancePresetsRepo.rename("old", "Renamed");

		const listed = await webAppearancePresetsRepo.list();
		expect(listed.map((p) => p.uid)).toEqual(["new", "old"]);
	});
});

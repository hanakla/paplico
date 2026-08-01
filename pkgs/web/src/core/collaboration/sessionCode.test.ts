import { buildSessionCode, parseSessionCode } from "./sessionCode";

describe("sessionCode", () => {
	it("should return what it was given", () => {
		const code = buildSessionCode("companion", {
			roomId: "room-a",
			encodedKey: "a-key",
		});

		expect(parseSessionCode(code)).toEqual({
			kind: "companion",
			roomId: "room-a",
			encodedKey: "a-key",
		});
	});

	it("should keep a room code apart from a companion code", () => {
		const target = { roomId: "room-a", encodedKey: "a-key" };

		expect(parseSessionCode(buildSessionCode("room", target))?.kind).toBe(
			"room",
		);
		expect(parseSessionCode(buildSessionCode("companion", target))?.kind).toBe(
			"companion",
		);
	});

	it("should survive the whitespace a camera picks up around a code", () => {
		const code = buildSessionCode("room", {
			roomId: "room-a",
			encodedKey: "a-key",
		});

		expect(parseSessionCode(`  ${code}\n`)).not.toBe(null);
	});

	it("should return null for text that is not a code", () => {
		expect(parseSessionCode("https://example.com/?room=a#k=b")).toBe(null);
		expect(parseSessionCode("hello")).toBe(null);
		expect(parseSessionCode("")).toBe(null);
	});

	it("should return null for an unknown kind", () => {
		expect(parseSessionCode("paplico:everything:room-a:a-key")).toBe(null);
	});

	it("should return null when a part is missing", () => {
		expect(parseSessionCode("paplico:room:room-a")).toBe(null);
		expect(parseSessionCode("paplico:room::a-key")).toBe(null);
	});
});

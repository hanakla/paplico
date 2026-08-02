import { buildCompanionUrl, buildInviteUrl } from "./inviteUrl";
import { parseSessionCode } from "./sessionCode";

const ORIGIN = "https://paplico.test";
const TARGET = { roomId: "room-a", encodedKey: "a-key" };

describe("sessionCode", () => {
	it("should return what the invite link was built from", () => {
		expect(parseSessionCode(buildCompanionUrl(ORIGIN, TARGET))).toEqual({
			kind: "companion",
			roomId: "room-a",
			encodedKey: "a-key",
		});
	});

	it("should keep a room link apart from a companion link", () => {
		expect(parseSessionCode(buildInviteUrl(ORIGIN, TARGET))?.kind).toBe("room");
		expect(parseSessionCode(buildCompanionUrl(ORIGIN, TARGET))?.kind).toBe(
			"companion",
		);
	});

	it("should read a companion link that arrived with a trailing slash", () => {
		expect(
			parseSessionCode(`${ORIGIN}/companion/?room=room-a#k=a-key`)?.kind,
		).toBe("companion");
	});

	it("should survive the whitespace a camera picks up around a code", () => {
		expect(parseSessionCode(`  ${buildInviteUrl(ORIGIN, TARGET)}\n`)).not.toBe(
			null,
		);
	});

	it("should return null for a link carrying no key", () => {
		expect(parseSessionCode(`${ORIGIN}/?room=room-a`)).toBe(null);
	});

	it("should return null for text that is not a code", () => {
		expect(parseSessionCode("https://example.com/")).toBe(null);
		expect(parseSessionCode("hello")).toBe(null);
		expect(parseSessionCode("")).toBe(null);
	});

	describe("codes from a build that still sends the bare string form", () => {
		it("should read both kinds", () => {
			expect(parseSessionCode("paplico:companion:room-a:a-key")).toEqual({
				kind: "companion",
				roomId: "room-a",
				encodedKey: "a-key",
			});
			expect(parseSessionCode("paplico:room:room-a:a-key")?.kind).toBe("room");
		});

		it("should return null for an unknown kind", () => {
			expect(parseSessionCode("paplico:everything:room-a:a-key")).toBe(null);
		});

		it("should return null when a part is missing", () => {
			expect(parseSessionCode("paplico:room:room-a")).toBe(null);
			expect(parseSessionCode("paplico:room::a-key")).toBe(null);
		});
	});
});

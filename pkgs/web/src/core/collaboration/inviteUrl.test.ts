import {
	buildDeepLinkUrl,
	buildInviteUrl,
	parseInvite,
	readKeyFromFragment,
} from "./inviteUrl";

describe("inviteUrl", () => {
	describe("buildInviteUrl", () => {
		it("should keep the key in the fragment so it is never sent to a server", () => {
			const url = buildInviteUrl("https://paplico.test", {
				roomId: "room-1",
				encodedKey: "aGVsbG8",
			});

			expect(url).toBe("https://paplico.test/?room=room-1#k=aGVsbG8");
			expect(new URL(url).search).not.toContain("aGVsbG8");
		});

		it("should omit the fragment for rooms without a key", () => {
			expect(buildInviteUrl("https://paplico.test", { roomId: "room-1" })).toBe(
				"https://paplico.test/?room=room-1",
			);
		});
	});

	describe("buildDeepLinkUrl", () => {
		it("should produce a paplico:// link carrying the same parts", () => {
			expect(
				buildDeepLinkUrl({ roomId: "room-1", encodedKey: "aGVsbG8" }),
			).toBe("paplico://join?room=room-1#k=aGVsbG8");
		});
	});

	describe("parseInvite", () => {
		it("should round-trip a built invite URL", () => {
			const invite = { roomId: "room-1", encodedKey: "aGVsbG8" };

			expect(
				parseInvite(buildInviteUrl("https://paplico.test", invite)),
			).toEqual(invite);
		});

		it("should round-trip a built deep link", () => {
			const invite = { roomId: "room-1", encodedKey: "aGVsbG8" };

			expect(parseInvite(buildDeepLinkUrl(invite))).toEqual(invite);
		});

		it("should accept a bare room id typed by hand", () => {
			expect(parseInvite("room-1")).toEqual({ roomId: "room-1" });
		});

		it("should trim surrounding whitespace from a pasted link", () => {
			expect(
				parseInvite("  https://paplico.test/?room=room-1#k=abc  "),
			).toEqual({
				roomId: "room-1",
				encodedKey: "abc",
			});
		});

		it("should return null for a URL that carries no room", () => {
			expect(parseInvite("https://paplico.test/")).toBeNull();
		});

		it("should return null for empty input", () => {
			expect(parseInvite("   ")).toBeNull();
		});

		it("should report no key when the link has none", () => {
			expect(parseInvite("https://paplico.test/?room=room-1")).toEqual({
				roomId: "room-1",
			});
		});
	});

	describe("readKeyFromFragment", () => {
		it("should read the key with or without the leading hash", () => {
			expect(readKeyFromFragment("#k=abc")).toBe("abc");
			expect(readKeyFromFragment("k=abc")).toBe("abc");
		});

		it("should return null when the fragment holds no key", () => {
			expect(readKeyFromFragment("#something=else")).toBeNull();
			expect(readKeyFromFragment("")).toBeNull();
		});
	});
});

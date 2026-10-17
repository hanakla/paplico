import {
	describe,
	expect,
	it,
} from "../../../../../../node_modules/vitest/dist/index";
import type { Viewport } from "../../../schema";
import { boundsIntersectViewport, isInViewport } from "./viewport";

describe("coordinates", () => {
	const viewport: Viewport = {
		x: 0,
		y: 0,
		zoom: 1,
		rotation: 0,
	};

	const canvasWidth = 800;
	const canvasHeight = 600;

	describe("isInViewport", () => {
		it("should return true for point at world origin", () => {
			expect(isInViewport(0, 0, viewport, canvasWidth, canvasHeight)).toBe(
				true,
			);
		});

		it("should return true for point within bounds", () => {
			expect(isInViewport(200, 100, viewport, canvasWidth, canvasHeight)).toBe(
				true,
			);
		});

		it("should return false for point outside bounds", () => {
			expect(isInViewport(500, 0, viewport, canvasWidth, canvasHeight)).toBe(
				false,
			);
			expect(isInViewport(0, 400, viewport, canvasWidth, canvasHeight)).toBe(
				false,
			);
		});

		it("should respect margin parameter", () => {
			expect(isInViewport(410, 0, viewport, canvasWidth, canvasHeight, 0)).toBe(
				false,
			);
			expect(
				isInViewport(410, 0, viewport, canvasWidth, canvasHeight, 20),
			).toBe(true);
		});
	});

	describe("boundsIntersectViewport", () => {
		it("should return true for bounds completely within viewport", () => {
			expect(
				boundsIntersectViewport(
					-100,
					-100,
					100,
					100,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});

		it("should return true for bounds partially overlapping viewport", () => {
			expect(
				boundsIntersectViewport(
					300,
					-100,
					500,
					100,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});

		it("should return false for bounds completely outside viewport", () => {
			expect(
				boundsIntersectViewport(
					500,
					500,
					600,
					600,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(false);
		});

		it("should return true for bounds containing entire viewport", () => {
			expect(
				boundsIntersectViewport(
					-1000,
					-1000,
					1000,
					1000,
					viewport,
					canvasWidth,
					canvasHeight,
				),
			).toBe(true);
		});
	});
});

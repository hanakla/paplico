import { describe, expect, it } from "vitest";
import { evaluateNumberExpression } from "./numberExpression";

describe("evaluateNumberExpression", () => {
	it("should return the number itself for a plain number", () => {
		expect(evaluateNumberExpression("42")).toBe(42);
		expect(evaluateNumberExpression("3.5")).toBe(3.5);
		expect(evaluateNumberExpression(".5")).toBe(0.5);
	});

	it("should evaluate the four arithmetic operators", () => {
		expect(evaluateNumberExpression("12+3")).toBe(15);
		expect(evaluateNumberExpression("12 - 3")).toBe(9);
		expect(evaluateNumberExpression("12*3")).toBe(36);
		expect(evaluateNumberExpression("12/4")).toBe(3);
		expect(evaluateNumberExpression("13%5")).toBe(3);
	});

	it("should respect operator precedence and parentheses", () => {
		expect(evaluateNumberExpression("2+3*4")).toBe(14);
		expect(evaluateNumberExpression("(2+3)*4")).toBe(20);
	});

	it("should accept signed values", () => {
		expect(evaluateNumberExpression("-5")).toBe(-5);
		expect(evaluateNumberExpression("10*-2")).toBe(-20);
	});

	it("should read full-width digits and symbols as half-width", () => {
		expect(evaluateNumberExpression("１２＋３")).toBe(15);
		expect(evaluateNumberExpression("（２＋３）＊４")).toBe(20);
		expect(evaluateNumberExpression("１０．５")).toBe(10.5);
		expect(evaluateNumberExpression("１２　＋　３")).toBe(15);
	});

	it("should read a trailing decimal point as a zero fraction", () => {
		expect(evaluateNumberExpression("10.")).toBe(10);
		expect(evaluateNumberExpression("10.+2")).toBe(12);
		expect(evaluateNumberExpression("１０．")).toBe(10);
	});

	it("should return null for an incomplete or invalid expression", () => {
		expect(evaluateNumberExpression("")).toBeNull();
		expect(evaluateNumberExpression("12+")).toBeNull();
		expect(evaluateNumberExpression("(1+2")).toBeNull();
		expect(evaluateNumberExpression("12px")).toBeNull();
		expect(evaluateNumberExpression("auto")).toBeNull();
	});

	it("should return null when the result is not finite", () => {
		expect(evaluateNumberExpression("1/0")).toBeNull();
	});
});

/**
 * Tests for the shared JSON parsing helpers in the extraction pipeline module.
 */

import { describe, expect, it } from "bun:test";
import { stripFences } from "./extraction";

describe("stripFences", () => {
	it("strips leading non-JSON text before first brace", () => {
		const input = 'Here is the JSON output:\n{"key": "value"}';
		const result = stripFences(input);
		expect(result).toBe('{"key": "value"}');
	});

	it("returns input unchanged when it starts with a brace", () => {
		const input = '{"key": "value"}';
		expect(stripFences(input)).toBe('{"key": "value"}');
	});

	it("still prefers code fence extraction over leading-text stripping", () => {
		const input = 'explanation\n```json\n{"fenced": true}\n```\nmore text';
		expect(stripFences(input)).toBe('{"fenced": true}');
	});

	it("strips think blocks from reasoning models", () => {
		const input = '<think>reasoning here</think>{"key": "value"}';
		expect(stripFences(input)).toBe('{"key": "value"}');
	});
});

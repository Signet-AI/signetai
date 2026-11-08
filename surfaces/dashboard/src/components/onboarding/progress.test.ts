import { expect, test } from "bun:test";
import { ONBOARDING_STEPS, restoreOnboardingStep } from "./progress";

test("saved setup progress preserves the old numeric order and named steps", () => {
	const legacy = [
		"Welcome",
		"Identity",
		"Harnesses",
		"Connection",
		"Sources",
		"Search",
		"How it works",
		"First memory",
		"Summary",
	];
	for (const [index, name] of legacy.entries()) {
		expect(ONBOARDING_STEPS[restoreOnboardingStep(index)]).toBe(name);
		expect(ONBOARDING_STEPS[restoreOnboardingStep(name)]).toBe(name);
	}
	expect(ONBOARDING_STEPS[restoreOnboardingStep("Usage data")]).toBe("Usage data");
	for (const invalid of [null, undefined, -1, 25, 1.5, "retired"]) expect(restoreOnboardingStep(invalid)).toBe(-1);
});

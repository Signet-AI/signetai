import { describe, expect, test } from "bun:test";
import { GraphHoverIntent } from "./graph-hover";

describe("graph hover intent", () => {
	test("passing across nodes does not highlight intermediate connections", () => {
		const hover = new GraphHoverIntent();
		hover.move("entity", 0);
		hover.tick(120);
		expect(hover.active).toBe("entity");
		for (let now = 140; now < 300; now += 20) {
			hover.move(`passing-${now}`, now);
			expect(hover.tick(now)).toBe(true);
			expect(hover.active).toBe("entity");
		}
		hover.move("ontology", 300);
		hover.tick(419);
		expect(hover.active).toBe("entity");
		expect(hover.tick(420)).toBe(false);
		expect(hover.active).toBe("ontology");
	});

	test("brief gaps keep emphasis and leaving eventually clears it", () => {
		const hover = new GraphHoverIntent();
		hover.move("entity", 0);
		hover.tick(120);
		hover.move(undefined, 130);
		hover.tick(200);
		expect(hover.active).toBe("entity");
		hover.move("entity", 210);
		expect(hover.tick(210)).toBe(false);
		hover.move(undefined, 220);
		hover.tick(340);
		expect(hover.active).toBeUndefined();
		hover.move("ontology", 350);
		hover.clear();
		expect(hover.tick(500)).toBe(false);
		expect(hover.active).toBeUndefined();
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateInferenceProviders } from "./config-migration";

function setupDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-config-migration-"));
	mkdirSync(join(dir, "memory"), { recursive: true });
	return dir;
}

afterEach(() => {
	// each test cleans its own dir
});

describe("migrateInferenceProviders (#947)", () => {
	it("rewrites folded harness executors to acpx with the mapped agent", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`# leading comment
inference:
  targets:
    opus:           # claude target
      executor: claude-code
      account: claude-dot
      models:
        default:
          model: opus-4.6
    codex-target:
      executor: codex
      models:
        default:
          model: gpt-5
    oc:
      executor: opencode
      models:
        default:
          model: x
    sonnet:          # direct API, must be untouched
      executor: anthropic
      models:
        default:
          model: claude-sonnet-4
`,
			);
			migrateInferenceProviders(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			// claude-code -> acpx + agent: claude
			expect(after).toContain("executor: acpx");
			expect(after).not.toContain("executor: claude-code");
			expect(after).not.toContain("executor: codex");
			expect(after).not.toContain("executor: opencode");
			// agent blocks added
			expect(after).toMatch(/acpx:\s*\n\s*agent: claude\b/);
			expect(after).toMatch(/agent: codex\b/);
			expect(after).toMatch(/agent: opencode\b/);
			// anthropic untouched
			expect(after).toContain("executor: anthropic");
			// comments preserved
			expect(after).toContain("# leading comment");
			expect(after).toContain("# claude target");
			// version stamped
			expect(after).toMatch(/^configVersion: 3/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not insert a duplicate acpx block if one already exists", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  targets:
    opus:
      executor: claude-code
      acpx:
        agent: claude   # user already configured
      models:
        default:
          model: opus
`,
			);
			migrateInferenceProviders(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after).toContain("executor: acpx");
			// only one acpx block
			expect(after.match(/acpx:/g)).toHaveLength(1);
			// user's existing agent value preserved (comment may have spacing normalized)
			expect(after).toMatch(/agent: claude.*user already configured/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves the command executor and legacy provider fields for manual reconfiguration", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`memory:
  pipelineV2:
    extraction:
      provider: claude-code
inference:
  targets:
    custom:
      executor: command
      command:
        bin: ./my-script
      models:
        default:
          model: x
`,
			);
			migrateInferenceProviders(dir);
			const after = readFileSync(join(dir, "agent.yaml"), "utf-8");
			// command and legacy provider are NOT migrated
			expect(after).toContain("executor: command");
			expect(after).toContain("provider: claude-code");
			// but version still stamped so we don't re-parse every startup
			expect(after).toMatch(/^configVersion: 3/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is idempotent — a second run is a no-op", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, "agent.yaml"),
				`inference:
  targets:
    opus:
      executor: claude-code
      models:
        default:
          model: opus
`,
			);
			migrateInferenceProviders(dir);
			const after1 = readFileSync(join(dir, "agent.yaml"), "utf-8");
			migrateInferenceProviders(dir);
			const after2 = readFileSync(join(dir, "agent.yaml"), "utf-8");
			expect(after2).toBe(after1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips when there is no agent.yaml", () => {
		const dir = setupDir();
		// no agent.yaml written — must not throw
		expect(() => migrateInferenceProviders(dir)).not.toThrow();
	});

	it("skips an unparseable file without throwing", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, "agent.yaml"), "inference:\n  [unterminated");
			expect(() => migrateInferenceProviders(dir)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

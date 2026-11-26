import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome =
	Bun.which("google-chrome-stable") ?? Bun.which("google-chrome") ?? Bun.which("chromium") ?? Bun.which("chrome");

test.skipIf(chrome === null)(
	"recent memory rows contain their text in a capped mobile list",
	async () => {
		if (chrome === null) throw new Error("Chrome is required for layout measurement");
		const directory = await mkdtemp(join(tmpdir(), "recent-memories-layout-"));
		try {
			const css = await readFile(new URL("../../index.css", import.meta.url), "utf8");
			const rows = Array.from({ length: 20 }, (_, index) => {
				const title =
					index % 3 === 0
						? "A short decision."
						: "A saved decision with enough detail to wrap onto two lines on a narrow screen and remain readable alongside its source and timestamp.";
				return `<button type="button" class="home-memory-row home-memory-summary"><div><p>${title}</p><div class="metadata">2h ago · decision · via demo-agent</div></div></button>`;
			}).join("");
			const html = `<style>${css}</style><style>
			body { margin: 0; font: 13px/1.5 sans-serif; }
			* { box-sizing: border-box; }
			button { font: inherit; border: 0; background: none; }
			.home-dashboard { width: 390px; }
			.home-recent-list { display: flex; flex-direction: column; }
			.home-memory-summary > div { min-width: 0; flex: 1; }
			.metadata { margin-top: 2px; display: flex; font-size: 11px; }
			:where(.home-memory-summary p) { margin: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; line-height: 1.35; }
		</style><main class="home-dashboard"><div class="home-recent-list">${rows}</div></main>
		<script>
			const measure = () => Array.from(document.querySelectorAll('button'), row => {
				const bounds = row.getBoundingClientRect();
				const content = row.firstElementChild.getBoundingClientRect();
				return content.top >= bounds.top && content.bottom < bounds.bottom;
			});
			const mobile = measure();
			const list = document.querySelector('.home-recent-list');
			const mobileCap = list.clientHeight;
			const scrolls = list.scrollHeight > list.clientHeight;
			document.querySelector('main').style.width = '1440px';
			const desktop = Array.from(document.querySelectorAll('button'), row => row.getBoundingClientRect().height);
			document.body.textContent = JSON.stringify({ mobile, mobileCap, scrolls, desktop });
		</script>`;
			const path = join(directory, "layout.html");
			await writeFile(path, html);
			const child = Bun.spawn(
				[
					chrome,
					"--headless",
					"--enable-logging=stderr",
					"--no-sandbox",
					"--disable-gpu",
					`--user-data-dir=${join(directory, "profile")}`,
					"--dump-dom",
					`file://${path}`,
				],
				{
					stdout: "pipe",
					stderr: "pipe",
					cwd: directory,
					env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, TMPDIR: "." },
					signal: AbortSignal.timeout(20_000),
				},
			);
			const [output, errors, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (exitCode !== 0) throw new Error(`Chrome exited ${exitCode}: ${errors}`);
			const body = /<body>(.*?)<\/body>/s.exec(output)?.[1];
			expect(body).toBeDefined();
			const result: { mobile: boolean[]; mobileCap: number; scrolls: boolean; desktop: number[] } = JSON.parse(
				body ?? "{}",
			);
			expect(result.mobileCap).toBe(340);
			expect(result.scrolls).toBe(true);
			expect(result.mobile).toEqual(Array(20).fill(true));
			expect(result.desktop).toEqual(Array(20).fill(52));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	30_000,
);

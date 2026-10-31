import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Run outside the project's dependency tree, like a binary-only Pi host.
// The copied adapter must not depend on any installed pi-ai JS modules.
describe("standalone Codex fallback", () => {
	it.each(["auto", "bundled"])("loads without node_modules in %s mode", (source) => {
		const root = mkdtempSync(join(tmpdir(), "cpa-standalone-"));
		try {
			cpSync(new URL("../extensions/codex-stream.ts", import.meta.url), join(root, "codex-stream.ts"));
			cpSync(new URL("../extensions/vendor", import.meta.url), join(root, "vendor"), { recursive: true });
			writeFileSync(join(root, "package.json"), '{"type":"module"}');
			writeFileSync(
				join(root, "check.ts"),
				`
import { loadCliproxyCodexStreams } from "./codex-stream.ts";
const streams = await loadCliproxyCodexStreams();
if (typeof streams.streamSimple !== "function") throw new Error("missing streamSimple");
streams.closeOpenAICodexWebSocketSessions();
console.log("ok");
`,
			);
			const output = execFileSync(process.execPath, ["--experimental-strip-types", join(root, "check.ts")], {
				cwd: root,
				env: { ...process.env, HOME: root, USERPROFILE: root, CLIPROXYAPI_CODEX_SOURCE: source },
				encoding: "utf8",
				timeout: 15000,
			});
			expect(output.trim()).toBe("ok");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

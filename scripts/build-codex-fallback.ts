// Rebuild with npm run build:codex-fallback. Keep the generated bundle in git so
// binary Pi installations do not need npm dependencies or a build step at runtime.
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	hasNativeMidConvoEffort,
	patchCodexSource,
	sharedSupportsConfigurationUpdate,
	supportsTranscriptSource,
} from "../extensions/codex-stream.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai")));
const packageDir = dirname(packagePath);
const { version } = JSON.parse(readFileSync(packagePath, "utf8")) as { version: string };
const sourcePath = join(packageDir, "dist/api/openai-codex-responses.js");
const source = readFileSync(sourcePath, "utf8");
const supportsConfigurationUpdate = sharedSupportsConfigurationUpdate(
	readFileSync(join(dirname(sourcePath), "openai-responses-shared.js"), "utf8"),
);
const metadata = {
	version,
	supportsConfigurationUpdate,
	supportsTranscript: supportsTranscriptSource(source),
	nativeMidConvoEffort: hasNativeMidConvoEffort(source),
};
const patched = `${patchCodexSource(source, [], { supportsConfigurationUpdate })}
export const fallbackMetadata = ${JSON.stringify(metadata)};
export function configureFallbackProviderIds(ids) {
    for (const id of ids) CODEX_TOOL_CALL_PROVIDERS.add(id);
}
`;

const result = await build({
	stdin: { contents: patched, resolveDir: dirname(sourcePath), sourcefile: "cliproxyapi-codex-fallback.js" },
	outfile: join(root, "extensions/vendor/codex-fallback.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	metafile: true,
	legalComments: "eof",
	banner: {
		js: `// Generated from @earendil-works/pi-ai ${version}; do not edit.\n// See LICENSE.pi-ai and LICENSE.partial-json; rebuild with npm run build:codex-fallback.\nimport { createRequire as createFallbackRequire } from "node:module";\nconst require = createFallbackRequire(import.meta.url);`,
	},
});
for (const output of Object.values(result.metafile.outputs)) {
	for (const dependency of output.imports) {
		if (dependency.external && !isBuiltin(dependency.path)) {
			throw new Error(`Fallback must be self-contained; found external import: ${dependency.path}`);
		}
	}
}
console.log(`Built bundled Codex fallback from pi-ai ${version}`);

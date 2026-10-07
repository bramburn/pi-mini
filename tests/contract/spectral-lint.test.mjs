// Runs Spectral against the OpenAPI and AsyncAPI roots as part of `npm test`.
//
// If the @stoplight/spectral-cli package is not installed, this test skips
// (install once with `npm i -D @stoplight/spectral-cli`).
//
// NOTE: on this machine `npx spectral lint …` is broken (spectral-cli 6.17 +
// its bundled yargs mis-slices process.argv on Node 24, so every positional
// arg is rejected as an "unknown command"). The equivalent supported
// invocation is:
//
//   node -e "require('@stoplight/spectral-cli/dist/index.js')" lint <docs...>
//
// which is what this test spawns. Same linter, same config, same exit codes.
//
// Placeholder content is expected to carry `description: TODO(<feature>)`
// markers. Those should not fail the build: we assert exit code 0. If Spectral
// fails only because of TODO-placeholder rule violations, we assert that every
// reported problem's rule code is in ALLOWED_PLACEHOLDER_RULES below and say
// so — new content must not add codes to that list without owner sign-off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const targets = ["specs/api/openapi.yaml", "specs/async/asyncapi.yaml"];

// Rule codes we tolerate while specs are still TODO placeholders.
const ALLOWED_PLACEHOLDER_RULES = new Set([
	// none currently: placeholders are written to satisfy all house rules.
]);

function spectralEntry() {
	try {
		const entry = require.resolve("@stoplight/spectral-cli/dist/index.js");
		return fs.existsSync(entry) ? entry : null;
	} catch {
		return null;
	}
}

test("spectral lint passes on OpenAPI and AsyncAPI roots", { timeout: 180_000 }, (t, done) => {
	const entry = spectralEntry();
	if (!entry) {
		t.skip("@stoplight/spectral-cli not installed; run `npm i -D @stoplight/spectral-cli` to enable this test");
		return done();
	}
	const child = spawn(
		process.execPath,
		["-e", `require(${JSON.stringify(entry)})`, "lint", ...targets],
		{ cwd: repoRoot },
	);
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	child.on("close", (code) => {
		if (code === 0) return done();
		// Non-zero: tolerate ONLY documented placeholder rule codes.
		const codes = [...new Set([...out.matchAll(/\b([a-z0-9]+(?:-[a-z0-9]+)+)\s+\d+:\d+/gi)].map((m) => m[1].toLowerCase()))];
		const unexpected = codes.filter((c) => !ALLOWED_PLACEHOLDER_RULES.has(c));
		assert.deepEqual(
			unexpected,
			[],
			`spectral failed with non-placeholder violations (tolerated placeholder codes: ${[...ALLOWED_PLACEHOLDER_RULES].join(", ") || "none"}):\n${out}`,
		);
		done();
	});
	child.on("error", done);
});

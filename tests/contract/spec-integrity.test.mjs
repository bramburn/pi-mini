// Contract tests: structural integrity of the specs/ tree.
//
// Guarantees (see tests/contract/README.md):
//   1. every *.yaml under specs/ parses as YAML
//   2. every relative $ref ("file.yaml" or "file.yaml#/pointer") resolves
//   3. specs/api/openapi.yaml is OpenAPI 3.1.x with info + paths
//   4. specs/async/asyncapi.yaml is AsyncAPI 3.x with channels
//   5. every specs/features/**/*.feature starts with "Feature:" and has >= 1 "Scenario:"
//   6. spectral.yaml parses and extends at least spectral:oas
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const specsDir = path.join(repoRoot, "specs");

function walk(dir, acc = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, acc);
		else acc.push(full);
	}
	return acc;
}

function findByExt(ext) {
	if (!fs.existsSync(specsDir)) return [];
	return walk(specsDir).filter((f) => f.endsWith(ext));
}

/** Resolve a JSON-pointer-ish fragment like /components/schemas/Foo against a parsed doc. */
function pointerExists(doc, pointer) {
	const parts = pointer.split("/").filter(Boolean).map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
	let cur = doc;
	for (const part of parts) {
		if (cur == null || typeof cur !== "object") return false;
		cur = cur[part];
	}
	return cur !== undefined;
}

// --- 1 + 2: all YAML parses, all $refs resolve --------------------------------

const yamlFiles = findByExt(".yaml");
assert.ok(yamlFiles.length > 0, "expected placeholder YAML files under specs/");

for (const file of yamlFiles) {
	const rel = path.relative(repoRoot, file);
	test(`yaml parses: ${rel}`, () => {
		const content = fs.readFileSync(file, "utf8");
		assert.doesNotThrow(() => parseYaml(content), `${rel} must be valid YAML`);
	});
}

test("relative $refs point to existing files", () => {
	for (const file of yamlFiles) {
		const content = fs.readFileSync(file, "utf8");
		const doc = parseYaml(content);
		const refs = [];
		const visit = (node) => {
			if (Array.isArray(node)) return node.forEach(visit);
			if (node && typeof node === "object") {
				for (const [k, v] of Object.entries(node)) {
					if (k === "$ref" && typeof v === "string") refs.push(v);
					else visit(v);
				}
			}
		};
		visit(doc);
		for (const ref of refs) {
			if (ref.startsWith("#")) {
				assert.ok(pointerExists(doc, ref.slice(1)), `${path.relative(repoRoot, file)}: local ref ${ref} does not resolve`);
				continue;
			}
			const [filePart, pointer] = ref.split("#");
			const target = path.resolve(path.dirname(file), filePart);
			assert.ok(fs.existsSync(target), `${path.relative(repoRoot, file)}: $ref ${ref} -> missing file ${filePart}`);
			if (pointer) {
				const targetDoc = parseYaml(fs.readFileSync(target, "utf8"));
				assert.ok(pointerExists(targetDoc, pointer), `${path.relative(repoRoot, file)}: pointer ${pointer} missing in ${filePart}`);
			}
		}
	}
});

// --- 3 + 4: root documents are valid OpenAPI / AsyncAPI roots ------------------

test("openapi.yaml is an OpenAPI 3.1 root with info and paths", () => {
	const doc = parseYaml(fs.readFileSync(path.join(specsDir, "api", "openapi.yaml"), "utf8"));
	assert.match(String(doc.openapi), /^3\.1\./, "openapi must be 3.1.x");
	assert.ok(doc.info && typeof doc.info.title === "string" && typeof doc.info.version === "string");
	assert.ok(doc.paths && typeof doc.paths === "object" && Object.keys(doc.paths).length > 0);
});

test("asyncapi.yaml is an AsyncAPI 3.x root with channels", () => {
	const doc = parseYaml(fs.readFileSync(path.join(specsDir, "async", "asyncapi.yaml"), "utf8"));
	assert.match(String(doc.asyncapi), /^3\./, "asyncapi must be 3.x");
	assert.ok(doc.info && typeof doc.info.title === "string");
	assert.ok(doc.channels && typeof doc.channels === "object" && Object.keys(doc.channels).length > 0);
});

// --- 5: Gherkin well-formedness (zero files allowed for now) -------------------

const featureFiles = findByExt(".feature");

test("feature files are well-formed", () => {
	for (const file of featureFiles) {
		const rel = path.relative(repoRoot, file);
		const content = fs.readFileSync(file, "utf8");
		const firstContentLine = content.split("\n").find((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
		assert.ok(firstContentLine && firstContentLine.trim().startsWith("Feature:"), `${rel} must start with Feature:`);
		assert.match(content, /^Scenario:|\nScenario:/, `${rel} must contain at least one Scenario:`);
	}
});

// --- 6: spectral config parses and extends the oas ruleset ---------------------

test("spectral.yaml parses and extends spectral:oas", () => {
	const doc = parseYaml(fs.readFileSync(path.join(repoRoot, "spectral.yaml"), "utf8"));
	assert.ok(Array.isArray(doc.extends), "extends must be a list");
	assert.ok(doc.extends.includes("spectral:oas"), "must extend spectral:oas");
	assert.ok(doc.rules && typeof doc.rules === "object", "custom rules must be declared");
});

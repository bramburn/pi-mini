// Ensure @earendil-works/pi-ai resolves for `npm test` on a fresh clone.
// pi-mini ships without node_modules (it runs inside pi's own module graph at
// runtime), but the test suites import pi-ai directly. When it isn't
// resolvable we junction node_modules/@earendil-works to the pi monorepo's
// node_modules. Override the search with PI_MONOREPO=<path to pi checkout>.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
	await import("@earendil-works/pi-ai");
	process.exit(0); // already resolvable
} catch {
	// not resolvable: fall through to linking
}

const candidates = [
	process.env.PI_MONOREPO ? path.join(process.env.PI_MONOREPO, "node_modules", "@earendil-works") : undefined,
	"C:/dev/pi/node_modules/@earendil-works",
	path.join(process.env.HOME ?? "", "pi", "node_modules", "@earendil-works"),
].filter(Boolean);

const target = candidates.find((dir) => fs.existsSync(path.join(dir, "pi-ai", "package.json")));
if (!target) {
	console.error("pi-mini test deps: @earendil-works/pi-ai is not resolvable and no pi monorepo was found.");
	console.error("Set PI_MONOREPO=<path to the pi checkout> (the directory containing node_modules/@earendil-works).");
	process.exit(1);
}

fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
try {
	fs.symlinkSync(target, path.join(root, "node_modules", "@earendil-works"), "junction");
	console.log(`pi-mini test deps: linked node_modules/@earendil-works -> ${target}`);
} catch (error) {
	if (error?.code !== "EEXIST") throw error;
}

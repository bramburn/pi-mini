// Pure /mini command parser, kept in its own module so plain-node tests can
// import it without pulling in index.ts's TUI-side import chain (picker.ts
// uses TS parameter properties that Node's strip-only mode rejects).
// index.ts imports and re-exports parseMiniCommand from here.

export type MiniGoalOp = "start" | "amend" | "cancel" | "status";

export interface ParsedMiniCommand {
	sub: "" | "on" | "off" | "tiny" | "large" | "status" | "settings";
	goal: { op: MiniGoalOp; text: string } | null;
}

/**
 * Pure /mini argument parser. Returns null for unknown input (callers show
 * the usage string). Objective/amend text keeps its original case;
 * subcommand matching is case-insensitive.
 */
export function parseMiniCommand(args: string): ParsedMiniCommand | null {
	const raw = (args ?? "").trim();
	const lower = raw.toLowerCase();
	if (!lower) return { sub: "", goal: null };
	if (lower === "on" || lower === "off" || lower === "tiny" || lower === "large" || lower === "status" || lower === "settings") {
		return { sub: lower, goal: null };
	}
	if (lower === "goal" || lower.startsWith("goal ")) {
		const restRaw = raw.replace(/^goal\s*/i, "").trim();
		const restLower = restRaw.toLowerCase();
		if (!restRaw) return { sub: "", goal: { op: "status", text: "" } };
		if (restLower === "cancel") return { sub: "", goal: { op: "cancel", text: "" } };
		if (restLower === "amend" || restLower.startsWith("amend ")) {
			return { sub: "", goal: { op: "amend", text: restLower === "amend" ? "" : restRaw.slice("amend".length).trim() } };
		}
		return { sub: "", goal: { op: "start", text: restRaw } };
	}
	return null;
}

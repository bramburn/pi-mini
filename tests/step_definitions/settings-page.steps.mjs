// Step skeletons for specs/features/settings-page/*.feature.
//
// These are BINDINGS ONLY: every step throws "pending" until the
// settings-page feature is implemented against pi's extension API
// (ctx.ui.custom overlay, ctx.ui.select fallback, ctx.ui.notify) and the
// settings.ts config surface. This file is intentionally NOT named
// *.test.* so node --test does not auto-discover it.
//
// Usage by a future Cucumber-style runner:
//   import { steps, runFeatureText } from "./settings-page.steps.mjs";
//   await runFeatureText(featureText);

function pending(step) {
	return () => {
		throw new Error(`pending: ${step}`);
	};
}

/**
 * Ordered [RegExp, handler] bindings. Handlers receive regex capture groups
 * and a world object the runner supplies (world.cfg, world.ui, world.ollama).
 */
export const steps = [
	// --- Background / given state ------------------------------------------------
	[/^pi-mini is installed$/, pending("pi-mini is installed")],
	[/^pi is running without a TUI$/, pending("pi is running without a TUI")],
	[/^the tiny model ollama-mini\/granite4\.2:8b is in the model registry$/, pending("tiny model in registry")],
	[/^a large model is configured$/, pending("a large model is configured")],
	[/^persisted config has enabled=(true|false)$/, pending("persisted config enabled flag")],
	[/^mini mode is (inactive|active)$/, pending("mini mode state")],
	[/^mini mode is active with a remembered previous model and tools$/, pending("mini mode with remembered state")],
	[/^the current tiny model is (.+)$/, pending("current tiny model")],
	[/^the model registry has providers (.+)$/, pending("registry providers")],
	[/^Ollama serves (\d+) local models$/, pending("Ollama serves N local models")],
	[/^Ollama is reachable$/, pending("Ollama reachable")],
	[/^Ollama is unreachable$/, pending("Ollama unreachable")],
	[/^GET \/api\/tags returns models? (.+)$/, pending("GET /api/tags returns models")],
	[/^GET \/api\/tags returns only "([^"]+)"$/, pending("GET /api/tags returns only")],
	[/^the registry has (ollama-mini|llama-cpp|ollama) model "([^"]+)"$/, pending("registry has model")],
	[/^an entry with provider "([^"]+)" and source "([^"]+)"$/, pending("picker entry classification input")],
	[/^the tiny model is (.+)$/, pending("tiny model is")],
	[/^think is (true|false)$/, pending("think flag")],
	[/^toolsMode is "([^"]+)"$/, pending("toolsMode")],
	[/^delegateBudget is (\d+)$/, pending("delegateBudget")],
	[/^the config file contains "([^"]+)" set to (.+)$/, pending("config file field value")],
	[/^the config file contains "\{not json"$/, pending("malformed config file")],
	[/^the config file contains the legacy tiny ref (.+)$/, pending("legacy tiny ref")],
	[/^the config file predates the enabled field$/, pending("config predates enabled")],
	[/^the user disabled pi-mini from the settings page$/, pending("disabled from settings page")],
	[/^the picker is open(?: with (\d+) local models)?$/, pending("picker open")],
	[/^the tiny-model fallback select is open$/, pending("fallback select open")],

	// --- Actions -----------------------------------------------------------------
	[/^the user runs "([^"]*)"$/, pending("user runs command")],
	[/^the user runs "([^"]*)" and chooses "([^"]*)"$/, pending("user runs command and chooses")],
	[/^the user opens the tiny-model picker(?: from "([^"]*)")?$/, pending("open tiny-model picker")],
	[/^the user chooses "([^"]*)" in "([^"]*)"$/, pending("user chooses in command")],
	[/^the user chooses "([^"]*)" from the select menu$/, pending("user chooses from select menu")],
	[/^the user types "([^"]*)"$/, pending("user types query")],
	[/^the user moves the selection down (\d+) times$/, pending("user moves selection")],
	[/^the user presses "(up|down|Enter|Escape)"$/, pending("user presses key")],
	[/^the user navigates to "([^"]+)"$/, pending("user navigates to row")],
	[/^the user confirms "([^"]+)"$/, pending("user confirms row")],
	[/^the user confirms the current model "([^"]+)"$/, pending("user confirms current model")],
	[/^the user cancels the select$/, pending("user cancels select")],
	[/^a new pi session starts$/, pending("new pi session starts")],
	[/^pi restarts$/, pending("pi restarts")],
	[/^the config is (loaded|reloaded)$/, pending("config load")],

	// --- Assertions ---------------------------------------------------------------
	[/^the settings menu opens(?: as an overlay)?$/, pending("settings menu opens")],
	[/^a select menu is offered via ctx\.ui\.select$/, pending("select menu offered")],
	[/^the options include "([^"]+)"$/, pending("options include")],
	[/^the options include the tiny model entry$/, pending("options include tiny model entry")],
	[/^the first option reads "([^"]+)"$/, pending("first option label")],
	[/^the second option reads "([^"]+)"$/, pending("second option label")],
	[/^the second option shows the active tiny model ref$/, pending("second option shows tiny ref")],
	[/^the menu contains a model-list entry for browsing local models$/, pending("menu has model-list entry")],
	[/^a notification shows "([^"]*)"$/, pending("notification text")],
	[/^ctx\.ui\.notify is called with a warning about unreachable Ollama$/, pending("notify Ollama warning")],
	[/^no config change is made$/, pending("no config change")],
	[/^mini mode is (active|inactive)$/, pending("mini mode result")],
	[/^mini mode activates automatically with the configured tiny model$/, pending("auto activation")],
	[/^the session model switches to the tiny model$/, pending("session model switches")],
	[/^the active tools become the curated set plus delegate_to_worker$/, pending("active tools become curated")],
	[/^the status line shows the MINI summary$/, pending("status line MINI")],
	[/^the previous session model is restored$/, pending("previous model restored")],
	[/^the previous tool set is restored$/, pending("previous tools restored")],
	[/^a notification confirms pi-mini is enabled$/, pending("notify enabled")],
	[/^a notification reports pi-mini is enabled again without duplicating state$/, pending("notify re-enabled")],
	[/^a notification confirms the tiny model change$/, pending("notify tiny change")],
	[/^a warning notification mentions Ollama is unreachable$/, pending("warning Ollama unreachable")],
	[/^a warning notes think:false, wrap-fix, and the stall watchdog only apply to ollama-mini models$/, pending("warning native pipeline")],
	[/^the picker shows "([^"]+)" sourced from (ollama-tags|registry)$/, pending("picker shows entry")],
	[/^every entry has source "([^"]+)" or "([^"]+)"$/, pending("entry sources")],
	[/^no entry has a remote provider$/, pending("no remote entries")],
	[/^the entry is (included as local|excluded as remote)$/, pending("classification result")],
	[/^registry-only entries are marked not pulled$/, pending("registry entries not pulled")],
	[/^the picker lists registry local entries only$/, pending("registry-only list")],
	[/^the picker shows no ollama-tags entries$/, pending("no ollama-tags entries")],
	[/^persisted config tiny is (.+)$/, pending("persisted tiny ref")],
	[/^persisted config tiny is unchanged$/, pending("persisted tiny unchanged")],
	[/^the config file mtime is unchanged$/, pending("config mtime unchanged")],
	[/^the picker closes$/, pending("picker closes")],
	[/^the first row is the current model marked with "✓"$/, pending("current row checkmark")],
	[/^the list is sorted current-model-first then provider alphabetical$/, pending("list sort order")],
	[/^the visible rows are "([^"]*)"$/, pending("visible rows after query")],
	[/^at most (\d+) rows are visible at any time$/, pending("max visible rows")],
	[/^the visible window is centered on the selection$/, pending("window centered")],
	[/^the position indicator shows "\((\d+)\/(\d+)\)"$/, pending("position indicator")],
	[/^the selection is at index (\d+)$/, pending("selection index")],
	[/^the footer shows "Model Name:" for the selected row$/, pending("footer model name hint")],
	[/^the footer shows the type-to-search hint$/, pending("footer search hint")],
	[/^all fields retain their saved values$/, pending("round-trip values")],
	[/^the effective "([^"]+)" is (.+)$/, pending("effective field value")],
	[/^the effective config equals the defaults$/, pending("effective defaults")],
	[/^enabled is (true|false)$/, pending("enabled value")],
	[/^the tiny model is (.+)$/, pending("tiny model value")],
	[/^other fields are preserved$/, pending("other fields preserved")],
	[/^existing fields are preserved$/, pending("existing fields preserved")],
	[/^ctx\.ui\.select is called with only the local model labels$/, pending("select called with local labels")],
	[/^no remote provider label is offered$/, pending("no remote labels")],
	[/^the select offers registry local entries only$/, pending("select registry-only")],
	[/^no notification about a model change is shown$/, pending("no model-change notification")],
	[/^no model-change notification is shown$/, pending("no model-change notification")],
	[/^no config change is made$/, pending("no config change made")],
];

/**
 * Minimal runner: walks Gherkin text, matches each step line against
 * `steps`, and invokes the handler with (captures..., world). Unmatched
 * steps throw, so the skeleton fails loudly instead of silently skipping.
 * @param {string} featureText raw .feature content
 * @param {object} [world] shared state passed to handlers
 */
export async function runFeatureText(featureText, world = {}) {
	for (const rawLine of featureText.split("\n")) {
		const line = rawLine.trim();
		const kw = /^(Given|When|Then|And|But)\s+(.+)$/.exec(line);
		if (!kw) continue;
		const text = kw[2];
		const hit = steps.find(([re]) => re.test(text));
		if (!hit) throw new Error(`no step binding for: ${text}`);
		const captures = hit[0].exec(text).slice(1);
		await hit[1](...captures, world);
	}
}

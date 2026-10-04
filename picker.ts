import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatRef, type ModelRef } from "./settings.ts";

/** Theme type of the ui.custom() factory, derived since coding-agent does not export it. */
type PickerTheme = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>[1];

/**
 * /model-style fuzzy search picker over the available model catalogue.
 * Returns the chosen model ref, or undefined when cancelled.
 */
export async function pickModelRef(ctx: ExtensionContext, title: string): Promise<ModelRef | undefined> {
	const byLabel = new Map<string, ModelRef>();
	for (const model of ctx.modelRegistry.getAvailable()) {
		byLabel.set(formatRef({ provider: model.provider, modelId: model.id }), {
			provider: model.provider,
			modelId: model.id,
		});
	}
	const labels = [...byLabel.keys()];
	if (labels.length === 0) {
		ctx.ui.notify("No models available in the registry", "warning");
		return undefined;
	}
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		const chosen = await ctx.ui.select(title, labels);
		return chosen ? byLabel.get(chosen) : undefined;
	}
	const chosen = await ctx.ui.custom<string | undefined>(
		(_tui, theme, _keybindings, done) => new ModelPicker(theme, title, labels, done),
		{ overlay: true },
	);
	return chosen ? byLabel.get(chosen) : undefined;
}

const MAX_VISIBLE_ROWS = 12;

class ModelPicker extends Container {
	private readonly input = new Input();
	private readonly listBox = new Container();
	private filtered: string[];
	private selected = 0;

	constructor(
		private readonly theme: PickerTheme,
		private readonly title: string,
		private readonly items: string[],
		private readonly done: (result: string | undefined) => void,
	) {
		super();
		this.filtered = items;
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("accent", this.theme.bold(this.title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listBox);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("text", "type to filter  ↑↓ navigate  enter select  esc cancel"), 1, 0));
		this.addChild(new Spacer(1));

		this.input.onSubmit = () => this.confirm();
		this.input.onEscape = () => this.done(undefined);
		this.refreshList();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			this.input.handleInput(data);
			this.refilter();
		}
	}

	private move(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = Math.min(this.filtered.length - 1, Math.max(0, this.selected + delta));
		this.refreshList();
	}

	private confirm(): void {
		const chosen = this.filtered[this.selected];
		if (chosen) this.done(chosen);
	}

	private refilter(): void {
		const query = this.input.getValue();
		this.filtered = query ? fuzzyFilter(this.items, query, (item) => item) : this.items;
		this.selected = 0;
		this.refreshList();
	}

	private refreshList(): void {
		this.listBox.clear();
		const visible = this.filtered.slice(0, MAX_VISIBLE_ROWS);
		if (visible.length === 0) {
			this.listBox.addChild(new Text(this.theme.fg("text", "  (no matches)"), 1, 0));
			return;
		}
		for (let i = 0; i < visible.length; i++) {
			const isSelected = i === this.selected;
			const line = isSelected
				? this.theme.fg("accent", "→ ") + this.theme.fg("accent", visible[i])
				: `  ${this.theme.fg("text", visible[i])}`;
			this.listBox.addChild(new Text(line, 1, 0));
		}
		if (this.filtered.length > MAX_VISIBLE_ROWS) {
			this.listBox.addChild(
				new Text(this.theme.fg("text", `  … ${this.filtered.length - MAX_VISIBLE_ROWS} more`), 1, 0),
			);
		}
	}
}

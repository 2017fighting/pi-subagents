import { createHerdrInspectorPlugin } from "./herdr/plugin.ts";
import { createTmuxInspectorPlugin } from "./tmux/plugin.ts";
import { createGhosttyInspectorPlugin } from "./ghostty/plugin.ts";
import type { InspectorPlugin } from "./types.ts";

/** Built-in inspector plugins, ordered by host preference. */
export function createBuiltinInspectorPlugins(): readonly InspectorPlugin[] {
	// tmux outranks Ghostty because a tmux pane inside a Ghostty window reports both
	// hosts as available; the innermost host is the one the operator is looking at.
	return [createHerdrInspectorPlugin(), createTmuxInspectorPlugin(), createGhosttyInspectorPlugin()];
}

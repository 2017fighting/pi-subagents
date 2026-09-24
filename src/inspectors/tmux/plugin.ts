import { createTmuxClient, type TmuxClient } from "./client.ts";
import { closeTmuxInspector, openTmuxInspector, readTmuxInspectorBindingForTarget, statusTmuxInspector } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";

export interface TmuxPluginDeps {
	client?: TmuxClient;
}

export function createTmuxInspectorPlugin(deps: TmuxPluginDeps = {}): InspectorPlugin {
	const client = deps.client ?? createTmuxClient();
	return {
		name: "tmux",
		// TMUX is the only variable tmux always injects into a pane. A stale value
		// (server already gone) fails closed inside open, which is where the real
		// reachability evidence comes from; probing here would cost a spawn on the
		// Fleet keypress path.
		available: (context) => Boolean(context.env.TMUX?.trim()),
		owns: (context) => readTmuxInspectorBindingForTarget(context.target, context.env) !== undefined,
		open: (context, launch, params) => openTmuxInspector(context, launch, params, client),
		status: (context) => statusTmuxInspector(context, client),
		close: (context) => closeTmuxInspector(context, client),
	};
}

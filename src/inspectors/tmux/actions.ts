import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams, InspectorTarget } from "../types.ts";
import type { TmuxClient, TmuxError } from "./client.ts";

export interface TmuxInspectorBinding {
	schemaVersion: 1;
	kind: "tmux-inspector";
	runId: string;
	asyncDir: string;
	childIndex?: number;
	missionId?: string;
	missionPath?: string;
	paneId: string;
	sessionId: string;
	/** Server identity from TMUX; pane ids are only unique inside one server. */
	socketPath: string;
	serverPid: number;
	openedAt: string;
	lastFocusedAt?: string;
	command: string;
}

export function bindingPath(asyncDir: string, index?: number): string {
	return path.join(asyncDir, "inspectors", `tmux${index === undefined ? "" : `-${index}`}.json`);
}

function parse(value: unknown): TmuxInspectorBinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const binding = value as Partial<TmuxInspectorBinding>;
	if (binding.schemaVersion !== 1
		|| binding.kind !== "tmux-inspector"
		|| (binding.childIndex !== undefined && (!Number.isInteger(binding.childIndex) || binding.childIndex < 0))
		|| typeof binding.runId !== "string"
		|| typeof binding.asyncDir !== "string"
		|| typeof binding.paneId !== "string"
		|| typeof binding.sessionId !== "string"
		|| typeof binding.socketPath !== "string"
		|| !Number.isInteger(binding.serverPid)
		|| typeof binding.openedAt !== "string"
		|| typeof binding.command !== "string") return undefined;
	return binding as TmuxInspectorBinding;
}

export function readTmuxInspectorBinding(asyncDir: string, index?: number): TmuxInspectorBinding | undefined {
	try {
		return parse(JSON.parse(fs.readFileSync(bindingPath(asyncDir, index), "utf8")));
	} catch {
		return undefined;
	}
}

/**
 * Read a binding only when it belongs to the requested inspector target and to
 * the tmux server this process is running under. A restarted server reuses pane
 * ids, so a binding from a previous server must never be claimed.
 */
export function readTmuxInspectorBindingForTarget(target: InspectorTarget, env: NodeJS.ProcessEnv): TmuxInspectorBinding | undefined {
	const binding = readTmuxInspectorBinding(target.asyncDir, target.index);
	if (!binding || binding.runId !== target.runId || binding.childIndex !== target.index) return undefined;
	const server = parseTmuxEnv(env);
	if (!server || server.socketPath !== binding.socketPath || server.serverPid !== binding.serverPid) return undefined;
	try {
		if (fs.realpathSync(binding.asyncDir) !== fs.realpathSync(target.asyncDir)) return undefined;
	} catch {
		return undefined;
	}
	return binding;
}

export interface TmuxServerIdentity {
	socketPath: string;
	serverPid: number;
}

/** TMUX is "<socket path>,<server pid>,<session index>". */
export function parseTmuxEnv(env: NodeJS.ProcessEnv): TmuxServerIdentity | undefined {
	const raw = env.TMUX?.trim();
	if (!raw) return undefined;
	const [socketPath, serverPid] = raw.split(",");
	const pid = Number(serverPid);
	if (!socketPath || !Number.isInteger(pid) || pid <= 0) return undefined;
	return { socketPath, serverPid: pid };
}

function result(text: string, isError = false): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
		details: { mode: "management", results: [] },
	};
}

function errorText(error: TmuxError): string {
	return `Tmux inspector error (${error.code}): ${error.message}`;
}

interface LivePane {
	paneId: string;
	sessionId: string;
}

/**
 * Probe a pane in one spawn. An unknown pane id is not an error for tmux: it
 * exits 0 and expands every format to the empty string, so liveness has to
 * come from the format values. `pane_dead` is 1 when the process exited but
 * `remain-on-exit` kept the pane, which must not read as live either.
 */
async function probePane(client: TmuxClient, env: NodeJS.ProcessEnv, id: string, signal?: AbortSignal): Promise<LivePane | undefined> {
	const probe = await client.run(["display-message", "-p", "-t", id, "#{pane_id}|#{pane_dead}|#{session_id}"], { timeoutMs: 5_000, signal, env });
	if (!probe.ok) return undefined;
	const [paneId, dead, sessionId] = probe.data.split("|");
	if (!paneId?.trim() || dead !== "0" || !sessionId?.trim()) return undefined;
	return { paneId: paneId.trim(), sessionId: sessionId.trim() };
}

async function focusPane(client: TmuxClient, env: NodeJS.ProcessEnv, id: string, signal?: AbortSignal): Promise<TmuxError | undefined> {
	const selected = await client.run(["select-pane", "-t", id], { timeoutMs: 5_000, signal, env });
	return selected.ok ? undefined : selected.error;
}

export async function openTmuxInspector(
	context: InspectorContext,
	launch: InspectorLaunch,
	params: InspectorParams,
	client: TmuxClient,
): Promise<AgentToolResult<Details>> {
	const server = parseTmuxEnv(context.env);
	if (!server) {
		return result(`Tmux inspector error (VALIDATION_ERROR): TMUX is not set or is malformed; cannot identify the tmux server.`, true);
	}
	const sourcePane = context.env.TMUX_PANE?.trim();
	if (!sourcePane) {
		return result(`Tmux inspector error (VALIDATION_ERROR): TMUX_PANE is not set, so the source pane to split is unknown.`, true);
	}
	const existing = readTmuxInspectorBindingForTarget(context.target, context.env);
	if (existing) {
		const live = await probePane(client, context.env, existing.paneId, context.signal);
		if (live) {
			if (params.focus !== true) return result(`Tmux inspector pane ${existing.paneId} is already open for async run ${context.target.runId}.`);
			const focusError = await focusPane(client, context.env, existing.paneId, context.signal);
			if (focusError) return result(errorText(focusError), true);
			writeAtomicJson(bindingPath(context.target.asyncDir, context.target.index), { ...existing, lastFocusedAt: (context.now?.() ?? new Date()).toISOString() });
			return result(`Tmux inspector pane ${existing.paneId} is already open for async run ${context.target.runId}, and was focused.`);
		}
	}
	const cwd = context.target.status.cwd ?? context.cwd;
	// The command runs as a real argv vector, never as a shell string: tmux
	// spawns it directly, so shell metacharacters in paths stay literal.
	const split = await client.run([
		"split-window",
		"-t", sourcePane,
		"-d",
		"-P",
		"-F", "#{pane_id}|#{session_id}",
		"-c", cwd,
		launch.executable,
		...launch.argv,
	], { timeoutMs: 15_000, signal: context.signal, env: context.env });
	if (!split.ok) return result(errorText(split.error), true);
	const [paneId, sessionId] = split.data.split("|");
	if (!paneId?.trim() || !sessionId?.trim()) {
		return result(`Tmux inspector error (PANE_GONE): the tmux split returned no pane identity.`, true);
	}
	const opened = { paneId: paneId.trim(), sessionId: sessionId.trim() };
	// The pane can vanish immediately when the runner cannot start; that must
	// fail closed instead of leaving a binding that points at nothing.
	const live = await probePane(client, context.env, opened.paneId, context.signal);
	if (!live) {
		await client.run(["kill-pane", "-t", opened.paneId], { timeoutMs: 5_000, env: context.env });
		return result(`Tmux inspector error (PANE_GONE): pane ${opened.paneId} exited before the inspector started. Check that '${launch.executable}' runs in this environment.`, true);
	}
	const now = (context.now?.() ?? new Date()).toISOString();
	const binding: TmuxInspectorBinding = {
		schemaVersion: 1,
		kind: "tmux-inspector",
		runId: context.target.runId,
		asyncDir: context.target.asyncDir,
		...(context.target.index === undefined ? {} : { childIndex: context.target.index }),
		...(launch.mission ? { missionId: launch.mission.id, missionPath: launch.mission.path } : {}),
		paneId: live.paneId,
		sessionId: live.sessionId,
		socketPath: server.socketPath,
		serverPid: server.serverPid,
		openedAt: now,
		...(params.focus === true ? { lastFocusedAt: now } : {}),
		command: launch.displayCommand,
	};
	writeAtomicJson(bindingPath(context.target.asyncDir, context.target.index), binding);
	// The pane is open and recorded, so a failed focus reports rather than fails the open.
	const focusError = params.focus === true ? await focusPane(client, context.env, binding.paneId, context.signal) : undefined;
	const focusNote = focusError ? ` Focus failed (${focusError.code}): ${focusError.message}` : "";
	return result(`Opened read-only tmux inspector pane ${binding.paneId} for async run ${context.target.runId}. Closing the pane does not stop the run.\nControls inside the pane: steer <message>, stop, status.${focusNote}`);
}

export async function statusTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>> {
	const binding = readTmuxInspectorBindingForTarget(context.target, context.env);
	if (!binding) {
		return result(`No tmux inspector binding exists for async run ${context.target.runId}${context.target.index === undefined ? "" : ` child ${context.target.index}`}.`);
	}
	const live = await probePane(client, context.env, binding.paneId, context.signal);
	if (!live) {
		return result(`Tmux inspector pane ${binding.paneId} is gone for async run ${context.target.runId}.\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}\nRun state remains authoritative: ${context.target.status.state}.`, true);
	}
	return result(`Tmux inspector ${binding.paneId} is open for async run ${context.target.runId}.\nRun state: ${context.target.status.state}\nBinding: ${bindingPath(context.target.asyncDir, context.target.index)}`);
}

export async function closeTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>> {
	const binding = readTmuxInspectorBindingForTarget(context.target, context.env);
	if (!binding) return result(`No tmux inspector binding exists for async run ${context.target.runId}.`);
	const closed = await client.run(["kill-pane", "-t", binding.paneId], { timeoutMs: 10_000, signal: context.signal, env: context.env });
	if (!closed.ok && closed.error.code !== "PANE_GONE") return result(errorText(closed.error), true);
	fs.rmSync(bindingPath(context.target.asyncDir, context.target.index), { force: true });
	return result(`Closed tmux inspector pane ${binding.paneId} for async run ${context.target.runId}. The subagent run was not stopped.`);
}

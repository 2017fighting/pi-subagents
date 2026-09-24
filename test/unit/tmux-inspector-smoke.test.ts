import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { openTmuxInspector, readTmuxInspectorBinding, statusTmuxInspector, closeTmuxInspector } from "../../src/inspectors/tmux/actions.ts";
import { createTmuxClient } from "../../src/inspectors/tmux/client.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import type { InspectorContext, InspectorLaunch } from "../../src/inspectors/types.ts";

/**
 * Real-tmux smoke test. The unit tests prove what we hand to tmux; only a real
 * server can prove how tmux interprets it (in particular that the runner command
 * arrives as an argv vector and is never re-parsed as a shell string).
 *
 * It runs against a private server on a private socket, so it never touches the
 * operator's own tmux session. It skips when the tmux binary is unavailable
 * rather than failing, because tmux is not required to run pi-subagents.
 */
const tmuxAvailable = (() => {
	try {
		return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
})();

/** Always delete the caller's tmux routing keys unless the test supplies its own. */
function tmuxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.TMUX;
	delete env.TMUX_PANE;
	return { ...env, ...overrides };
}

function runTmux(server: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync("tmux", ["-L", server, ...args], { encoding: "utf8", env: tmuxEnv(env) });
	if (result.status !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}

function writeRun(root: string, id = "run-smoke"): string {
	const asyncDir = path.join(root, id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const status: AsyncStatus = {
		runId: id,
		mode: "single",
		state: "running",
		startedAt: Date.now() - 1_000,
		cwd: root,
		steps: [{ agent: "worker", status: "running", recentOutput: ["working"] }],
	};
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
	return asyncDir;
}

function contextFor(env: NodeJS.ProcessEnv, asyncDir: string, cwd: string): InspectorContext {
	return { cwd, env, target: { runId: "run-smoke", asyncDir, status: { cwd, state: "running", steps: [] } } };
}

describe("tmux inspector against a real tmux server", { skip: tmuxAvailable ? false : "tmux binary is not available" }, () => {
	it("splits, reports, focuses, and closes a real pane without shell re-parsing", async () => {
		const server = `pi-subagent-smoke-${process.pid}`;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-smoke-"));
		try {
			// Long-lived source session; the private socket keeps this invisible.
			runTmux(server, ["new-session", "-d", "-s", "smoke", "-x", "80", "-y", "24", "sleep 300"]);
			const [socketPath, serverPid] = runTmux(server, ["display-message", "-p", "-t", "smoke", "#{socket_path}|#{pid}"]).split("|");
			const sourcePane = runTmux(server, ["display-message", "-p", "-t", "smoke", "#{pane_id}"]);
			assert.ok(socketPath && serverPid && sourcePane);
			const env = { TMUX: `${socketPath},${serverPid},0`, TMUX_PANE: sourcePane };

			// The launched program records the argv it actually received.
			const argvFile = path.join(root, "argv.txt");
			const dumpScript = path.join(root, "dump-argv.sh");
			fs.writeFileSync(dumpScript, `#!/bin/sh\n: > ${JSON.stringify(argvFile)}\nfor a in "$@"; do printf '[%s]\\n' "$a" >> ${JSON.stringify(argvFile)}; done\nsleep 5\n`, { mode: 0o755 });
			const payload = ["a;b", "$HOME", "x  y", "it's", "", "|pipe"];
			const asyncDir = writeRun(root);
			const launch: InspectorLaunch = {
				executable: dumpScript,
				argv: payload,
				displayCommand: `${dumpScript} ${payload.join(" ")}`,
				allowSteer: true,
				allowStop: true,
				sessionRoots: [],
			};

			const client = createTmuxClient();
			const context = contextFor(env, asyncDir, root);
			const opened = await openTmuxInspector(context, launch, {}, client);
			assert.notEqual(opened.isError, true);
			const binding = readTmuxInspectorBinding(asyncDir);
			assert.equal(binding?.kind, "tmux-inspector");
			assert.equal(binding?.socketPath, socketPath);
			assert.equal(Number(binding?.serverPid), Number(serverPid));

			// The real proof: tmux handed the argv vector through untouched.
			await new Promise((resolve) => setTimeout(resolve, 400));
			const received = fs.readFileSync(argvFile, "utf8").trimEnd().split("\n").map((line) => line.slice(1, -1));
			assert.deepEqual(received, payload);

			const live = await statusTmuxInspector(context, client);
			assert.notEqual(live.isError, true);
			assert.match(live.content[0]?.type === "text" ? live.content[0].text : "", /is open for async run run-smoke/);

			// focus really selects the pane, even from a background split.
			const focused = await openTmuxInspector(context, launch, { focus: true }, client);
			assert.match(focused.content[0]?.type === "text" ? focused.content[0].text : "", /was focused/);
			assert.equal(runTmux(server, ["display-message", "-p", "#{pane_id}"]), binding?.paneId);

			const closed = await closeTmuxInspector(context, client);
			assert.notEqual(closed.isError, true);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
			assert.equal(runTmux(server, ["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").includes(binding!.paneId), false);
		} finally {
			spawnSync("tmux", ["-L", server, "kill-server"], { encoding: "utf8", env: tmuxEnv() });
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

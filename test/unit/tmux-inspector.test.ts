import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { handleInspectorAction } from "../../src/inspectors/actions.ts";
import { createBuiltinInspectorPlugins } from "../../src/inspectors/plugins.ts";
import { bindingPath, readTmuxInspectorBinding, type TmuxInspectorBinding } from "../../src/inspectors/tmux/actions.ts";
import { createTmuxClient, type TmuxClient, type TmuxRunOptions } from "../../src/inspectors/tmux/client.ts";
import { createTmuxInspectorPlugin } from "../../src/inspectors/tmux/plugin.ts";
import { createGhosttyInspectorPlugin } from "../../src/inspectors/ghostty/plugin.ts";
import type { AsyncStatus } from "../../src/shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams } from "../../src/inspectors/types.ts";

const TMUX_ENV = { TMUX: "/tmp/tmux-0/default,4242,0", TMUX_PANE: "%7" };

function fakeChild(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean } {
	const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): boolean };
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => true;
	return child;
}

interface Call {
	args: string[];
	options: TmuxRunOptions | undefined;
}

interface FakeTmux {
	client: TmuxClient;
	calls: Call[];
}

/**
 * Scripted tmux double. `responses` are consumed in call order; a response is
 * either ok+stdout or a failure code. Calls are recorded so tests can assert on
 * the exact argv vector the plugin hands to tmux.
 */
function fakeTmux(script: Array<{ ok: true; data: string } | { ok: false; code: "PANE_GONE" | "TMUX_UNAVAILABLE" | "VALIDATION_ERROR" | "TIMEOUT"; message?: string }>): FakeTmux {
	const calls: Call[] = [];
	const client: TmuxClient = {
		run: async (args, options) => {
			calls.push({ args, options });
			const next = script.shift();
			if (!next) throw new Error(`Unexpected tmux call: ${args.join(" ")}`);
			if (next.ok) return { ok: true, data: next.data };
			return { ok: false, error: { code: next.code, message: next.message ?? "scripted failure" } };
		},
	};
	return { client, calls };
}

/** A live pane probe reply: pane id, not dead, session id present. */
function liveProbe(paneId = "%42", sessionId = "$0"): { ok: true; data: string } {
	return { ok: true, data: `${paneId}|0|${sessionId}` };
}

function writeRun(root: string, id = "run-123"): { asyncDir: string; status: AsyncStatus } {
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
	return { asyncDir, status };
}

function ctx(env: NodeJS.ProcessEnv = TMUX_ENV, asyncDir = "/tmp/run-123"): InspectorContext {
	return {
		cwd: "/tmp",
		env,
		target: {
			runId: "run-123",
			asyncDir,
			status: { cwd: "/tmp", state: "running", steps: [] },
		},
	};
}

function launch(): InspectorLaunch {
	return { executable: "node", argv: ["inspector-runner.mjs", "--run-id", "run-123"], displayCommand: "node inspector-runner.mjs --run-id run-123", allowSteer: true, allowStop: true, sessionRoots: [] };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("tmux inspector availability", () => {
	it("is available when TMUX is set and unavailable otherwise", async () => {
		const plugin = createTmuxInspectorPlugin({ client: fakeTmux([]).client });
		assert.equal(await plugin.available(ctx()), true);
		assert.equal(await plugin.available(ctx({})), false);
		assert.equal(await plugin.available(ctx({ TMUX: "   " })), false);
		assert.equal(await plugin.available(ctx({ TMUX: "/tmp/tmux-0/default,1,0" })), true);
	});

	it("takes over Ghostty when a tmux pane runs inside a Ghostty window", () => {
		// A tmux pane in a Ghostty window reports both hosts; the innermost one wins.
		const names = createBuiltinInspectorPlugins().map((plugin) => plugin.name);
		assert.deepEqual(names, ["herdr", "tmux", "ghostty"]);
		const ghostty = createGhosttyInspectorPlugin({ platform: "darwin", runner: async () => ({ stdout: "1.3.2", stderr: "" }) });
		assert.equal(ghostty.available(ctx({ TERM_PROGRAM: "ghostty", __CFBundleIdentifier: "com.mitchellh.ghostty" })), true);
		assert.equal(createTmuxInspectorPlugin({ client: fakeTmux([]).client }).available(ctx({ TERM_PROGRAM: "tmux", __CFBundleIdentifier: "com.mitchellh.ghostty", ...TMUX_ENV })), true);
	});
});

describe("tmux inspector open", () => {
	it("splits the source pane with a real argv vector and records a binding", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-inspector-"));
		try {
			const { asyncDir } = writeRun(root);
			const { client, calls } = fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe()]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.notEqual(opened.isError, true);
			assert.match(text(opened), /Opened read-only tmux inspector pane %42/);
			// split, then the liveness probe.
			assert.equal(calls.length, 2);
			assert.deepEqual(calls[0]?.args, [
				"split-window",
				"-t", "%7",
				"-d",
				"-P",
				"-F", "#{pane_id}|#{session_id}",
				"-c", "/tmp",
				"node",
				"inspector-runner.mjs", "--run-id", "run-123",
			]);
			// The runner command must arrive as separate argv entries, never as one
			// shell string: tmux spawns the vector directly and does not re-parse it.
			assert.ok(calls[0]?.args.every((arg) => arg !== launch().displayCommand));
			const binding = readTmuxInspectorBinding(asyncDir);
			assert.equal(binding?.kind, "tmux-inspector");
			assert.equal(binding?.paneId, "%42");
			assert.equal(binding?.sessionId, "$0");
			assert.equal(binding?.socketPath, "/tmp/tmux-0/default");
			assert.equal(binding?.serverPid, 4242);
			assert.equal(binding?.command, launch().displayCommand);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("passes the caller's TMUX routing keys to every tmux call", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-env-"));
		try {
			const { asyncDir } = writeRun(root);
			// Every call has to carry the routing keys, otherwise the probe and the
			// close would silently address the operator's default server instead.
			const { client, calls } = fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe(), { ok: true, data: "" }, liveProbe(), { ok: true, data: "" }]);
			const plugin = createTmuxInspectorPlugin({ client });
			await plugin.open(ctx(TMUX_ENV, asyncDir), launch(), { focus: true });
			await plugin.status!(ctx(TMUX_ENV, asyncDir));
			await plugin.close!(ctx(TMUX_ENV, asyncDir));
			assert.equal(calls.length, 5);
			for (const call of calls) {
				assert.equal(call.options?.env?.TMUX, TMUX_ENV.TMUX, `missing TMUX for: ${call.args.join(" ")}`);
				assert.equal(call.options?.env?.TMUX_PANE, TMUX_ENV.TMUX_PANE, `missing TMUX_PANE for: ${call.args.join(" ")}`);
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a split failure and writes no binding", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-split-fail-"));
		try {
			const { asyncDir } = writeRun(root);
			const { client } = fakeTmux([{ ok: false, code: "PANE_GONE", message: "can't find pane: %7" }]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /Tmux inspector error \(PANE_GONE\)/);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed and leaves no binding when the pane dies before the inspector starts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-dead-pane-"));
		try {
			const { asyncDir } = writeRun(root);
			// Split reports a pane, but the probe shows an unknown pane (empty formats).
			const { client, calls } = fakeTmux([{ ok: true, data: "%42|$0" }, { ok: true, data: "||" }, { ok: true, data: "" }]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /PANE_GONE/);
			assert.match(text(opened), /exited before the inspector started/);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
			// The half-open pane is reaped instead of being leaked.
			assert.deepEqual(calls[2]?.args, ["kill-pane", "-t", "%42"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a remain-on-exit pane as dead", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-remain-"));
		try {
			const { asyncDir } = writeRun(root);
			// pane_dead=1: the process exited but tmux kept the pane alive.
			const { client } = fakeTmux([{ ok: true, data: "%42|$0" }, { ok: true, data: "%42|1|$0" }, { ok: true, data: "" }]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /PANE_GONE/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed without TMUX_PANE instead of guessing a source pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-no-pane-"));
		try {
			const { asyncDir } = writeRun(root);
			const { client, calls } = fakeTmux([]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx({ TMUX: TMUX_ENV.TMUX }, asyncDir), launch(), {});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /TMUX_PANE is not set/);
			assert.equal(calls.length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("is idempotent for a live pane and focuses only when asked", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-idempotent-"));
		try {
			const { asyncDir } = writeRun(root);
			const binding: TmuxInspectorBinding = {
				schemaVersion: 1,
				kind: "tmux-inspector",
				runId: "run-123",
				asyncDir,
				paneId: "%42",
				sessionId: "$0",
				socketPath: "/tmp/tmux-0/default",
				serverPid: 4242,
				openedAt: new Date().toISOString(),
				command: "node x",
			};
			fs.mkdirSync(path.dirname(bindingPath(asyncDir)), { recursive: true });
			fs.writeFileSync(bindingPath(asyncDir), JSON.stringify(binding), "utf-8");

			const first = fakeTmux([liveProbe()]);
			const reopened = await createTmuxInspectorPlugin({ client: first.client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.notEqual(reopened.isError, true);
			assert.match(text(reopened), /already open/);
			assert.equal(first.calls.length, 1);

			const focused = fakeTmux([liveProbe(), { ok: true, data: "" }]);
			const refocused = await createTmuxInspectorPlugin({ client: focused.client }).open(ctx(TMUX_ENV, asyncDir), launch(), { focus: true });
			assert.match(text(refocused), /was focused/);
			assert.deepEqual(focused.calls[1]?.args, ["select-pane", "-t", "%42"]);
			assert.equal(readTmuxInspectorBinding(asyncDir)?.lastFocusedAt !== undefined, true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reopens when the recorded pane is gone", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-stale-"));
		try {
			const { asyncDir } = writeRun(root);
			fs.mkdirSync(path.dirname(bindingPath(asyncDir)), { recursive: true });
			fs.writeFileSync(bindingPath(asyncDir), JSON.stringify({
				schemaVersion: 1, kind: "tmux-inspector", runId: "run-123", asyncDir,
				paneId: "%9", sessionId: "$0", socketPath: "/tmp/tmux-0/default", serverPid: 4242,
				openedAt: new Date().toISOString(), command: "node x",
			}), "utf-8");
			// Probe of the stale pane is empty, then a fresh split and probe.
			const { client, calls } = fakeTmux([{ ok: true, data: "||" }, { ok: true, data: "%43|$0" }, liveProbe("%43")]);
			const opened = await createTmuxInspectorPlugin({ client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			assert.match(text(opened), /Opened read-only tmux inspector pane %43/);
			assert.equal(readTmuxInspectorBinding(asyncDir)?.paneId, "%43");
			assert.equal(calls[1]?.args[0], "split-window");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not claim a binding written by another tmux server", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-other-server-"));
		try {
			const { asyncDir } = writeRun(root);
			fs.mkdirSync(path.dirname(bindingPath(asyncDir)), { recursive: true });
			fs.writeFileSync(bindingPath(asyncDir), JSON.stringify({
				schemaVersion: 1, kind: "tmux-inspector", runId: "run-123", asyncDir,
				paneId: "%42", sessionId: "$0", socketPath: "/tmp/tmux-0/default", serverPid: 4242,
				openedAt: new Date().toISOString(), command: "node x",
			}), "utf-8");
			// A restarted server has a new pid, so pane %42 may now belong to someone else.
			const plugin = createTmuxInspectorPlugin({ client: fakeTmux([]).client });
			assert.equal(plugin.owns(ctx({ TMUX: "/tmp/tmux-0/default,9999,0", TMUX_PANE: "%7" }, asyncDir)), false);
			assert.equal(plugin.owns(ctx(TMUX_ENV, asyncDir)), true);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("tmux inspector status and close", () => {
	it("reports a live pane and a gone pane differently", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-status-"));
		try {
			const { asyncDir } = writeRun(root);
			const plugin = createTmuxInspectorPlugin({ client: fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe()]).client });
			await plugin.open(ctx(TMUX_ENV, asyncDir), launch(), {});

			const live = createTmuxInspectorPlugin({ client: fakeTmux([liveProbe()]).client });
			const liveStatus = await live.status!(ctx(TMUX_ENV, asyncDir));
			assert.notEqual(liveStatus.isError, true);
			assert.match(text(liveStatus), /is open for async run run-123/);
			assert.match(text(liveStatus), /Run state: running/);

			const gone = createTmuxInspectorPlugin({ client: fakeTmux([{ ok: true, data: "||" }]).client });
			const goneStatus = await gone.status!(ctx(TMUX_ENV, asyncDir));
			assert.equal(goneStatus.isError, true);
			assert.match(text(goneStatus), /is gone for async run run-123/);
			// Stale evidence is preserved for the operator to inspect.
			assert.equal(readTmuxInspectorBinding(asyncDir)?.paneId, "%42");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes the pane, removes the binding, and tolerates an already-gone pane", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-close-"));
		try {
			const { asyncDir } = writeRun(root);
			await createTmuxInspectorPlugin({ client: fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe()]).client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});

			const { client, calls } = fakeTmux([{ ok: true, data: "" }]);
			const closed = await createTmuxInspectorPlugin({ client }).close!(ctx(TMUX_ENV, asyncDir));
			assert.notEqual(closed.isError, true);
			assert.deepEqual(calls[0]?.args, ["kill-pane", "-t", "%42"]);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);

			await createTmuxInspectorPlugin({ client: fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe()]).client }).open(ctx(TMUX_ENV, asyncDir), launch(), {});
			const twice = await createTmuxInspectorPlugin({ client: fakeTmux([{ ok: false, code: "PANE_GONE", message: "can't find pane: %42" }]).client }).close!(ctx(TMUX_ENV, asyncDir));
			assert.notEqual(twice.isError, true);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("tmux client", () => {
	it("classifies missing binaries, timeouts, and gone panes", async () => {
		const missing = createTmuxClient({ spawn: (() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }) as never });
		const missingResult = await missing.run(["-V"]);
		assert.equal(missingResult.ok, false);
		if (!missingResult.ok) {
			assert.equal(missingResult.error.code, "TMUX_UNAVAILABLE");
			assert.match(missingResult.error.message, /TMUX_BIN/);
		}

		const timeout = createTmuxClient({ spawn: (() => fakeChild()) as never });
		const timeoutResult = await timeout.run(["display-message"], { timeoutMs: 5 });
		assert.equal(timeoutResult.ok, false);
		if (!timeoutResult.ok) assert.equal(timeoutResult.error.code, "TIMEOUT");

		const gone = createTmuxClient({ spawn: (() => {
			const child = fakeChild();
			queueMicrotask(() => {
				child.stderr.end("can't find pane: %9\n");
				child.emit("close", 1);
			});
			return child;
		}) as never });
		const goneResult = await gone.run(["kill-pane", "-t", "%9"]);
		assert.equal(goneResult.ok, false);
		if (!goneResult.ok) assert.equal(goneResult.error.code, "PANE_GONE");
	});

	it("routes the client through the caller's server and trims stdout", async () => {
		const spawned: Array<{ env: NodeJS.ProcessEnv }> = [];
		const client = createTmuxClient({
			spawn: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
				spawned.push({ env: options.env });
				const child = fakeChild();
				queueMicrotask(() => {
					child.stdout.end("%42|$0\n");
					child.emit("close", 0);
				});
				return child;
			}) as never,
		});
		const result = await client.run(["display-message"], { env: TMUX_ENV });
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.data, "%42|$0");
		assert.equal(spawned[0]?.env.TMUX, TMUX_ENV.TMUX);
		// PATH survives, otherwise the tmux binary itself would not resolve.
		assert.equal(spawned[0]?.env.PATH, process.env.PATH);
	});

	it("drops stale TMUX keys when the caller has no tmux environment", async () => {
		const spawned: Array<{ env: NodeJS.ProcessEnv }> = [];
		const client = createTmuxClient({
			spawn: ((_command: string, _args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
				spawned.push({ env: options.env });
				const child = fakeChild();
				queueMicrotask(() => { child.stdout.end(""); child.emit("close", 0); });
				return child;
			}) as never,
		});
		await client.run(["-V"], { env: { TMUX: "  " } });
		assert.equal("TMUX" in (spawned[0]?.env ?? {}), false);
		assert.equal("TMUX_PANE" in (spawned[0]?.env ?? {}), false);
	});
});

describe("tmux inspector through the dispatcher", () => {
	it("opens through handleInspectorAction and routes status/close to the owning plugin", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-dispatch-"));
		try {
			const { asyncDir } = writeRun(root);
			const openClient = fakeTmux([{ ok: true, data: "%42|$0" }, liveProbe()]).client;
			const opened = await handleInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				env: TMUX_ENV,
				plugins: [createTmuxInspectorPlugin({ client: openClient })],
			});
			assert.notEqual(opened.isError, true);
			assert.match(text(opened), /Opened read-only tmux inspector pane/);

			const status = await handleInspectorAction("inspector.status", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				env: TMUX_ENV,
				plugins: [createTmuxInspectorPlugin({ client: fakeTmux([liveProbe()]).client })],
			});
			assert.notEqual(status.isError, true);
			assert.match(text(status), /is open for async run run-123/);

			const closed = await handleInspectorAction("inspector.close", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				env: TMUX_ENV,
				plugins: [createTmuxInspectorPlugin({ client: fakeTmux([{ ok: true, data: "" }]).client })],
			});
			assert.notEqual(closed.isError, true);
			assert.equal(readTmuxInspectorBinding(asyncDir), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("still fails closed outside tmux", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tmux-outside-"));
		try {
			writeRun(root);
			const opened = await handleInspectorAction("inspector.open", { id: "run-123" }, {
				cwd: root,
				asyncDirRoot: root,
				env: { TERM_PROGRAM: "xterm-256color" },
				plugins: createBuiltinInspectorPlugins(),
			});
			assert.equal(opened.isError, true);
			assert.match(text(opened), /No inspector plugin is available/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

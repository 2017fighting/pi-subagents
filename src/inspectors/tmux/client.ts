import { spawn } from "node:child_process";

export type TmuxErrorCode = "TMUX_UNAVAILABLE" | "PANE_GONE" | "TIMEOUT" | "VALIDATION_ERROR";

export interface TmuxError {
	code: TmuxErrorCode;
	message: string;
	details?: unknown;
}

export type TmuxResult<T> =
	| { ok: true; data: T }
	| { ok: false; error: TmuxError };

export interface TmuxRunOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Source of the TMUX and TMUX_PANE routing keys; every other variable stays on process.env. */
	env?: NodeJS.ProcessEnv;
}

export interface TmuxClient {
	/** Run one tmux client command and return its trimmed stdout. */
	run(args: string[], options?: TmuxRunOptions): Promise<TmuxResult<string>>;
}

type SpawnTmux = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; env: NodeJS.ProcessEnv }) => ReturnType<typeof spawn>;

const DEFAULT_TIMEOUT_MS = 15_000;

function error(code: TmuxErrorCode, message: string, details?: unknown): TmuxResult<never> {
	return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

function unavailableMessage(cause: unknown): string {
	const code = (cause as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return "tmux is not installed or is not on PATH. Install tmux or set TMUX_BIN.";
	return `Failed to run tmux: ${cause instanceof Error ? cause.message : String(cause)}`;
}

/**
 * A tmux client picks its server from TMUX, so the caller's value has to win.
 * Everything else stays on process.env, otherwise PATH would no longer resolve
 * the tmux binary when the caller passes a narrow environment.
 */
function tmuxSpawnEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["TMUX", "TMUX_PANE"]) {
		const value = env?.[key]?.trim();
		if (value) merged[key] = value;
		else delete merged[key];
	}
	return merged;
}

/** Map tmux's own stderr wording onto the small set of codes callers act on. */
function classify(stderr: string, exitCode: number): TmuxError {
	const line = stderr.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
	const message = line ?? `tmux exited with code ${exitCode}.`;
	if (/can't find (pane|session|window)/i.test(message)) return { code: "PANE_GONE", message };
	if (/no server running|error connecting to|lost server|no such file or directory/i.test(message)) return { code: "TMUX_UNAVAILABLE", message };
	return { code: "VALIDATION_ERROR", message, details: { exitCode } };
}

export function createTmuxClient(options: { bin?: string; spawn?: SpawnTmux } = {}): TmuxClient {
	const bin = options.bin ?? process.env.TMUX_BIN ?? "tmux";
	const spawnImpl = options.spawn ?? spawn;
	return {
		run(args, runOptions = {}) {
			return new Promise<TmuxResult<string>>((resolve) => {
				let child: ReturnType<typeof spawn>;
				try {
					child = spawnImpl(bin, args, { shell: false, windowsHide: true, env: tmuxSpawnEnv(runOptions.env) });
				} catch (cause) {
					resolve(error("TMUX_UNAVAILABLE", unavailableMessage(cause)));
					return;
				}
				let stdout = "";
				let stderr = "";
				let settled = false;
				const finish = (outcome: TmuxResult<string>) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					runOptions.signal?.removeEventListener("abort", abort);
					resolve(outcome);
				};
				const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
				const abort = () => {
					try { child.kill(); } catch {}
					finish(error("TIMEOUT", `tmux command '${args.join(" ")}' was aborted.`));
				};
				const timer = setTimeout(() => {
					try { child.kill(); } catch {}
					finish(error("TIMEOUT", `tmux command '${args.join(" ")}' timed out after ${timeoutMs}ms.`));
				}, timeoutMs);
				timer.unref?.();
				if (runOptions.signal?.aborted) abort();
				else runOptions.signal?.addEventListener("abort", abort, { once: true });
				child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
				child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
				child.on("error", (cause) => finish(error("TMUX_UNAVAILABLE", unavailableMessage(cause))));
				child.on("close", (exitCode) => {
					if (exitCode === 0) {
						finish({ ok: true, data: stdout.trim() });
						return;
					}
					finish({ ok: false, error: classify(stderr, exitCode ?? -1) });
				});
			});
		},
	};
}

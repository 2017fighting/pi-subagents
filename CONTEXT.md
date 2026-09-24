# pi-subagents

pi-subagents lets one Pi session delegate focused work to child agents with supervision, evidence, and control. The parent session stays the orchestrator and the decision maker.

## Language

**Inspector**:
A read-only mirror view of an existing async run. It never owns the run's lifecycle, and closing an inspector never stops the run.
_Avoid_: dashboard, monitor, viewer

**Inspector Target**:
The async run being mirrored, together with its async directory and optional child index.
_Avoid_: job, session, run reference

**Inspector Host**:
A terminal host that can carry an inspector pane, such as Herdr, Ghostty, or tmux. An inspector plugin's name is its host's name.
_Avoid_: backend, driver, terminal

**Inspector Plugin**:
The adapter for one inspector host. It reports whether it is available and whether it owns a target, and it opens the pane; status and close are optional.
_Avoid_: provider, integration, handler

**Inspector Binding**:
The pane handle a plugin records for one inspector target, so that status and close have evidence to work from.
_Avoid_: state, record, lock

**available**:
Whether the current environment can carry an inspector pane at all.
_Avoid_: enabled, supported, detected

**owns**:
Whether a binding already exists for this inspector target.
_Avoid_: claims, handles, matches

**Fleet inspector**:
The interactive TUI over current-session and recent runs, opened by `/subagents-fleet`. It is not an inspector in the sense above.
_Avoid_: inspector, FleetView

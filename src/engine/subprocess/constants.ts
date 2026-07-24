/** How long a resolution decision stays cached before it is retried,
letting the extension self-heal from a change in the environment without
the user touching a setting or restarting: `runner.ts`'s
`resolveDjlintCommandCached()` re-probes a resolved `{ command, version }`
after this window (picking up an in-place `pip install -U djlint`), and
`select.ts`'s `FallbackEngine` re-tries the primary engine for a
workspace-folder scope after this window (picking up a previously-missing
djLint becoming available, e.g. after `pip install djlint` or a venv
rebuild). Defined here, rather than in either of those modules, so both can
depend on it without depending on each other. 5 minutes balances self-healing
against re-probing (spawning a process, or attempting the primary engine) on
every format/lint call. */
export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

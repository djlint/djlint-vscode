/** How long a resolution decision stays cached before retry, letting the
extension self-heal from an environment change (e.g. `pip install djlint`,
a venv rebuild) without the user touching a setting or restarting. Shared
by `runner.ts`'s command cache and `select.ts`'s `FallbackEngine`. Defined
here so both can depend on it without depending on each other. 5 minutes
balances self-healing against re-probing on every format/lint call. */
export const RESOLUTION_TTL_MS = 5 * 60 * 1000;

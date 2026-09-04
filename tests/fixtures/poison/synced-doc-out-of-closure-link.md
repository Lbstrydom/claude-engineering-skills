# Persona-Test Consistency Mode — HTML Attribute Contract

> Authoritative spec for consumer-app frontend devs adopting consistency mode.
> Plan: [docs/plans/persona-test-consistency-mode.md](../plans/persona-test-consistency-mode.md).

POISON FIXTURE. This is `docs/reference/consistency-contract.md` as it stood at
`9f8674d8` — the exact shape wine-cellar-app reported as upstream 15da01b6, and
the exact shape `edad6090`'s href repair left in place.

The link above resolves in THIS repo, which is why review passed it twice. It
resolves nowhere in a consumer: `docs/reference/consistency-contract.md` is the
only `docs/` file the sync ships, so `../plans/…` has no target there at any
depth. `check-synced-doc-links.mjs` must refuse it rather than read the healthy
link TEXT and call the file clean, which is what the two token-based gates did.

A fenced sample must stay invisible to the gate — this one is here so the pill
also proves the fence exemption did not silently swallow the real link above:

```md
> Shared project context lives in [AGENTS.md](./AGENTS.md).
```

And an intra-`skills/` relative link is legal, because `.claude/skills/**`
mirrors `skills/**` at the same offset — but from `docs/reference/` there is no
such link to write, so nothing more is asserted here.

# setupius-claudius

My Claude Code setup: mods (Claude Code plugins that change its interface) kept under
version control.

## Mods

Each folder under `mods/` is one mod. To use one, copy it to `~/.claude/mods/<name>/`
and list that folder in `CLAUDE_CODE_PLUGIN_DIRS`. Interactive sessions reload it when
a turn ends. Claude Code lays its own API types in `<mod>/.claude-plugin/types/` when
it loads a mod (git ignores them), and each mod's `tsconfig.json` extends those types.

Check a mod with:

```
claude plugin validate mods/<name>
claude plugin test mods/<name>
npx -y -p typescript@5 tsc -p mods/<name> --noEmit   # once the types are laid
```

### usage-band

A band above the prompt. What needs you comes first, then the figures:

```
────────────────────────────────────────────────────────────────────────────────
◆ 5-hour limit 93% used, resets in 2h 14m
Context ████░░ 60%   5-hour ██████ 93% resets in 2h 14m   Week ████░░ 61%
Opus 5.5 (1M)   effort high   ≈ $3.42   PR #62 draft · checks failed   +1 more open PR
```

- **Warnings** appear only when they apply: a plan limit spent (extra usage is paying)
  or 90% used, and context 85% full.
- **Context** is measured against the auto-compact window (`autoCompactWindow`, the
  number `/context` uses), not the model's whole window. It is re-read after every
  slash command.
- **Meters** show bars from 90 columns, and token counts and reset times from 120
  (sooner for a limit that is filling up).
- **The model row** shows model, effort, billing when it isn't the plan, an estimated
  cost and this branch's PR with its checks. `p` opens the PR. When the row would be
  too wide it drops the other-PR count, then the PR title, then the cost.
- **Colour** comes from the theme only, and only on what needs you. `/usage-band`
  hides or shows the band.

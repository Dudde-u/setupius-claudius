/** A worktree: its local branch, and the upstream's name when that differs ('' if not). */
export type Tree = { path: string; branch: string; pushed: string; locked: boolean }
export type Pr = { number: number; title: string; branch: string; url: string; isDraft: boolean }

/** A session as the pane shows it, joined with the repo's worktrees and open PRs. */
export type SessionRow = {
  id: string
  name: string
  state: string
  detail: string
  updatedAt: string
  prs: Pr[]
  trees: Tree[]
  agents: number
  shells: number
  /** The session's last `owns:` line, without the `owns:`. */
  owns: string
  /** That line's `next:` part, or ''. */
  next: string
  /** Blocked, or its `next:` is the user's and a PR it names (or it owns) is still open. */
  needsYou: boolean
}

export type SessionsSnapshot = {
  main: string
  sessions: SessionRow[]
  unownedPrs: Pr[]
  unusedTrees: Tree[]
  fetchedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'sessions-pane': {
      snapshot: Shaped<SessionsSnapshot | null>
      /** Done sessions drawn in full rather than folded. */
      showDone: boolean
      /** The worktrees no session uses listed rather than counted. */
      showTrees: boolean
    }
  }
}

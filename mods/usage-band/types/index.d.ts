export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type UsageSnap = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  costUsd?: number
}
/** The window context is measured against: the auto-compact window when one is set. */
export type Compaction = { tokens: number; isModelLimit: boolean }
export type MiniPr = {
  number: number
  title: string
  branch: string
  url: string
  isDraft: boolean
  checks: 'pass' | 'fail' | 'pending' | 'none'
}
export type EffortState = { setting: string | null; sent: string | null }
export type PrFeed = { branch: string; prs: MiniPr[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      usage: Shaped<UsageSnap | null>
      compaction: Shaped<Compaction | null>
      model: string | null
      prs: Shaped<PrFeed | null>
      effort: Shaped<EffortState>
      tick: number
      isHidden: boolean
    }
  }
}

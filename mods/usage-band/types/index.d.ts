export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type UsageSnap = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  costUsd?: number
}
export type MiniPr = {
  number: number
  title: string
  branch: string
  isDraft: boolean
  checks: 'pass' | 'fail' | 'pending' | 'none'
}
export type EffortState = { setting: string | null; sent: string | null }
export type PrFeed = { branch: string; prs: MiniPr[]; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      usage: Shaped<UsageSnap | null>
      model: string | null
      prs: Shaped<PrFeed | null>
      effort: Shaped<EffortState>
      tick: number
      isHidden: boolean
    }
  }
}

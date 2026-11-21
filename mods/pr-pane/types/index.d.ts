export type Checks = 'pass' | 'fail' | 'pending' | 'none'
export type Pr = {
  number: number
  title: string
  branch: string
  url: string
  isDraft: boolean
  checks: Checks
  review: string
  updatedAt: string
}
export type PrSnapshot = {
  branch: string
  prs: Pr[]
  fetchedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-pane': { snapshot: Shaped<PrSnapshot | null> }
  }
}

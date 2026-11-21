import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checks, Pr, PrSnapshot } from '../types'

const PANE = 'pr-pane'
const TITLE = 'Pull requests'
const POLL_MS = 60_000

// Bump the shape tag when Pr's fields change: it drops what an older version stored.
const snapshot = atom({ plugin: 'pr-pane', key: 'snapshot' } as const, null, {
  shape: 'pr-snapshot-1',
})

type RawCheck = { conclusion?: string; state?: string; status?: string }
type RawPr = {
  number: number
  title: string
  headRefName: string
  url: string
  isDraft: boolean
  reviewDecision?: string
  updatedAt: string
  statusCheckRollup?: RawCheck[]
}

function summarise(rollup: RawCheck[] | undefined): Checks {
  if (!rollup || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const v = (c.conclusion || c.state || '').toUpperCase()
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(v)) return 'fail'
    if (v === '' || v === 'PENDING' || v === 'EXPECTED' || (c.status && c.status !== 'COMPLETED')) pending = true
  }
  return pending ? 'pending' : 'pass'
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

const CHECK_GLYPH: Record<Checks, { glyph: string; color?: string; label: string }> = {
  pass: { glyph: '✓', color: 'success', label: 'checks pass' },
  fail: { glyph: '✗', color: 'error', label: 'checks fail' },
  pending: { glyph: '…', color: 'warning', label: 'checks running' },
  none: { glyph: '·', label: 'no checks' },
}

let refreshing: Promise<void> | null = null

function refresh($: EngineInterface): Promise<void> {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const now = await $.clock.now()
      let branch = ''
      try {
        const b = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
        branch = b.exitCode === 0 ? b.stdout.trim() || '(detached)' : ''
      } catch {
        branch = ''
      }
      try {
        const r = await $.process.run(
          [
            'gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json',
            'number,title,headRefName,url,isDraft,reviewDecision,updatedAt,statusCheckRollup',
          ],
          { timeoutMs: 20_000 },
        )
        if (r.exitCode !== 0) {
          const msg = (r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`).slice(0, 160)
          await update($, snapshot, prev => ({ branch, prs: prev?.prs ?? [], fetchedAt: now, error: msg }))
          return
        }
        const raw = JSON.parse(r.stdout) as RawPr[]
        const prs: Pr[] = raw.map(p => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          url: p.url,
          isDraft: p.isDraft,
          checks: summarise(p.statusCheckRollup),
          review: p.reviewDecision ?? '',
          updatedAt: p.updatedAt,
        }))
        const next: PrSnapshot = { branch, prs, fetchedAt: now, error: null }
        await update($, snapshot, () => next)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await update($, snapshot, prev => ({ branch, prs: prev?.prs ?? [], fetchedAt: now, error: msg.slice(0, 160) }))
      }
    })().finally(() => {
      refreshing = null
    })
    return refreshing
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prs', description: 'Open the pull requests pane and refresh it' })
    void refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'prs' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced
        ? 'Pull requests pane opened.'
        : 'Pull requests pane is waiting for room (widen the terminal).',
    }
  })

  // Refresh right after anything that likely changed PR or branch state.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    const cmd = e.command
    if (/\bgh\s+pr\b|\bgit\s+(push|checkout|switch|merge|worktree)\b/.test(cmd)) void refresh($)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()

    if (snap === null) return <Text dimColor>Loading pull requests…</Text>

    const mine = snap.prs.find(p => p.branch === snap.branch)

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>branch </Text>
          <Text bold wrap="truncate-end">{snap.branch || 'unknown'}</Text>
        </Box>
        <Text dimColor>
          {mine ? `→ PR #${mine.number}` : 'no open PR for this branch'}
        </Text>
        <Text> </Text>
        {snap.error && <Text color="error" wrap="truncate-end">{snap.error}</Text>}
        {snap.prs.length === 0 && !snap.error && <Text dimColor>No open pull requests.</Text>}
        {snap.prs.map(p => {
          const c = CHECK_GLYPH[p.checks]
          const isMine = p.branch === snap.branch
          const review =
            p.review === 'APPROVED' ? ' · approved' : p.review === 'CHANGES_REQUESTED' ? ' · changes requested' : ''
          return (
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                <Button key={`open-${p.number}`} plain dimColor={!isMine} onPress={() => void $.process.run(['open', p.url])}>
                  #{p.number}
                </Button>
                <Text color={c.color} dimColor={!c.color}> {c.glyph} </Text>
                {p.isDraft && <Text color="subtle">draft </Text>}
                <Text bold={isMine} wrap="truncate-end">{p.title}</Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {'   '}{p.branch} · {c.label}{review} · {ago(p.updatedAt, now)}
              </Text>
            </Box>
          )
        })}
        <Box>
          <Button key="refresh" hotkey="r" onPress={() => void refresh($)}>Refresh</Button>
          <Text dimColor> checked {ago(new Date(snap.fetchedAt).toISOString(), now)}</Text>
        </Box>
      </Box>
    )
  })
}

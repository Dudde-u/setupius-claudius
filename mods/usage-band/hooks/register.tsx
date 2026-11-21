import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, SessionCost } from 'claude-code'

import type { Limit, MiniPr, PrFeed, UsageSnap } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null, { shape: 'usage-1' })
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const prs = atom({ plugin: 'usage-band', key: 'prs' } as const, null, { shape: 'prs-1' })
const effort = atom({ plugin: 'usage-band', key: 'effort' } as const, { setting: null, sent: null }, { shape: 'effort-1' })
// Bumped every minute so the reset countdowns stay current between turns.
const tick = atom({ plugin: 'usage-band', key: 'tick' } as const, 0)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

const PR_POLL_MS = 90_000

// Phosphor CRT palette, on its own dark screen so it reads the same in light and dark themes.
const SCREEN = '#0b120b'
const GREEN = '#33ff66'
const GREEN_DIM = '#1d6b36'
const AMBER = '#ffb000'
const RED = '#ff4a3d'

const LABELS: Record<string, string> = {
  five_hour: '5H',
  seven_day: 'WEEK',
  seven_day_opus: 'WK.OPUS',
  seven_day_sonnet: 'WK.SONNET',
  spend_limit: 'SPEND',
}

function snap(context: SessionContextUsage, rateLimits: SessionRateLimit[], cost?: SessionCost): UsageSnap {
  return {
    tokens: context.tokens,
    window: context.window,
    percent: context.percent,
    limits: rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    costUsd: cost?.usd,
  }
}

async function load($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  await update($, usage, () => snap(u.context, u.rateLimits, u.cost))
}

async function loadModel($: EngineInterface): Promise<void> {
  try {
    const m = await $.session.model()
    await update($, model, prev => (prev === m ? prev : m))
  } catch {
    // keep the last reading
  }
}

type SettingsFile = { effortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown }> }

async function readSettings($: EngineInterface, path: string): Promise<SettingsFile | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as SettingsFile
  } catch {
    return null
  }
}

function levelIn(file: SettingsFile | null, rawModel: string): string | null {
  if (!file) return null
  const id = rawModel.replace(/\[[^\]]*\]/g, '')
  const per = file.modelSettings
  if (per) {
    const hit = per[id] ?? per[rawModel] ?? Object.entries(per).find(([key]) => modelName(key) === modelName(id))?.[1]
    if (typeof hit?.effortLevel === 'string') return hit.effortLevel
  }
  return typeof file.effortLevel === 'string' ? file.effortLevel : null
}

// The configured effort: env, then the live /config row, then settings files (local > project > user).
// null means nothing is set, which the engine treats as auto (the model picks).
async function loadEffortSetting($: EngineInterface): Promise<void> {
  let setting: string | null = null
  try {
    const env = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    if (env) setting = env
    if (!setting) {
      const row = (await $.config.list()).find(r => /effort/i.test(r.key))
      if (row && typeof row.value === 'string' && row.value) setting = row.value
    }
    if (!setting) {
      const rawModel = (await read($, model)) ?? ''
      const home = await $.env.get('HOME')
      for (const path of ['.claude/settings.local.json', '.claude/settings.json', home ? `${home}/.claude/settings.json` : '']) {
        if (!path) continue
        const level = levelIn(await readSettings($, path), rawModel)
        if (level) {
          setting = level
          break
        }
      }
    }
  } catch {
    // keep whatever was found
  }
  const value = setting ? setting.toLowerCase() : null
  await update($, effort, prev => (prev.setting === value ? prev : { ...prev, setting: value }))
}

export function effortLabel(e: { setting: string | null; sent: string | null }): string {
  const sent = e.sent?.toUpperCase()
  const isAuto = e.setting === null || e.setting === 'auto' || e.setting === 'unset'
  if (isAuto) return sent ? `AUTO→${sent}` : 'AUTO'
  const set = e.setting!.toUpperCase()
  return sent && sent !== set ? `${set}→${sent}` : set
}

function effortTone(label: string): string {
  const level = label.split('→').pop() ?? ''
  return level === 'MAX' ? RED : level === 'XHIGH' ? AMBER : GREEN
}

type RawCheck = { conclusion?: string; state?: string; status?: string }

function checksOf(rollup: RawCheck[] | undefined): MiniPr['checks'] {
  if (!rollup || rollup.length === 0) return 'none'
  let pending = false
  for (const c of rollup) {
    const v = (c.conclusion || c.state || '').toUpperCase()
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(v)) return 'fail'
    if (v === '' || v === 'PENDING' || v === 'EXPECTED' || (c.status && c.status !== 'COMPLETED')) pending = true
  }
  return pending ? 'pending' : 'pass'
}

let fetchingPrs: Promise<void> | null = null

function loadPrs($: EngineInterface): Promise<void> {
  if (fetchingPrs) return fetchingPrs
  fetchingPrs = (async () => {
    let branch = ''
    try {
      const b = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
      branch = b.exitCode === 0 ? b.stdout.trim() : ''
    } catch {
      branch = ''
    }
    try {
      const r = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,isDraft,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (r.exitCode !== 0) {
        const msg = (r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`).slice(0, 120)
        await update($, prs, prev => ({ branch, prs: prev?.prs ?? [], error: msg }))
        return
      }
      const raw = JSON.parse(r.stdout) as {
        number: number
        title: string
        headRefName: string
        isDraft: boolean
        statusCheckRollup?: RawCheck[]
      }[]
      const feed: PrFeed = {
        branch,
        error: null,
        prs: raw.map(p => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          isDraft: p.isDraft,
          checks: checksOf(p.statusCheckRollup),
        })),
      }
      await update($, prs, () => feed)
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120)
      await update($, prs, prev => ({ branch, prs: prev?.prs ?? [], error: msg }))
    }
  })().finally(() => {
    fetchingPrs = null
  })
  return fetchingPrs
}

function k(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`
}

function pct3(p: number | undefined): string {
  return p === undefined ? '---%' : `${String(Math.min(999, Math.round(p))).padStart(3, '0')}%`
}

function tone(p: number): string {
  return p >= 90 ? RED : p >= 70 ? AMBER : GREEN
}

function countdown(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  const h = Math.floor(m / 60)
  // A delta (time left), never a clock time: Δ2h14m, Δ45m, Δ3d05h.
  if (h === 0) return `Δ${m}m`
  if (h < 24) return `Δ${h}h${String(m % 60).padStart(2, '0')}m`
  return `Δ${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`
}

// "claude-opus-5-5[1m]" → "OPUS 5.5 1M"; anything else, upper-cased as given.
export function modelName(raw: string | null): string {
  if (!raw) return '---'
  const ctx = /\[(\d+[km])\]/i.exec(raw)
  const base = raw.replace(/\[[^\]]*\]/g, '')
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base)
  const name = m ? `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}` : base
  return (name + (ctx ? ` ${ctx[1]}` : '')).toUpperCase()
}

export type Credits = { label: string; lamp: '●' | '○'; color: string }

// The engine reports no "extra usage" flag, so it is inferred:
// a subscription window at 100% while replies still come means extra-usage credits pay for them;
// no subscription windows at all means per-token (API) billing.
export function credits(u: UsageSnap): Credits {
  const plan = u.limits.filter(l => l.kind === 'five_hour' || l.kind.startsWith('seven_day'))
  const spend = u.limits.find(l => l.kind === 'spend_limit')
  if (plan.some(l => l.percentUsed >= 100)) return { label: 'BURNING', lamp: '●', color: RED }
  if (spend) return { label: `SPEND ${pct3(spend.percentUsed)}`, lamp: '●', color: tone(spend.percentUsed) }
  if (plan.length === 0) return { label: 'METERED', lamp: '●', color: AMBER }
  return { label: 'PLAN', lamp: '○', color: GREEN }
}

// Most important first: the session window, then weekly ones, then anything else.
function order(limits: Limit[]): Limit[] {
  const rank = (kind: string) => (kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : kind.startsWith('seven_day') ? 2 : 3)
  return [...limits].filter(l => l.kind !== 'spend_limit').sort((a, b) => rank(a.kind) - rank(b.kind))
}

type Meter = { key: string; label: string; pct?: number; detail: string }

function meters(u: UsageSnap, now: number): Meter[] {
  return [
    {
      key: 'ctx',
      label: 'CTX',
      pct: u.percent,
      detail: `${u.tokens === undefined ? '---' : k(u.tokens)}/${k(u.window)}`,
    },
    ...order(u.limits).map(l => ({
      key: l.kind,
      label: LABELS[l.kind] ?? l.kind.toUpperCase().replace(/_/g, '.'),
      pct: l.percentUsed,
      detail: countdown(l.resetsAt, now),
    })),
  ]
}

const CHECK: Record<MiniPr['checks'], { glyph: string; color: string }> = {
  pass: { glyph: '✓', color: GREEN },
  fail: { glyph: '✗', color: RED },
  pending: { glyph: '…', color: AMBER },
  none: { glyph: '·', color: GREEN_DIM },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-band', description: 'Show or hide the retro usage monitor' })
    await Promise.all([load($), loadModel($)])
    await loadEffortSetting($)
    void loadPrs($)
    $.clock.every(60_000, () => void update($, tick, n => n + 1))
    $.clock.every(PR_POLL_MS, () => void loadPrs($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => snap(e.context, e.rateLimits, e.cost))
    void loadModel($).then(() => loadEffortSetting($))
    return next(e)
  })

  // /model, /effort, /config (or anything else) may switch the model or effort between turns.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    void loadModel($).then(() => loadEffortSetting($))
    return result
  })

  // What each main-loop request actually goes out with: what auto picked, or a silent downgrade.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const sent = e.effort === undefined ? 'default' : String(e.effort)
      void update($, effort, prev => (prev.sent === sent ? prev : { ...prev, sent }))
    }
    return yield* next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (/\bgh\s+pr\b|\bgit\s+(push|checkout|switch|merge|worktree)\b/.test(e.command)) void loadPrs($)
    return result
  })

  on('command.run', { command: 'usage-band' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? 'Usage monitor shown.' : 'Usage monitor hidden. /usage-band brings it back.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null || (await read($, isHidden))) return next(e)
    await read($, tick) // subscribe so the countdowns redraw each minute
    const now = await $.clock.now()
    const mdl = modelName(await read($, model))
    const eff = effortLabel(await read($, effort))
    const feed = await read($, prs)
    // Whatever other bands draw goes first, so this monitor sits right on the prompt.
    const beneath = await next(e)

    const { Box, Text } = $.ui.resolve(e)
    const rows = meters(u, now)
    const cr = credits(u)
    const cost = u.costUsd === undefined ? '' : `$${u.costUsd.toFixed(2).padStart(6, '0')}`
    const openPrs = feed?.prs ?? []
    const cols = e.props.bodyColumns
    // Frame (2) + status row + meter row + PR row; leave room for the other bands.
    const isFull = cols >= 70 && e.props.maxRows >= 5 + 2

    if (!isFull) {
      const segW = cols >= 110 ? 10 : 6
      return (
        <Box flexDirection="column">
          {beneath}
          <Box backgroundColor={SCREEN} paddingX={1} flexWrap="wrap" columnGap={2}>
            <Text color={GREEN} weight="bold">{mdl}</Text>
            <Text color={effortTone(eff)}>EFF {eff}</Text>
            <Text color={cr.color}>{cr.lamp} {cr.label}</Text>
            {rows.map(m => (
              <Box key={m.key}>
                <Text color={GREEN_DIM}>[</Text>
                <Text color={GREEN} weight="bold">{m.label} </Text>
                <Text color={tone(m.pct ?? 0)}>{'█'.repeat(Math.round(((m.pct ?? 0) / 100) * segW))}</Text>
                <Text color={GREEN_DIM}>{'░'.repeat(segW - Math.round(((m.pct ?? 0) / 100) * segW))}</Text>
                <Text color={tone(m.pct ?? 0)} weight="bold"> {pct3(m.pct)}</Text>
                {m.detail && m.key !== 'ctx' && <Text color={GREEN_DIM}> {m.detail}</Text>}
                <Text color={GREEN_DIM}>]</Text>
              </Box>
            ))}
            {cost && <Text color={GREEN}>{cost}</Text>}
            {openPrs.length > 0 && (
              <Text color={GREEN}>
                PR {openPrs.map(p => `#${p.number}${CHECK[p.checks].glyph}`).join(' ')}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    // inner width = cols - frame(2) - padding(2). Meters sit side by side, sharing what is left for bars.
    const inner = cols - 4
    const GAP = 3
    const fixed = rows.reduce((sum, m) => sum + m.label.length + 1 + 2 + 5 + (m.detail ? 1 + m.detail.length : 0), 0)
    const barW = Math.max(4, Math.min(24, Math.floor((inner - fixed - GAP * (rows.length - 1)) / Math.max(1, rows.length))))

    // PRs on one row: the checked-out branch's PR first, with its title; the rest as chips, as many as fit.
    const head = openPrs.find(p => p.branch === feed?.branch)
    const others = openPrs.filter(p => p !== head)
    const titleW = head ? Math.max(12, Math.min(head.title.length, Math.floor(inner / 3))) : 0
    const headW = head ? 6 + (head.isDraft ? 6 : 0) + titleW + 7 + 2 : 0
    const chipRoom = inner - 4 - headW - 8
    const shown = others.slice(0, Math.max(0, Math.floor(chipRoom / 8)))
    const hiddenCount = others.length - shown.length
    const clip = (t: string, w: number) => (t.length > w ? t.slice(0, w - 1) + '…' : t)

    return (
      <Box flexDirection="column">
        {beneath}
        <Box flexDirection="column" borderStyle="double" borderColor={GREEN_DIM} backgroundColor={SCREEN} paddingX={1}>
          <Box columnGap={4} flexWrap="wrap">
            <Box>
              <Text color={GREEN_DIM}>MODEL </Text>
              <Text color={GREEN} weight="bold">{mdl}</Text>
            </Box>
            <Box>
              <Text color={GREEN_DIM}>EFFORT </Text>
              <Text color={effortTone(eff)} weight="bold">{eff}</Text>
            </Box>
            <Box>
              <Text color={GREEN_DIM}>CREDITS </Text>
              <Text color={cr.color} weight="bold">{cr.lamp} {cr.label}</Text>
            </Box>
            {cost && (
              <Box>
                <Text color={GREEN_DIM}>SESSION </Text>
                <Text color={GREEN}>{cost}</Text>
              </Box>
            )}
          </Box>
          <Box columnGap={GAP} flexWrap="wrap">
            {rows.map(m => {
              const p = m.pct ?? 0
              const filled = Math.max(0, Math.min(barW, Math.round((p / 100) * barW)))
              const c = tone(p)
              return (
                <Box key={m.key}>
                  <Text color={GREEN} weight="bold">{m.label} </Text>
                  <Text color={GREEN_DIM}>▕</Text>
                  <Text color={c}>{'█'.repeat(filled)}</Text>
                  <Text color={GREEN_DIM}>{'░'.repeat(barW - filled)}</Text>
                  <Text color={GREEN_DIM}>▏</Text>
                  <Text color={c} weight="bold"> {pct3(m.pct)}</Text>
                  {m.detail && <Text color={GREEN_DIM}> {m.detail}</Text>}
                </Box>
              )
            })}
            {u.limits.length === 0 && <Text color={GREEN_DIM}>LIMITS NO SIGNAL</Text>}
          </Box>
          <Box columnGap={2}>
            <Text color={GREEN} weight="bold">PRS</Text>
            {feed === null && <Text color={GREEN_DIM}>SCANNING…</Text>}
            {feed?.error && <Text color={RED} wrap="truncate-end">ERR {feed.error}</Text>}
            {feed && !feed.error && openPrs.length === 0 && <Text color={GREEN_DIM}>NONE OPEN</Text>}
            {head && (
              <Box>
                <Text color={GREEN} weight="bold">#{String(head.number).padStart(3, '0')} </Text>
                <Text color={CHECK[head.checks].color}>{CHECK[head.checks].glyph} </Text>
                {head.isDraft && <Text color={AMBER}>DRAFT </Text>}
                <Text color={GREEN}>{clip(head.title, titleW)}</Text>
                <Text color={GREEN} weight="bold"> ◀ HEAD</Text>
              </Box>
            )}
            {shown.map(p => (
              <Box key={`pr-${p.number}`}>
                <Text color={GREEN_DIM} weight="bold">#{String(p.number).padStart(3, '0')} </Text>
                <Text color={CHECK[p.checks].color}>{CHECK[p.checks].glyph}</Text>
              </Box>
            ))}
            {hiddenCount > 0 && <Text color={GREEN_DIM}>+{hiddenCount}</Text>}
          </Box>
        </Box>
      </Box>
    )
  })
}

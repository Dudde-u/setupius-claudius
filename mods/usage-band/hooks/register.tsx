import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, SessionCost } from 'claude-code'

import type { Compaction, Limit, MiniPr, PrFeed, UsageSnap } from '../types'

// What this session has left: context before it compacts, the plan's limits and when
// they reset, then the model, effort, cost and this branch's PR. Two rows when all is
// well; whatever needs you goes first, on a row of its own.
//
// Like the sessions pane: plain words, theme colours only, and colour only on what
// needs you (no grey, no fixed palette). Nothing is drawn for "fine" or "none".

const PLUGIN = 'usage-band'
const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null, { shape: 'usage-1' })
const compaction = atom({ plugin: 'usage-band', key: 'compaction' } as const, null, { shape: 'compaction-1' })
const model = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const prs = atom({ plugin: 'usage-band', key: 'prs' } as const, null, { shape: 'prs-2' })
const effort = atom({ plugin: 'usage-band', key: 'effort' } as const, { setting: null, sent: null }, { shape: 'effort-1' })
// Bumped every minute while a reset countdown is shown, so it stays current between turns.
const tick = atom({ plugin: 'usage-band', key: 'tick' } as const, 0)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

const PR_POLL_MS = 90_000
// A meter turns amber here, and red once a limit is spent.
const WARN_AT = 75
// A limit this full, or context this close to compacting, gets a row of its own.
const LIMIT_ALERT_AT = 90
const CONTEXT_ALERT_AT = 85

type Tone = 'warning' | 'error' | undefined

const LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Week',
  seven_day_opus: 'Week (Opus)',
  seven_day_sonnet: 'Week (Sonnet)',
  spend_limit: 'Spend',
}

function labelOf(kind: string): string {
  return LABELS[kind] ?? kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
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

// Writes only when something changed, so a turn that moved nothing redraws nothing.
let lastUsage = ''
async function setUsage($: EngineInterface, next: UsageSnap): Promise<void> {
  const json = JSON.stringify(next)
  if (json === lastUsage) return
  lastUsage = json
  await update($, usage, () => next)
}

async function load($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  await setUsage($, snap(u.context, u.rateLimits, u.cost))
}

// The window /context measures against: the auto-compact window when one is set (env,
// settings, per model), else the model's own limit. Estimated locally, no requests.
async function loadCompaction($: EngineInterface): Promise<void> {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!b || !(b.rawMaxTokens > 0)) return
    const next: Compaction = { tokens: b.rawMaxTokens, isModelLimit: b.autocompactSource === 'auto' }
    await update($, compaction, prev =>
      prev && prev.tokens === next.tokens && prev.isModelLimit === next.isModelLimit ? prev : next,
    )
  } catch {
    // keep the last reading; the meter falls back to the model's window
  }
}

async function loadModel($: EngineInterface): Promise<boolean> {
  try {
    const m = await $.session.model()
    const was = await read($, model)
    if (was === m) return false
    await update($, model, () => m)
    return true
  } catch {
    return false // keep the last reading
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

/** A model or effort switch (/model, /effort, /config) can move all three. */
async function reloadSetup($: EngineInterface, isCommand = false): Promise<void> {
  const changed = await loadModel($)
  await loadEffortSetting($)
  // Also retried until it reads: the breakdown can be missing before the session is bound,
  // and without it the meter would fall back to the model's (much larger) window.
  // A command (/config, /model) may move the window itself, so it always re-reads.
  if (isCommand || changed || !(await read($, compaction))) await loadCompaction($)
}

/** `high`; `auto (medium)` for what auto sent; `xhigh (sent high)` for a downgrade. */
export function effortLabel(e: { setting: string | null; sent: string | null }): string {
  const sent = e.sent?.toLowerCase()
  const isAuto = e.setting === null || e.setting === 'auto' || e.setting === 'unset'
  if (isAuto) return sent ? `auto (${sent})` : 'auto'
  const set = e.setting!.toLowerCase()
  return sent && sent !== set ? `${set} (sent ${sent})` : set
}

// The costly levels are marked, as a reminder rather than an alarm.
function effortTone(label: string): Tone {
  return /\b(max|xhigh)\)?$/.test(label) ? 'warning' : undefined
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
let lastPrs = ''

function loadPrs($: EngineInterface): Promise<void> {
  if (fetchingPrs) return fetchingPrs
  const put = async (feed: PrFeed) => {
    const json = JSON.stringify(feed)
    if (json === lastPrs) return
    lastPrs = json
    await update($, prs, () => feed)
  }
  fetchingPrs = (async () => {
    let branch = ''
    try {
      const b = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
      branch = b.exitCode === 0 ? b.stdout.trim() : ''
    } catch {
      branch = ''
    }
    const kept = (await read($, prs))?.prs ?? []
    try {
      const r = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--limit', '30', '--json', 'number,title,headRefName,url,isDraft,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (r.exitCode !== 0) {
        const msg = (r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`).slice(0, 120)
        return void (await put({ branch, prs: kept, error: msg }))
      }
      const raw = JSON.parse(r.stdout) as {
        number: number
        title: string
        headRefName: string
        url?: string
        isDraft: boolean
        statusCheckRollup?: RawCheck[]
      }[]
      await put({
        branch,
        error: null,
        prs: raw.map(p => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          url: p.url ?? '',
          isDraft: p.isDraft,
          checks: checksOf(p.statusCheckRollup),
        })),
      })
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 120)
      await put({ branch, prs: kept, error: msg })
    }
  })().finally(() => {
    fetchingPrs = null
  })
  return fetchingPrs
}

/** 84k, 200k, 1M, 1.5M. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(n / 1000)}k`
}

/** Time left, never a clock time: `2h 14m`, `45m`, `3d 5h`, `under a minute`. */
export function timeLeft(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const m = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (m < 1) return 'under a minute'
  const h = Math.floor(m / 60)
  if (h === 0) return `${m}m`
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

/** `s` cut to `n` columns, an ellipsis marking the cut. */
function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`
}

function toneOf(p: number): Tone {
  return p >= 100 ? 'error' : p >= WARN_AT ? 'warning' : undefined
}

// "claude-opus-5-5[1m]" → "Opus 5.5 (1M)"; anything else as given.
export function modelName(raw: string | null): string {
  if (!raw) return 'model unknown'
  const ctx = /\[(\d+[km])\]/i.exec(raw)
  const base = raw.replace(/\[[^\]]*\]/g, '')
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(base)
  const name = m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]}${m[3] ? '.' + m[3] : ''}` : base
  return name + (ctx ? ` (${ctx[1]!.toUpperCase()})` : '')
}

const isPlan = (l: Limit) => l.kind === 'five_hour' || l.kind.startsWith('seven_day')

/**
 * How replies are paid for, when it isn't simply "the plan". The engine has no "extra
 * usage" flag, so it is inferred: a plan window at 100% while replies still come means
 * extra usage pays; no plan windows at all means API (per-token) billing.
 */
export function billing(u: UsageSnap): { label: string; tone: Tone } | null {
  const plan = u.limits.filter(isPlan)
  if (plan.some(l => l.percentUsed >= 100)) return { label: 'on extra usage', tone: 'error' }
  if (plan.length === 0 && !u.limits.some(l => l.kind === 'spend_limit')) return { label: 'API billing', tone: undefined }
  return null
}

// The session window, then weekly ones, then anything else (a spend limit last).
function order(limits: Limit[]): Limit[] {
  const rank = (kind: string) =>
    kind === 'five_hour' ? 0 : kind === 'seven_day' ? 1 : kind.startsWith('seven_day') ? 2 : kind === 'spend_limit' ? 4 : 3
  return [...limits].sort((a, b) => rank(a.kind) - rank(b.kind))
}

/** Context as a share of the window it compacts at, which can be far below the model's. */
export function contextFill(u: UsageSnap, c: Compaction | null): { pct?: number; of: number } {
  const of = c?.tokens ?? u.window
  if (u.tokens === undefined) return { pct: c ? undefined : u.percent, of }
  return { pct: Math.round((u.tokens / of) * 100), of }
}

export type Alert = { key: string; text: string; tone: 'warning' | 'error' }

/** What needs you, most urgent first: a spent limit, one nearly spent, context nearly full. */
export function alerts(u: UsageSnap, c: Compaction | null, now: number): Alert[] {
  const out: Alert[] = []
  for (const l of order(u.limits)) {
    const left = timeLeft(l.resetsAt, now)
    const reset = left ? `, resets in ${left}` : ''
    const name = labelOf(l.kind)
    if (l.percentUsed >= 100) {
      out.push({
        key: `a-${l.kind}`,
        tone: 'error',
        text: isPlan(l) ? `${name} limit used up: extra usage is paying for replies${reset}` : `${name} limit reached${reset}`,
      })
    } else if (l.percentUsed >= LIMIT_ALERT_AT) {
      out.push({ key: `a-${l.kind}`, tone: 'warning', text: `${name} limit ${Math.round(l.percentUsed)}% used${reset}` })
    }
  }
  const ctx = contextFill(u, c)
  if (ctx.pct !== undefined && ctx.pct >= CONTEXT_ALERT_AT) {
    const why = c && !c.isModelLimit ? `auto-compacts at ${tokens(ctx.of)}` : 'near the model limit'
    out.push({ key: 'a-ctx', tone: 'warning', text: `Context ${Math.min(ctx.pct, 100)}% full, ${why}: /compact at a good break` })
  }
  // Spent before nearly spent, and at most two rows of them.
  return [...out.filter(a => a.tone === 'error'), ...out.filter(a => a.tone === 'warning')].slice(0, 2)
}

type Meter = { key: string; label: string; pct?: number; detail: string }

function meters(u: UsageSnap, c: Compaction | null, now: number): Meter[] {
  const ctx = contextFill(u, c)
  return [
    {
      key: 'ctx',
      label: 'Context',
      pct: ctx.pct,
      detail: u.tokens === undefined ? `of ${tokens(ctx.of)}` : `${tokens(u.tokens)} of ${tokens(ctx.of)}`,
    },
    ...order(u.limits).map(l => {
      const left = timeLeft(l.resetsAt, now)
      return { key: l.kind, label: labelOf(l.kind), pct: l.percentUsed, detail: left ? `resets in ${left}` : '' }
    }),
  ]
}

const CHECKS: Record<MiniPr['checks'], { text: string; tone: Tone } | null> = {
  pass: { text: 'checks passed', tone: undefined },
  fail: { text: 'checks failed', tone: 'error' },
  pending: { text: 'checks running', tone: 'warning' },
  none: null,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-band', description: 'Show or hide the usage band above the prompt' })
    await Promise.all([load($), loadModel($)])
    await Promise.all([loadEffortSetting($), loadCompaction($)])
    void loadPrs($)
    $.clock.every(60_000, async () => {
      const u = await read($, usage)
      if (u?.limits.some(l => l.resetsAt)) await update($, tick, n => n + 1)
    })
    $.clock.every(PR_POLL_MS, () => void loadPrs($))
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await setUsage($, snap(e.context, e.rateLimits, e.cost))
    void reloadSetup($)
    return next(e)
  })

  // /model, /effort, /config (or anything else) may switch the model or effort between turns.
  on('command.run', async ($, e, next) => {
    const result = await next(e)
    void reloadSetup($, true)
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
    return { text: hidden ? 'Usage band shown.' : 'Usage band hidden. /usage-band brings it back.' }
  })

  // This band sits right on the prompt, under any other plugin's rows.
  on('ui.render', { component: 'AbovePromptList' }, (_$, e, next) => {
    const rows = e.props.rows
    const at = rows.findIndex(r => r.plugin === PLUGIN)
    if (at < 0 || at === rows.length - 1) return next(e)
    return next({ ...e, props: { ...e.props, rows: [...rows.filter(r => r.plugin !== PLUGIN), rows[at]!] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null || (await read($, isHidden))) return next(e)
    await read($, tick) // subscribe so the countdowns redraw each minute
    const now = await $.clock.now()
    const c = await read($, compaction)
    const mdl = modelName(await read($, model))
    const eff = effortLabel(await read($, effort))
    const feed = await read($, prs)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    // Bars from 90 columns; below that the numbers alone. Details from 120.
    const barW = cols >= 130 ? 10 : cols >= 90 ? 6 : 0
    const isRoomy = cols >= 120
    const warn = alerts(u, c, now)
    const pay = billing(u)
    const cost = u.costUsd === undefined || u.costUsd === 0 ? '' : `≈ $${u.costUsd.toFixed(2)}`
    const openPrs = feed?.prs ?? []
    const head = openPrs.find(p => p.branch === feed?.branch)
    const others = openPrs.length - (head ? 1 : 0)
    const checks = head ? CHECKS[head.checks] : null
    const prLabel = head ? `PR #${head.number}${head.isDraft ? ' draft' : ''}` : ''
    const errText = feed?.error ? `PRs unavailable: ${feed.error}` : ''
    const othersText = others > 0 ? `+${others} more open PR${others === 1 ? '' : 's'}` : ''
    // The info row is kept to one line: what matters least gives way first.
    const GAP = 3
    let title = isRoomy && head ? ` ${cut(head.title, 40)}` : ''
    let showCost = !!cost
    let showOthers = !!othersText
    const rowLen = () =>
      [
        mdl,
        `effort ${eff}`,
        pay?.label ?? '',
        showCost ? cost : '',
        head ? `[${prLabel}]${title}${checks ? ` · ${checks.text}` : ''}` : '',
        showOthers ? othersText : '',
        errText,
      ]
        .filter(Boolean)
        .reduce((n, t, i) => n + t.length + (i ? GAP : 0), 0)
    if (rowLen() > cols) showOthers = false
    if (rowLen() > cols) title = ''
    if (rowLen() > cols) showCost = false
    const openUrl = (url: string) => void (url && $.process.run(['open', url]))

    const meter = (m: Meter) => {
      const p = Math.max(0, m.pct ?? 0)
      const tone = m.pct === undefined ? undefined : toneOf(p)
      const filled = Math.max(0, Math.min(barW, Math.round((Math.min(p, 100) / 100) * barW)))
      // A limit's reset shows when there's room, or when it's getting full.
      const showDetail = m.detail && (isRoomy || (m.key !== 'ctx' && p >= WARN_AT))
      return (
        <Box key={`m-${m.key}`}>
          <Text weight="bold">{`${m.label} `}</Text>
          {barW > 0 ? (
            <Box>
              <Text color={tone}>{'█'.repeat(filled)}</Text>
              <Text>{`${'░'.repeat(barW - filled)} `}</Text>
            </Box>
          ) : null}
          <Text color={tone} weight={tone ? 'bold' : undefined}>
            {m.pct === undefined ? '–' : `${Math.round(m.pct)}%`}
          </Text>
          {showDetail ? <Text>{` ${m.detail}`}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {/* A dim rule parting the band from the chat above it. */}
        <Text key="rule" dimColor wrap="truncate-end">
          {'─'.repeat(Math.max(1, cols))}
        </Text>
        {warn.map(a => (
          <Text key={a.key} color={a.tone} wrap="truncate-end">
            {`◆ ${a.text}`}
          </Text>
        ))}
        <Box columnGap={3} flexWrap="wrap">
          {meters(u, c, now).map(meter)}
        </Box>
        <Box columnGap={3} flexWrap="wrap">
          <Text weight="bold">{mdl}</Text>
          <Text color={effortTone(eff)}>{`effort ${eff}`}</Text>
          {pay ? <Text color={pay.tone}>{pay.label}</Text> : null}
          {showCost ? <Text>{cost}</Text> : null}
          {head ? (
            <Box key="head-pr">
              <Button key="open-head-pr" plain hotkey="p" onPress={() => openUrl(head.url)}>
                {prLabel}
              </Button>
              {title ? <Text wrap="truncate-end">{title}</Text> : null}
              {checks ? <Text color={checks.tone}>{` · ${checks.text}`}</Text> : null}
            </Box>
          ) : null}
          {showOthers ? <Text>{othersText}</Text> : null}
          {errText ? (
            <Text color="error" wrap="truncate-end">
              {errText}
            </Text>
          ) : null}
        </Box>
      </Box>
    )
  })
}

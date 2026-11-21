import { expect, test } from 'claude-code/testing'
import type { UsageUnit } from 'claude-code'
import { alerts, billing, contextFill, effortLabel, modelName, timeLeft, tokens } from './register'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const PRS = JSON.stringify([
  {
    headRefName: 'feature-dark-mode',
    isDraft: true,
    number: 62,
    url: 'https://github.com/o/r/pull/62',
    statusCheckRollup: [{ conclusion: 'FAILURE' }],
    title: 'Dark mode: a calmer palette for the editor, and a darker border',
  },
  { headRefName: 'other', isDraft: false, number: 70, url: 'https://github.com/o/r/pull/70', statusCheckRollup: [], title: 'Other' },
])
const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 24, bodyColumns: 140, scroll: { offset: 0, bodyRows: 23 }, view: {} },
} as const
const RUN = { isStdoutTruncated: false, isStderrTruncated: false }
const BASE = { window: 1_000_000, limits: [] as { kind: string; percentUsed: number; resetsAt?: string }[] }

// The drawn tree as rough text, one line per column Box child, for eyeballing widths.
type El = { type?: string; props?: Record<string, unknown>; children?: unknown }
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  const el = node as El
  if (!el || typeof el !== 'object') return ''
  if (el.type === 'Button') return `[${(el.props?.label as string) ?? text(el.children)}]`
  const kids = Array.isArray(el.children) ? el.children : el.children === undefined ? [] : [el.children]
  if (el.type === 'Box') {
    if (el.props?.flexDirection === 'column') return kids.map(text).filter(Boolean).join('\n')
    return kids.map(text).filter(Boolean).join(' '.repeat(Number(el.props?.columnGap ?? 0)))
  }
  return kids.map(text).join('')
}

test('labels', async () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5 (1M)')
  expect(modelName('claude-haiku-5-5-20261001')).toBe('Haiku 5.5')
  expect(effortLabel({ setting: null, sent: null })).toBe('auto')
  expect(effortLabel({ setting: 'auto', sent: 'medium' })).toBe('auto (medium)')
  expect(effortLabel({ setting: 'high', sent: 'high' })).toBe('high')
  expect(effortLabel({ setting: 'xhigh', sent: 'high' })).toBe('xhigh (sent high)')
  expect(tokens(84_000)).toBe('84k')
  expect(tokens(1_000_000)).toBe('1M')
  expect(timeLeft('2026-11-18T14:14:00Z', NOW)).toBe('2h 14m')
  expect(timeLeft('2026-11-18T12:45:00Z', NOW)).toBe('45m')
  expect(timeLeft('2026-11-21T17:00:00Z', NOW)).toBe('3d 5h')
  expect(timeLeft('2026-11-18T11:00:00Z', NOW)).toBe('under a minute')
  expect(billing(BASE)?.label).toBe('API billing')
  expect(billing({ ...BASE, limits: [{ kind: 'five_hour', percentUsed: 40 }] })).toBeNull()
  expect(billing({ ...BASE, limits: [{ kind: 'seven_day_opus', percentUsed: 100 }] })?.label).toBe('on extra usage')
})

test('context is measured against the auto-compact window, not the model window', async () => {
  const u = { ...BASE, tokens: 180_000, percent: 18 }
  expect(contextFill(u, null).pct).toBe(18)
  expect(contextFill(u, { tokens: 200_000, isModelLimit: false }).pct).toBe(90)
  const a = alerts(u, { tokens: 200_000, isModelLimit: false }, NOW)
  expect(a.map(x => x.text)).toEqual(['Context 90% full, auto-compacts at 200k: /compact at a good break'])
})

test('alerts: spent first, then nearly spent; nothing when all is well', async () => {
  const limits = [
    { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-11-18T14:14:00Z' },
    { kind: 'seven_day_opus', percentUsed: 100, resetsAt: '2026-11-21T17:00:00Z' },
    { kind: 'seven_day', percentUsed: 40 },
  ]
  expect(alerts({ ...BASE, tokens: 10_000, limits }, null, NOW)).toEqual([
    { key: 'a-seven_day_opus', tone: 'error', text: 'Week (Opus) limit used up: extra usage is paying for replies, resets in 3d 5h' },
    { key: 'a-five_hour', tone: 'warning', text: '5-hour limit 92% used, resets in 2h 14m' },
  ])
  expect(alerts({ ...BASE, tokens: 10_000, limits: [{ kind: 'five_hour', percentUsed: 50 }] }, null, NOW)).toEqual([])
})

type Opts = { window?: { tokens: number }; gh?: number; opened?: string[]; breakdownMisses?: number; limits?: { kind: string; percentUsed: number; resetsAt?: string }[] }

async function boot($: any, on: any, opts: Opts = {}) {
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: NOW }))
  on('command.run', () => ({ text: '' }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '{"modelSettings":{"claude-opus-5-5":{"effortLevel":"high"}}}' }))
  let misses = opts.breakdownMisses ?? 0
  on('session.usage', (_: unknown, e: { breakdown?: string } | undefined) => {
    const hasBreakdown = !!e?.breakdown && misses-- <= 0
    return {
      value: {
        startedAt: NOW,
        context: {
          window: 1_000_000,
          ...(hasBreakdown ? { breakdown: { rawMaxTokens: opts.window?.tokens ?? 200_000, autocompactSource: 'settings' } } : {}),
        },
        rateLimits: [],
        cost: { usd: 0 },
      },
    }
  })
  on('session.measure', (_: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'open') {
      opts.opened?.push(e.argv[1]!)
      return { value: { exitCode: 0, stdout: '', stderr: '', ...RUN } }
    }
    return e.argv[0] === 'git'
      ? { value: { exitCode: 0, stdout: 'feature-dark-mode\n', stderr: '', ...RUN } }
      : { value: { exitCode: opts.gh ?? 0, stdout: opts.gh ? '' : PRS, stderr: opts.gh ? 'gh: offline' : '', ...RUN } }
  })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) void _
}

const BUSY = {
  context: { tokens: 120_000, window: 1_000_000, percent: 12 },
  rateLimits: [
    { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-11-21T14:00:00Z' },
    { kind: 'five_hour', percentUsed: 92.5, resetsAt: '2026-11-18T14:14:00Z' },
  ],
  cost: { usd: 3.4219 },
  changed: ['context', 'rateLimits', 'cost'] as UsageUnit[],
}

test('band: alert first, meters, model row, head PR opens', async ($, on) => {
  const opened: string[] = []
  await boot($, on, { opened })
  await $.session.measure(BUSY)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^◆/ }))?.text).toBe('◆ 5-hour limit 93% used, resets in 2h 14m')
    expect((await ui.find({ type: 'Text', text: /^Opus 5\.5 \(1M\)$/ }))?.text).toBe('Opus 5.5 (1M)')
    expect((await ui.find({ type: 'Text', text: /^effort / }))?.text).toBe('effort high')
    expect((await ui.find({ type: 'Text', text: /^≈ / }))?.text).toBe('≈ $3.42')
    // 120k of a 200k auto-compact window, not 12% of the 1M model window.
    expect((await ui.find({ type: 'Text', text: /^60%$/ }))?.text).toBe('60%')
    expect((await ui.find({ type: 'Text', text: /120k of 200k/ }))?.text).toBe(' 120k of 200k')
    expect((await ui.find({ type: 'Text', text: /checks/ }))?.text).toBe(' · checks failed')
    expect((await ui.find({ type: 'Text', text: /more open PR/ }))?.text).toBe('+1 more open PR')
    // Nothing is said when nothing needs saying.
    expect(await ui.find({ type: 'Text', text: /PLAN|NONE|SIGNAL|billing/ })).toBeUndefined()
    await ui.press({ key: 'open-head-pr' })
    await ui.unmount()
  }
  expect(opened).toContain('https://github.com/o/r/pull/62')
})

test('band: a gh failure says so; effort from per-model settings', async ($, on) => {
  await boot($, on, { gh: 1 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^effort / }))?.text).toBe('effort high')
  expect((await ui.find({ type: 'Text', text: /^API billing$/ }))?.text).toBe('API billing')
  expect((await ui.find({ type: 'Text', text: /PRs unavailable/ }))?.text).toBe('PRs unavailable: gh: offline')
  await ui.unmount()
})

test('the auto-compact window is read again when the first read finds none', async ($, on) => {
  await boot($, on, { breakdownMisses: 1 })
  await $.session.measure(BUSY)
  await $.session.measure(BUSY) // the first measure's reload is not awaited; the second sees it
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^60%$/ }))?.text).toBe('60%')
  await ui.unmount()
})

test('a command that moves the auto-compact window (say /config) moves the meter', async ($, on) => {
  const window = { tokens: 200_000 }
  await boot($, on, { window })
  await $.session.measure(BUSY)
  window.tokens = 400_000
  await $.command.run({ command: 'config', args: '', origin: 'user' } as never)
  await $.session.measure(BUSY) // lets the unawaited reload settle
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^30%$/ }))?.text).toBe('30%')
  await ui.unmount()
})

test('the model row fits its column: the PR count, then the title, then the cost give way', async ($, on) => {
  await boot($, on)
  await $.session.measure({
    ...BUSY,
    rateLimits: [...BUSY.rateLimits, { kind: 'seven_day_opus', percentUsed: 80, resetsAt: '2026-11-20T10:00:00Z' }, { kind: 'seven_day_sonnet', percentUsed: 20 }],
  })
  for (const bodyColumns of [60, 70, 80, 100, 120, 140]) {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
    const lines = text(await ui.drawn()).split('\n')
    await ui.unmount()
    const modelRow = lines[lines.length - 1]!
    expect([bodyColumns, modelRow.length <= bodyColumns]).toEqual([bodyColumns, true])
    expect(modelRow).toContain('PR #62')
  }
})

test('layout by width: three rows with an alert, bars from 90 columns, titles from 120', async ($, on) => {
  await boot($, on)
  await $.session.measure(BUSY)
  const at = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns } })
    const lines = text(await ui.drawn()).split('\n')
    await ui.unmount()
    return lines
  }
  const narrow = await at(80)
  expect(narrow).toEqual([
    '─'.repeat(80),
    '◆ 5-hour limit 93% used, resets in 2h 14m',
    'Context 60%   5-hour 93% resets in 2h 14m   Week 61%',
    'Opus 5.5 (1M)   effort high   ≈ $3.42   [PR #62 draft] · checks failed',
  ])
  expect((await at(100))[3]).toBe('Opus 5.5 (1M)   effort high   ≈ $3.42   [PR #62 draft] · checks failed   +1 more open PR')
  expect((await at(100))[2]).toBe('Context ████░░ 60%   5-hour ██████ 93% resets in 2h 14m   Week ████░░ 61%')
  const wide = await at(140)
  expect(wide[0]).toBe('─'.repeat(140))
  expect(wide[3]).toBe('Opus 5.5 (1M)   effort high   ≈ $3.42   [PR #62 draft] Dark mode: a calmer palette for the edi… · checks failed   +1 more open PR')
})

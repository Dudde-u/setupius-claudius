import { expect, test } from 'claude-code/testing'
import { credits, effortLabel, modelName } from './register'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const PRS = "[{\"headRefName\":\"feature-dark-mode\",\"isDraft\":true,\"number\":62,\"statusCheckRollup\":[],\"title\":\"Dark mode: a calmer palette for the editor, and a darker border\"}]"
const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 140, scroll: { offset: 0, bodyRows: 23 }, view: {} },
} as const
const RUN = { isStdoutTruncated: false, isStderrTruncated: false }

test('labels', async () => {
  expect(modelName('claude-opus-5-5')).toBe('OPUS 5.5')
  expect(modelName('claude-opus-5-5[1m]')).toBe('OPUS 5.5 1M')
  expect(modelName('claude-haiku-5-5-20261001')).toBe('HAIKU 5.5')
  expect(effortLabel({ setting: null, sent: null })).toBe('AUTO')
  expect(effortLabel({ setting: 'auto', sent: 'medium' })).toBe('AUTO→MEDIUM')
  expect(effortLabel({ setting: null, sent: 'default' })).toBe('AUTO→DEFAULT')
  expect(effortLabel({ setting: 'high', sent: 'high' })).toBe('HIGH')
  expect(effortLabel({ setting: 'xhigh', sent: 'high' })).toBe('XHIGH→HIGH')
  const base = { window: 200_000, limits: [] as { kind: string; percentUsed: number }[] }
  expect(credits(base).label).toBe('METERED')
  expect(credits({ ...base, limits: [{ kind: 'five_hour', percentUsed: 40 }] }).label).toBe('PLAN')
  expect(credits({ ...base, limits: [{ kind: 'five_hour', percentUsed: 100 }] }).label).toBe('BURNING')
  expect(credits({ ...base, limits: [{ kind: 'seven_day', percentUsed: 30 }, { kind: 'seven_day_opus', percentUsed: 100 }] }).label).toBe('BURNING')
})

test('monitor: model, auto effort, credits, limits, PRs, band beneath', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', () => ({ value: undefined }))
  on('config.list', () => ({ value: [] }))
  on('fs.read', () => ({ value: '{"alwaysThinkingEnabled": true}' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('process.run', (_, e) =>
    e.argv[0] === 'git'
      ? { value: { exitCode: 0, stdout: 'feature-dark-mode\n', stderr: '', ...RUN } }
      : { value: { exitCode: 0, stdout: PRS, stderr: '', ...RUN } })
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>roadmap beneath</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) void _
  await $.session.measure({
    context: { tokens: 84_000, window: 200_000, percent: 42 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-11-21T14:00:00Z' },
      { kind: 'five_hour', percentUsed: 92.5, resetsAt: '2026-11-18T14:14:00Z' },
    ],
    cost: { usd: 3.4219 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^OPUS 5\.5$/ }))?.text).toBe('OPUS 5.5')
    expect((await ui.find({ type: 'Text', text: /^AUTO→MEDIUM$/ }))?.text).toBe('AUTO→MEDIUM')
    expect((await ui.find({ type: 'Text', text: /PLAN/ }))?.text).toBe('○ PLAN')
    expect((await ui.find({ type: 'Text', text: /^\$003\.42$/ }))?.text).toBe('$003.42')
    expect((await ui.find({ type: 'Text', text: /^ 093%$/ }))?.text).toBe(' 093%')
    expect((await ui.find({ type: 'Text', text: /Δ2h14m/ }))?.text).toMatch(/Δ2h14m$/)
    expect((await ui.find({ type: 'Text', text: /^#062 $/ }))?.text).toBe('#062 ')
    expect((await ui.find({ type: 'Text', text: /HEAD/ }))?.text).toBe(' ◀ HEAD')
    expect((await ui.find({ type: 'Text', text: /roadmap beneath/ }))?.text).toBe('roadmap beneath')
    await ui.unmount()
  }
})

test('fixed effort from per-model settings', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/Users/x' : undefined }))
  on('config.list', () => ({ value: [] }))
  on('fs.read', (_, e) => e.path === '/Users/x/.claude/settings.json'
    ? { value: '{"modelSettings":{"claude-opus-5-5":{"effortLevel":"high"}}}' }
    : { deny: 'missing' })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'gh: offline', ...RUN } }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>beneath</Text> })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^HIGH$/ }))?.text).toBe('HIGH')
  expect((await ui.find({ type: 'Text', text: /METERED/ }))?.text).toBe('● METERED')
  expect((await ui.find({ type: 'Text', text: /ERR/ }))?.text).toMatch(/ERR gh: offline/)
  await ui.unmount()
})

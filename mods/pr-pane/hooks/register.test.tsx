import { expect, test } from 'claude-code/testing'

const PRS = "[{\"headRefName\":\"feature-dark-mode\",\"isDraft\":true,\"number\":62,\"reviewDecision\":\"\",\"statusCheckRollup\":[],\"title\":\"Dark mode: a calmer palette for the editor, and a darker border\",\"updatedAt\":\"2026-11-16T12:45:50Z\",\"url\":\"https://github.com/o/r/pull/62\"}]"

const PANE = {
  plugin: 'pr-pane',
  component: 'Pane',
  requestId: 'pr-pane',
  props: { title: 'Pull requests', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('lists open PRs and marks the current branch', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18T12:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: 'feature-dark-mode\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: PRS, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'prs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /PR #62/ }))?.text).toBe('→ PR #62')
    expect((await ui.find({ type: 'Text', text: /Dark mode/ }))?.text).toBe('Dark mode: a calmer palette for the editor, and a darker border')
    expect((await ui.find({ type: 'Text', text: /no checks/ }))?.text).toMatch(/feature-dark-mode · no checks/)
    await ui.unmount()
  }
})

test('shows gh errors instead of a blank pane', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18T12:00:00Z') }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => (e.argv as readonly string[])[0] === 'git'
    ? { value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    : { value: { exitCode: 1, stdout: '', stderr: 'gh: not logged in', isStdoutTruncated: false, isStderrTruncated: false } })
  await $.command.run({ command: 'prs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not logged/ }))?.text).toBe('gh: not logged in')
  await ui.unmount()
})

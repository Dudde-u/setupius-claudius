import { expect, mock, test } from 'claude-code/testing'

// The shape of the real jobs on 2026-11-21: a session with no worktreePath of its own
// whose PR is only in `children` (ec922f6f), one whose four PRs are only reachable
// through its subagents' worktrees and whose own worktreeBranch is stale (f5597e51),
// a job folder with no state.json yet, and a session on another repo. Plus a finished
// session whose `next: you merge #150` is out of date (#150 merged), and a working
// session that has gone quiet.
const MAIN = '/r/app'
const WT = `${MAIN}/.claude/worktrees`
const WORKTREES = [
  `worktree ${MAIN}\nHEAD 1\nbranch refs/heads/main\n`,
  `worktree ${WT}/merge-batches\nHEAD 2\nbranch refs/heads/sync-batch-2\nlocked\n`,
  `worktree ${WT}/agent-aaa\nHEAD 3\nbranch refs/heads/fix-login-redirect\nlocked claude agent\n`,
  `worktree ${WT}/next-phase-skill\nHEAD 4\nbranch refs/heads/next-phase-skill\n`,
  `worktree ${WT}/old-thing\nHEAD 5\nbranch refs/heads/old-thing\n`,
].join('\n')
// The batch worktree's local branch is pushed under another name, so #165 is reachable
// only through the upstream; next-phase-skill tracks origin/main, which is no PR's head.
const REFS = 'main main\nsync-batch-2 fixes-batch-2\nnext-phase-skill main\nfix-login-redirect fix-login-redirect\n'
const PRS = JSON.stringify([
  { number: 165, title: 'fixes batch 2', headRefName: 'fixes-batch-2', url: 'u165', isDraft: false },
  { number: 133, title: 'login redirect', headRefName: 'fix-login-redirect', url: 'u133', isDraft: false },
  { number: 161, title: 'next-phase skill', headRefName: 'next-phase-skill', url: 'u161', isDraft: false },
  { number: 164, title: 'cache ttl', headRefName: 'fix-cache-ttl', url: 'u164', isDraft: false },
  { number: 170, title: 'orphan', headRefName: 'nobody', url: 'u170', isDraft: true },
])
const HOME = '/h'
const JOBS = `${HOME}/.claude/jobs`
const STATES: Record<string, object> = {
  f5597e51: {
    name: 'merge batches pr-165 migrations',
    state: 'working',
    detail: "I'll check each PR myself",
    updatedAt: '2026-11-21T18:00:00Z',
    cwd: MAIN,
    worktreePath: `${WT}/merge-batches`,
    worktreeBranch: 'worktree-merge-batches',
    children: [{ id: '169', kind: 'pr' }],
    fan: [
      // No PR number here: #133 is reachable only through this agent's worktree.
      { id: 'aaa', kind: 'agent', label: 'review e6f5bc6' },
      { id: 'bbb', kind: 'agent', label: '#164 cache option (a)' },
      { id: 'ccc', kind: 'shell', label: 'make ci', doneAt: 1 },
    ],
  },
  ec922f6f: {
    name: 'Contents of plan.md',
    state: 'done',
    detail: 'ready to merge',
    updatedAt: '2026-11-21T17:00:00Z',
    cwd: MAIN,
    children: [{ id: '161', kind: 'pr' }],
  },
  d0d0d0d0: { name: 'stale finished', state: 'done', detail: 'merged', updatedAt: '2026-11-21T16:00:00Z', cwd: MAIN },
  q1q1q1q1: { name: 'slow one', state: 'working', detail: 'thinking', updatedAt: '2026-11-21T17:30:00Z', cwd: MAIN },
  other: { name: 'elsewhere', state: 'working', cwd: '/r/other', children: [{ id: '170', kind: 'pr' }] },
}
const say = (...texts: string[]) => texts.map(text => JSON.stringify({ state: 'done', text })).join('\n')
const TIMELINES: Record<string, string> = {
  ec922f6f: say('', 'Ready.\n\nowns: #161 · worktree next-phase-skill · next: you merge #161\nresult: #161 ready'),
  d0d0d0d0: say('Merged.\n\nowns: #150 · worktree gone · next: you merge #150\nresult: #150 ready'),
}

const PANE = {
  plugin: 'sessions-pane',
  component: 'Pane',
  requestId: 'sessions-pane',
  props: { title: 'Sessions', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const jobOf = (path: string) => path.slice(JOBS.length + 1).split('/')[0] ?? ''

type Ui = { findAll: (q: { type?: string }) => Promise<{ type: string; text: string }[]> }
/** The pane's words as drawn, in order: every Text's and Button's own text. */
async function page(ui: Ui): Promise<string> {
  return (await ui.findAll({}))
    .filter(n => n.type === 'Text' || n.type === 'Button')
    .map(n => n.text)
    .join('\n')
}

test('each PR lands on the session that owns it, and what needs the user comes first', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-21T18:01:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] !== 'git') return ok(PRS)
    return argv[1] === 'for-each-ref' ? ok(REFS) : ok(WORKTREES)
  })
  on('fs.list', () => ({
    value: ['f5597e51', 'ec922f6f', 'eb33f2a3', 'other', 'd0d0d0d0', 'q1q1q1q1'].map(name => ({
      name,
      kind: 'dir' as const,
      size: 0,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('fs.stat', (_, e) => {
    const t = TIMELINES[jobOf(String(e.path))]
    if (!t) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: t.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const path = String(e.path)
    const job = jobOf(path)
    if (path.endsWith('/timeline.jsonl') && TIMELINES[job]) return { value: TIMELINES[job] }
    if (path.endsWith('/state.json') && STATES[job]) return { value: JSON.stringify(STATES[job]) }
    throw new Error('ENOENT')
  })

  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const joined = await page(ui)

    // The stale `next: you merge #150` does not count: #150 is no longer open.
    expect(joined).toMatch(/◆ 1 needs you/)
    expect(joined).toMatch(/● 2 working/)
    expect(joined).toMatch(/○ 1 done/)

    // ec922f6f first (its next step is the user's and #161 is open), then the working
    // sessions newest first, then the done one folded to a line.
    const at = (s: string) => joined.indexOf(s)
    expect(at('ec922f6f')).toBeGreaterThan(-1)
    expect(at('f5597e51')).toBeGreaterThan(at('ec922f6f'))
    expect(at('q1q1q1q1')).toBeGreaterThan(at('f5597e51'))
    expect(at('stale finished')).toBeGreaterThan(at('q1q1q1q1'))

    const ec = joined.slice(at('Contents of plan.md'), at('merge batches pr-165'))
    expect(ec).toMatch(/needs you/)
    expect(ec).toMatch(/→ you merge #161/)
    expect(ec).toMatch(/#161 next-phase skill/)
    expect(ec).toMatch(/in next-phase-skill/)

    // f5597e51 owns #133 through its agent's worktree, #165 through its branch's
    // upstream and #164 by its running agent's label.
    const f5 = joined.slice(at('merge batches pr-165'), at('slow one'))
    expect(f5).toMatch(/#133 login redirect/)
    expect(f5).toMatch(/#165 fixes batch 2/)
    expect(f5).toMatch(/#164 cache ttl/)
    expect(f5).toMatch(/in merge-batches \(sync-batch-2\) \+1 agent worktree · 2 agents running/)
    expect(f5).not.toMatch(/quiet/)
    expect(joined.slice(at('slow one'), at('stale finished'))).toMatch(/quiet/)

    // The other repo's session and the job with no state are left out; #170 is nobody's.
    expect(joined).not.toMatch(/elsewhere|eb33f2a3/)
    const free = joined.slice(at('Open PRs no session owns'))
    expect(free).toMatch(/#170 draft orphan/)
    expect(free).not.toMatch(/#16[145]|#133/)
    // Worktrees no session uses are counted, and listed on request.
    expect(joined).toMatch(/Worktrees no session uses\n 1/)
    expect(joined).not.toMatch(/old-thing/)
    await ui.press({ key: 'toggle-trees' })
    expect(await page(ui)).toMatch(/old-thing/)

    // The done session opens in full on request, its out-of-date next step plain.
    expect(joined).not.toMatch(/next: you merge #150/)
    await ui.press({ key: 'toggle-done' })
    const full = await page(ui)
    expect(full).toMatch(/next: you merge #150/)
    expect(full).not.toMatch(/→ you merge #150/)
    // No grey: nothing is dimmed or `subtle`, and only the three coloured cards are
    // framed, so the opened done card has no frame.
    const all = (await ui.findAll({})) as unknown as { props: Record<string, unknown> }[]
    expect(all.filter(x => x.props.dimColor || x.props.color === 'subtle' || x.props.borderColor === 'subtle')).toEqual([])
    expect(all.filter(x => x.props.borderStyle === 'round').length).toBe(3)
    await ui.press({ key: 'toggle-done' })
    await ui.press({ key: 'toggle-trees' })
    await ui.unmount()
  }
})

test('a blocked session needs the user, and a narrow pane drops the card borders', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-21T18:01:00Z') }))
  on('env.get', () => ({ value: HOME }))
  on('process.run', (_, e) => ((e.argv as readonly string[])[0] === 'git' ? ok(WORKTREES) : ok('[]')))
  on('fs.list', () => ({ value: [{ name: 'q1q1q1q1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.read', () => ({ value: JSON.stringify({ ...STATES.q1q1q1q1, state: 'blocked' }) }))

  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const words = await page(first)
  expect(words).toMatch(/◆ 1 needs you/)
  expect(words).toMatch(/→ waiting for your answer/)
  // Counts of nothing are left out, not greyed.
  expect(words).not.toMatch(/working|○ 0|0 done/)
  await first.unmount()
  for (const [columns, bordered] of [
    [30, false],
    [50, true],
  ] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' })
    const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { props: Record<string, unknown> }[]
    expect(boxes.some(b => b.props.borderStyle === 'round')).toBe(bordered)
    await ui.unmount()
  }
})

test('a change of state shows on the quick tick, without git or gh', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-11-21T18:01:00Z') })
  const state: Record<string, unknown> = { ...STATES.ec922f6f, state: 'blocked' }
  let timeline = say('Which one?\n\nowns: nothing · next: you pick 1 or 2')
  let gh = 0
  let tails = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: HOME }))
  on('process.run', (_, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] !== 'git') return (gh++, ok(PRS))
    return argv[1] === 'for-each-ref' ? ok(REFS) : ok(WORKTREES)
  })
  on('fs.list', () => ({ value: [{ name: 'ec922f6f', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: timeline.length, mtimeMs: 5, isLink: false } }))
  on('fs.read', (_, e) => {
    if (String(e.path).endsWith('/timeline.jsonl')) return (tails++, { value: timeline })
    return { value: JSON.stringify(state) }
  })

  await $.session.start({ cwd: MAIN, surface: "terminal", isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await page(ui)).toMatch(/◆ 1 needs you/)
  const ghAtStart = gh
  const tailsAtStart = tails
  expect(ghAtStart).toBeGreaterThan(0)

  // Nothing changed: the quick tick neither asks gh nor reads the timeline again.
  await clock.advance(3_000)
  expect(gh).toBe(ghAtStart)
  expect(tails).toBe(tailsAtStart)

  // The session takes its answer and works on: the next quick tick shows it.
  Object.assign(state, { state: 'working', updatedAt: '2026-11-21T18:01:05Z' })
  await clock.advance(3_000)
  const words = await page(ui)
  expect(words).toMatch(/● 1 working/)
  expect(words).not.toMatch(/needs you/)
  expect(gh).toBe(ghAtStart)

  // It finishes with a next step that isn't yours, while #161 is still open: the grown
  // timeline is read again, and the session is done, not waiting on you.
  timeline = say('Which one?\n\nowns: nothing · next: you pick 1 or 2', 'Done.\n\nowns: #161 · next: waiting on make ci')
  Object.assign(state, { state: 'done', updatedAt: '2026-11-21T18:01:08Z' })
  await clock.advance(3_000)
  const after = await page(ui)
  expect(after).toMatch(/○ 1 done/)
  expect(after).not.toMatch(/needs you/)
  expect(tails).toBe(tailsAtStart + 1)

  // The slow tick still asks git and gh.
  await clock.advance(60_000)
  expect(gh).toBeGreaterThan(ghAtStart)
  await ui.unmount()
})

test('a gh failure still lists the sessions', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.now', () => ({ value: Date.parse('2026-11-21T18:01:00Z') }))
  on('env.get', () => ({ value: HOME }))
  on('process.run', (_, e) =>
    (e.argv as readonly string[])[0] === 'git'
      ? ok(WORKTREES)
      : { value: { exitCode: 1, stdout: '', stderr: 'gh: not logged in', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  on('fs.list', () => ({ value: [{ name: 'ec922f6f', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  on('fs.read', () => ({ value: JSON.stringify(STATES.ec922f6f) }))

  await $.command.run({ command: 'sessions', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /not logged in/ }))?.text).toBe('gh: gh: not logged in; PRs left out')
  expect(await page(ui)).toMatch(/○ Contents of plan\.md · /)
  await ui.unmount()
})

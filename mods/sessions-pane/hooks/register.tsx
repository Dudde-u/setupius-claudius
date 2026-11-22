import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Pr, SessionRow, SessionsSnapshot, Tree } from '../types'

// What each background session on this repo is doing. The same join as a repo's own
// `make sessions` script, where it has one; keep the two in step.
//
// A session owns an open PR when the PR's head branch is the branch of its worktree or
// of one of its subagents' worktrees (`agent-<fan id>`), when the PR is in its
// `children`, or when a running subagent's label names it (`#124`). Branches come from
// `git worktree list`, never state.json's `worktreeBranch` (the name at creation).

const PANE = 'sessions-pane'
const TITLE = 'Sessions'
// Two clocks: the sessions' own files are local and cheap, so a change of state shows
// within seconds; worktrees and PRs (git, and gh over the network) change rarely.
const FAST_MS = 3_000
const SLOW_MS = 60_000
const TAIL_BYTES = 262_144
// What needs the user comes first, then what is running, then what is done.
const ORDER: Record<string, number> = { working: 1, blocked: 2, done: 3 }
// A working session silent this long is flagged as quiet.
const QUIET_MS = 20 * 60_000

const snapshot = atom({ plugin: 'sessions-pane', key: 'snapshot' } as const, null, {
  shape: 'sessions-snapshot-3',
})
const showDone = atom({ plugin: 'sessions-pane', key: 'showDone' } as const, false)
const showTrees = atom({ plugin: 'sessions-pane', key: 'showTrees' } as const, false)

type Fan = { id?: unknown; kind?: unknown; label?: unknown; doneAt?: unknown }
type Job = {
  id: string
  name?: string
  state?: string
  detail?: string
  updatedAt?: string
  cwd?: string
  originCwd?: string
  worktreePath?: string
  fan?: Fan[]
  inFlight?: { kinds?: unknown }
  children?: { id?: unknown; kind?: unknown }[]
  owns: string
}
type RawPr = { number: number; title: string; headRefName: string; url: string; isDraft: boolean }

// The last state.json that parsed, per job: one caught mid-write keeps its old row.
const lastGood = new Map<string, Omit<Job, 'owns'>>()
// Each timeline's last owns: line, kept with the size and mtime it was read at.
const ownsSeen = new Map<string, { size: number; mtimeMs: number; owns: string }>()

/**
 * `git worktree list --porcelain`, with each branch's upstream from `git for-each-ref`
 * (`<branch> <upstream without remote>` per line). A PR's head is the branch as pushed,
 * which can differ from the local name (a worktree on `worktree-x` pushed as `x`); an
 * upstream that is the main checkout's branch (a branch started from origin/main) is
 * left out.
 */
function parseWorktrees(out: string, refs: string): Tree[] {
  const trees: Tree[] = []
  let cur: Tree | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: '', pushed: '', locked: false }
      trees.push(cur)
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (cur && line === 'detached') {
      cur.branch = '(detached)'
    } else if (cur && line.startsWith('locked')) {
      cur.locked = true
    }
  }
  const upstream = new Map<string, string>()
  for (const line of refs.split('\n')) {
    const at = line.indexOf(' ')
    if (at > 0) upstream.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const mainBranch = trees[0]?.branch ?? ''
  for (const t of trees) {
    const up = upstream.get(t.branch) ?? ''
    t.pushed = up && up !== t.branch && up !== mainBranch ? up : ''
  }
  return trees
}

/** The branch names a PR from this worktree could have as its head. */
function heads(t: Tree): string[] {
  return [t.branch, t.pushed].filter(Boolean)
}

/** The last `owns:` line in a timeline's tail, or ''. */
function lastOwns(tail: string): string {
  for (const line of tail.split('\n').reverse()) {
    let text = ''
    try {
      const row = JSON.parse(line) as { text?: unknown }
      text = typeof row.text === 'string' ? row.text : ''
    } catch {
      continue
    }
    for (const raw of text.split('\n').reverse()) {
      const r = raw.trim()
      if (r.toLowerCase().startsWith('owns:')) return r.slice('owns:'.length).trim()
    }
  }
  return ''
}

/** The `next:` part of an owns line (`#161 · worktree x · next: you merge #161`), or ''. */
function nextOf(owns: string): string {
  const m = /(?:^|·)\s*next:\s*(.*)$/i.exec(owns)
  return m?.[1]?.trim() ?? ''
}

/**
 * A session needs the user when it is blocked, or when its `next:` is theirs (`you
 * merge #161`) and is still to do: a PR it names is open, or, naming none, it still
 * owns one. A finished session's old `next: you merge #N` drops out once #N merges.
 */
function needsUser(state: string, next: string, open: Set<number>, owned: number): boolean {
  if (state === 'blocked') return true
  // A working session is on its way: its last owns: line is from before it took up
  // your answer, so it doesn't need you until it stops again.
  if (state === 'working') return false
  if (!/^you\b/i.test(next)) return false
  const named = [...next.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
  return named.length ? named.some(n => open.has(n)) : owned > 0
}

/**
 * A subagent is still running for the session, so it counts as working whatever its
 * state says: it wakes itself when the agent reports back. A loop waiting on an agent
 * often ends its turn with a `next:` that is partly yours (`you merge #42; I wait on
 * the review agent`), and the job list then calls it blocked. Running means a fan agent
 * with no `doneAt`, and `inFlight.kinds` listing `local_agent`, so a stale fan
 * entry can't hide a real block.
 */
function agentRunning(j: Job, running: Fan[]): boolean {
  if (!running.some(f => f.kind === 'agent')) return false
  const flight = j.inFlight
  const kinds = flight && typeof flight === 'object' && !Array.isArray(flight) ? flight.kinds : undefined
  return Array.isArray(kinds) && kinds.includes('local_agent')
}

function join(jobs: Job[], trees: Tree[], prs: Pr[], main: string) {
  const byPath = new Map(trees.map(t => [t.path, t]))
  const byBranch = new Map<string, Tree>()
  for (const t of trees) for (const b of heads(t)) if (!byBranch.has(b)) byBranch.set(b, t)
  const prByNum = new Map(prs.map(p => [p.number, p]))

  const sessions: SessionRow[] = []
  for (const j of jobs) {
    const where = j.originCwd || j.cwd || ''
    if (where !== main && !where.startsWith(main + '/')) continue
    const fan = (Array.isArray(j.fan) ? j.fan : []).filter(f => f && typeof f === 'object')
    const paths: string[] = []
    if (j.worktreePath) paths.push(j.worktreePath)
    for (const f of fan) if (f.kind === 'agent') paths.push(`${main}/.claude/worktrees/agent-${String(f.id)}`)
    const mine: Tree[] = []
    for (const p of paths) {
      const t = byPath.get(p)
      if (t && !mine.includes(t)) mine.push(t)
    }
    const branches = new Set(mine.flatMap(heads))

    const owned = new Set<number>()
    for (const p of prs) if (branches.has(p.branch)) owned.add(p.number)
    for (const c of Array.isArray(j.children) ? j.children : []) {
      const n = Number(c?.id)
      if (c?.kind === 'pr' && prByNum.has(n)) owned.add(n)
    }
    const running = fan.filter(f => !f.doneAt)
    for (const f of running) {
      for (const m of String(f.label ?? '').matchAll(/#(\d+)\b/g)) {
        if (prByNum.has(Number(m[1]))) owned.add(Number(m[1]))
      }
    }
    // A PR the session owns brings its worktree along (a session with no
    // worktreePath of its own still works in its PR's worktree).
    for (const n of owned) {
      const t = byBranch.get(prByNum.get(n)!.branch)
      if (t && !mine.includes(t)) mine.push(t)
    }

    const state = agentRunning(j, running) ? 'working' : (j.state ?? '?')
    const next = nextOf(j.owns)
    sessions.push({
      id: j.id,
      name: j.name ?? '',
      state,
      detail: j.detail ?? '',
      updatedAt: j.updatedAt ?? '',
      prs: [...owned].sort((a, b) => a - b).map(n => prByNum.get(n)!),
      trees: mine.filter(t => t.path !== main),
      agents: running.filter(f => f.kind === 'agent').length,
      shells: running.filter(f => f.kind !== 'agent').length,
      owns: j.owns,
      next,
      needsYou: needsUser(state, next, new Set(prByNum.keys()), owned.size),
    })
  }

  const rank = (s: SessionRow) => (s.needsYou ? 0 : (ORDER[s.state] ?? 4))
  sessions.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  )
  const claimedPrs = new Set(sessions.flatMap(s => s.prs.map(p => p.number)))
  const claimedTrees = new Set(sessions.flatMap(s => s.trees.map(t => t.path)))
  return {
    main,
    sessions,
    unownedPrs: prs.filter(p => !claimedPrs.has(p.number)),
    unusedTrees: trees.filter(t => t.path !== main && !claimedTrees.has(t.path)),
  }
}

async function loadJobs($: EngineInterface, dir: string): Promise<Job[]> {
  const jobs: Job[] = []
  const entries = await $.fs.list(dir).catch(() => [])
  for (const ent of entries) {
    if (ent.kind !== 'dir') continue
    const at = `${dir}/${ent.name}`
    try {
      const raw = JSON.parse(await $.fs.read(`${at}/state.json`)) as Omit<Job, 'id' | 'owns'>
      if (raw && typeof raw === 'object') lastGood.set(ent.name, { ...raw, id: ent.name })
    } catch {
      // no state.json yet, or caught mid-write: keep the last good one, if any
    }
    const state = lastGood.get(ent.name)
    if (!state) continue
    // The timeline only grows: read its tail again only when it has changed.
    let owns = ''
    try {
      const { size, mtimeMs } = await $.fs.stat(`${at}/timeline.jsonl`)
      const seen = ownsSeen.get(ent.name)
      if (seen && seen.size === size && seen.mtimeMs === mtimeMs) {
        owns = seen.owns
      } else {
        const offset = Math.max(0, size - TAIL_BYTES)
        owns = lastOwns(await $.fs.read(`${at}/timeline.jsonl`, { offset, length: size - offset }))
        ownsSeen.set(ent.name, { size, mtimeMs, owns })
      }
    } catch {
      owns = ''
    }
    jobs.push({ ...state, owns })
  }
  return jobs
}

// What the last full refresh found (git and gh), which the quick pass reuses.
type Repo = { trees: Tree[]; prs: Pr[]; main: string; error: string | null; fetchedAt: number }
let repo: Repo | null = null
let drawn = ''

let refreshing: Promise<void> | null = null
let rejoining: Promise<void> | null = null

/**
 * The quick pass: re-read the sessions' files and join them with the last git and gh
 * results. Writes only when the view changed, so an idle pane isn't redrawn every tick.
 * A pass asked for while one runs waits for it, then runs (it may have read too early).
 */
function rejoin($: EngineInterface, again = false): Promise<void> {
  if (rejoining) return again ? rejoining.then(() => rejoin($, true)) : rejoining
  rejoining = (async () => {
    if (!repo) return
    const at = repo
    try {
      const home = (await $.env.get('HOME')) ?? ''
      const jobs = await loadJobs($, `${home}/.claude/jobs`)
      const next: SessionsSnapshot = { ...join(jobs, at.trees, at.prs, at.main), fetchedAt: at.fetchedAt, error: at.error }
      const json = JSON.stringify(next)
      if (json === drawn) return
      drawn = json
      await update($, snapshot, () => next)
    } catch {
      // keep what is drawn; the next tick tries again
    }
  })().finally(() => {
    rejoining = null
  })
  return rejoining
}

/** The full pass: worktrees, branches and open PRs, then the quick pass on them. */
function refresh($: EngineInterface): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const now = await $.clock.now()
    const fail = (msg: string) => {
      drawn = ''
      return update($, snapshot, prev => ({
        main: prev?.main ?? '',
        sessions: prev?.sessions ?? [],
        unownedPrs: prev?.unownedPrs ?? [],
        unusedTrees: prev?.unusedTrees ?? [],
        fetchedAt: now,
        error: msg.slice(0, 160),
      }))
    }
    try {
      const wt = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 5000 })
      if (wt.exitCode !== 0) return void (await fail('Not in a git repository.'))
      const refs = await $.process.run(
        ['git', 'for-each-ref', '--format=%(refname:lstrip=2) %(upstream:lstrip=3)', 'refs/heads'],
        { timeoutMs: 5000 },
      )
      const trees = parseWorktrees(wt.stdout, refs.exitCode === 0 ? refs.stdout : '')
      const main = trees[0]?.path ?? ''

      let prs: Pr[] = []
      let error: string | null = null
      const r = await $.process.run(
        ['gh', 'pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,headRefName,url,isDraft'],
        { timeoutMs: 20_000 },
      )
      if (r.exitCode === 0) {
        prs = (JSON.parse(r.stdout) as RawPr[]).map(p => ({
          number: p.number,
          title: p.title,
          branch: p.headRefName,
          url: p.url,
          isDraft: p.isDraft,
        }))
      } else {
        error = `gh: ${(r.stderr.trim().split('\n')[0] || `exited ${r.exitCode}`).slice(0, 150)}; PRs left out`
      }

      repo = { trees, prs, main, error, fetchedAt: now }
      await rejoin($, true)
    } catch (err) {
      await fail(err instanceof Error ? err.message : String(err))
    }
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '?'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function treeName(t: Tree, main: string): string {
  const root = `${main}/.claude/worktrees/`
  const name = t.path.startsWith(root) ? t.path.slice(root.length) : t.path
  const branch = t.branch === '(detached)' ? 'detached' : t.branch
  return branch && branch !== name ? `${name} (${branch})` : name
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** `s` cut to `n` columns, an ellipsis marking the cut. */
function cut(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`
}

// No grey anywhere: colour marks what needs you or is running, and the rest is plain text.
type Tone = { glyph: string; label: string; color?: string }

function toneOf(s: SessionRow): Tone {
  if (s.needsYou) return { glyph: '◆', label: 'needs you', color: 'warning' }
  if (s.state === 'working') return { glyph: '●', label: 'working', color: 'success' }
  if (s.state === 'done') return { glyph: '○', label: 'done' }
  return { glyph: '?', label: s.state }
}

const isAgentTree = (t: Tree) => /\/agent-[^/]+$/.test(t.path)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Open the sessions pane and refresh it' })
    void refresh($)
    $.clock.every(FAST_MS, () => void rejoin($))
    $.clock.every(SLOW_MS, () => void refresh($))
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced ? 'Sessions pane opened.' : 'Sessions pane is waiting for room (widen the terminal).',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const doneOpen = await read($, showDone)
    const treesOpen = await read($, showTrees)
    const now = await $.clock.now()

    if (snap === null) return <Text>Loading sessions…</Text>

    // A card's round border and padding take four columns; below 36 there is no room.
    const width = Math.max(20, e.props.bodyColumns || 50)
    const boxed = width >= 36
    const inner = boxed ? width - 4 : width
    const open = (url: string) => void $.process.run(['open', url])

    const needs = snap.sessions.filter(s => s.needsYou).length
    const working = snap.sessions.filter(s => !s.needsYou && s.state === 'working').length
    const live = snap.sessions.filter(s => s.needsYou || s.state !== 'done')
    const done = snap.sessions.filter(s => !s.needsYou && s.state === 'done')

    // A PR is one press: its whole row opens it.
    const prRow = (key: string, p: Pr, room: number) => {
      const title = cut(p.title, room - String(p.number).length - 2 - (p.isDraft ? 6 : 0))
      return p.isDraft ? (
        <Button key={key} plain onPress={() => open(p.url)}>
          {`#${p.number} `}
          <Text>draft</Text>
          {` ${title}`}
        </Button>
      ) : (
        <Button key={key} plain onPress={() => open(p.url)}>
          {`#${p.number} ${title}`}
        </Button>
      )
    }

    const card = (s: SessionRow) => {
      const t = toneOf(s)
      const quiet = !s.needsYou && s.state === 'working' && now - (Date.parse(s.updatedAt) || now) > QUIET_MS
      const agentTrees = s.trees.filter(isAgentTree).length
      const named = s.trees.filter(x => !isAgentTree(x)).map(x => treeName(x, snap.main))
      const where = [...named, ...(agentTrees ? [`+${plural(agentTrees, 'agent worktree')}`] : [])].join(' ')
      const runs = [s.agents ? plural(s.agents, 'agent') : '', s.shells ? plural(s.shells, 'shell') : '']
        .filter(Boolean)
        .join(', ')
      const foot = [where ? `in ${where}` : '', runs ? `${runs} running` : ''].filter(Boolean).join(' · ')
      // Only a coloured card gets a frame; a done one would get a grey one.
      const frame = boxed && t.color
        ? ({ borderStyle: 'round', borderColor: t.color, paddingX: 1 } as const)
        : ({ marginBottom: 1 } as const)
      return (
        <Box key={`s-${s.id}`} flexDirection="column" {...frame}>
          <Box>
            <Text color={t.color}>{t.glyph} </Text>
            <Text weight="bold" wrap="truncate-end">
              {s.name || s.id}
            </Text>
          </Box>
          <Box>
            <Text color={t.color}>{t.label}</Text>
            <Text wrap="truncate-end">
              {` · ${s.id} · ${ago(s.updatedAt, now)}`}
            </Text>
            {quiet ? <Text color="warning"> · quiet</Text> : null}
          </Box>
          {s.needsYou ? (
            <Text color="warning" wrap="truncate-end">
              {`→ ${s.next || 'waiting for your answer'}`}
            </Text>
          ) : null}
          {s.detail ? <Text wrap="truncate-end">{s.detail}</Text> : null}
          {s.prs.map(p => prRow(`pr-${s.id}-${p.number}`, p, inner))}
          {foot ? <Text wrap="truncate-end">{foot}</Text> : null}
          {!s.needsYou && s.next ? <Text wrap="truncate-end">{`next: ${s.next}`}</Text> : null}
          {!s.next && s.owns ? <Text wrap="truncate-end">{`owns: ${s.owns}`}</Text> : null}
        </Box>
      )
    }

    // A done session folded to one line, keeping the PRs it still holds in view.
    const folded = (s: SessionRow) => (
      <Text wrap="truncate-end">
        {`○ ${s.name || s.id} · ${ago(s.updatedAt, now)}${s.prs.length ? ` · ${s.prs.map(p => `#${p.number}`).join(' ')}` : ''}`}
      </Text>
    )

    // A count of nothing is left out rather than greyed.
    const count = (n: number, label: string, glyph: string, color?: string) =>
      n ? <Text color={color}>{`${glyph} ${n} ${label}`}</Text> : null

    return (
      <Box flexDirection="column">
        <Box columnGap={2} flexWrap="wrap" marginBottom={1}>
          {count(needs, 'needs you', '◆', 'warning')}
          {count(working, 'working', '●', 'success')}
          {count(done.length, 'done', '○')}
        </Box>
        {snap.error ? (
          <Text color="error" wrap="truncate-end">
            {snap.error}
          </Text>
        ) : null}
        {snap.sessions.length === 0 ? <Text>No sessions on this repo.</Text> : null}
        {live.map(card)}
        {done.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {doneOpen ? done.map(card) : done.map(folded)}
            <Button key="toggle-done" plain hotkey="d" onPress={() => void update($, showDone, v => !v)}>
              {doneOpen ? 'Fold done sessions' : `Show ${plural(done.length, 'done session')} in full`}
            </Button>
          </Box>
        ) : null}
        {snap.unownedPrs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text weight="bold">Open PRs no session owns</Text>
              <Text>{` ${snap.unownedPrs.length}`}</Text>
            </Box>
            {snap.unownedPrs.map(p => prRow(`free-${p.number}`, p, width))}
          </Box>
        ) : null}
        {snap.unusedTrees.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text weight="bold">Worktrees no session uses</Text>
              <Text>{` ${snap.unusedTrees.length}`}</Text>
            </Box>
            {treesOpen
              ? snap.unusedTrees.map(t => (
                  <Text wrap="truncate-end">
                    {`  ${treeName(t, snap.main)}${t.locked ? '  locked' : ''}`}
                  </Text>
                ))
              : null}
            {treesOpen ? <Text>  make prune lists the merged ones</Text> : null}
            <Button key="toggle-trees" plain hotkey="w" onPress={() => void update($, showTrees, v => !v)}>
              {treesOpen ? 'Hide them' : 'List them'}
            </Button>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Button key="refresh" plain hotkey="r" onPress={() => void refresh($)}>
            Refresh
          </Button>
          <Text>{` · checked ${ago(new Date(snap.fetchedAt).toISOString(), now)}`}</Text>
        </Box>
      </Box>
    )
  })
}

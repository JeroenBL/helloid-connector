import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

import type {
  ConfigField,
  Endpoint,
  Overview,
  Remote,
  RemoteItem,
  Review,
  ScriptGeneration,
  ScriptVersion,
} from '../types'

const PANE = 'helloid-connector'
const TITLE = 'Connector overview'
const overview = atom(
  { plugin: 'helloid-connector', key: 'overview' } as const,
  null,
)
// Set while /ai-reviewer runs: the connector and the files it has read so far.
const reviewing = atom({ plugin: 'helloid-connector', key: 'reviewing' } as const, null)
// Set while /connector-v1-v2 runs: the connector and the script it touched last.
const converting = atom({ plugin: 'helloid-connector', key: 'converting' } as const, null)
const notice = atom({ plugin: 'helloid-connector', key: 'notice' } as const, null)
const filter = atom({ plugin: 'helloid-connector', key: 'filter' } as const, '')

// The connector folder is the first path segment named HelloID-Conn-*.
const CONNECTOR = /^(.*?[\\/]HelloID-Conn-[^\\/]+)(?:[\\/](.*))?$/i
const NAME_PREFIX = /^HelloID-Conn-(Prov-(Target|Source)-|SA-[^-]+-)?/i
// backup-v1 is left over from earlier conversions; its V1 scripts are not the connector's.
const SKIPPED_DIRS = /^(\.|test$|node_modules$|backup-v1$)/i

// How much of the release timeline and the endpoint grid is drawn.
const TIMELINE_SHOWN = 6
const GRID_ROWS = 12
const GRID_CELL = 4

const LIFECYCLE = ['create', 'update', 'enable', 'disable', 'delete']
// By file name; V1 connectors list permissions in entitlements.ps1 and keep all
// three in the root, V2 ones keep them in a permissions folder.
const PERMISSION_KINDS: Record<string, string> = {
  'permissions.ps1': 'list',
  'entitlements.ps1': 'list',
  'grantpermission.ps1': 'grant',
  'revokepermission.ps1': 'revoke',
}
// One accent per card, so the panels tell apart; success, warning and error stay for state.
const PALETTE = {
  violet: '#A78BFA',
  sky: '#38BDF8',
  teal: '#2DD4BF',
  amber: '#FBBF24',
  rose: '#F472B6',
} as const

// One legend for where a release stands against GitHub, used by the sync note, the next step and the
// timeline: green in sync, amber behind, violet local only (ahead). The icons go with the colors.
const STATUS = {
  synced: { color: 'success', icon: '✓' },
  behind: { color: 'warning', icon: '↓' },
  ahead: { color: PALETTE.violet, icon: '↑' },
} as const

const METHOD_COLORS: Record<string, string> = {
  GET: PALETTE.sky,
  POST: '#4ADE80',
  PUT: PALETTE.amber,
  PATCH: PALETTE.amber,
  DELETE: '#F87171',
}

const NOTICE_COLORS = { info: 'suggestion', success: 'success', error: 'error' } as const

const join = (dir: string, name: string) =>
  `${dir.replace(/[\\/]+$/, '')}/${name}`

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

const shortName = (name: string) => name.replace(NAME_PREFIX, '') || name

const sameScript = (a: string | undefined, b: string) =>
  a !== undefined && a.toLowerCase() === b.toLowerCase()

// A connector folder is compared as text everywhere (the run, the pane, the review), and the same
// folder may be spelled `C:\code\X` by a command and `C:/code/X` by a tool call, or with another
// drive-letter case. The first spelling seen is the one every later path gets back.
const spellings = new Map<string, string>()

function canonicalRoot(root: string) {
  const key = root.replace(/[\\/]+/g, '/').toLowerCase()
  const known = spellings.get(key)
  if (known !== undefined) return known
  spellings.set(key, root)

  return root
}

function locate(path: string) {
  const match = CONNECTOR.exec(path)
  if (!match?.[1]) return undefined
  const rest = match[2]

  return {
    root: canonicalRoot(match[1]),
    action: rest !== undefined && /\.ps1$/i.test(rest) ? rest.replace(/\\/g, '/') : undefined,
  }
}

type Scan = {
  scripts: string[]
  files: string[]
  fileStamps: Record<string, string>
  stamp: string
  changelog?: string
}

// Every .ps1 up to three folders deep, as paths relative to the connector. The
// stamp changes when a script or configuration.json does, so unchanged
// connectors need no re-read.
async function scan($: EngineInterface, root: string, prefix = '', depth = 0): Promise<Scan> {
  const entries = await $.fs.list(prefix ? join(root, prefix) : root).catch(() => [])
  const scripts: string[] = []
  const stamp: string[] = []
  const files: string[] = []
  const fileStamps: Record<string, string> = {}
  let changelog: string | undefined
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    const isScript = entry.kind === 'file' && /\.ps1$/i.test(entry.name)
    // The root's other files (json, md, …); hidden ones such as .gitignore are left out.
    if (!prefix && entry.kind === 'file' && !isScript && !entry.name.startsWith('.')) {
      files.push(entry.name)
      fileStamps[entry.name] = `${entry.mtimeMs}:${entry.size}`
    }
    if (!prefix && entry.kind === 'file' && /^changelog\.md$/i.test(entry.name)) changelog = entry.name
    if (isScript || (!prefix && /^(configuration\.json|changelog\.md)$/i.test(entry.name))) {
      stamp.push(`${path}:${entry.mtimeMs}:${entry.size}`)
    }
    if (isScript) scripts.push(path)
    if (entry.kind === 'dir' && depth < 2 && !SKIPPED_DIRS.test(entry.name)) {
      const inner = await scan($, root, path, depth + 1)
      scripts.push(...inner.scripts)
      stamp.push(inner.stamp)
    }
  }

  return {
    scripts: scripts.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)),
    files,
    fileStamps,
    stamp: stamp.join('|'),
    changelog,
  }
}

// Files a connector is expected to have, shown even when one is missing.
const EXPECTED_FILES = ['configuration.json', 'fieldMapping.json', 'README.md', 'CHANGELOG.md']

const sameFile = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// Every release heading of a CHANGELOG.md, in the order written (newest first).
const parseReleases = (text: string) =>
  [...text.matchAll(/^##\s*\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/gm)].map(one => one[1])

async function readReleases($: EngineInterface, root: string, changelog: string | undefined) {
  if (!changelog) return []

  return parseReleases(await $.fs.read(join(root, changelog)).catch(() => ''))
}

// Negative when a is older than b, positive when newer; major.minor.patch only.
function compareVersions(a: string, b: string) {
  const parts = (version: string) => version.split(/[.+-]/).slice(0, 3).map(part => parseInt(part, 10) || 0)
  const [left, right] = [parts(a), parts(b)]
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }

  return 0
}

// The one thing worth doing next, from what the pane already knows; the text names the button
// that does it. Nothing while an action runs or before GitHub has answered.
type NextStep = { text: string; color: string }

function nextStep(current: Overview, isBusy: boolean): NextStep | undefined {
  const { remote, release, review } = current
  if (isBusy || remote?.state !== 'ok') return undefined

  const waiting = remote.items?.filter(one => one.kind === 'pr' && one.isReviewRequested && !one.isDraft).length ?? 0
  const behind = release && remote.version ? compareVersions(release, remote.version) < 0 : false
  const ahead = release && remote.version ? compareVersions(release, remote.version) > 0 : false

  if (review && review.total > 0) return { text: `${review.total} review findings: fix them before a release`, color: 'error' }
  if (behind) return { text: `Behind GitHub: ⇩ Download v${remote.version}`, color: STATUS.behind.color }
  if (current.hasConverter && current.version && current.version !== 'V2') {
    return { text: 'Still on V1: ⇢ Convert to V2', color: 'warning' }
  }
  if (waiting > 0) return { text: `${waiting} pull request${waiting === 1 ? '' : 's'} waiting for review`, color: PALETTE.rose }
  if (ahead) return { text: `Ahead of GitHub: release v${release} is not published yet`, color: STATUS.ahead.color }

  return { text: `${STATUS.synced.icon} Up to date`, color: STATUS.synced.color }
}

type Release = { version: string; isLocal: boolean; isRemote: boolean }

// The releases of both changelogs, oldest first, each marked with where it exists.
function releaseTimeline(current: Overview): Release[] {
  const local = new Set(current.releases)
  const remote = new Set(current.remote?.releases ?? [])
  const all = [...new Set([...local, ...remote])].sort(compareVersions)

  return all.map(version => ({ version, isLocal: local.has(version), isRemote: remote.has(version) }))
}

// Endpoints against the scripts that call them: one row per method and path.
type HeatRow = { method: string; path: string; scripts: Set<string> }

function heatRows(endpoints: Endpoint[]): HeatRow[] {
  const rows = new Map<string, HeatRow>()
  for (const one of endpoints) {
    const key = `${one.method} ${one.path}`
    const row = rows.get(key) ?? { method: one.method, path: one.path, scripts: new Set<string>() }
    row.scripts.add(one.script)
    rows.set(key, row)
  }

  return [...rows.values()]
}

// Three letters for a column head: create.ps1 becomes "cre".
const scriptHead = (script: string) => script.replace(/\.ps1$/i, '').slice(0, 3).toLowerCase()

// The public connector repositories; the folder name is the repository name.
const GITHUB_ORG = 'Tools4everBV'
const GITHUB_RAW = `https://raw.githubusercontent.com/${GITHUB_ORG}`
const GITHUB_API = `https://api.github.com/repos/${GITHUB_ORG}`
const REMOTE_TTL_MS = 10 * 60 * 1000

// GitHub answers a rate limit with 403 (the API) or 429 (raw files).
const isRateLimit = (response: { status: number } | undefined) => response?.status === 403 || response?.status === 429

// The last answer and its ETag per URL. A conditional GET that GitHub answers with 304 does not
// count against the rate limit, so a list that has not changed costs nothing to ask for again.
const etags = new Map<string, { etag: string; response: HttpResponse }>()

async function fetchConditional($: EngineInterface, url: string): Promise<HttpResponse | undefined> {
  const cached = etags.get(url)
  const response = await $.http
    .fetch(url, cached ? { headers: { 'If-None-Match': cached.etag } } : undefined)
    .catch(() => undefined)
  if (response?.status === 304 && cached) return cached.response
  if (response?.ok && response.headers.etag) etags.set(url, { etag: response.headers.etag, response })

  return response
}

// The open issues and pull requests. GitHub's issues list carries both; the pull request
// list adds what the issues list lacks (a draft, and requested reviewers), so it is only asked
// for when the issues list holds a pull request.
async function fetchItems($: EngineInterface, name: string): Promise<RemoteItem[] | 'limited' | undefined> {
  const base = `${GITHUB_API}/${encodeURIComponent(name)}`
  const issues = await fetchConditional($, `${base}/issues?state=open&per_page=30`)
  if (!issues?.ok) return isRateLimit(issues) ? 'limited' : undefined

  try {
    const rows = JSON.parse(issues.text) as {
      number: number
      title: string
      html_url: string
      pull_request?: unknown
    }[]
    const pulls = rows.some(row => row.pull_request)
      ? await fetchConditional($, `${base}/pulls?state=open&per_page=30`)
      : undefined
    const details = new Map<number, { isDraft: boolean; isReviewRequested: boolean }>()
    if (pulls?.ok) {
      const list = JSON.parse(pulls.text) as {
        number: number
        draft?: boolean
        requested_reviewers?: unknown[]
        requested_teams?: unknown[]
      }[]
      for (const one of list) {
        details.set(one.number, {
          isDraft: one.draft === true,
          isReviewRequested: (one.requested_reviewers?.length ?? 0) + (one.requested_teams?.length ?? 0) > 0,
        })
      }
    }

    const items = rows.map((row): RemoteItem => ({
      kind: row.pull_request ? 'pr' : 'issue',
      number: row.number,
      title: row.title,
      url: row.html_url,
      ...(row.pull_request ? details.get(row.number) : undefined),
    }))
    // Pull requests first: they are waiting on someone.
    return [...items.filter(one => one.kind === 'pr'), ...items.filter(one => one.kind === 'issue')]
  } catch {
    return undefined
  }
}

// The repository counts as there when it has a CHANGELOG.md (which also gives the releases) or,
// failing that, a README.md: a connector without a changelog is still on GitHub.
async function fetchRemote($: EngineInterface, name: string): Promise<Remote> {
  // raw.githubusercontent.com is case-sensitive, and some repositories spell them in lower case.
  for (const file of ['CHANGELOG.md', 'changelog.md', 'README.md', 'readme.md']) {
    for (const branch of ['main', 'master']) {
      const response = await $.http
        .fetch(`${GITHUB_RAW}/${encodeURIComponent(name)}/${branch}/${file}`)
        .catch(() => undefined)
      if (!response) return { state: 'unavailable' }
      if (response.ok) {
        const releases = /^changelog/i.test(file) ? parseReleases(response.text) : []

        const items = await fetchItems($, name)

        return {
          state: 'ok',
          version: releases[0],
          releases,
          items: items === 'limited' ? undefined : items,
          isLimited: items === 'limited',
          at: Date.now(),
        }
      }
      if (response.status !== 404) return { state: 'unavailable', isLimited: isRateLimit(response) }
    }
  }

  return { state: 'missing' }
}

// The last answer per connector; `at` is set when a fetch starts, so one runs at a time.
const remotes = new Map<string, { at: number; value?: Remote }>()

// Runs behind the load, so the pane never waits for GitHub; the answer is
// merged into the overview when it arrives.
async function refreshRemote($: EngineInterface, root: string, isForced = false) {
  const cached = remotes.get(root)
  if (!isForced && cached && Date.now() - cached.at < REMOTE_TTL_MS) return
  remotes.set(root, { at: Date.now(), value: cached?.value })
  const value = await fetchRemote($, baseName(root))
  remotes.set(root, { at: Date.now(), value })
  await update($, overview, current => (current?.root === root ? { ...current, remote: value } : current))
}

// A Uri = '…' / -Uri "…" / -Uri $var in a script; the Method sits in the same
// statement. `$uri = '…'` is a plain assignment, resolved when -Uri $uri uses it.
const URI_ARG = /(?:(?<!\$)\bUri\b\s*=|-Uri\s+)\s*(?:(["'])((?:(?!\1)[^\r\n])*)\1|\$(\w+))/gi
const METHOD_ARG = /(?:(?<!\$)\bMethod\b\s*=|-Method\s+)\s*(?:["']?(GET|POST|PUT|PATCH|DELETE|HEAD)\b|\$(\w+))/i
// A whole-line `$var = "…"`; the value runs to the last quote, so quotes inside a $( … ) are fine.
const ASSIGNMENT = /^[ \t]*\$(\w+)[ \t]*=[ \t]*(["'])(.*)\2[ \t]*$/gim
const BASE_URL = /base|url|uri|host|server|endpoint/i

// What a `$( … )` or `$name` stands for: the base URL (dropped) or a {name} placeholder.
// Quoted strings and method calls are left out, so `$url.trim("/")` reads as `url`
// and `$account.AccountId` as `AccountId`.
function placeholder(expression: string) {
  let bare = expression.replace(/"[^"]*"|'[^']*'/g, '')
  for (let before = ''; before !== bare; ) {
    before = bare
    bare = bare.replace(/\.\w+\([^()]*\)/g, '')
  }
  const word = bare.match(/[A-Za-z_]\w*(?=\W*$)/)?.[0] ?? '?'

  return BASE_URL.test(word) ? '' : `{${word}}`
}

// "$($config.BaseUrl)/users/$($id)?x=1" becomes "/users/{id}".
function endpointPath(uri: string) {
  let path = ''
  for (let index = 0; index < uri.length; ) {
    if (uri[index] === '$' && uri[index + 1] === '(') {
      // The matching ")", with nested parentheses (and quotes inside them) counted.
      let depth = 0
      let close = index + 1
      for (; close < uri.length; close++) {
        if (uri[close] === '(') depth++
        else if (uri[close] === ')' && --depth === 0) break
      }
      path += placeholder(uri.slice(index + 2, close))
      index = close + 1
      continue
    }
    const variable = uri[index] === '$' ? /^\$\{?(\w+)\}?/.exec(uri.slice(index)) : null
    if (variable) {
      path += placeholder(variable[1] ?? '')
      index += variable[0].length
      continue
    }
    path += uri[index]
    index++
  }
  path = path.replace(/^https?:\/\/[^/]+/i, '').replace(/\?.*$/, '')

  return path.startsWith('/') ? path : `/${path}`
}

// The text of the call a Uri belongs to: the enclosing @{ … } splat when the Uri
// is a hashtable entry, otherwise the statement (backtick continuations included).
function statementAround(text: string, at: number, isInline: boolean): string {
  const hashStart = isInline ? -1 : text.lastIndexOf('@{', at)
  if (hashStart >= 0 && !/\n[ \t]*\}/.test(text.slice(hashStart, at))) {
    const close = /\n[ \t]*\}|\}[ \t]*(?:\r?\n|$)/.exec(text.slice(at))

    return text.slice(hashStart, close ? at + close.index : text.length)
  }
  let start = text.lastIndexOf('\n', at) + 1
  while (start > 0) {
    const previousStart = text.lastIndexOf('\n', start - 2) + 1
    if (!text.slice(previousStart, start).trimEnd().endsWith('`')) break
    start = previousStart
  }
  let end = text.indexOf('\n', at)
  while (end >= 0 && text.slice(0, end).trimEnd().endsWith('`')) end = text.indexOf('\n', end + 1)

  return text.slice(start, end < 0 ? text.length : end)
}

function endpointsIn(script: string, text: string) {
  const found: Endpoint[] = []
  const assignments = [...text.matchAll(ASSIGNMENT)].map(one => ({
    name: (one[1] ?? '').toLowerCase(),
    index: one.index ?? 0,
    value: one[3] ?? '',
  }))
  // The value a variable holds at a position: its last plain assignment before it.
  const valueOf = (name: string, at: number) =>
    assignments.filter(one => one.name === name.toLowerCase() && one.index < at).at(-1)?.value

  for (const match of text.matchAll(URI_ARG)) {
    const at = match.index ?? 0
    const uri = match[3] === undefined ? match[2] : valueOf(match[3], at)
    if (uri === undefined) continue
    const call = METHOD_ARG.exec(statementAround(text, at, /^-Uri/i.test(match[0])))
    const method = call?.[1] ?? (call?.[2] ? valueOf(call[2], at) : undefined)
    found.push({ script, method: (method ?? 'GET').toUpperCase(), path: endpointPath(uri) })
  }

  return found
}

// $actionContext / $outputContext are V2; $p, $aRef, $pp and friends are V1.
const V2_MARKER = /\$(actionContext|outputContext)\b/i
const V1_MARKER = /\$(aRef|pp)\b|\$p\.|\$auditLogs\b/i

const generationOf = (text: string): ScriptGeneration | undefined =>
  V2_MARKER.test(text) ? 'V2' : V1_MARKER.test(text) ? 'V1' : undefined

function detectVersion(generations: ScriptGeneration[]): ScriptVersion | undefined {
  const isV2 = generations.includes('V2')
  const isV1 = generations.includes('V1')
  if (isV2 && isV1) return 'mixed'

  return isV2 ? 'V2' : isV1 ? 'V1' : undefined
}

async function readScripts($: EngineInterface, root: string, scripts: string[]) {
  const texts = await Promise.all(
    scripts.map(async script => [script, await $.fs.read(join(root, script)).catch(() => '')] as const),
  )
  const seen = new Set<string>()
  const endpoints = texts
    .flatMap(([script, text]) => endpointsIn(script, text))
    .filter(one => {
      const key = `${one.script}|${one.method}|${one.path}`
      if (seen.has(key)) return false
      seen.add(key)

      return true
    })

  const scriptVersions: Record<string, ScriptGeneration> = {}
  for (const [script, text] of texts) {
    const generation = generationOf(text)
    if (generation) scriptVersions[script] = generation
  }

  return { endpoints, scriptVersions, version: detectVersion(Object.values(scriptVersions)) }
}

type RawConfig = {
  key?: string
  type?: string
  defaultValue?: unknown
  templateOptions?: { label?: string; type?: string; required?: boolean }
}

// The settings of configuration.json; a password default is never shown.
async function readConfig($: EngineInterface, root: string) {
  const path = join(root, 'configuration.json')
  if (!(await $.fs.exists(path))) return { config: [], note: 'No configuration.json' }
  try {
    const raw = JSON.parse((await $.fs.read(path)).replace(/^﻿/, '')) as RawConfig[]
    const config: ConfigField[] = raw.map(field => {
      const isSecret = field.templateOptions?.type === 'password'
      const value = field.defaultValue

      return {
        key: field.key ?? '?',
        kind: isSecret ? 'password' : (field.type ?? '?'),
        label: field.templateOptions?.label ?? '',
        required: field.templateOptions?.required === true,
        value: isSecret || value === undefined || value === null ? '' : String(value),
      }
    })

    return { config, note: undefined }
  } catch {
    return { config: [], note: 'configuration.json does not parse' }
  }
}

// The result /ai-reviewer leaves outside the connector, in ~/.claude/ai-reviews/<connector>.json.
async function readReview($: EngineInterface, name: string): Promise<Review | undefined> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (!home) return undefined
    const raw = JSON.parse(await $.fs.read(join(home, `.claude/ai-reviews/${name}.json`))) as Partial<Review>
    if (typeof raw.total !== 'number') return undefined

    return {
      reviewedAt: raw.reviewedAt ?? '',
      scope: raw.scope ?? '',
      total: raw.total,
      bySeverity: raw.bySeverity ?? {},
      openPoints: raw.openPoints ?? 0,
    }
  } catch {
    return undefined
  }
}

type Analysis = {
  stamp: string
  endpoints: Endpoint[]
  version: ScriptVersion | undefined
  scriptVersions: Record<string, ScriptGeneration>
  releases: string[]
  config: ConfigField[]
  configNote: string | undefined
}

// What the scripts and configuration.json yielded, per connector, until their stamp changes.
const analyses = new Map<string, Analysis>()

// The review file is small and changes without touching the connector, so it is
// always read again; the scripts are only parsed again when they changed.
// A plugin's command may carry its plugin as a prefix (`plugin:ai-reviewer`).
async function hasCommand($: EngineInterface, name: string) {
  const commands = await $.command.list().catch(() => [])

  return commands.some(one => one.name === name || one.name.endsWith(`:${name}`))
}

async function load($: EngineInterface, root: string, action: string | undefined, isForced = false) {
  const { scripts, files, fileStamps, stamp, changelog } = await scan($, root)
  let analysis = analyses.get(root)
  if (isForced || analysis?.stamp !== stamp) {
    const [parsed, configuration, releases] = await Promise.all([
      readScripts($, root, scripts),
      readConfig($, root),
      readReleases($, root, changelog),
    ])
    analysis = {
      stamp,
      endpoints: parsed.endpoints,
      version: parsed.version,
      scriptVersions: parsed.scriptVersions,
      releases,
      config: configuration.config,
      configNote: configuration.note,
    }
    analyses.set(root, analysis)
  }
  const name = baseName(root)
  const next: Overview = {
    root,
    name,
    action,
    version: analysis.version,
    scriptVersions: analysis.scriptVersions,
    files,
    fileStamps,
    release: analysis.releases[0],
    releases: analysis.releases,
    remote: remotes.get(root)?.value,
    hasReviewer: await hasCommand($, 'ai-reviewer'),
    hasConverter: await hasCommand($, 'connector-v1-v2'),
    scripts,
    endpoints: analysis.endpoints,
    config: analysis.config,
    configNote: analysis.configNote,
    review: await readReview($, name),
  }
  await update($, overview, () => next)
  void refreshRemote($, root).catch(() => undefined)

  return next
}

// Sets the line under the header; it replaces the one before and stays until dismissed.
const notify = (
  $: EngineInterface,
  root: string,
  text: string,
  tone: 'info' | 'success' | 'error' = 'info',
  open?: string,
) => update($, notice, () => ({ root, text, tone, open }))

// The command of the editor that is running (stable, Insiders, a preview, Cursor, …), found
// from its open window: the one titled with the connector's folder, else the first. Plain
// `code` would reach whichever install is first on the PATH, not the one that is open.
// Windows only; elsewhere, and when no window is found, this is undefined.
async function runningEditor($: EngineInterface, root: string): Promise<string | undefined> {
  if (!/^[A-Za-z]:/.test(root)) return undefined
  const script =
    "Get-Process | Where-Object { $_.MainWindowTitle -and $_.Path -match '\\\\(Code[^\\\\]*|Cursor)\\.exe$' } | " +
    'Select-Object Path, MainWindowTitle | ConvertTo-Json -Compress'
  const ran = await $.process.run(['powershell.exe', '-NoProfile', '-Command', script]).catch(() => undefined)
  if (ran?.exitCode !== 0 || !ran.stdout.trim()) return undefined

  try {
    const parsed = JSON.parse(ran.stdout) as { Path: string; MainWindowTitle: string } | { Path: string; MainWindowTitle: string }[]
    const windows = Array.isArray(parsed) ? parsed : [parsed]
    const folder = baseName(root).toLowerCase()
    const open = windows.find(one => one.MainWindowTitle.toLowerCase().includes(folder)) ?? windows[0]
    const bin = join(open.Path.replace(/[\\/][^\\/]*$/, ''), 'bin')
    const entries = await $.fs.list(bin).catch(() => [])
    const cli = entries.map(entry => entry.name).find(name => /^[\w-]+\.cmd$/i.test(name))
    return cli ? join(bin, cli) : undefined
  } catch {
    return undefined
  }
}

// Opens a file or folder in the editor that is running; `code` is a .cmd shim on Windows, so it
// goes through PowerShell (a path with spaces is quoted there), or through cmd when none is found.
async function openPath($: EngineInterface, root: string, path: string) {
  const cli = await runningEditor($, root)
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const argv = cli
    ? ['powershell.exe', '-NoProfile', '-Command', `& ${quote(cli)} -r ${quote(path)}`]
    : /^[A-Za-z]:/.test(root)
      ? ['cmd.exe', '/d', '/c', 'code', '-r', path]
      : ['code', '-r', path]
  const ran = await $.process.run(argv).catch(() => undefined)
  if (ran?.exitCode !== 0) await notify($, root, `Could not open ${baseName(path)} in VS Code`, 'error')
}

const openScript = ($: EngineInterface, root: string, script: string) =>
  openPath($, root, join(root, script))

// Connectors whose download is running, so a second press does not start another.
const downloading = new Set<string>()

// What the model is told, beside the prompt, when a conversion starts.
const CONVERT_CONTEXT =
  `Convert the scripts in place in the connector's root folder, overwriting each V1 script with its V2 ` +
  `version; do not create new or renamed copies of scripts beside the originals, and never move or delete ` +
  `a script (not even for a moment).`

// Starts tracking the conversion.
async function startConversion($: EngineInterface, root: string): Promise<void> {
  // The plan is taken before anything is touched.
  const seen = await read($, overview)
  const before = await load($, root, seen?.root === root ? seen.action : undefined)
  const planned = Object.keys(before.scriptVersions)
  // How the tracked documents stand now; one written later counts as done.
  const docs: Record<string, string> = {}
  for (const name of TRACKED_DOCS) {
    const stamp = docStamp(before, name)
    if (stamp !== undefined) docs[name] = stamp
  }
  await update($, converting, () => ({ root, planned, docs }))
}

// A conversion is counted against the scripts it started with; a script that is
// gone from disk for a while, or reappears under another name, is still pending.
const pendingScripts = (loaded: Overview, planned: string[]) =>
  (planned.length > 0 ? planned : Object.keys(loaded.scriptVersions)).filter(
    script => loaded.scriptVersions[script] !== 'V2',
  )

// The documents a conversion writes besides the scripts: the V2 field mapping,
// and the README that describes the connector. Each is done once it was written
// again (or created), not merely because it exists.
const TRACKED_DOCS = ['fieldMapping.json', 'README.md']

const docStamp = (loaded: Overview, name: string) => {
  const file = loaded.files.find(one => sameFile(one, name))

  return file === undefined ? undefined : loaded.fileStamps[file]
}

const isDocDone = (loaded: Overview, run: Converting, name: string) => {
  const now = docStamp(loaded, name)

  return now !== undefined && now !== run.docs[name]
}

// Says where a conversion stands, at the end of a turn. That a turn ends does not
// end the conversion (it can go on over several turns), so tracking only stops
// once every script is on V2 and every tracked document is written; until then
// the line names what is still waiting. Reporting at the turn's end, and not at
// the last script, is what keeps the README and the field mapping inside it.
async function reportConversion($: EngineInterface, loaded: Overview, run: Converting) {
  const scripts = run.planned.length > 0 ? run.planned.length : Object.keys(loaded.scriptVersions).length
  const total = scripts + TRACKED_DOCS.length
  const waiting = [
    ...pendingScripts(loaded, run.planned).map(script => script.replace(/\.ps1$/i, '')),
    ...TRACKED_DOCS.filter(name => !isDocDone(loaded, run, name)),
  ]
  if (waiting.length === 0 && scripts > 0) {
    await update($, converting, () => null)
    await notify($, run.root, `Converted to V2: ${scripts} scripts, ${TRACKED_DOCS.join(' and ')} written`, 'success')
    return
  }
  const more = waiting.length > 3 ? ` +${waiting.length - 3}` : ''
  await notify(
    $,
    run.root,
    `Paused: ${total - waiting.length} of ${total} done · waiting: ${waiting.slice(0, 3).join(', ')}${more}`,
  )
}

// Clones the GitHub repository into a new sibling folder named after the
// release (<connector>-v1.3.0). An existing folder is never written to.
async function downloadRelease($: EngineInterface, root: string, version: string) {
  const name = baseName(root)
  const parent = root.replace(/[\\/][^\\/]+$/, '')
  // The version comes from a file on GitHub, so it may not carry path characters.
  const dest = join(parent, `${name}-v${version.replace(/[^\w.+-]/g, '')}`)
  if (downloading.has(root)) return
  if (await $.fs.exists(dest).catch(() => false)) {
    await notify($, root, `${baseName(dest)} already exists; nothing downloaded`, 'info', dest)
    return
  }
  downloading.add(root)
  try {
    await notify($, root, `Downloading v${version} to ${baseName(dest)}…`)
    const argv = ['git', 'clone', '--depth', '1', '--', `https://github.com/${GITHUB_ORG}/${name}.git`, dest]
    const ran = await $.process.run(argv, { cwd: parent, timeoutMs: 120_000 }).catch(() => undefined)
    if (ran?.exitCode === 0) {
      await notify($, root, `Downloaded v${version} to ${dest}`, 'success', dest)
    } else {
      const reason = ran?.stderr.trim().split(/\r?\n/).at(-1)
      await notify($, root, `Download failed: ${reason || 'is git installed?'}`, 'error')
    }
  } finally {
    downloading.delete(root)
  }
}

// Starts a Keep a Changelog file with a first release; an existing file is never written to.
async function createChangelog($: EngineInterface, root: string) {
  const path = join(root, 'CHANGELOG.md')
  if (await $.fs.exists(path).catch(() => false)) {
    await notify($, root, 'CHANGELOG.md already exists; nothing written', 'info', path)
    return
  }
  const text =
    '# Change Log\n\nAll notable changes to this project will be documented in this file.\n\n' +
    'The format is based on [Keep A Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to ' +
    '[Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n' +
    `## [1.0.0] - ${new Date().toISOString().slice(0, 10)}\n\n### Added\n\n- Initial release\n`
  try {
    await $.fs.write(path, text)
    await notify($, root, 'Created CHANGELOG.md with release 1.0.0', 'success', path)
    await load($, root, undefined, true)
  } catch {
    await notify($, root, 'Could not create CHANGELOG.md', 'error')
  }
}

// A prompt a plugin submits is not run as a slash command, so the command is put
// in the prompt box for the person to send.
async function fillCommand($: EngineInterface, command: string, root: string, what: string) {
  const filled = await $.prompt.fill({ text: `/${command} ${root}`, mode: 'replace' }).catch(() => undefined)
  await (filled?.isFilled
    ? notify($, root, `Press Enter to start ${what}`)
    : notify($, root, `Could not fill the prompt; run /${command} yourself`, 'error'))
}

const reviewConnector = ($: EngineInterface, root: string) =>
  fillCommand($, 'ai-reviewer', root, 'the AI review')

const convertConnector = ($: EngineInterface, root: string) =>
  fillCommand($, 'connector-v1-v2', root, 'the V1 to V2 conversion')

// The pane opens by itself once per load, the first time a connector shows up.
let hasOpened = false

async function show($: EngineInterface) {
  if (hasOpened) return
  hasOpened = true
  await $.ui.open({ id: PANE, title: TITLE })
}

// Opens the pane whether or not it was opened before.
async function reveal($: EngineInterface) {
  hasOpened = true
  await $.ui.open({ id: PANE, title: TITLE })
}

// The working directory last looked at, so a /cd or folder switch is noticed,
// and the connector it was in.
let lastCwd: string | undefined
let lastCwdRoot: string | undefined

// Follows the working directory; true when it entered another connector.
async function entersConnector($: EngineInterface, cwd: string) {
  const before = lastCwdRoot
  const loaded = await followCwd($, cwd)

  return loaded !== undefined && loaded.root !== before
}

// Loads the connector the working directory sits in, when it moved into one.
async function followCwd($: EngineInterface, cwd: string, isForced = false) {
  if (!isForced && cwd === lastCwd) return undefined
  lastCwd = cwd
  const found = locate(cwd)
  lastCwdRoot = found?.root
  if (!found) return undefined
  const current = await read($, overview)
  const action = current?.root === found.root ? current.action : found.action

  return load($, found.root, action)
}

type Chip = { label: string; script?: string }

// Splits the scripts into the lifecycle, permission sets and everything else.
function groupScripts(scripts: string[]) {
  const lifecycle: Chip[] = LIFECYCLE.map(action => ({
    label: action.charAt(0).toUpperCase() + action.slice(1),
    script: scripts.find(script => sameScript(script, `${action}.ps1`)),
  }))
  const sets = new Map<string, Chip[]>()
  const others: Chip[] = []
  for (const script of scripts) {
    if (lifecycle.some(chip => chip.script === script)) continue
    const parts = script.split('/')
    const file = parts.at(-1) ?? script
    const isInPermissionsFolder = parts[0]?.toLowerCase() === 'permissions' && parts.length <= 3
    // A permission script in the root, recognised by its name.
    const isRootPermission = parts.length === 1 && PERMISSION_KINDS[file.toLowerCase()] !== undefined
    if (isInPermissionsFolder || isRootPermission) {
      const set = parts.length === 3 ? (parts[1] ?? 'permissions') : 'permissions'
      const chips = sets.get(set) ?? []
      chips.push({ label: PERMISSION_KINDS[file.toLowerCase()] ?? file.replace(/\.ps1$/i, ''), script })
      sets.set(set, chips)
    } else {
      others.push({ label: script.replace(/\.ps1$/i, ''), script })
    }
  }

  return { lifecycle, sets: [...sets], others }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'connector-overview',
      description: 'Show the HelloID connector overview pane',
    })
    if (await entersConnector($, e.cwd)) await reveal($)

    return next(e)
  })

  // Moving into a connector folder (/cd, the app's folder switch) opens the
  // pane again, even when it was closed for the previous one.
  on('classic.CwdChanged', async ($, e, next) => {
    if (await entersConnector($, e.new_cwd)) await reveal($)

    return next(e)
  })

  // A fallback for a folder change that raised no CwdChanged.
  on('turn.start', async ($, e, next) => {
    if (await entersConnector($, await $.session.cwd())) await reveal($)
    // A conversion carries on over turns; scripts written meanwhile (by a
    // subagent, say) show up when the next turn starts.
    const run = await read($, converting)
    if (run) {
      const seen = await read($, overview)
      await load($, run.root, seen?.root === run.root ? seen.action : undefined)
    }

    return next(e)
  })

  // A review starts with the /ai-reviewer command; its argument is the connector.
  on('prompt.submit', async ($, e, next) => {
    if (/^\/ai-reviewer\b/i.test(e.text)) {
      const seen = await read($, overview)
      const root =
        locate(e.text.replace(/^\/ai-reviewer\s*/i, ''))?.root ??
        seen?.root ??
        locate(await $.session.cwd())?.root
      if (root) await update($, reviewing, () => ({ root, files: [] }))
    }
    // A conversion starts the same way, with /connector-v1-v2 <connector>.
    if (/^\/connector-v1-v2\b/i.test(e.text)) {
      const seen = await read($, overview)
      const root =
        locate(e.text.replace(/^\/connector-v1-v2\s*/i, ''))?.root ??
        seen?.root ??
        locate(await $.session.cwd())?.root
      if (root) {
        await startConversion($, root)

        return next({ ...e, context: [...(e.context ?? []), CONVERT_CONTEXT] })
      }
    }

    return next(e)
  })

  // A review or conversion ends in a turn; pick up what it just wrote, and say
  // how far a conversion got.
  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends this way too; only the main loop's end is the end of a run.
    const isMain = e.agentId === undefined
    if (isMain) await update($, reviewing, () => null)
    const run = await read($, converting)
    const seen = await read($, overview)
    const loaded = seen ? await load($, seen.root, seen.action) : undefined
    if (isMain && run && loaded?.root === run.root) await reportConversion($, loaded, run)

    return next(e)
  })

  on('command.run', { command: 'connector-overview' }, async $ => {
    let current = await followCwd($, await $.session.cwd(), true)
    if (!current) {
      const seen = await read($, overview)
      current = seen ? await load($, seen.root, seen.action) : undefined
    }
    hasOpened = true
    await $.ui.open({ id: PANE, title: TITLE })
    // Running the command asks GitHub again, whatever was cached.
    if (current) void refreshRemote($, current.root, true).catch(() => undefined)

    return {
      text: current
        ? `Showing ${current.name}.`
        : 'No HelloID-Conn-* folder here or seen yet; open a connector file to fill the pane.',
    }
  })

  on('tool.call', async ($, e, next) => {
    const path =
      e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : undefined
    const found = path === undefined ? undefined : locate(path)
    // A file counts as under review the moment its Read starts, before the call returns.
    if (found && path !== undefined && e.tool === 'Read') {
      const active = await read($, reviewing)
      if (active && active.root === found.root) {
        const file = path.slice(found.root.length + 1).replace(/\\/g, '/')
        if (file) {
          await update($, reviewing, list =>
            list && !list.files.includes(file) ? { ...list, files: [...list.files, file] } : list,
          )
        }
      }
    }
    // The conversion may also start through the Skill tool, without a typed command.
    if (e.tool === 'Skill' && /connector-v1-v2$/i.test(e.skill) && !(await read($, converting))) {
      const root = (await read($, overview))?.root ?? locate(await $.session.cwd())?.root
      if (root) await startConversion($, root)
    }
    const ran = await next(e)

    // While converting, every tool call may have changed a script (Bash too), so
    // the pane is brought up to date; unchanged connectors cost one folder listing.
    const run = await read($, converting)
    if (run) {
      const file = found && path !== undefined && e.tool !== 'Read' && found.root === run.root
        ? path.slice(found.root.length + 1).replace(/\\/g, '/')
        : undefined
      if (file) {
        await update($, converting, one => (one ? { ...one, current: file } : one))
      }
      const seen = await read($, overview)
      await load($, run.root, found?.action ?? (seen?.root === run.root ? seen.action : undefined))
    }
    if (!found) return ran

    const current = await read($, overview)
    const isWrite = e.tool !== 'Read'
    const action = found.action ?? (current?.root === found.root ? current.action : undefined)
    if (current?.root !== found.root || current.action !== action || isWrite) {
      await load($, found.root, action, isWrite)
      await show($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Link } = elements
    // Not every surface draws a text field; there the filter is left out.
    const Input = 'Input' in elements ? elements.Input : undefined
    const current = await read($, overview)

    if (!current) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No HelloID connector yet.</Text>
          <Text dimColor>Open a file in a HelloID-Conn-* folder, or run /connector-overview.</Text>
        </Box>
      )
    }

    const active = await read($, reviewing)
    const reviewFiles = active?.root === current.root ? active.files : undefined
    const conversion = await read($, converting)
    const convert = conversion?.root === current.root ? conversion : undefined
    // While converting, scripts are counted against the plan made at the start,
    // not against whatever is on disk at the moment.
    const planned = convert?.planned ?? []
    const tracked = planned.length > 0 ? planned : Object.keys(current.scriptVersions)
    const onV2 = tracked.filter(script => current.scriptVersions[script] === 'V2').length
    // The documents a conversion writes count as steps of their own.
    const docRows = convert ? TRACKED_DOCS.map(name => [name, isDocDone(current, convert, name)] as const) : []
    const done = onV2 + docRows.filter(([, isDone]) => isDone).length
    const total = tracked.length + docRows.length
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    const BAR_WIDTH = 20
    const barFilled = Math.round((percent / 100) * BAR_WIDTH)
    // Planned scripts that are off the disk right now stay listed, as waiting.
    const missing = planned.filter(script => !current.scripts.includes(script))
    const convertRows = tracked.map(
      script => [script, current.scriptVersions[script] ?? 'V1', current.scripts.includes(script)] as const,
    )
    const typed = await read($, filter)
    const query = typed.trim().toLowerCase()
    const { lifecycle, sets, others } = groupScripts([...current.scripts, ...missing])

    // Flightdeck-style panel: a coloured round frame, the title on the left and
    // a summary on the right.
    const section = (id: string, title: string, summary: string, color: string, body: unknown) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Text color={color} weight="semibold">{title}</Text>
          <Text dimColor wrap="truncate-end">{summary}</Text>
        </Box>
        {body}
      </Box>
    )

    // Compact chips: no border, a marker for the script that is open.
    const chip = (chip: Chip) => {
      if (!chip.script) return <Text dimColor strikethrough>{chip.label}</Text>
      const script = chip.script
      // Off the disk mid-conversion: still listed, but there is nothing to open.
      if (missing.includes(script)) return <Text dimColor>{`${chip.label} ○`}</Text>
      const isCurrent = sameScript(current.action, script)

      // While converting, or with both generations present, each script shows its own.
      const state = convert || current.version === 'mixed' ? current.scriptVersions[script] : undefined
      const mark = state === 'V2' ? ' ✓' : state === 'V1' ? ' ·V1' : ''
      const isTouched = convert?.current !== undefined && sameScript(convert.current, script)

      return (
        <Button
          key={`open-${script}`}
          plain
          label={`${isCurrent || isTouched ? '▸ ' : ''}${chip.label}${mark}`}
          onPress={() => void openScript($, current.root, script)}
        />
      )
    }

    const chipRow = (chips: Chip[]) => (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {chips.map(chip)}
      </Box>
    )

    // The root's json, md and other files: the expected ones first (struck through
    // when missing), then whatever else is there.
    const expectedFiles: Chip[] = EXPECTED_FILES.map(name => ({
      label: name,
      script: current.files.find(file => sameFile(file, name)),
    }))
    const otherFiles: Chip[] = current.files
      .filter(file => !EXPECTED_FILES.some(name => sameFile(file, name)))
      .sort((a, b) => a.localeCompare(b))
      .map(file => ({ label: file, script: file }))
    const present = lifecycle.filter(one => one.script).length
    const permissionCount = sets.reduce((sum, [, chips]) => sum + chips.length, 0)

    const endpoints = query
      ? current.endpoints.filter(one =>
          `${one.method} ${one.path} ${one.script}`.toLowerCase().includes(query),
        )
      : current.endpoints
    // One block per script, in script order.
    const byScript = current.scripts
      .map(script => [script, endpoints.filter(one => one.script === script)] as const)
      .filter(([, list]) => list.length > 0)
    const methodWidth = 7
    const config = query
      ? current.config.filter(one => `${one.key} ${one.label} ${one.value}`.toLowerCase().includes(query))
      : current.config
    const requiredCount = current.config.filter(one => one.required).length

    // The notice belongs to one connector; another one's is not shown here.
    const said = await read($, notice)
    const line = said?.root === current.root ? said : undefined

    const next = nextStep(current, Boolean(convert || reviewFiles))
    const timeline = releaseTimeline(current)
    // The scripts that call anything, in folder order, are the columns of the endpoint grid.
    const gridScripts = current.scripts.filter(script => endpoints.some(one => one.script === script))
    const grid = heatRows(endpoints)

    // How the local release stands against the one on GitHub.
    const { remote, release } = current
    const sync =
      remote === undefined
        ? { text: 'checking GitHub…', color: undefined, isDim: true }
        : remote.state === 'missing'
        ? { text: 'not on GitHub', color: undefined, isDim: true }
        : remote.state === 'unavailable'
          ? remote.isLimited
            ? { text: 'GitHub rate limit reached, try again later', color: undefined, isDim: false }
            : { text: 'GitHub unavailable', color: undefined, isDim: true }
        : remote.state !== 'ok' || !remote.version
          ? undefined
          : !release
            ? { text: `GitHub v${remote.version}`, color: undefined, isDim: true }
            : compareVersions(release, remote.version) === 0
              ? { text: `${STATUS.synced.icon} GitHub`, color: STATUS.synced.color, isDim: false }
              : compareVersions(release, remote.version) < 0
                ? { text: `${STATUS.behind.icon} GitHub v${remote.version}`, color: STATUS.behind.color, isDim: false }
                : { text: `${STATUS.ahead.icon} ahead of GitHub v${remote.version}`, color: STATUS.ahead.color, isDim: false }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="bold" size="heading">{shortName(current.name)}</Text>
          <Text dimColor wrap="truncate-end">{current.name}</Text>
          {remote?.state === 'ok' && (
            <Text wrap="truncate-end">
              <Link href={`https://github.com/${GITHUB_ORG}/${encodeURIComponent(baseName(current.root))}`} />
            </Text>
          )}
          {/* Identity: what this connector is, as read-only tags. */}
          <Box flexDirection="row" flexWrap="wrap" marginTop="xs" columnGap={2}>
            {current.release && (
              <Text color={PALETTE.violet} weight="semibold">{`v${current.release}`}</Text>
            )}
            {current.version && (
              <Text color={current.version === 'V2' ? 'success' : 'warning'} weight="semibold">
                {current.version === 'mixed' ? 'V1 + V2' : current.version}
              </Text>
            )}
            {sync && (
              <Text color={sync.color} dimColor={sync.isDim}>{sync.text}</Text>
            )}
          </Box>
          {/* The one thing worth doing next. */}
          {next && (
            <Box marginTop="xs">
              <Text color={next.color} wrap="truncate-end">{next.text}</Text>
            </Box>
          )}
          {/* Releases: where the local and the GitHub changelog stand. */}
          {timeline.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" marginTop="xs" columnGap={1}>
              {timeline.length > TIMELINE_SHOWN && (
                <Text dimColor>{`+${timeline.length - TIMELINE_SHOWN} earlier`}</Text>
              )}
              {timeline.slice(-TIMELINE_SHOWN).map(one => {
                // On both sides is in sync, local only is ahead, GitHub only is behind.
                const status = one.isLocal && one.isRemote ? STATUS.synced : one.isLocal ? STATUS.ahead : STATUS.behind

                return (
                  <Text color={status.color} weight={one.version === current.release ? 'bold' : undefined}>
                    {`${status.icon} ${one.version}`}
                  </Text>
                )
              })}
            </Box>
          )}
          {/* Empty state: no local changelog yet, and a way to start one. */}
          {!current.files.some(file => sameFile(file, 'CHANGELOG.md')) && (
            <Box flexDirection="row" flexWrap="wrap" marginTop="xs" columnGap={2}>
              <Text dimColor>No changelog yet</Text>
              <Button
                key="create-changelog"
                label="＋ Create CHANGELOG.md"
                onPress={() => void createChangelog($, current.root)}
              />
            </Box>
          )}
          {/* Actions: what can be done with it. */}
          <Box flexDirection="row" flexWrap="wrap" marginTop="xs" columnGap={2}>
            {reviewFiles ? (
              <Text color="warning">Review running…</Text>
            ) : (
              current.hasReviewer && (
                <Button
                  key="ai-review"
                  label="▶ AI review"
                  onPress={() => void reviewConnector($, current.root)}
                />
              )
            )}
            {remote?.state === 'ok' && remote.version && (!release || compareVersions(release, remote.version) < 0) && (
              <Button
                key="download"
                label={`⇩ Download v${remote.version}`}
                onPress={() => void downloadRelease($, current.root, remote.version ?? '')}
              />
            )}
            {convert && (
              <Text color="warning" weight="semibold">Converting…</Text>
            )}
            {!convert && current.hasConverter && current.version && current.version !== 'V2' && (
              <Button
                key="convert-v2"
                label="⇢ Convert to V2"
                onPress={() => void convertConnector($, current.root)}
              />
            )}
          </Box>
          {/* Feedback: what the last action did; it stays until dismissed. */}
          {line && (
            <Box flexDirection="row" marginTop="xs" columnGap={1}>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text color={NOTICE_COLORS[line.tone]}>{line.text}</Text>
              </Box>
              {line.open && (
                <Button
                  key="notice-open"
                  plain
                  label="Open"
                  onPress={() => void openPath($, current.root, line.open ?? current.root)}
                />
              )}
              <Button
                key="notice-dismiss"
                plain
                label="✕"
                onPress={() =>
                  // Dismissing also stops following a conversion of this connector.
                  void Promise.all([
                    update($, notice, () => null),
                    update($, converting, one => (one?.root === current.root ? null : one)),
                  ])
                }
              />
            </Box>
          )}
        </Box>

        {Input && (current.endpoints.length > 0 || current.config.length > 0) && (
          <Input
            key="pane-filter"
            placeholder="Filter settings and endpoints…"
            value={typed}
            onInput={(value: string) => void update($, filter, () => value)}
            onSubmit={(value: string) => void update($, filter, () => value)}
          />
        )}

        {convert && section(
          'conversion',
          'V1 → V2 conversion',
          `${done}/${total}`,
          done === total && total > 0 ? 'success' : 'warning',
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="row" columnGap={1}>
              <Text color="success">{'█'.repeat(barFilled)}</Text>
              <Text dimColor>{'░'.repeat(BAR_WIDTH - barFilled)}</Text>
              <Text weight="semibold">{`${percent}%`}</Text>
            </Box>
            <Box flexDirection="column">
              {convertRows.map(([script, generation, isOnDisk]) => {
                const isTouched = convert.current !== undefined && sameScript(convert.current, script)
                const icon = generation === 'V2' ? '✓' : isTouched ? '▸' : '○'
                const color = generation === 'V2' ? 'success' : isTouched ? 'warning' : undefined

                return (
                  <Box flexDirection="row" columnGap={1}>
                    <Box width={2}>
                      <Text color={color} dimColor={!color}>{icon}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text mono wrap="truncate-end" dimColor={generation === 'V1' && !isTouched}>
                        {script.replace(/\.ps1$/i, '')}
                      </Text>
                    </Box>
                    <Text color={color} dimColor={!color}>{isOnDisk ? generation : '…'}</Text>
                  </Box>
                )
              })}
              {docRows.map(([name, isDone]) => {
                const isTouched = convert.current !== undefined && sameFile(convert.current, name)
                const icon = isDone ? '✓' : isTouched ? '▸' : '○'
                const color = isDone ? 'success' : isTouched ? 'warning' : undefined

                return (
                  <Box flexDirection="row" columnGap={1}>
                    <Box width={2}>
                      <Text color={color} dimColor={!color}>{icon}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text mono wrap="truncate-end" dimColor={!isDone && !isTouched}>{name}</Text>
                    </Box>
                    <Text color={color} dimColor={!color}>{isDone ? 'written' : 'waiting'}</Text>
                  </Box>
                )
              })}
            </Box>
          </Box>,
        )}

        {(current.hasReviewer || current.review || reviewFiles) && section(
          'review',
          'AI review',
          reviewFiles
            ? 'under review…'
            : current.review
              ? `${current.review.total} ${current.review.total === 1 ? 'finding' : 'findings'}`
              : 'not reviewed',
          reviewFiles ? 'warning' : !current.review ? 'inactive' : current.review.total > 0 ? 'error' : 'success',
          <Box flexDirection="column">
            {reviewFiles && (
              <Box flexDirection="column">
                <Text dimColor>{`Files being reviewed (${reviewFiles.length})`}</Text>
                {reviewFiles.length === 0 && <Text dimColor>Nothing read yet…</Text>}
                {reviewFiles.map((file, index) => (
                  <Text mono wrap="truncate-end">
                    {index === reviewFiles.length - 1 ? `▸ ${file}` : `  ${file}`}
                  </Text>
                ))}
              </Box>
            )}
            {!reviewFiles && !current.review && <Text dimColor>Press ▶ AI review to run one.</Text>}
            {!reviewFiles && current.review && (
              <Box flexDirection="column">
                {Object.entries(current.review.bySeverity).map(([severity, count]) => (
                  <Box flexDirection="row">
                    <Box flexGrow={1}>
                      <Text>{severity}</Text>
                    </Box>
                    <Text weight="semibold">{String(count)}</Text>
                  </Box>
                ))}
                <Text dimColor>
                  {`${current.review.openPoints} open verification ${current.review.openPoints === 1 ? 'point' : 'points'}`}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {[current.review.reviewedAt.slice(0, 10), current.review.scope].filter(Boolean).join(' · ')}
                </Text>
              </Box>
            )}
          </Box>,
        )}

        {remote?.state === 'ok' && section(
          'github',
          'GitHub',
          remote.items
            ? `${remote.items.filter(one => one.kind === 'pr').length} PRs · ${remote.items.filter(one => one.kind === 'issue').length} issues`
            : 'unavailable',
          PALETTE.sky,
          <Box flexDirection="column">
            {!remote.items && (
              <Text dimColor>
                {remote.isLimited
                  ? 'GitHub rate limit reached; the issues and pull requests load later.'
                  : 'GitHub would not list the issues and pull requests.'}
              </Text>
            )}
            {remote.items?.length === 0 && <Text dimColor>No open issues or pull requests.</Text>}
            {remote.items?.map(one => (
              <Box flexDirection="row" columnGap={1}>
                <Box width={7} flexShrink={0}>
                  <Text color={one.kind === 'pr' ? PALETTE.violet : PALETTE.amber} weight="semibold">
                    {one.kind === 'pr' ? 'PR' : 'Issue'}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text
                    wrap="truncate-end"
                    weight={one.isReviewRequested ? 'bold' : undefined}
                    dimColor={one.isDraft}
                  >
                    <Link href={one.url}>{`#${one.number} ${one.title}`}</Link>
                  </Text>
                </Box>
                {one.isReviewRequested && !one.isDraft && (
                  <Text color={PALETTE.rose} weight="semibold">● review</Text>
                )}
                {one.isDraft && <Text dimColor>draft</Text>}
              </Box>
            ))}
          </Box>,
        )}

        {section(
          'files',
          'Files',
          `${present}/${LIFECYCLE.length} lifecycle · ${permissionCount} permission · ${current.files.length} other`,
          PALETTE.teal,
          <Box flexDirection="column" gap="xs">
            <Box flexDirection="column">
              <Text dimColor>Lifecycle</Text>
              {chipRow(lifecycle)}
            </Box>
            {sets.map(([set, chips]) => (
              <Box flexDirection="column">
                <Text dimColor>{set === 'permissions' ? 'Permissions' : `Permissions · ${set}`}</Text>
                {chipRow(chips)}
              </Box>
            ))}
            {others.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Other scripts</Text>
                {chipRow(others)}
              </Box>
            )}
            <Box flexDirection="column">
              <Text dimColor>Configuration and documents</Text>
              {chipRow(expectedFiles)}
            </Box>
            {otherFiles.length > 0 && (
              <Box flexDirection="column">
                <Text dimColor>Other files</Text>
                {chipRow(otherFiles)}
              </Box>
            )}
          </Box>,
        )}

        {section(
          'configuration',
          'Configuration',
          query ? `${config.length} of ${current.config.length}` : `${current.config.length} settings · ${requiredCount} required`,
          PALETTE.amber,
          <Box flexDirection="column">
            {current.configNote && <Text color="warning">{current.configNote}</Text>}
            {config.map(one => (
              <Box flexDirection="row" columnGap={1}>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text mono wrap="truncate-end">{one.required ? `${one.key} *` : one.key}</Text>
                </Box>
                <Text color={PALETTE.sky}>{one.kind}</Text>
                <Box width={14} flexShrink={0}>
                  <Text dimColor wrap="truncate-end">{one.value || '—'}</Text>
                </Box>
              </Box>
            ))}
            {query && config.length === 0 && current.config.length > 0 && (
              <Text dimColor>{`No setting matches "${typed.trim()}".`}</Text>
            )}
          </Box>,
        )}

        {section(
          'endpoints',
          'Endpoints',
          query ? `${endpoints.length} of ${current.endpoints.length}` : `${current.endpoints.length} calls`,
          PALETTE.rose,
          <Box flexDirection="column">
            {current.endpoints.length === 0 && <Text dimColor>No Uri/Method calls found in the scripts.</Text>}
            {gridScripts.length > 1 && (
              <Box flexDirection="column" marginBottom="xs">
                <Box flexDirection="row">
                  <Box flexGrow={1} flexShrink={1} minWidth={0} />
                  {gridScripts.map(script => (
                    <Box width={GRID_CELL} flexShrink={0}>
                      <Text dimColor>{scriptHead(script)}</Text>
                    </Box>
                  ))}
                </Box>
                {grid.slice(0, GRID_ROWS).map(row => (
                  <Box flexDirection="row">
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text mono wrap="truncate-end">{`${row.method} ${row.path}`}</Text>
                    </Box>
                    {gridScripts.map(script => (
                      <Box width={GRID_CELL} flexShrink={0}>
                        {row.scripts.has(script)
                          ? <Text color={METHOD_COLORS[row.method]}>●</Text>
                          : <Text dimColor>·</Text>}
                      </Box>
                    ))}
                  </Box>
                ))}
                {grid.length > GRID_ROWS && <Text dimColor>{`+${grid.length - GRID_ROWS} more, listed below`}</Text>}
              </Box>
            )}
            {byScript.map(([script, list]) => (
              <Box flexDirection="column">
                <Text dimColor>{script.replace(/\.ps1$/i, '')}</Text>
                {list.map(one => (
                  <Box flexDirection="row">
                    <Box width={methodWidth}>
                      <Text color={METHOD_COLORS[one.method]} weight="semibold">{one.method}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text mono wrap="truncate-end">{one.path}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
            {query && endpoints.length === 0 && current.endpoints.length > 0 && (
              <Text dimColor>{`No endpoint matches "${typed.trim()}".`}</Text>
            )}
          </Box>,
        )}
      </Box>
    )
  })
}

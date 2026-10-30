import { expect, test } from 'claude-code/testing'

const ROOT = 'C:/code/HelloID-Conn-Prov-Target-Topdesk'

const SCRIPT = `
$splat = @{
    Uri    = "$($actionContext.Configuration.BaseUrl)/api/users/$($id)?x=1"
    Method = 'PATCH'
}
Invoke-RestMethod @splat
Invoke-RestMethod -Uri "$baseUrl/api/users" -Method POST
Invoke-RestMethod -Uri "$baseUrl/api/ping"
$uri = "$($actionContext.Configuration.BaseUrl)/api/groups"
Invoke-RestMethod -Uri $uri -Method DELETE
$requestURL = "$($url.trim("/"))/rest/api/3/group/user?groupname=$($group.DisplayName)"
$response = ( Invoke-RestMethod -Method PUT -Uri $requestURL -Headers $headers )
`

// A V1 script: $p / $aRef instead of $actionContext.
const V1_SCRIPT = `
$account = @{ Name = $p.Name.GivenName }
Invoke-RestMethod -Uri "$($config.BaseUrl)/users" -Method POST
$aRef = 1
`

const CONFIG = JSON.stringify([
  { key: 'BaseUrl', type: 'input', defaultValue: '', templateOptions: { label: 'BaseUrl', required: true } },
  { key: 'token', type: 'input', defaultValue: 'secret', templateOptions: { type: 'password', label: 'Token', required: true } },
])

// Files of the root folder that are off the disk for a moment, as when a script is moved.
const hidden = new Set<string>()
// The GitHub list requests the mod made, and the ETag each one sent.
const requests: { url: string; ifNoneMatch?: string }[] = []
// What the mod wrote, by path.
const written: Record<string, string> = {}
// Scripts added to the root folder, as in a V1 connector that keeps its permission scripts there.
const rootExtras: string[] = []
// Modified times of root files, to stand for one being written again.
const mtimes: Record<string, number> = {}

const file = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })
const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })

const PANE = {
  plugin: 'helloid-connector',
  component: 'Pane',
  requestId: 'helloid-connector',
  props: {
    title: 'Connector overview',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const COMMAND = {
  command: 'connector-overview',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

// Stands in for the engine: a Topdesk connector with one permission set.
function engine(
  on: On,
  cwd: () => string,
  onOpen = () => {},
  script: string | ((path: string) => string) = SCRIPT,
  commands = ['ai-reviewer', 'connector-v1-v2'],
  // The release on GitHub; null stands for a repository that is not there (404).
  remote: string | null = '1.3.0',
) {
  on('http.fetch', (_, e) => {
    const url = String(e.url)
    const answer = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    if (remote === null) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    // 'limited': GitHub refuses everything with 429; 'api-limited': only the issues and pulls list, with 403.
    if (remote === 'limited') return { value: { status: 429, ok: false, headers: {}, text: '' } }
    if (remote === 'api-limited' && /\/(issues|pulls)\?/.test(url)) return { value: { status: 403, ok: false, headers: {}, text: '' } }
    // 'lowercase': the only file on GitHub is readme.md (the raw host is case-sensitive).
    if (remote === 'lowercase' && !/\/readme\.md$/.test(url) && !/\/(issues|pulls)\?/.test(url)) {
      return { value: { status: 404, ok: false, headers: {}, text: '' } }
    }
    // '' stands for a repository that is there but has no CHANGELOG.md.
    if (remote === '' && url.endsWith('/CHANGELOG.md')) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    // The lists carry an ETag; a request that sends it back gets 304, as GitHub does.
    const listed = (text: string) => {
      const sent = (e.init as { headers?: Record<string, string> } | undefined)?.headers?.['If-None-Match']
      requests.push({ url, ifNoneMatch: sent })
      if (sent === '"v1"') return { value: { status: 304, ok: false, headers: {}, text: '' } }

      return { value: { status: 200, ok: true, headers: { etag: '"v1"' }, text } }
    }
    // The open issues and pull requests; #2 is a pull request with a reviewer requested.
    if (url.includes('/issues?')) {
      // 'no-prs': an issues list without a pull request.
      if (remote === 'no-prs') return listed(JSON.stringify([{ number: 1, title: 'Bug in create', html_url: 'https://github.com/x/issues/1' }]))

      return listed(JSON.stringify([
        { number: 1, title: 'Bug in create', html_url: 'https://github.com/x/issues/1' },
        { number: 2, title: 'Add paging', html_url: 'https://github.com/x/pull/2', pull_request: {} },
        { number: 3, title: 'Draft work', html_url: 'https://github.com/x/pull/3', pull_request: {} },
      ]))
    }
    if (url.includes('/pulls?')) {
      return listed(JSON.stringify([
        { number: 2, draft: false, requested_reviewers: [{}] },
        { number: 3, draft: true, requested_reviewers: [] },
      ]))
    }

    return answer(`# Change Log\n\n## [${remote}] - 2024-06-01\n\n## [1.1.0] - 2024-01-01\n`)
  })
  on('command.register', () => ({ value: { command: 'connector-overview' } }))
  on('command.list', () => ({
    value: commands.map(name => ({ name, description: '', source: 'user' as const })),
  }))
  on('ui.open', () => {
    onOpen()
    return { value: { isPlaced: true } }
  })
  on('session.cwd', () => ({ value: cwd() }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('classic.CwdChanged', () => ({}))
  on('fs.list', (_, e) => {
    const path = String(e.path)
    if (path.endsWith('permissions')) return { value: [dir('groups')] }
    if (path.endsWith('groups')) {
      return { value: [file('permissions.ps1'), file('grantPermission.ps1'), file('revokePermission.ps1')] }
    }
    return {
      value: [file('create.ps1'), file('update.ps1'), file('delete.ps1'), file('CHANGELOG.md'), file('README.md'), file('configuration.json'), file('LICENSE'), file('.gitignore'), dir('permissions'), dir('.github'),...rootExtras.map(file)]
        .filter(one => !hidden.has(one.name))
        .map(one => ({ ...one, mtimeMs: mtimes[one.name] ?? one.mtimeMs })),
    }
  })
  // Everything exists except a downloaded <connector>-v1.3.0 folder.
  on('fs.exists', (_, e) => ({ value: !/-v\d/.test(String(e.path)) && !hidden.has(String(e.path).split(/[\\/]/).pop() ?? '') }))
  on('fs.write', (_, e) => {
    written[String(e.path)] = String(e.text)
    hidden.delete(String(e.path).split(/[\\/]/).pop() ?? '')

    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const path = String(e.path)
    if (path.endsWith('CHANGELOG.md')) return { value: '# Change Log\n\n## [1.2.0] - 2024-05-01\n\n## [1.1.0] - 2024-01-01\n' }

    const body = typeof script === 'function' ? script(path) : script

    return { value: path.endsWith('configuration.json') ? CONFIG : body }
  })
}

test('a connector file fills the pane', async ($, on) => {
  engine(on, () => 'C:/code')

  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/update.ps1` })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Topdesk$/ }))?.text).toBe('Topdesk')
    // Lifecycle: present scripts are buttons, a missing one is struck-through text.
    expect(await ui.find({ key: 'open-update.ps1' })).toBeTruthy()
    expect(await ui.find({ key: 'open-enable.ps1' })).toBeUndefined()
    // The root's other files: present ones open, an expected one that is missing
    // is struck-through text, hidden files are not listed.
    expect(await ui.find({ key: 'open-configuration.json' })).toBeTruthy()
    expect(await ui.find({ key: 'open-CHANGELOG.md' })).toBeTruthy()
    expect(await ui.find({ key: 'open-LICENSE' })).toBeTruthy()
    expect(await ui.find({ key: 'open-fieldMapping.json' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^fieldMapping\.json$/ }))?.text).toBe('fieldMapping.json')
    expect(await ui.find({ key: 'open-.gitignore' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^Enable$/ }))?.text).toBe('Enable')
    expect(await ui.find({ key: 'open-permissions/groups/grantPermission.ps1' })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /Permissions · groups/ }))?.text).toBe('Permissions · groups')
    // Endpoints, with the base URL and query string dropped.
    expect((await ui.find({ type: 'Text', text: /^\/api\/users\/\{id\}$/ }))?.text).toBe('/api/users/{id}')
    expect((await ui.find({ type: 'Text', text: /^PATCH$/ }))?.text).toBe('PATCH')
    // A -Uri $var resolves to its assignment, and a call without -Method does
    // not borrow the Method of the call above it.
    expect((await ui.find({ type: 'Text', text: /^\/api\/groups$/ }))?.text).toBe('/api/groups')
    expect((await ui.find({ type: 'Text', text: /^DELETE$/ }))?.text).toBe('DELETE')
    expect((await ui.find({ type: 'Text', text: /^GET$/ }))?.text).toBe('GET')
    // A URL with quotes and a method call inside $( … ), set in a variable first, as
    // the Jira connector does: "$($url.trim("/"))/rest/…" reads as /rest/…
    expect((await ui.find({ type: 'Text', text: /^\/rest\/api\/3\/group\/user$/ }))?.text).toBe('/rest/api/3/group/user')
    expect((await ui.find({ type: 'Text', text: /^PUT$/ }))?.text).toBe('PUT')
    // $actionContext marks a V2 connector: a badge, and nothing to convert.
    expect((await ui.find({ type: 'Text', text: /^V2$/ }))?.text).toBe('V2')
    expect(await ui.find({ key: 'convert-v2' })).toBeUndefined()
    // The newest CHANGELOG.md release, not the older one below it.
    expect((await ui.find({ type: 'Text', text: /^v1\.2\.0$/ }))?.text).toBe('v1.2.0')
    expect(await ui.find({ type: 'Text', text: /^v1\.1\.0$/ })).toBeUndefined()
    expect(await ui.find({ key: 'ai-review' })).toBeTruthy()
    // Configuration: required marker, password kind, and no secret default.
    expect((await ui.find({ type: 'Text', text: /^BaseUrl \*$/ }))?.text).toBe('BaseUrl *')
    expect((await ui.find({ type: 'Text', text: /^password$/ }))?.text).toBe('password')
    expect(await ui.find({ type: 'Text', text: /^secret$/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the filter narrows the endpoints', async ($, on) => {
  engine(on, () => 'C:/code')
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/create.ps1` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'pane-filter', text: 'patch' })
  expect((await ui.find({ type: 'Text', text: /of 30$/ }))?.text).toBe('6 of 30')
  expect(await ui.find({ type: 'Text', text: /^POST$/ })).toBeUndefined()
  await ui.unmount()
})

// The local CHANGELOG.md says 1.2.0; the GitHub answer arrives after the load.
type Caller = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const syncNote = async ($: Caller, on: On, remote: string | null, connector: string) => {
  engine(on, () => 'C:/code', () => {}, SCRIPT, undefined, remote)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `C:/code/${connector}/create.ps1` })
  await new Promise(done => setTimeout(done, 0))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const note = (await ui.find({ type: 'Text', text: /GitHub/ }))?.text
  await ui.unmount()

  return note
}

test('the pane lists a release on GitHub that differs from the local one', async ($, on) => {
  expect(await syncNote($, on, '1.3.0', 'HelloID-Conn-Prov-Target-Behind')).toBe('↓ GitHub v1.3.0')
})

test('a local release ahead of GitHub is marked as such', async ($, on) => {
  expect(await syncNote($, on, '1.1.0', 'HelloID-Conn-Prov-Target-Ahead')).toBe('↑ ahead of GitHub v1.1.0')
})

test('the same release on GitHub shows a check', async ($, on) => {
  expect(await syncNote($, on, '1.2.0', 'HelloID-Conn-Prov-Target-Synced')).toBe('✓ GitHub')
})

test('a connector with no repository on GitHub says so', async ($, on) => {
  expect(await syncNote($, on, null, 'HelloID-Conn-Prov-Target-Private')).toBe('not on GitHub')
})

test('the download button clones the GitHub release into a folder named after its version', async ($, on) => {
  const runs: (readonly string[])[] = []
  engine(on, () => 'C:/code')
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-Download/create.ps1' })
  await new Promise(done => setTimeout(done, 0))

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'notice-dismiss' })).toBeUndefined()
  await ui.press({ key: 'download' })
  await ui.unmount()
  await new Promise(done => setTimeout(done, 0))

  expect(runs.at(-1)?.at(-1)).toBe('C:/code/HelloID-Conn-Prov-Target-Download-v1.3.0')
  expect(runs.at(-1)?.slice(0, 3)).toEqual(['git', 'clone', '--depth'])

  // The result stays under the header, with a way to open the folder, until dismissed.
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Downloaded v1\.3\.0 to .*-v1\.3\.0$/ })).toBeTruthy()
  expect(await ui.find({ key: 'notice-open' })).toBeTruthy()
  await ui.press({ key: 'notice-dismiss' })
  await ui.unmount()
  await new Promise(done => setTimeout(done, 0))

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'notice-dismiss' })).toBeUndefined()
  await ui.unmount()
})

test('without a repository on GitHub there is no download button', async ($, on) => {
  engine(on, () => 'C:/code', () => {}, SCRIPT, undefined, null)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-Nowhere/create.ps1' })
  await new Promise(done => setTimeout(done, 0))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'download' })).toBeUndefined()
  await ui.unmount()
})

test('without /ai-reviewer there is no review button or section', async ($, on) => {
  engine(on, () => 'C:/code', () => {}, SCRIPT, [])
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-NoReview/create.ps1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'ai-review' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Review$/ })).toBeUndefined()
  expect(await ui.find({ key: 'open-create.ps1' })).toBeTruthy()
  await ui.unmount()
})

test('a V1 connector gets a warning badge and a convert button', async ($, on) => {
  engine(on, () => 'C:/code', () => {}, V1_SCRIPT)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  // Its own connector, so nothing cached from the V2 tests applies.
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-Legacy/create.ps1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^V1$/ }))?.text).toBe('V1')
  expect(await ui.find({ key: 'convert-v2' })).toBeTruthy()
  await ui.unmount()
})

test('a running conversion shows how many scripts are on V2 and which one was touched', async ($, on) => {
  const connector = 'C:/code/HelloID-Conn-Prov-Target-Converting'
  const converted = new Set<string>()
  engine(on, () => 'C:/code', () => {}, path =>
    [...converted].some(name => path.endsWith(name)) ? SCRIPT : V1_SCRIPT,
  )
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${connector}/create.ps1` })

  await $.prompt.submit({ text: `/connector-v1-v2 ${connector}` })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Converting…$/ })).toBeTruthy()
  // Six scripts and the two documents (fieldMapping.json, README.md) are the eight steps.
  expect(await ui.find({ type: 'Text', text: /^0\/8$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^0%$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^waiting$/ })).toBeTruthy()
  // The convert button makes way for the progress text.
  expect(await ui.find({ key: 'convert-v2' })).toBeUndefined()
  await ui.unmount()

  converted.add('create.ps1')
  await $.tool.call({ tool: 'Write', file_path: `${connector}/create.ps1`, content: '' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^1\/8$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^13%$/ })).toBeTruthy()
  // The converted script is ticked off; the others wait with an open circle.
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^○$/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^V1 \+ V2$/ }))?.text).toBe('V1 + V2')
  await ui.unmount()

  // The last script flipping to V2 does not finish the conversion: the field
  // mapping and the README are still to be written.
  const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
  try {
    for (const name of ['update', 'delete', 'permissions', 'grantPermission', 'revokePermission']) {
      converted.add(`${name}.ps1`)
    }
    await $.tool.call({ tool: 'Write', file_path: `${connector}/permissions/groups/revokePermission.ps1`, content: '' })
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^6\/8$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Converted to V2/ })).toBeUndefined()
    await ui.unmount()

    // A turn ending with the documents still waiting only pauses it. A subagent's
    // turn ending is not the run's end at all.
    await $.turn.complete({ ...turn, agentId: 'sub-1' })
    await $.turn.complete(turn)
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(
      await ui.find({ type: 'Text', text: /^Paused: 6 of 8 done · waiting: fieldMapping\.json, README\.md$/ }),
    ).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Converting…$/ })).toBeTruthy()
    await ui.unmount()

    // Writing them completes the steps; the turn ending then finishes the conversion.
    rootExtras.push('fieldMapping.json')
    mtimes['README.md'] = 1
    await $.tool.call({ tool: 'Write', file_path: `${connector}/README.md`, content: '' })
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^8\/8$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^100%$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Converted to V2/ })).toBeUndefined()
    await ui.unmount()

    await $.turn.complete({ ...turn, agentId: 'sub-2' })
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^Converting…$/ })).toBeTruthy()
    await ui.unmount()

    await $.turn.complete(turn)
    ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(
      await ui.find({ type: 'Text', text: /^Converted to V2: 6 scripts, fieldMapping\.json and README\.md written$/ }),
    ).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Converting…$/ })).toBeUndefined()
    await ui.unmount()
  } finally {
    rootExtras.length = 0
    delete mtimes['README.md']
  }
})

test('a conversion keeps its card when a tool call spells the folder another way', async ($, on) => {
  const converted = new Set<string>()
  engine(on, () => 'C:/code', () => {}, path =>
    [...converted].some(name => path.endsWith(name)) ? SCRIPT : V1_SCRIPT,
  )
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-Spelled/create.ps1' })

  // The command says backslashes and a lower-case drive; the writes say forward slashes.
  await $.prompt.submit({ text: '/connector-v1-v2 C:/code/HelloID-Conn-Prov-Target-Spelled' })
  converted.add('create.ps1')
  await $.tool.call({ tool: 'Write', file_path: 'c:\\code\\HelloID-Conn-Prov-Target-Spelled\\create.ps1', content: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Converting…$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^1\/8$/ })).toBeTruthy()
  await ui.unmount()
})

test('a script that leaves the disk mid-conversion stays in the lifecycle, waiting', async ($, on) => {
  const connector = 'C:/code/HelloID-Conn-Prov-Target-Moving'
  engine(on, () => 'C:/code', () => {}, V1_SCRIPT)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${connector}/create.ps1` })
  await $.prompt.submit({ text: `/connector-v1-v2 ${connector}` })

  hidden.add('update.ps1')
  try {
    await $.tool.call({ tool: 'Write', file_path: `${connector}/create.ps1`, content: '' })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // Still listed (not struck through, not openable) and still counted against the plan.
    expect(await ui.find({ type: 'Text', text: /^Update ○$/ })).toBeTruthy()
    expect(await ui.find({ key: 'open-update.ps1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^0\/8$/ })).toBeTruthy()
    await ui.unmount()
  } finally {
    hidden.delete('update.ps1')
  }
})

test('permission scripts in the root are grouped as permissions, by their names', async ($, on) => {
  engine(on, () => 'C:/code', () => {}, V1_SCRIPT)
  rootExtras.push('entitlements.ps1', 'grantPermission.ps1', 'revokePermission.ps1', 'helper.ps1')
  try {
    await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
    await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-RootPermissions/create.ps1' })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // Under a "Permissions" heading of their own, next to the folder-based set.
    expect((await ui.find({ type: 'Text', text: /^Permissions$/ }))?.text).toBe('Permissions')
    expect(await ui.find({ key: 'open-entitlements.ps1' })).toBeTruthy()
    expect(await ui.find({ key: 'open-grantPermission.ps1' })).toBeTruthy()
    expect(await ui.find({ key: 'open-revokePermission.ps1' })).toBeTruthy()
    // A root script with another name stays under "Other scripts".
    expect((await ui.find({ type: 'Text', text: /^Other scripts$/ }))?.text).toBe('Other scripts')
    await ui.unmount()
  } finally {
    rootExtras.length = 0
  }
})

test('without /connector-v1-v2 a V1 connector keeps its badge but has no convert button', async ($, on) => {
  engine(on, () => 'C:/code', () => {}, V1_SCRIPT, ['ai-reviewer'])
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-NoConverter/create.ps1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^V1$/ }))?.text).toBe('V1')
  expect(await ui.find({ key: 'convert-v2' })).toBeUndefined()
  await ui.unmount()
})

test('moving into a connector folder opens the pane, once per connector', async ($, on) => {
  let opens = 0
  engine(on, () => 'C:/code', () => {
    opens += 1
  })

  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  expect(opens).toBe(0)

  await $.classic.CwdChanged({ old_cwd: 'C:/code', new_cwd: ROOT })
  expect(opens).toBe(1)

  // A subfolder of the same connector leaves the pane as it is.
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: `${ROOT}/permissions` })
  expect(opens).toBe(1)

  // Another connector opens it again.
  await $.classic.CwdChanged({ old_cwd: ROOT, new_cwd: 'C:/code/HelloID-Conn-Prov-Target-Ans' })
  expect(opens).toBe(2)
})

test('a running review shows "under review" and the files it reads', async ($, on) => {
  engine(on, () => 'C:/code')
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/create.ps1` })

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^not reviewed$/ }))?.text).toBe('not reviewed')
  await ui.unmount()

  await $.prompt.submit({ text: `/ai-reviewer ${ROOT}` })
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/update.ps1` })

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^under review…$/ }))?.text).toBe('under review…')
  expect(await ui.find({ type: 'Text', text: /update\.ps1$/ })).toBeTruthy()
  await ui.unmount()
})

test('the command picks up a connector the session moved into', async ($, on) => {
  let cwd = 'C:/code'
  engine(on, () => cwd)

  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  cwd = 'C:\\Temp\\HelloID-Conn-Prov-Target-Ans'
  const ran = await $.command.run(COMMAND)

  expect(ran.text).toBe('Showing HelloID-Conn-Prov-Target-Ans.')
})

// Mounts the pane for a connector of its own, once the GitHub answer is in.
const mountFor = async ($: Caller, on: On, remote: string | null, connector: string, script: string = SCRIPT) => {
  engine(on, () => 'C:/code', () => {}, script, undefined, remote)
  await $.session.start({ cwd: 'C:/code', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: `C:/code/${connector}/create.ps1` })
  await new Promise(done => setTimeout(done, 0))

  return $.ui.mount({ ...PANE, surface: 'desktop' })
}

test('the GitHub card lists pull requests first, with review and draft marks', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-Card')
  expect((await ui.find({ type: 'Text', text: /^2 PRs · 1 issues$/ }))?.text).toBe('2 PRs · 1 issues')
  expect(await ui.find({ type: 'Link', href: 'https://github.com/x/pull/2' })).toBeTruthy()
  expect(await ui.find({ type: 'Link', href: 'https://github.com/x/issues/1' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^● review$/ }))?.text).toBe('● review')
  expect((await ui.find({ type: 'Text', text: /^draft$/ }))?.text).toBe('draft')
  // No refresh button, and no fold buttons on the sections.
  expect(await ui.find({ key: 'github-refresh' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-github' })).toBeUndefined()
  await ui.unmount()
})

test('the repository URL is a link', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-Linked')
  expect(await ui.find({ type: 'Link', href: 'https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-Linked' })).toBeTruthy()
  await ui.unmount()
})

test('a repository that is not on GitHub has no link, no card and no next step', async ($, on) => {
  const ui = await mountFor($, on, null, 'HelloID-Conn-Prov-Target-Unlinked')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^GitHub$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Up to date|Behind GitHub|Ahead of GitHub/ })).toBeUndefined()
  await ui.unmount()
})

test('a repository without a changelog is still on GitHub: link and card, no release note', async ($, on) => {
  const ui = await mountFor($, on, '', 'HelloID-Conn-Prov-Target-NoChangelog')
  expect(await ui.find({ type: 'Link', href: 'https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-NoChangelog' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^2 PRs · 1 issues$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not on GitHub/ })).toBeUndefined()
  await ui.unmount()
})

test('the download button shows while GitHub is ahead of the local release', async ($, on) => {
  const ui = await mountFor($, on, '1.3.0', 'HelloID-Conn-Prov-Target-DlBehind')
  expect(await ui.find({ key: 'download' })).toBeTruthy()
  await ui.unmount()
})

test('the download button is gone when GitHub has the same release', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-DlSynced')
  expect(await ui.find({ key: 'download' })).toBeUndefined()
  await ui.unmount()
})

test('the download button is gone when the local release is ahead', async ($, on) => {
  const ui = await mountFor($, on, '1.1.0', 'HelloID-Conn-Prov-Target-DlAhead')
  expect(await ui.find({ key: 'download' })).toBeUndefined()
  await ui.unmount()
})

test('the next step says to download when behind GitHub', async ($, on) => {
  const ui = await mountFor($, on, '1.3.0', 'HelloID-Conn-Prov-Target-NextBehind')
  expect((await ui.find({ type: 'Text', text: /^Behind GitHub: / }))?.text).toBe('Behind GitHub: ⇩ Download v1.3.0')
  await ui.unmount()
})

test('the next step says to convert a V1 connector, before a pull request waiting for review', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-NextV1', V1_SCRIPT)
  expect((await ui.find({ type: 'Text', text: /^Still on V1/ }))?.text).toBe('Still on V1: ⇢ Convert to V2')
  await ui.unmount()
})

test('the next step counts pull requests waiting for review', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-NextReview')
  expect((await ui.find({ type: 'Text', text: /waiting for review$/ }))?.text).toBe('1 pull request waiting for review')
  await ui.unmount()
})

test('a pull request waiting for review comes before an unpublished release', async ($, on) => {
  const ui = await mountFor($, on, '1.1.0', 'HelloID-Conn-Prov-Target-NextAhead')
  expect((await ui.find({ type: 'Text', text: /waiting for review$/ }))?.text).toBe('1 pull request waiting for review')
  expect(await ui.find({ type: 'Text', text: /^Ahead of GitHub: release/ })).toBeUndefined()
  await ui.unmount()
})

test('the release timeline marks where each release exists', async ($, on) => {
  // Local: 1.2.0 and 1.1.0. GitHub: 1.3.0 and 1.1.0.
  const ui = await mountFor($, on, '1.3.0', 'HelloID-Conn-Prov-Target-Timeline')
  // One legend: ✓ on both sides, ↑ local only (ahead), ↓ GitHub only (behind).
  expect((await ui.find({ type: 'Text', text: /^✓ 1\.1\.0$/ }))?.text).toBe('✓ 1.1.0')
  expect((await ui.find({ type: 'Text', text: /^↑ 1\.2\.0$/ }))?.text).toBe('↑ 1.2.0')
  expect((await ui.find({ type: 'Text', text: /^↓ 1\.3\.0$/ }))?.text).toBe('↓ 1.3.0')
  await ui.unmount()
})

test('a repository whose only file is a lower-case readme.md is still on GitHub', async ($, on) => {
  const ui = await mountFor($, on, 'lowercase', 'HelloID-Conn-Prov-Target-Lowercase')
  expect(await ui.find({ type: 'Link', href: 'https://github.com/Tools4everBV/HelloID-Conn-Prov-Target-Lowercase' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not on GitHub/ })).toBeUndefined()
  await ui.unmount()
})

test('the pull request list is only asked for when the issues list holds a pull request', async ($, on) => {
  requests.length = 0
  const ui = await mountFor($, on, 'no-prs', 'HelloID-Conn-Prov-Target-NoPrs')
  expect(await ui.find({ type: 'Text', text: /^0 PRs · 1 issues$/ })).toBeTruthy()
  expect(requests.some(one => one.url.includes('-NoPrs/issues?'))).toBe(true)
  expect(requests.some(one => one.url.includes('-NoPrs/pulls?'))).toBe(false)
  await ui.unmount()
})

test('asking again sends the ETag, and a 304 keeps the lists without a new answer', async ($, on) => {
  requests.length = 0
  let cwd = 'C:/code'
  engine(on, () => cwd)
  await $.session.start({ cwd, surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:/code/HelloID-Conn-Prov-Target-Etag/create.ps1' })
  await new Promise(done => setTimeout(done, 20))
  cwd = 'C:/code/HelloID-Conn-Prov-Target-Etag'
  await $.command.run(COMMAND)
  await new Promise(done => setTimeout(done, 20))

  const issues = requests.filter(one => one.url.includes('-Etag/issues?'))
  expect(issues.length).toBeGreaterThanOrEqual(2)
  expect(issues[0].ifNoneMatch).toBeUndefined()
  expect(issues[1].ifNoneMatch).toBe('"v1"')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^2 PRs · 1 issues$/ })).toBeTruthy()
  await ui.unmount()
})

test('a rate-limited GitHub says so instead of staying empty', async ($, on) => {
  const ui = await mountFor($, on, 'limited', 'HelloID-Conn-Prov-Target-Limited')
  expect(await ui.find({ type: 'Text', text: /^GitHub rate limit reached, try again later$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /not on GitHub/ })).toBeUndefined()
  await ui.unmount()
})

test('when only the issue list is rate-limited, the card says it will load later', async ($, on) => {
  const ui = await mountFor($, on, 'api-limited', 'HelloID-Conn-Prov-Target-ApiLimited')
  expect(await ui.find({ type: 'Text', text: /rate limit reached; the issues and pull requests load later/ })).toBeTruthy()
  await ui.unmount()
})

test('without a local changelog the pane offers to create one, and never overwrites', async ($, on) => {
  hidden.add('CHANGELOG.md')
  try {
    const ui = await mountFor($, on, '', 'HelloID-Conn-Prov-Target-EmptyLog')
    expect(await ui.find({ type: 'Text', text: /^No changelog yet$/ })).toBeTruthy()
    await ui.press({ key: 'create-changelog' })
    await new Promise(done => setTimeout(done, 20))
    const text = Object.entries(written).find(([path]) => /EmptyLog.CHANGELOG\.md$/.test(path))?.[1]
    expect(text).toMatch(/^# Change Log[\s\S]*## \[1\.0\.0\] - \d{4}-\d{2}-\d{2}/)
    // The file is there now: the empty state is gone.
    expect(await ui.find({ key: 'create-changelog' })).toBeUndefined()
    await ui.unmount()
  } finally {
    hidden.delete('CHANGELOG.md')
  }
})

test('the endpoint grid marks the scripts that call an endpoint', async ($, on) => {
  const ui = await mountFor($, on, '1.2.0', 'HelloID-Conn-Prov-Target-Grid')
  // Columns are the scripts that call anything: create, update and delete here.
  expect((await ui.find({ type: 'Text', text: /^cre$/ }))?.text).toBe('cre')
  expect((await ui.find({ type: 'Text', text: /^upd$/ }))?.text).toBe('upd')
  expect((await ui.find({ type: 'Text', text: /^del$/ }))?.text).toBe('del')
  expect((await ui.find({ type: 'Text', text: /^POST \/api\/users$/ }))?.text).toBe('POST /api/users')
  expect(await ui.find({ type: 'Text', text: /^●$/ })).toBeTruthy()
  await ui.unmount()
})

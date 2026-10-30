export type Endpoint = {
  script: string
  method: string
  path: string
}

export type ConfigField = {
  key: string
  kind: string
  label: string
  required: boolean
  value: string
}

export type Review = {
  reviewedAt: string
  scope: string
  total: number
  bySeverity: Record<string, number>
  openPoints: number
}

// The line under the header that says what an action did; it stays until dismissed.
export type Notice = {
  root: string
  text: string
  tone: 'info' | 'success' | 'error'
  // A folder or file the notice can open in VS Code.
  open?: string
}

export type Reviewing = {
  root: string
  files: string[]
}

// The release the connector's repository on GitHub carries, or why there is none.
export type Remote = {
  state: 'ok' | 'missing' | 'unavailable'
  version?: string
  // Every release the changelog on GitHub lists, newest first.
  releases?: string[]
  // The open issues and pull requests; absent when GitHub would not list them.
  items?: RemoteItem[]
  // GitHub refused with its rate limit (403 or 429), so the answer is missing or partial.
  isLimited?: boolean
  // When GitHub was asked (ms since the epoch).
  at?: number
}

export type RemoteItem = {
  kind: 'issue' | 'pr'
  number: number
  title: string
  url: string
  // Pull requests only: a draft, and one that has reviewers requested.
  isDraft?: boolean
  isReviewRequested?: boolean
}

// Which PowerShell connector generation the scripts are written for.
export type ScriptVersion = 'V1' | 'V2' | 'mixed'

// One script's generation; a script with neither marker is left out.
export type ScriptGeneration = 'V1' | 'V2'

// Set while /helloid-v1-to-v2 runs: the connector and the script it touched last.
export type Converting = {
  root: string
  // The scripts the connector had when the conversion started (those with a
  // generation marker): the fixed list progress is counted against, whatever
  // happens to the files on disk meanwhile.
  planned: string[]
  // The tracked documents (README.md, fieldMapping.json) as they were at the
  // start, by their stamp; one that did not exist has no entry. A document counts
  // as done once its stamp differs, that is, once it was written again.
  docs: Record<string, string>
  current?: string
}

export type Overview = {
  root: string
  name: string
  action?: string
  version?: ScriptVersion
  scriptVersions: Record<string, ScriptGeneration>
  // The files in the connector's root folder that are not scripts (json, md, …).
  files: string[]
  // Those files' stamps (modified time and size), by name.
  fileStamps: Record<string, string>
  // The newest release in CHANGELOG.md, e.g. "1.2.0".
  release?: string
  // Every release in CHANGELOG.md, newest first.
  releases: string[]
  // The newest release on GitHub; fills in a moment after the connector loads.
  remote?: Remote
  // Whether /ai-reviewer is installed; without it the review button is left out.
  hasReviewer: boolean
  // Whether /helloid-v1-to-v2 is installed; without it the convert button is left out.
  hasConverter: boolean
  scripts: string[]
  endpoints: Endpoint[]
  config: ConfigField[]
  configNote?: string
  review?: Review
}

declare module 'claude-code' {
  interface PluginState {
    'helloid-connector': {
      overview: Overview | null
      reviewing: Reviewing | null
      notice: Notice | null
      converting: Converting | null
      filter: string
    }
  }
}

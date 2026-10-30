# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep A Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-30

### Changed

- The V1 to V2 skill is now called `/connector-v1-v2` (was `/helloid-v1-to-v2`). The **⇢ Convert to V2** button, the check for the skill and the detection of a running conversion use the new name; with the old skill name the button is left out.

## [0.2.0] - 2026-10-30

### Added

- GitHub card with open pull requests and issues, a repository link and a download button for a newer release.
- Next-step line, release timeline and endpoint grid.
- Empty state with a **Create CHANGELOG.md** button when a connector has no changelog.
- One status legend and icon set (`✓` in sync, `↓` behind, `↑` ahead) for the sync note, next step and timeline.
- A clear message when GitHub's rate limit is hit, in the sync note and in the GitHub card, instead of an empty card.

### Changed

- Fewer GitHub API calls: the issues and pull request lists are conditional requests (`ETag`, a `304` does not count against the rate limit), and the pull request list is only asked for when the issues list holds a pull request.

### Fixed

- A connector without a `CHANGELOG.md` was shown as "not on GitHub". A repository with a `README.md` now counts as on GitHub, and the file names are also tried in lower case (`readme.md`, `changelog.md`).

## [0.1.0] - 2026-10-27

### Added

- Connector pane with scripts, endpoints, configuration and versions, the AI review card and the V1 to V2 conversion progress.

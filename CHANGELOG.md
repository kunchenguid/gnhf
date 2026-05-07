# Changelog

## [0.1.41](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.40...gnhf-v0.1.41) (2026-05-07)


### Bug Fixes

* **agents:** recover schema-valid agent JSON output ([#145](https://github.com/kunchenguid/gnhf/issues/145)) ([b5ffc2d](https://github.com/kunchenguid/gnhf/commit/b5ffc2dde57b27199c43aae29849a7c07416fbe6))

## [0.1.40](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.39...gnhf-v0.1.40) (2026-05-06)


### Bug Fixes

* **agents:** filter unrelated OpenCode session errors ([#142](https://github.com/kunchenguid/gnhf/issues/142)) ([2093a4a](https://github.com/kunchenguid/gnhf/commit/2093a4a686b048d9a044840bc36b91154dda83f1))

## [0.1.39](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.38...gnhf-v0.1.39) (2026-05-06)


### Features

* **renderer:** render meteors beside content ([#139](https://github.com/kunchenguid/gnhf/issues/139)) ([6538a2a](https://github.com/kunchenguid/gnhf/commit/6538a2af397876f1531e593ef4c067626f6181e8))

## [0.1.38](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.37...gnhf-v0.1.38) (2026-05-06)


### Bug Fixes

* **cli:** resume same-prompt current-branch runs ([#137](https://github.com/kunchenguid/gnhf/issues/137)) ([0b6eccf](https://github.com/kunchenguid/gnhf/commit/0b6eccfa076868cc3477de2c79f36bbb4f1b0c56))

## [0.1.37](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.36...gnhf-v0.1.37) (2026-05-06)


### Features

* **cli:** add configurable meteor frequency ([#135](https://github.com/kunchenguid/gnhf/issues/135)) ([785435d](https://github.com/kunchenguid/gnhf/commit/785435d8f9cfa02cdd547dc852ee635bc6f473f9))

## [0.1.36](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.35...gnhf-v0.1.36) (2026-05-05)


### Features

* **cli:** support pushing current-branch runs ([#132](https://github.com/kunchenguid/gnhf/issues/132)) ([306bdec](https://github.com/kunchenguid/gnhf/commit/306bdec6f54b011a552985ea4a57be6bf7c2e7ac))


### Bug Fixes

* **core:** preserve commit-failure workspaces for repair ([#134](https://github.com/kunchenguid/gnhf/issues/134)) ([bfb90cc](https://github.com/kunchenguid/gnhf/commit/bfb90ccbd9a46aad3dcd39def5d2ffc3e78c65e9))

## [0.1.35](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.34...gnhf-v0.1.35) (2026-05-03)


### Bug Fixes

* **core:** retry failed commits without hooks ([#130](https://github.com/kunchenguid/gnhf/issues/130)) ([bb2c2f9](https://github.com/kunchenguid/gnhf/commit/bb2c2f9737fa5d43abaea9e3c2de0b62ea068469))

## [0.1.34](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.33...gnhf-v0.1.34) (2026-05-03)


### Features

* **cli:** print post-run exit summaries ([#126](https://github.com/kunchenguid/gnhf/issues/126)) ([f3622f5](https://github.com/kunchenguid/gnhf/commit/f3622f5ab302a8c0db04b4302fdca69bb6b6912b))


### Bug Fixes

* **core:** clarify no-mistakes review link ([#129](https://github.com/kunchenguid/gnhf/issues/129)) ([6ecd669](https://github.com/kunchenguid/gnhf/commit/6ecd6692bcd4f0f84f53244d16ecfac41c89c0da))
* **core:** keep exit summary within terminal width ([#128](https://github.com/kunchenguid/gnhf/issues/128)) ([0e65519](https://github.com/kunchenguid/gnhf/commit/0e65519f602abbbde21b817f95d5fb742a2df0df))

## [0.1.33](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.32...gnhf-v0.1.33) (2026-05-03)


### Features

* **core:** support raw ACP command specs ([#122](https://github.com/kunchenguid/gnhf/issues/122)) ([ef7bfb2](https://github.com/kunchenguid/gnhf/commit/ef7bfb2ee698d04083d5004266f52e57cafa94ac))


### Bug Fixes

* **core:** drop issue marker from default commits ([#124](https://github.com/kunchenguid/gnhf/issues/124)) ([2f99dfb](https://github.com/kunchenguid/gnhf/commit/2f99dfbd300b46175e41edae0fd35b134e45f102))

## [0.1.32](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.31...gnhf-v0.1.32) (2026-05-02)


### Miscellaneous Chores

* rebuild release with telemetry website id baked in ([b6a9920](https://github.com/kunchenguid/gnhf/commit/b6a9920edf008b1d7704f8aee3cbfc84c25793d8))

## [0.1.31](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.30...gnhf-v0.1.31) (2026-05-02)


### Features

* **agents:** add ACP agent support ([#112](https://github.com/kunchenguid/gnhf/issues/112)) ([5157712](https://github.com/kunchenguid/gnhf/commit/51577120c8005c966f4de0ae70f2d67e9b60784f))
* **agents:** support ACP registry overrides ([#117](https://github.com/kunchenguid/gnhf/issues/117)) ([8d47386](https://github.com/kunchenguid/gnhf/commit/8d473861d9596dadc5f943923f1b1da810d97690))
* **core:** add anonymous run telemetry ([#114](https://github.com/kunchenguid/gnhf/issues/114)) ([a2dca97](https://github.com/kunchenguid/gnhf/commit/a2dca9744650c019ba90faa590440f8909057ccc))


### Bug Fixes

* **agents:** count ACP thought text as output tokens ([#118](https://github.com/kunchenguid/gnhf/issues/118)) ([f8881e4](https://github.com/kunchenguid/gnhf/commit/f8881e4b8e8c39257023619396ebd73185ef287e))
* **agents:** mark ACP token estimates consistently ([#119](https://github.com/kunchenguid/gnhf/issues/119)) ([80fc97d](https://github.com/kunchenguid/gnhf/commit/80fc97d12e2535281c1fa0baa2c1f7a7b7f6ca04))
* **renderer:** clear terminal title on exit ([#115](https://github.com/kunchenguid/gnhf/issues/115)) ([9ed3172](https://github.com/kunchenguid/gnhf/commit/9ed3172b5b7c3a4d517e9a1d4a4cc5fb10a9ecce))

## [0.1.30](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.29...gnhf-v0.1.30) (2026-04-29)


### Bug Fixes

* **cli:** handle generated branch and worktree slug collisions ([#106](https://github.com/kunchenguid/gnhf/issues/106)) ([df81f78](https://github.com/kunchenguid/gnhf/commit/df81f7804e6ed12c7c34e4a920938bd1f83702bf))

## [0.1.29](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.28...gnhf-v0.1.29) (2026-04-29)


### Bug Fixes

* **agents:** extend Rovo Dev startup timeout ([#104](https://github.com/kunchenguid/gnhf/issues/104)) ([0b2bbe5](https://github.com/kunchenguid/gnhf/commit/0b2bbe52f9398fa8028b514252918243b4f7f8f5))

## [0.1.28](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.27...gnhf-v0.1.28) (2026-04-29)


### Bug Fixes

* **core:** abort immediately on Claude low credit ([#102](https://github.com/kunchenguid/gnhf/issues/102)) ([28f54bb](https://github.com/kunchenguid/gnhf/commit/28f54bb939a098e463c40cefb0683da897b999e6))

## [0.1.27](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.26...gnhf-v0.1.27) (2026-04-29)


### Features

* Add support for Pi coding agent ([#97](https://github.com/kunchenguid/gnhf/issues/97)) ([380de4e](https://github.com/kunchenguid/gnhf/commit/380de4e97ea4d08517cf8fa0352b3db035c6517b))
* graceful shutdown on first ctrl+c ([#88](https://github.com/kunchenguid/gnhf/issues/88)) ([385211d](https://github.com/kunchenguid/gnhf/commit/385211d7e460d8a3abd273f40b69b01eb368b690))
* **worktree:** resume into a preserved worktree on re-invocation ([#76](https://github.com/kunchenguid/gnhf/issues/76)) ([f0e05f3](https://github.com/kunchenguid/gnhf/commit/f0e05f3a819b396367415942715b755a2ac62b33))


### Bug Fixes

* **cli:** persist stop-when on resume ([#100](https://github.com/kunchenguid/gnhf/issues/100)) ([0051228](https://github.com/kunchenguid/gnhf/commit/00512284b8bd7d71e421a0bd408d7ed7bb418172))

## [0.1.26](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.25...gnhf-v0.1.26) (2026-04-24)


### Bug Fixes

* **agents:** preserve final Claude output before forced shutdown ([#93](https://github.com/kunchenguid/gnhf/issues/93)) ([61e37a8](https://github.com/kunchenguid/gnhf/commit/61e37a87ea3811e16f1e04ba7dd38db8ce94a011))

## [0.1.25](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.24...gnhf-v0.1.25) (2026-04-23)


### Bug Fixes

* **cli:** preserve run history when updating a resumed prompt ([#91](https://github.com/kunchenguid/gnhf/issues/91)) ([61306e9](https://github.com/kunchenguid/gnhf/commit/61306e9a2a29f8ebd6885f1fe02bdf1fd3b8917b))
* **core:** preserve agent output and back off only on hard errors ([#89](https://github.com/kunchenguid/gnhf/issues/89)) ([b369ae8](https://github.com/kunchenguid/gnhf/commit/b369ae80fd752d11729046d971a5ab09be18c394))

## [0.1.24](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.23...gnhf-v0.1.24) (2026-04-23)


### Bug Fixes

* **agents:** make stop output schema conditional on --stop-when ([#82](https://github.com/kunchenguid/gnhf/issues/82)) ([36f69e8](https://github.com/kunchenguid/gnhf/commit/36f69e8d480f259b0142eb5aa9e1b25ad69f09cc))
* **cli:** handle resume prompt overwrite from the controlling terminal ([#77](https://github.com/kunchenguid/gnhf/issues/77)) ([cc18215](https://github.com/kunchenguid/gnhf/commit/cc1821531af107adfd31253feabdd24077867110))

## [0.1.23](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.22...gnhf-v0.1.23) (2026-04-18)


### Features

* **orchestrator:** add --stop-when condition to end loop ([#74](https://github.com/kunchenguid/gnhf/issues/74)) ([3ad2c86](https://github.com/kunchenguid/gnhf/commit/3ad2c861afcc47d46037e076e9646b29a167448d))

## [0.1.22](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.21...gnhf-v0.1.22) (2026-04-17)


### Bug Fixes

* **agents:** dedupe Claude usage across repeated assistant snapshots ([#72](https://github.com/kunchenguid/gnhf/issues/72)) ([22a4728](https://github.com/kunchenguid/gnhf/commit/22a472831471b66051c27018ac8a033e3c06299d))

## [0.1.21](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.20...gnhf-v0.1.21) (2026-04-17)

### Features

- add live terminal title updates ([#70](https://github.com/kunchenguid/gnhf/issues/70)) ([f8b57d6](https://github.com/kunchenguid/gnhf/commit/f8b57d6a7640cff457f3d399b4aa1b44bb37abbe))

## [0.1.20](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.19...gnhf-v0.1.20) (2026-04-17)

### Bug Fixes

- **core:** harden git command inputs against shell injection ([#68](https://github.com/kunchenguid/gnhf/issues/68)) ([b19d778](https://github.com/kunchenguid/gnhf/commit/b19d778a1322d636e1179aa29b5fe606e7c8b0cc))

## [0.1.19](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.18...gnhf-v0.1.19) (2026-04-12)

### Bug Fixes

- **orchestrator:** handle aborts and preserve successful recordings ([#66](https://github.com/kunchenguid/gnhf/issues/66)) ([7ad041d](https://github.com/kunchenguid/gnhf/commit/7ad041ddabdd70cf18e1a20e2ed917e7372bc2da))

## [0.1.18](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.17...gnhf-v0.1.18) (2026-04-10)

### Features

- git worktree support so that it can support multiple features to one git repository ([#63](https://github.com/kunchenguid/gnhf/issues/63)) ([bf9e3d8](https://github.com/kunchenguid/gnhf/commit/bf9e3d86899e6f3c6421605566849d110b55c1db))

## [0.1.17](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.16...gnhf-v0.1.17) (2026-04-10)

### Bug Fixes

- **iteration-prompt:** clarify notes.md instructions ([2182240](https://github.com/kunchenguid/gnhf/commit/218224073890831d667850272b4234f6fefc68b8))

## [0.1.16](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.15...gnhf-v0.1.16) (2026-04-09)

### Features

- **codex:** allow per-agent cli arg overrides ([#58](https://github.com/kunchenguid/gnhf/issues/58)) ([4c1731e](https://github.com/kunchenguid/gnhf/commit/4c1731e0f1fc321d3ac63818bffe6dd245ed3dbe))

## [0.1.15](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.14...gnhf-v0.1.15) (2026-04-08)

### Bug Fixes

- Normalize changes and learnings to avoid JSON schema non-adherence to break the notes.md file ([#59](https://github.com/kunchenguid/gnhf/issues/59)) ([3b1427b](https://github.com/kunchenguid/gnhf/commit/3b1427b8eeaac7463da95c358e4bf8a510542772))

## [0.1.14](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.13...gnhf-v0.1.14) (2026-04-07)

### Features

- **agents:** use prompt_async endpoint instead of blocking /message ([#56](https://github.com/kunchenguid/gnhf/issues/56)) ([ef5d6d3](https://github.com/kunchenguid/gnhf/commit/ef5d6d3c8c6634abccaebd28db59086cb294f8ee))

## [0.1.13](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.12...gnhf-v0.1.13) (2026-04-06)

### Features

- **core:** add detailed error logging ([#54](https://github.com/kunchenguid/gnhf/issues/54)) ([84eaa15](https://github.com/kunchenguid/gnhf/commit/84eaa15e740d35e81508a4dce91405656eb34ff3))

## [0.1.12](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.11...gnhf-v0.1.12) (2026-04-05)

### Bug Fixes

- **cli:** clarify loop prompts and abort UI ([#26](https://github.com/kunchenguid/gnhf/issues/26)) ([90022c1](https://github.com/kunchenguid/gnhf/commit/90022c1df1d0456d67255c6d36dec968ffa9e943))

## [0.1.11](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.10...gnhf-v0.1.11) (2026-04-04)

### Features

- **config:** add agent path overrides ([#24](https://github.com/kunchenguid/gnhf/issues/24)) ([c8a71c6](https://github.com/kunchenguid/gnhf/commit/c8a71c61019fd4795dabe3e5bdda4e7a44771855))

## [0.1.10](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.9...gnhf-v0.1.10) (2026-04-03)

### Features

- **renderer:** adapt content to viewport ([#20](https://github.com/kunchenguid/gnhf/issues/20)) ([592d80b](https://github.com/kunchenguid/gnhf/commit/592d80b6d9befb9a38f44cc19346e736c01a5220))
- **renderer:** randomize star field seeds ([#22](https://github.com/kunchenguid/gnhf/issues/22)) ([e658f32](https://github.com/kunchenguid/gnhf/commit/e658f32004bc54b66ef3c23fec85857f1132fece))

## [Unreleased]

### Features

- **config:** allow per-agent binary path overrides
- **renderer:** randomize star field seeds between runs
- **renderer:** update the terminal title with live run status and restore it on exit

### Bug Fixes

- **agents:** support Windows cmd/bat agent wrappers and terminate overridden agent processes cleanly
- **agents:** deduplicate repeated Claude assistant usage snapshots so live token totals and max-token enforcement stay accurate
- **cli:** keep the final interactive TUI visible after aborted runs until the user exits
- **core:** harden git command execution so commit messages, branch names, and worktree paths are passed without shell interpretation
- **renderer:** keep wide Unicode graphemes wrapped and aligned in the live terminal UI

## [0.1.9](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.8...gnhf-v0.1.9) (2026-04-03)

### Features

- **sleep:** prevent system sleep during runs ([#17](https://github.com/kunchenguid/gnhf/issues/17)) ([091d9d3](https://github.com/kunchenguid/gnhf/commit/091d9d31b80a4c1b3c01fd7e65009ad86d864ec1))

## [0.1.8](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.7...gnhf-v0.1.8) (2026-04-02)

### Bug Fixes

- **schema:** enforce strict output schema ([#14](https://github.com/kunchenguid/gnhf/issues/14)) ([085aef7](https://github.com/kunchenguid/gnhf/commit/085aef74ba647a582aa280697213790abfa49cfa))

## [0.1.7](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.6...gnhf-v0.1.7) (2026-04-01)

### Features

- add RovoDev agent support ([#11](https://github.com/kunchenguid/gnhf/issues/11)) ([484d989](https://github.com/kunchenguid/gnhf/commit/484d989a632aebef27b4592f96ffd7fd4f25fde0))
- **opencode:** add OpenCode agent integration ([#13](https://github.com/kunchenguid/gnhf/issues/13)) ([aa9a2a5](https://github.com/kunchenguid/gnhf/commit/aa9a2a5cecbfe95abe6830dff40750aa03ee0423))

## [0.1.6](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.5...gnhf-v0.1.6) (2026-04-01)

### Features

- **cli:** add iteration and token caps ([#9](https://github.com/kunchenguid/gnhf/issues/9)) ([b92e9ac](https://github.com/kunchenguid/gnhf/commit/b92e9aca196647b19c854b722551e401c4ce72a7))

## [0.1.5](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.4...gnhf-v0.1.5) (2026-04-01)

### Bug Fixes

- **cli:** show friendly non-git error ([#7](https://github.com/kunchenguid/gnhf/issues/7)) ([65acf6b](https://github.com/kunchenguid/gnhf/commit/65acf6be343b805b99a6011d1562ac54b05b6760))

## [0.1.4](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.3...gnhf-v0.1.4) (2026-04-01)

### Features

- **core:** track branch commits from run base ([#5](https://github.com/kunchenguid/gnhf/issues/5)) ([dce09e6](https://github.com/kunchenguid/gnhf/commit/dce09e6a0a47644a174428c7a29b6e19f189486b))

## [0.1.3](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.2...gnhf-v0.1.3) (2026-03-31)

### Bug Fixes

- **cli:** correct version flag ([a1203ca](https://github.com/kunchenguid/gnhf/commit/a1203caf8a6fbb794b8a954b4acdf79ebba2ebd8))

## [0.1.2](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.1...gnhf-v0.1.2) (2026-03-31)

### Bug Fixes

- repo field in package json ([d635f42](https://github.com/kunchenguid/gnhf/commit/d635f42286f2a2904752d3d06319e2950d992934))

## [0.1.1](https://github.com/kunchenguid/gnhf/compare/gnhf-v0.1.0...gnhf-v0.1.1) (2026-03-31)

### Features

- initial commit ([c8ae6d2](https://github.com/kunchenguid/gnhf/commit/c8ae6d21f4cf0b493386c00bdaa023b947d02451))

### Bug Fixes

- update README and lower maxConsecutiveFailures to 3 ([ad8925b](https://github.com/kunchenguid/gnhf/commit/ad8925b93e80e62af615eff7fc56e8399cdee4b8))

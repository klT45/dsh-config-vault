# DSH configuration surface — Config Vault scope model

Status: v1 working doc, 2026-10-20. DSH runtime **0.2.1-rc.2**. Evidence: read-only inspection of
`C:\Users\lu\.dsh` + `C:\Users\lu\.agents` and the extracted packages under `.dsh-src/node_modules/@deepseek-ai/`
(cited per claim). Anything unprovable from those sources is marked **unverified**; no secret values appear here —
only key names, paths and byte lengths.

## 1. Scope model in one paragraph

DSH has no single settings file. At boot it composes an entry tree from: each profile's `package.json`
`dsh.profile.bundles` order → each bundle's patch file(s) → `$DSH_HOME/profiles/<name>/cordis.patch.yml` →
`$DSH_HOME/cordis.patch.yml` (home patch, applied last, so it outranks the profile) → `--patch` overlays
(`.dsh-src/node_modules/@deepseek-ai/dsh/README.md:41-44`). Everything a user configures today — model
routes, theme, plugin toggles, **MCP servers**, agent-preset overrides, live settings forms — lands either in
a profile patch or in the home patch, so **the profile (plus the home patch) is the unit of configuration**.
Secrets live in `$DSH_HOME/.credentials.yaml` (plus `.env` layers and any literal tokens a user pastes into
patches/MCP `env`). Runtime state (workspaces, schedules, projection cache) lives under `$DSH_HOME/storages/`
and is written by the host, not by a settings surface. Skills and `AGENTS.md` are loose files in two roots:
`$DSH_HOME` and the shared agents home `$DSH_AGENTS_HOME` (`~/.agents`).

## 2. Evidence base

| Source | Establishes |
|---|---|
| `dsh/README.md:41-48`; `dsh-app-boot/README.md:50,58-69`; `dsh-hmr/README.md:27,59-61`; `dsh-base/cordis.patch.yml:28-32` | Profile layout and patch layer order; home patch `$DSH_HOME/cordis.patch.yml`; `.env` home layer; HMR watches profile manifest + both patch files (on for web/desktop, off for headless/sdk/acp) |
| `dsh-config-editor/README.md:33-41,67-69`; `dsh-settings/README.md:33-39` | Live settings forms persist into the **active profile patch**; `settings.yaml` import-once → `settings.yaml.imported` |
| `dsh-plugin-manager/README.md:40,71,155-162` | Writes `cordis.patch.yml` (`disabled`), `package.json` (`dsh.profile.bundles`), `pnpm-lock.yaml`/`pnpm-workspace.yaml` (recovery), `compatibility.json`; logs in `.plugin-manager/logs` |
| `dsh-mcp-client/README.md:30-53,93`; `dsh-mcp-resources/README.md:29-33` | MCP servers are ordinary rows (`serverName`, `transport`, `command/args/env`, `url/headers`), one per entry; editing the row reloads the connection; no separate MCP config file |
| `dsh-skill-filesystem/README.md:44-56,74-81`; `dsh-agent-instructions/README.md:34-40` | Skill roots/ranks and `<n>/SKILL.md` frontmatter (watched); `AGENTS.md`/`CLAUDE.md` chain and its no-watcher refresh model |
| `dsh-agent-preset-registry/README.md:44-48`; `dsh-web-app/README.md:91`; `dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md:70` | Presets are `insert` rows; user edits persist in the profile patch; legacy `$DSH_HOME/.agent-presets/` is read by nothing |
| `dsh-credentials-local/README.md:69-115`; `dsh-storage-json/README.md:54-88`; `dsh-workspace/README.md:115-125` | Credential document shape/precedence/live watch; `storages/<unit>.json` single vs per-record; workspace unit v2; no cross-process lock |
| Disk (this machine) | Presence/sizes/masking-inventory in the tables below |

## 3. Scope table

| id | Display name | Paths (portable) | Format | Secret risk | Restore effect | Default |
|---|---|---|---|---|---|---|
| `settings` | 设置 / Settings | `$DSH_HOME/cordis.patch.yml`; `$DSH_HOME/profiles/<p>/cordis.patch.yml` (`config` rows); legacy `$DSH_HOME/settings.yaml` | YAML loader patch array (`!!js` tags) | Low–med (env-var names normally; pasted literals possible) | **live** (HMR) on web/desktop; restart on headless/sdk/acp | yes |
| `profile` | 配置档案 / Profile | `$DSH_HOME/profiles/<p>/{package.json,cordis.patch.yml,pnpm-workspace.yaml,pnpm-lock.yaml,compatibility.json,patches/}` | JSON / YAML | Low (lockfile may hold git URLs/userinfo) | manifest change → live recompose; new deps need `pnpm install`; restart without HMR | yes |
| `plugins` | 插件 / Plugins | bundle list + deps in `package.json`; enablement `disabled` in patch; `$DSH_HOME/plugins/<id>/config.yaml` (plugin-owned) | JSON / YAML | Low–med (plugin configs may hold tokens) | **live** for patch/manifest; plugin config file read at activation (unverified) | yes (patch+manifest); plugin dirs opt-in |
| `mcp` | MCP 服务器 | **No dedicated file.** `@deepseek-ai/dsh-mcp-client` rows inside a profile/home patch (or a bundle) | YAML patch rows | **Med–high** (`env`/`headers` may carry literal tokens) | **live** (row edit reloads connection in place) | yes (subset of `profile`) |
| `skills` | 技巧 / Skills | rank 100 `<root>/.dsh/skills`; 200 `<root>/.agents/skills`; 300 `customSkillDirs`; 400 `$DSH_HOME/skills`; 500 `$DSH_AGENTS_HOME/skills`; 600 bundled | `<n>/SKILL.md` or `<n>.md` + YAML frontmatter + resources | Low, but scripts may embed keys; dirs can be huge | **live** (watched catalog) | user-level yes (size-capped); project-level opt-in |
| `presets` | 智能体预设 / Agent presets | shipped in `@deepseek-ai/dsh-web-app/presets/*.patch.yml`; user overrides/`selectedDefault` in profile patch; legacy `$DSH_HOME/.agent-presets/` | YAML rows (`id`, `plugins`, `order`) | Low (prompt text) | **live** recompose; existing sessions keep old revision | yes (as patch rows); legacy dir no |
| `workspaces` | 工作区 / Workspaces | `$DSH_HOME/storages/workspace.json` | JSON, unit v2 | Low (absolute paths, session ids) | **restart** (stop host) | yes, sanitized |
| `credentials` | 凭据 / Credentials | `$DSH_HOME/.credentials.yaml` (+ `$DSH_HOME/.env`, `<cwd>/.env` fallbacks) | YAML: `version`, `refs.<ENV_NAME>`, `records.<owner>/<id>` | **High** | **live** (watched) | **no** (opt-in, encrypted) |
| `other` | 其他状态 / Other state | `storages/{schedule,token_stats}.json`, `storages/session_projcache/`, plugin state files, `.anonymous-user-id`, `settings.yaml.imported`, `logs/`, `cache/`, `.plugin-manager/`, `.dsh-market/` | JSON/JSONC/logs | Varies | n/a — not configuration | no |

## 4. Per-scope detail

### 4.1 `settings`
What lives here: id-targeted rows whose `config` is the user's value for a plugin. Observed: `agent-default-model`
(`provider: goujia`, `model: deepseek-v4.1-flash`, `reasoningEffort: max`), `llm-pi-ai` providers (`ikik`,
`qiniu`, `mao`, `ge`, `goujia`, each with `apiKeyEnv: <NAME>_API_KEY`), `ui-theme` (`preference: dark`),
`web` (`searchProvider: unified`), onboarding (`ui-settings-account.config.version: 1`) and pet rows.
The Models page, theme, locale, plugin toggles and preset defaults are also written here by
`dsh-config-editor`/`dsh-settings`.
Legacy `$DSH_HOME/settings.yaml` is imported once after startup and **renamed** to `settings.yaml.imported`
before the first write; a rejected section stays only in the renamed file (`dsh-settings/README.md:33-37`).
Observed tombstone: `settings.yaml.imported` (52 B) holds `ui-onboarding.welcomeNoticeVersion`.
Pitfalls: patch `config` is **replaced wholesale, never deep-merged** — an override must restate every field
it keeps; preserve comments and `!!js` scalars byte-for-byte (a generic YAML parse→dump loses both); an empty
or comments-only patch fails boot (disable with `[]`); writes must be atomic and serialized with the host's
writer lock, or HMR/config-editor/plugin-manager can clobber them.

### 4.2 `profile`
What lives here (`$DSH_HOME/profiles/<name>/`), measured today:

| file | desktop | web | headless | notes |
|---|---|---|---|---|
| `cordis.patch.yml` | 6,712 B | 3,513 B | 217 B (`[]`) | user layer; +13 stale copies on disk (clutter) |
| `package.json` | 1,051 B | 918 B | 213 B | deps + ordered `dsh.profile.bundles` |
| `pnpm-workspace.yaml` | 380 B | 466 B | 61 B | `nodeLinker: hoisted`, `allowBuilds`, `minimumReleaseAgeExclude`, `patchedDependencies` (web) |
| `pnpm-lock.yaml` | 40,100 B | 29,064 B | absent | lockfile v9; can grow to MBs |
| `compatibility.json` | absent | absent | absent | exact version exemptions; created only on grant |
| `cordis.yml` | 223 B (`[]`) | 223 B | 223 B | **generated root**, "Edit cordis.patch.yml, not this file" — exclude |
| `patches/*.patch` | — | 2 files, 7.9 KB | — | referenced by `pnpm-workspace.yaml`, must travel together |

Pitfalls: shared `link:`/`file:` deps carry machine-absolute paths (e.g.
`"@local/dsh-meme-probe": "link:C:/…/meme-probe"`) — mark non-portable; `patchedDependencies`
without its `patches/` dir breaks install; `pnpm-lock.yaml` is huge → diff by package/version summary;
`allowBuilds` rejects YAML anchors/aliases on approval (`dsh-plugin-manager/README.md:64`); `desktop` is
Electron-owned and its package operations belong to the Desktop shell (`dsh/README.md:20`).

### 4.3 `plugins`
Three separable things: (1) **installed + selected bundles** = `package.json` deps + ordered
`dsh.profile.bundles`; (2) **per-entry enablement/config** = rows in the profile/home patch (`disabled`,
`config`); (3) **per-plugin config directories** = `$DSH_HOME/plugins/<plugin>/config.yaml`, a plugin-owned
convention (observed for `dsh-fs-encoding`, whose file says "Location: $DSH_HOME/plugins/dsh-fs-encoding/config.yaml").
Only one such dir exists today (1,754 B) and **no inspected profile installs that package** — an orphan;
do not restore plugin config without verifying the plugin is installed (or is being restored with it).
Do not snapshot `node_modules`: desktop profile 189 MB / 18,768 files, web 40 MB / 2,723 files, and
`$DSH_HOME/profiles/node_modules` is a 47-entry hoist farm of which **36 are junctions** into a dev checkout
(a sibling harness source tree) — copying them is both huge and machine-bound.

### 4.4 `mcp`
There is no `mcp.json`. A server is one loader row inserted by a bundle or by the user:
```yaml
- insert:
    - id: mcp-akshare                       # observed in desktop cordis.patch.yml.bak-mcp-off-20261015-180411
      name: "@deepseek-ai/dsh-mcp-client"
      config: { serverName: akshare, transport: stdio,
                command: 'C:\Users\lu\.local\bin\uvx.exe', args: [akshare-one-mcp],
                toolCallTimeoutMs: 180000 }
```
Fields: `transport` (`stdio`|`streamable-http`, required), `serverName` (`[A-Za-z0-9_-]{1,32}`, unique in scope),
`command/args/env/cwd` or `url/headers`, `toolCallTimeoutMs` (60 s), `maxInstructionBytes`, `failOnStartupError`,
`reconnect.*` (`dsh-mcp-client/README.md:55-67`). Editing the row reloads the connection in place; tool names are
`mcp__<serverName>__<tool>`. Risks: literal tokens belong in `env`/`headers` — the documented safe form is
`!!js process.env.NAME` / `` !!js '`Bearer ${process.env.MCP_TOKEN}`' ``; `command` paths are machine-specific;
the current profile patch contains **no** MCP rows (they were disabled/removed on 2026-10-15), so a snapshot must
also record "no servers" instead of silently keeping a stale backup.

### 4.5 `skills`
Roots and ranks (`dsh-skill-filesystem/README.md:44-56`): 100 `<project>/.dsh/skills`, 200
`<project>/.agents/skills`, 300 `customSkillDirs`, 400 `$DSH_HOME/skills` (skips `.system`), 500
`$DSH_AGENTS_HOME/skills`, 600 bundled. "Project root" = nearest `.git` ancestor, else cwd. This machine:
`C:\Users\lu\.dsh\skills` absent, `C:\Users\lu\.agents\skills` has 15 entries totaling **289.5 MB**
(one skill, `stockaskill`, is 274.4 MB because of a bundled Python venv). Format: directory `<name>/SKILL.md`
or flat `<name>.md`, YAML frontmatter with required `name`/`description`, optional `whenToUse`, `metadata`,
`disable-model-invocation`, `user-invocable`; discovery is **one level deep only**.
Snapshot rules: user/agents-level roots by default, project-level opt-in (they belong to a repo); exclude
`.venv/`, `node_modules/`, `__pycache__/`, `.git/`, caches, model weights; keep `SKILL.md` + declared
`references/scripts/assets`; size-cap and report per-skill bytes. Renamed-to-disabled skill dirs are still
discovered as directories (`superpowers-workflow.disabled-20260911-101631` observed) — preserve names.

### 4.6 `presets`
Shipped presets (`standard`, `ptc`, `minimal`, `cordis`) are `insert` rows in the web bundle's
`presets/<id>.patch.yml` — installation files, not user data. User changes are (a) an override row keyed
`preset-<id>` or a new `insert` of `@deepseek-ai/dsh-agent-preset` in the profile patch, and (b) the registry's
`selectedDefault` volatile field persisted through the settings service into the profile patch
(`dsh-web-app/README.md:91`). Legacy per-user preset directories (`$DSH_HOME/.agent-presets/<id>/preset.yml` +
`agent.cordis.yml`) are read by **nothing** in this version; the observed directory is empty. Restore is a
profile-patch operation: a live host recomposes, but sessions already open keep their old preset revision.

### 4.7 `workspaces`
`$DSH_HOME/storages/workspace.json`, `single` layout, domain unit `workspace` v2 (`dsh-workspace/README.md:115-125`):
`global.{workspaceIds, defaultWorkspaceId, archivedSessionIds, pinnedSessionIds, pendingMutation?}` and
`tables.workspaces.<uuid>.{path, title, sessionIds, createdAt, updatedAt}`. Today: 6,394 B, 9 ids. Paths are
`realpath`-canonicalized and machine-absolute (e.g. `C:\dev\my-project`, …); session ids are machine-local.
Restore **only while DSH is stopped**: `dsh-storage-json` has no cross-process write lock and the live registry
holds in-memory state and rewrites the whole unit — restoring under a running host is last-completion-wins.
Portable form: keep `path` as `~/…`/relative, drop `sessionIds`/archive/pin sets on export (or keep them as
non-restored metadata).

### 4.8 `credentials`
Document `$DSH_HOME/.credentials.yaml` (936 B today): `version: 1`; `refs` maps env-var names to secret text
(observed names: `IKIK_API_KEY`, `QINIU_API_KEY`, `S2CLAUDE_API_KEY`, `MAO_API_KEY`, `GE_API_KEY`,
`GOUJIA_API_KEY`); `records` maps `<owner>/<id>` to `{kind: api-key|grant, payload|env}` (3 records observed:
`secret` len 43, `token` len 64 + `issuer`, and an id-only record). All values masked here.
Rules (`dsh-credentials-local/README.md:82-115`): any text incl. multi-line (no quoting needed); empty value is
invalid (delete to unset); `grant.payload` must survive a JSON round-trip; unknown top-level keys are kept but
ignored; malformed YAML fails boot (last good snapshot kept on live reload); POSIX requires owner-only mode
(Windows check skipped); writes take a writer lock and preserve comments. Snapshot policy: **excluded by
default**; opt-in export only as an encrypted blob (scrypt/AES-GCM or age), never as plain YAML, never logged,
never diffed by value (redact to `<masked len=N>`). Fallback layers `$DSH_HOME/.env`, `<cwd>/.env` and the launch
environment are read-only inputs, not managed here; the home `.env` does not exist on this machine.

### 4.9 `other` (deliberately out of the default snapshot)
`$DSH_HOME/storages/schedule.json` (4,794 B, unit `schedule` v1, reminder prompts + session ids),
`storages/token_stats.json` (157,325 B), `storages/session_projcache/` (67 per-record files, 1.48 MB),
`$DSH_HOME/dsh-pet/main-config.jsonc` (266 B), `pet.json` (523 B), `dsh-expression.json` (2,014 B),
`dsh-api-dashboard.json` (624 B), `llm-deepseek/files-v3.json` (926 B), `dsh-market/printed-build-keys.json`,
`openwrite/active.json`, `profiles/<p>/.dsh-market/` (incl. a 262 KB discovery cache), `.plugin-manager/logs/`
(48 files), `logs/`, `cache/`, `attachments/`, `sessions/`, `.anonymous-user-id`, `settings.yaml.imported`,
`.agent-presets/`, `dog/`, `meme-packs/`, `electron/`. These are session state, telemetry, caches, identity or
third-party plugin data; some are secrets-adjacent (`llm-deepseek` tokens are in the credential store, not here).
Include only via explicit per-plugin adapters.

## 5. Recommended snapshot layout (machine- and profile-portable)

```text
config-vault/
  manifest.json                 # formatVersion, createdAt, dshVersion, host{os,arch} (informational),
                                #   profiles[], scopes[], secretPolicy, sha256 per file, sanitize rules applied
  home/
    cordis.patch.yml            # optional home-level layer (absent today, but outranks the profile)
    AGENTS.md                   # optional
    plugins/<plugin-id>/config.yaml
    storages/workspace.json     # sanitized
  profiles/<profile-name>/
    package.json
    cordis.patch.yml
    pnpm-workspace.yaml
    pnpm-lock.yaml
    compatibility.json          # when present
    patches/*.patch             # when present
  agents-home/
    AGENTS.md
    skills/<skill>/...          # SKILL.md + resources, size-capped
  secrets/
    credentials.yaml.enc        # optional, encrypted; key never stored in the vault
```

Rules:
1. **Allowlist, never blocklist.** Copy only the names above; never walk `$DSH_HOME` wholesale.
2. Store relative POSIX-style paths. Render roots symbolically as `$DSH_HOME`, `$DSH_AGENTS_HOME`,
   `<profile>`, `$HOME`, `$PROJECT_ROOT` (same rules as `dsh-home-paths`); no drive letters or usernames in the
   manifest except inside informational `host`.
3. **Byte-exact copies for YAML** — preserve comments, blank lines and `!!js` tags; do not parse→re-serialize
   for storage. Parse only for masked previews/diffs.
4. Diffs: structural by entry `id` for patch files (rows are reordered by writers), line diff for display,
   package/version summary for `pnpm-lock.yaml`.
5. Sanitizers on export: workspace paths → `~`/relative, drop session ids and archive/pin sets, redact
   credential-shaped values (`*_API_KEY`, `token`, `secret`, `password`, `authorization`, `bearer`), flag
   `link:`/`file:`/git deps and absolute MCP `command` paths as non-portable warnings.
6. Exclude patterns (belt and braces): `node_modules/`, `*.lock`/`*.lock.takeover-*`, `.venv/`, `__pycache__/`,
   `.git/`, `sessions/`, `attachments/`, `cache/`, `logs/`, `electron/`, `*.bak-*`, `*.pre-*`, `.backup-*`,
   `.dsh-market/`, `.plugin-manager/`, `tokentats*`, `.anonymous-user-id`.
7. Restore writes: atomic replace + sibling writer lock with mode `0o600` (mirrors `dsh-atomic-write`), always
   after copying the current file to `<name>.bak-<unix-ms>` (the same convention `sanitizeProfile` uses).

## 6. Restore ordering and safety

| Step | Action | While host runs? |
|---|---|---|
| 1 | Stop DSH (web/desktop HMR could otherwise recompose over a half-restored set) | safest |
| 2 | Restore `package.json` + `pnpm-workspace.yaml` + `pnpm-lock.yaml` + `patches/`, then `pnpm install --frozen-lockfile` in the profile dir | no (Desktop owns package ops) |
| 3 | Restore `cordis.patch.yml` (profile), then home `cordis.patch.yml`; validate (`dsh --dump-config`) | live on web/desktop only if a single complete patch write |
| 4 | Restore plugin config files, skills, `AGENTS.md` | yes (skills watched; instructions next request) |
| 5 | Restore `storages/workspace.json` and other units | **never while running** |
| 6 | Restore encrypted credentials, chmod `0600` on POSIX | yes (watched, debounced 100 ms) |

Cross-profile restore is allowed by layout but must surface a compatibility diff: bundle availability,
DSH version requirement (`engines.dsh`/peers, exemptions in `compatibility.json`), and preset rows that name
packages the target profile does not install.

## 7. Open questions and risks

1. **MCP location**: verified as patch rows in this version; there is no standalone file. A future build could
   add one (unverified) — the MCP scope should be a *view* over patch entries, not a file import.
2. **Which patch layer settings target**: `dsh-settings`/`dsh-config-editor` write the *active profile* patch,
   yet `dsh-client-ui-theme` and `dsh-client-locale` READMEs say values persist in `$DSH_HOME/cordis.patch.yml`.
   On this machine `ui-theme` sits in the profile patch and no home patch exists — **unverified** which wins for
   every settings namespace; snapshot both and diff the effective result via `--dump-config`.
3. **`settings.yaml` and the home patch**: restoring an old `settings.yaml` would re-trigger the one-shot import;
   because the home patch outranks the profile patch and is HMR-watched, a profile-only snapshot would silently
   lose any settings a build writes there. Never restore over `.imported`; always include the home patch.
4. **Restore while running**: HMR recomposes on patch write; a multi-file restore triggers intermediate
   compositions (possibly failing startup rows) and plugin-manager/config-editor may hold the same writer lock.
   Only a single atomic patch write is safe live; otherwise stop the host.
5. **`storages/` under a running host**: no cross-process lock (`dsh-storage-json` limitation) and in-memory
   state republishes the whole unit → a restore can be overwritten or lost. Require host stop + pre-restore backup.
6. **`node_modules` and links**: 189 MB desktop profile; `$DSH_HOME/profiles/node_modules` has 36 junctions to
   a source checkout; web has an absolute `link:` dependency. Never snapshot; reinstall, and flag link/git deps.
7. **Secrets outside `.credentials.yaml`**: MCP `env`/`headers`, plugin config files, pasted literals in patches,
   project/home `.env`. The exporter must scan + mask those too (key-name heuristics + entropy checks).
8. **Backup clutter masquerades as config**: 13 `cordis.patch.yml.*` copies in the desktop profile plus
   `.backup-*` dirs in web. Allowlist prevents restoring stale/incorrect states; show them only as history.
9. **Huge skills**: 289.5 MB today, dominated by a 274 MB venv. Exclude heavy subdirs and size-cap, or the
   snapshot becomes unusable; report per-skill size in the UI.
10. **Plugin config orphans**: `$DSH_HOME/plugins/<id>/config.yaml` can belong to a plugin no profile installs
    (observed). Restore must validate plugin presence or restore config+plugin together.
11. **Platform + unmaterialized layers**: Windows-only observations (separators, drive letters, junctions,
    skipped POSIX mode check) require a platform-neutral format; `cordis.yml` is generated (`[]`), `--patch`
    overlays exist only at invocation, and the `desktop` profile is Electron-owned — record these as "not
    captured" and route Desktop restores through Desktop.

## 8. Current size ledger (this machine)

Snapshot-relevant: profile files (desktop+web+headless) **90.6 KB / 13 files**; home patch, `.env`,
`AGENTS.md`, `compatibility.json` absent (0 B); `plugins/` 1,754 B / 1 file; `storages/workspace.json` 6,394 B;
`$DSH_AGENTS_HOME/skills/` 289.5 MB / 15 roots (size-cap needed); `.credentials.yaml` 936 B (encrypted only).
Excluded: profile `node_modules` 229 MB / 21,491 files; `profiles/node_modules` 36 junctions;
`.dsh/electron/` 347.3 MB; the rest of `storages/` 1.64 MB / 69 files.

/**
 * dsh-config-vault — browser half (no build step).
 *
 * This file is the bundle the Host serves at `/plugins/dsh-config-vault/client.js`.
 * It registers one lazy CJS factory with the boot kernel's module-loader
 * facade; React comes from the shared browser module table, so `require('react')`
 * is safe without an import map and without a duplicate React.
 *
 * The factory returns `{ inject: ['slots'], apply }`. `apply` registers one
 * `settings.section` entry; the panel talks to this plugin's own host routes
 * (`POST /config-vault/<action>`, same-origin, JSON envelope).
 *
 * Runtime dependencies: none beyond React and the Host's own CSS variables.
 */
window.__ModuleLoader__.load({
  id: 'dsh-config-vault',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Route prefix owned by the host half (must match its config default). */
    const ROUTE_PREFIX = 'config-vault'

    /** Locale-independent Chinese copy (the vault is a zh-first plugin for now). */
    const COPY = {
      nav: '配置保险箱',
      title: '配置保险箱',
      subtitle: '给 DSH 配置留一份可回滚的底：快照、对比、恢复。恢复前会自动再拍一张安全快照，绝不删除快照之外的文件。',
      refresh: '刷新',
      create: '新建快照',
      cancel: '取消',
      name: '名称',
      namePlaceholder: '例如：装插件前的基线',
      note: '备注（可选）',
      scopes: '作用范围',
      includeSecrets: '包含凭据文件（.credentials.yaml，敏感）',
      createHint: '默认只备份设置、插件清单、技能与工作区列表；凭据文件默认排除。',
      snapshots: '快照列表',
      empty: '还没有快照。先点「新建快照」。',
      loading: '加载中…',
      kindManual: '手动',
      kindAuto: '自动',
      files: '文件',
      bytes: '字节',
      createdAt: '时间',
      actions: '操作',
      diff: '对比当前',
      plan: '恢复预演',
      restore: '恢复',
      remove: '删除',
      export: '导出',
      exportAll: '导出最新快照',
      import: '导入快照包',
      secretsBadge: '含密钥',
      diffTitle: '与当前磁盘的差异',
      planTitle: '恢复预演',
      noDiff: '与当前配置一致，没有差异。',
      createOp: '新增',
      overwriteOp: '覆盖',
      unchangedOp: '未变',
      extraOp: '仅当前存在（不会删除）',
      restoreConfirm: '确定恢复到这个快照吗？恢复前会自动创建一个安全快照。',
      restoreDone: '恢复完成',
      safetySnapshot: '安全快照',
      restartRequired: '部分作用域需要重启 DSH 后生效',
      passphrase: '口令',
      passphraseHint: '导出的快照包含凭据，必须设置口令加密；导入时请输入同一口令。',
      exportDone: '已导出',
      importDone: '已导入',
      deleteConfirm: '确定删除这个快照吗？此操作不可撤销。',
      failed: '操作失败',
      scopeLabels: {
        settings: '设置与插件参数',
        plugins: '插件清单',
        deps: '依赖锁文件',
        skills: '技能与规则',
        workspaces: '工作区列表',
        credentials: '凭据（密钥）',
      },
    }

    /**
     * POST one JSON payload to a host action. Never throws; returns the
     * decoded envelope.
     * @param {string} action
     * @param {object} [payload]
     * @returns {Promise<{ok: true, value: any} | {ok: false, error: {code: string, message: string}}>}
     */
    async function post(action, payload) {
      let response
      try {
        response = await fetch(new URL(`${ROUTE_PREFIX}/${action}`, document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload === undefined ? {} : payload),
        })
      } catch (error) {
        return { ok: false, error: { code: 'transport', message: String((error && error.message) || error) } }
      }
      let envelope
      try {
        envelope = await response.json()
      } catch {
        return { ok: false, error: { code: 'bad-json', message: `路由返回了非 JSON（HTTP ${response.status}）` } }
      }
      if (envelope === null || typeof envelope !== 'object') {
        return { ok: false, error: { code: 'bad-json', message: '路由返回了非法响应' } }
      }
      if (envelope.ok === true) return { ok: true, value: envelope.value }
      const error = envelope.error === undefined ? {} : envelope.error
      return {
        ok: false,
        error: {
          code: typeof error.code === 'string' ? error.code : 'unknown',
          message: typeof error.message === 'string' ? error.message : '操作失败',
        },
      }
    }

    /**
     * Format a byte count for the list.
     * @param {number} bytes
     */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    }

    /**
     * Format an ISO timestamp in local time.
     * @param {string} iso
     */
    function formatTime(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** Inline stylesheet; all colors come from host CSS variables with fallbacks. */
    const CSS = `
      .cv-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary, #1f2329)}
      .cv-head h3{margin:0;font-size:16px;font-weight:600}
      .cv-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary, #6b7280);font-size:12px;line-height:18px}
      .cv-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-chip{border:1px solid var(--dsw-alias-border-l1, #e5e7eb);border-radius:999px;padding:1px 8px}
      .cv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .cv-row.right{justify-content:flex-end}
      .cv-btn{background:var(--dsw-alias-bg-layer-2, #f3f4f6);color:inherit;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease}
      .cv-btn:hover{border-color:var(--dsw-alias-brand-primary, #4d6bfe)}
      .cv-btn.primary{background:var(--dsw-alias-brand-primary, #4d6bfe);border-color:var(--dsw-alias-brand-primary, #4d6bfe);color:#fff}
      .cv-btn.danger:hover{border-color:#e5484d;color:#e5484d}
      .cv-btn:disabled{opacity:.5;cursor:default}
      .cv-field{display:flex;flex-direction:column;gap:4px}
      .cv-field label{font-size:12px;color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-input{background:var(--dsw-alias-bg-layer-1, #fff);color:inherit;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}
      .cv-input:focus{border-color:var(--dsw-alias-brand-primary, #4d6bfe)}
      .cv-scopes{display:flex;flex-wrap:wrap;gap:6px 14px}
      .cv-scopes label{display:flex;align-items:center;gap:6px;font-size:12px;color:inherit}
      .cv-card{border:1px solid var(--dsw-alias-border-l1, #e5e7eb);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1, #fff)}
      .cv-card h4{margin:0 0 4px;font-size:13px;font-weight:600}
      .cv-card .hint{color:var(--dsw-alias-label-secondary, #6b7280);font-size:12px}
      .cv-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);border-radius:10px;overflow:hidden}
      .cv-item{display:flex;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1, #e5e7eb)}
      .cv-item:first-child{border-top:none}
      .cv-item.selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary, #4d6bfe) 8%,transparent)}
      .cv-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
      .cv-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .cv-sub{font-size:11px;color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-badge{font-size:11px;border-radius:999px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1, #e5e7eb);color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-badge.warn{border-color:#f0b429;color:#b7791f}
      .cv-diff{margin:0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2, #f7f8fa);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-all}
      .cv-hunk{border-top:1px dashed var(--dsw-alias-border-l1, #e5e7eb);padding-top:6px;margin-top:6px}
      .cv-hunk:first-child{border-top:none;margin-top:0;padding-top:0}
      .cv-line.add{color:#1a7f37}
      .cv-line.remove{color:#cf222e}
      .cv-line.context{color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-note{font-size:12px;color:var(--dsw-alias-label-secondary, #6b7280)}
      .cv-error{color:#cf222e;font-size:12px;white-space:pre-wrap}
      .cv-ok{color:#1a7f37;font-size:12px}
      .cv-scroll{max-height:320px;overflow:auto}
    `

    /**
     * One labelled input row.
     * @param {{ label: string, value: string, placeholder?: string, onChange: (value: string) => void, type?: string }} props
     */
    function Field(props) {
      return h('div', { className: 'cv-field' },
        h('label', null, props.label),
        h('input', {
          className: 'cv-input',
          type: props.type === undefined ? 'text' : props.type,
          value: props.value,
          placeholder: props.placeholder,
          onChange: (event) => props.onChange(event.target.value),
        }))
    }

    /**
     * Diff renderer: per-file hunk list with masked secret values already
     * masked by the host.
     * @param {{ diff: any }} props
     */
    function DiffView(props) {
      const diff = props.diff
      if (diff === undefined || diff === null) return null
      if (!Array.isArray(diff.files) || diff.files.length === 0) {
        return h('div', { className: 'cv-note' }, COPY.noDiff)
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        ...diff.files.map(file => h('div', { key: file.path, className: 'cv-card' },
          h('h4', null, file.path),
          h('div', { className: 'cv-sub', style: { marginBottom: 6 } },
            `${statusLabel(file.status)} · ${file.scope}${file.secret ? ' · 含密钥（已打码）' : ''}${file.binary ? ' · 二进制未展示' : ''}`),
          h('div', { className: 'cv-diff' },
            ...(file.hunks || []).map((hunk, hunkIndex) => h('div', { key: `${file.path}-${hunkIndex}`, className: 'cv-hunk' },
              ...hunk.lines.map((line, lineIndex) => h('div', {
                key: lineIndex,
                className: `cv-line ${line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : 'context'}`,
              }, `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.text}`)))),
            file.truncated === true ? h('div', { className: 'cv-note' }, '差异过大，仅显示部分内容') : null))) 
      )
    }

    /**
     * Chinese label for a file diff status.
     * @param {string} status
     */
    function statusLabel(status) {
      switch (status) {
        case 'added': return '新增'
        case 'removed': return '缺失'
        case 'changed': return '修改'
        case 'same': return '未变'
        default: return status
      }
    }

    /**
     * Restore plan renderer.
     * @param {{ plan: any }} props
     */
    function PlanView(props) {
      const plan = props.plan
      if (plan === undefined || plan === null) return null
      const ops = Array.isArray(plan.operations) ? plan.operations : []
      return h('div', { className: 'cv-card' },
        h('h4', null, COPY.planTitle),
        h('div', { className: 'cv-sub', style: { marginBottom: 8 } },
          `新增 ${plan.counts.create} · 覆盖 ${plan.counts.overwrite} · 未变 ${plan.counts.unchanged} · 仅当前存在 ${plan.counts.extra}`),
        plan.restartRequired === true ? h('div', { className: 'cv-note' }, COPY.restartRequired) : null,
        ...(plan.warnings || []).map((warning, index) => h('div', { key: index, className: 'cv-note' }, `⚠ ${warning}`)),
        h('div', { className: 'cv-scroll', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
          ...ops.filter(op => op.action !== 'unchanged').map(op => h('div', { key: op.path, className: 'cv-sub' },
            `${op.action === 'create' ? COPY.createOp : COPY.overwriteOp}  ${op.path}`))),
        h('div', { className: 'cv-note', style: { marginTop: 8 } },
          `超出快照的现有文件不会被删除：${(plan.extra || []).length} 个`))
    }

    /** Root settings section. */
    function VaultPanel() {
      const [status, setStatus] = useState(null)
      const [snapshots, setSnapshots] = useState([])
      const [selected, setSelected] = useState(undefined)
      const [diff, setDiff] = useState(undefined)
      const [plan, setPlan] = useState(undefined)
      const [showCreate, setShowCreate] = useState(false)
      const [name, setName] = useState('')
      const [note, setNote] = useState('')
      const [scopes, setScopes] = useState(undefined)
      const [includeSecrets, setIncludeSecrets] = useState(false)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(undefined)
      const [error, setError] = useState(undefined)
      const fileInput = useRef(null)

      const refresh = useCallback(async () => {
        const result = await post('status')
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setStatus(result.value)
        setSnapshots(result.value.snapshots || [])
        setScopes(previous => previous === undefined
          ? (result.value.scopes || []).filter(scope => scope.defaultOn).map(scope => scope.id)
          : previous)
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const run = useCallback(async (action, payload, done) => {
        setBusy(true)
        setError(undefined)
        setMessage(undefined)
        const result = await post(action, payload)
        setBusy(false)
        if (!result.ok) {
          setError(result.error.message)
          return undefined
        }
        if (typeof done === 'function') done(result.value)
        return result.value
      }, [])

      const createSnapshot = useCallback(async () => {
        const created = await run('snapshot', {
          name: name.trim() === '' ? undefined : name.trim(),
          note: note.trim() === '' ? undefined : note.trim(),
          scopes,
          includeSecrets,
        })
        if (created === undefined) return
        setMessage('已创建快照')
        setShowCreate(false)
        setName('')
        setNote('')
        setIncludeSecrets(false)
        await refresh()
      }, [run, refresh, name, note, scopes, includeSecrets])

      const showDiff = useCallback(async (id) => {
        setSelected(id)
        setPlan(undefined)
        const diffResult = await run('diff', { id })
        setDiff(diffResult === undefined ? undefined : diffResult.diff)
      }, [run])

      const showPlan = useCallback(async (id) => {
        setSelected(id)
        setDiff(undefined)
        const planResult = await run('plan', { id })
        setPlan(planResult === undefined ? undefined : planResult.plan)
      }, [run])

      const restore = useCallback(async (id) => {
        if (!window.confirm(COPY.restoreConfirm)) return
        const result = await run('restore', { id })
        if (result === undefined) return
        setMessage(`${COPY.restoreDone}（${COPY.safetySnapshot}：${result.restore.safetySnapshotId || '无'}）`)
        setPlan(undefined)
        setDiff(undefined)
        await refresh()
      }, [run, refresh])

      const remove = useCallback(async (id) => {
        if (!window.confirm(COPY.deleteConfirm)) return
        const result = await run('remove', { id })
        if (result === undefined) return
        setMessage('已删除快照')
        if (selected === id) {
          setSelected(undefined)
          setDiff(undefined)
          setPlan(undefined)
        }
        await refresh()
      }, [run, refresh, selected])

      const exportSnapshot = useCallback(async (id) => {
        let passphrase
        let result = await post('export', { ids: [id] })
        if (!result.ok && result.error.code === 'passphrase-required') {
          const entered = window.prompt(COPY.passphraseHint, '')
          if (entered === null || entered === '') return
          passphrase = entered
          result = await post('export', { ids: [id], passphrase })
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        const blob = new Blob([result.value.content], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = result.value.filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setMessage(`${COPY.exportDone}：${result.value.filename}`)
      }, [])

      const importFile = useCallback(async (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (file === undefined) return
        const text = await file.text()
        let payload = { content: text }
        let result = await post('import', payload)
        if (!result.ok && result.error.code === 'passphrase-required') {
          const passphrase = window.prompt(COPY.passphraseHint, '')
          if (passphrase === null || passphrase === '') return
          payload = { content: text, passphrase }
          result = await post('import', payload)
        }
        if (!result.ok) {
          setError(result.error.message)
          return
        }
        setMessage(`${COPY.importDone}：${result.value.imported.map(item => item.name).join('、')}`)
        await refresh()
      }, [refresh])

      const scopeDefs = (status && status.scopes) || []
      const selectedSnapshot = snapshots.find(snapshot => snapshot.id === selected)

      return h('div', { className: 'cv-root' },
        h('style', { 'data-plugin-css': 'dsh-config-vault/panel.css' }, CSS),
        h('div', { className: 'cv-head' },
          h('h3', null, COPY.title),
          h('p', null, COPY.subtitle),
          status === null ? null : h('div', { className: 'cv-meta' },
            h('span', { className: 'cv-chip' }, `home: ${status.home}`),
            h('span', { className: 'cv-chip' }, `profile: ${status.profile || '未知'}`),
            h('span', { className: 'cv-chip' }, `快照 ${snapshots.length}`))),

        h('div', { className: 'cv-row' },
          h('button', { className: 'cv-btn primary', onClick: () => setShowCreate(!showCreate), disabled: busy }, COPY.create),
          h('button', { className: 'cv-btn', onClick: refresh, disabled: busy }, COPY.refresh),
          h('button', { className: 'cv-btn', onClick: () => fileInput.current && fileInput.current.click(), disabled: busy }, COPY.import),
          h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: importFile }),
          h('button', {
            className: 'cv-btn',
            disabled: busy || snapshots.length === 0,
            onClick: () => snapshots.length > 0 && exportSnapshot(snapshots[0].id),
          }, COPY.exportAll)),

        showCreate ? h('div', { className: 'cv-card', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h(Field, { label: COPY.name, value: name, placeholder: COPY.namePlaceholder, onChange: setName }),
          h(Field, { label: COPY.note, value: note, onChange: setNote }),
          h('div', { className: 'cv-field' },
            h('label', null, COPY.scopes),
            h('div', { className: 'cv-scopes' },
              ...scopeDefs.map(scope => h('label', { key: scope.id, title: scope.description },
                h('input', {
                  type: 'checkbox',
                  checked: (scopes || []).includes(scope.id),
                  onChange: (event) => {
                    setScopes(previous => {
                      const current = previous === undefined ? scopeDefs.filter(item => item.defaultOn).map(item => item.id) : [...previous]
                      if (event.target.checked) return current.includes(scope.id) ? current : [...current, scope.id]
                      return current.filter(id => id !== scope.id)
                    })
                  },
                }),
                COPY.scopeLabels[scope.id] || scope.label)))),
          h('label', { className: 'cv-row', style: { fontSize: 12 } },
            h('input', { type: 'checkbox', checked: includeSecrets, onChange: event => setIncludeSecrets(event.target.checked) }),
            COPY.includeSecrets),
          h('div', { className: 'cv-note' }, COPY.createHint),
          h('div', { className: 'cv-row right' },
            h('button', { className: 'cv-btn', onClick: () => setShowCreate(false) }, COPY.cancel),
            h('button', { className: 'cv-btn primary', onClick: createSnapshot, disabled: busy }, COPY.create))) : null,

        error === undefined ? null : h('div', { className: 'cv-error' }, error),
        message === undefined ? null : h('div', { className: 'cv-ok' }, message),

        h('div', { className: 'cv-field' },
          h('label', null, COPY.snapshots),
          snapshots.length === 0
            ? h('div', { className: 'cv-note' }, COPY.empty)
            : h('div', { className: 'cv-list' },
              ...snapshots.map(snapshot => h('div', {
                key: snapshot.id,
                className: `cv-item${selected === snapshot.id ? ' selected' : ''}`,
                onClick: () => setSelected(snapshot.id),
              },
              h('div', { className: 'cv-main' },
                h('div', { className: 'cv-name' }, snapshot.name),
                h('div', { className: 'cv-sub' }, `${formatTime(snapshot.createdAt)} · ${snapshot.files} 个文件 · ${formatBytes(snapshot.bytes)} · ${snapshot.scopes.join(', ')}`)),
              h('span', { className: `cv-badge${snapshot.kind === 'auto' ? '' : ''}` }, snapshot.kind === 'auto' ? COPY.kindAuto : COPY.kindManual),
              snapshot.secrets > 0 ? h('span', { className: 'cv-badge warn' }, COPY.secretsBadge) : null,
              h('div', { className: 'cv-row' },
                h('button', { className: 'cv-btn', onClick: event => { event.stopPropagation(); showDiff(snapshot.id) }, disabled: busy }, COPY.diff),
                h('button', { className: 'cv-btn', onClick: event => { event.stopPropagation(); showPlan(snapshot.id) }, disabled: busy }, COPY.plan),
                h('button', { className: 'cv-btn primary', onClick: event => { event.stopPropagation(); restore(snapshot.id) }, disabled: busy }, COPY.restore),
                h('button', { className: 'cv-btn', onClick: event => { event.stopPropagation(); exportSnapshot(snapshot.id) }, disabled: busy }, COPY.export),
                h('button', { className: 'cv-btn danger', onClick: event => { event.stopPropagation(); remove(snapshot.id) }, disabled: busy }, COPY.remove))))) ),

        selectedSnapshot === undefined ? null : h('div', { className: 'cv-note' }, `${selectedSnapshot.name} · ${selectedSnapshot.id}`),
        diff === undefined ? null : h(DiffView, { diff }),
        plan === undefined ? null : h(PlanView, { plan }))
    }

    /**
     * Client plugin body: register the settings section once the slots service
     * and the `settings.section` slot type are available.
     * @param {any} ctx client root context
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[dsh-config-vault] slots service unavailable; settings section not registered')
        return
      }
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'config-vault', order: 40, label: COPY.nav },
        () => React.createElement(VaultPanel),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    // Pure helpers/components exposed for unit checks without a browser.
    exports.__test = { formatBytes, formatTime, COPY, statusLabel, DiffView, PlanView, VaultPanel }
    return module.exports
  },
})

    function SettingsPanel({ t, onClose, onSaved }) {
      const [loading, setLoading] = React.useState(true)
      const [info, setInfo] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      // 全部恢复
      const [clearing, setClearing] = React.useState(false)
      const [hiddenCleared, setHiddenCleared] = React.useState(false)
      // 多目录增删
      const [adding, setAdding] = React.useState(false)
      const [removing, setRemoving] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        callHost('settings')
          .then((payload) => {
            if (!alive) return
            if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
            const s = payload.settings
            setInfo(s)
            setDraft(s.root)
            setLoading(false)
          })
          .catch((e) => {
            if (!alive) return
            setError(String(e?.message ?? e))
            setLoading(false)
          })
        return () => { alive = false }
      }, [t])

      const save = React.useCallback(async (nextRoot) => {
        setSaving(true)
        setError(null)
        setSaved(false)
        try {
          const payload = await callHost('setRoot', { root: nextRoot })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setDraft(payload.settings.root)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }, [t, onSaved])

      /** 追加一个扫描目录。 */
      const addRoot = React.useCallback(async (nextRoot) => {
        if (typeof nextRoot !== 'string' || nextRoot.trim() === '') return
        setAdding(true)
        setError(null)
        try {
          const payload = await callHost('addRoot', { root: nextRoot.trim() })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setDraft('')
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setAdding(false)
        }
      }, [t, onSaved])

      /** 移除一个扫描目录（至少保留一个）。 */
      const removeRoot = React.useCallback(async (target) => {
        if (typeof target !== 'string' || target === '') return
        setRemoving(target)
        setError(null)
        try {
          const payload = await callHost('removeRoot', { root: target })
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          setInfo(payload.settings)
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setRemoving(null)
        }
      }, [t, onSaved])

      const sourceLabel = React.useMemo(() => {
        if (info === null) return ''
        if (info.rootSource === 'settings') return t('rootSourceSettings')
        if (info.rootSource === 'config') return t('rootSourceConfig')
        return t('rootSourceAuto')
      }, [info, t])

      /** 全部恢复：清空隐藏列表，让被隐藏的条目重新出现在列表里。 */
      const clearHidden = React.useCallback(async () => {
        if (info === null || info.hiddenCount === 0) return
        setClearing(true)
        setError(null)
        setHiddenCleared(false)
        try {
          const payload = await callHost('clearHidden', {})
          if (payload?.ok === false) throw new Error(payload?.error?.message ?? t('errorTitle'))
          // 重新拉一次设置，拿到最新的 hiddenCount
          const fresh = await callHost('settings')
          if (fresh?.ok !== false) setInfo(fresh.settings)
          setHiddenCleared(true)
          setTimeout(() => setHiddenCleared(false), 2000)
          if (typeof onSaved === 'function') onSaved()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setClearing(false)
        }
      }, [info, t, onSaved])

      return h('div', { className: 'dg-settingsLayer', key: 'settingsLayer' }, [
        h('div', {
          className: 'dg-settings',
          key: 'panel',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('settingsTitle'),
          'data-gallery-settings-panel': true,
        }, [
          h('div', { className: 'dg-settingsHead', key: 'head' }, [
            h('span', { className: 'dg-settingsTitle', key: 'title' }, t('settingsTitle')),
            h('button', {
              type: 'button', className: 'dg-btn', key: 'close',
              'aria-label': t('close'),
              onClick: onClose,
            }, '✕'),
          ]),

          loading
            ? h('p', { className: 'dg-status', key: 'loading' }, t('loading'))
            : h('div', { className: 'dg-settingsBody', key: 'body' }, [
                // ---- 扫描目录列表（多目录）----
                h('div', { className: 'dg-field', key: 'roots' }, [
                  h('div', { className: 'dg-fieldHead', key: 'head' }, [
                    h('span', { className: 'dg-fieldLabel', key: 'l' },
                      format(t('rootsLabel'), { count: info === null ? 0 : (info.roots?.length ?? 0) })),
                    info === null ? null : h('span', { className: 'dg-fieldHint', key: 'h' },
                      format(t('rootHint'), { source: sourceLabel })),
                  ]),
                  h('ul', { className: 'dg-rootsList', key: 'list', 'data-gallery-roots': info === null ? 0 : info.roots.length },
                    (info?.rootsInfo ?? []).map((r, i) => h('li', {
                      className: `dg-rootItem${r.exists ? '' : ' dg-rootItemMissing'}`,
                      key: r.path,
                      'data-gallery-root-item': r.path,
                      title: r.path,
                    }, [
                      h('span', { className: 'dg-rootOk', key: 'ok' }, r.exists ? '✓' : '✗'),
                      h('span', { className: 'dg-rootPath', key: 'p' }, r.path),
                      (info.roots?.length ?? 0) > 1
                        ? h('button', {
                            type: 'button',
                            className: 'dg-rootRemove',
                            key: 'rm',
                            disabled: saving || removing === r.path,
                            title: t('removeRootHint'),
                            'aria-label': t('removeRootHint'),
                            'data-gallery-root-remove': r.path,
                            onClick: () => { void removeRoot(r.path) },
                          }, '✕')
                        : null,
                    ])),
                  ),
                  // 添加新目录
                  h('div', { className: 'dg-rootAdd', key: 'add' }, [
                    h('input', {
                      type: 'text',
                      className: 'dg-input dg-rootInput',
                      key: 'i',
                      value: draft,
                      spellCheck: false,
                      placeholder: t('rootAddPlaceholder'),
                      'data-gallery-root-input': true,
                      onChange: (event) => setDraft(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && saving === false) { event.preventDefault(); void addRoot(draft) }
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dg-btn dg-primaryBtn',
                      key: 'btn',
                      disabled: saving || draft.trim() === '',
                      'data-gallery-root-add': true,
                      onClick: () => { void addRoot(draft) },
                    }, adding ? t('addingRoot') : t('addRoot')),
                  ]),
                  h('span', { className: 'dg-fieldHint', key: 'tip' }, t('rootsTip')),
                ]),

                info === null ? null : h('div', { className: 'dg-settingsMeta', key: 'meta' }, [
                  h('span', { key: 'status' },
                    info.rootExists ? t('rootExists') : t('rootMissingShort')),
                  h('span', { key: 'file' },
                    format(t('settingsFileAt'), { path: info.settingsFile })),
                ]),

                // ---- 已隐藏条目管理 ----
                info === null ? null : h('div', { className: 'dg-hiddenBox', key: 'hiddenBox', 'data-gallery-hidden-box': info.hiddenCount }, [
                  h('div', { className: 'dg-hiddenRow', key: 'row' }, [
                    h('span', { className: 'dg-hiddenLabel', key: 'label' },
                      format(t('hiddenCount'), { count: info.hiddenCount })),
                    h('button', {
                      type: 'button',
                      className: 'dg-btn',
                      key: 'clear',
                      'data-gallery-clear-hidden': true,
                      disabled: clearing || info.hiddenCount === 0,
                      title: t('hiddenClearHint'),
                      onClick: () => { void clearHidden() },
                    }, clearing ? t('hiddenClearing') : t('hiddenClear')),
                  ]),
                  info.hiddenCount > 0 && Array.isArray(info.hiddenSample) && info.hiddenSample.length > 0
                    ? h('ul', { className: 'dg-hiddenList', key: 'list' },
                        info.hiddenSample.map((p) => h('li', { className: 'dg-hiddenItem', key: p, title: p }, p)))
                    : null,
                  info.hiddenCount > info.hiddenSample?.length
                    ? h('div', { className: 'dg-hiddenMore', key: 'more' },
                        format(t('hiddenMore'), { count: info.hiddenCount - info.hiddenSample.length }))
                    : null,
                  hiddenCleared
                    ? h('p', { className: 'dg-status dg-ok', key: 'cleared' }, t('hiddenCleared'))
                    : null,
                ]),

                error === null ? null : h('p', { className: 'dg-status dg-error', key: 'err' }, error),
                saved ? h('p', { className: 'dg-status dg-ok', key: 'ok' }, t('savedImmediately')) : null,

                h('div', { className: 'dg-settingsActions', key: 'actions' }, [
                  h('button', {
                    type: 'button', className: 'dg-btn', key: 'reset',
                    disabled: saving || info === null,
                    title: t('resetDefaultHint'),
                    onClick: () => { if (info !== null) { setDraft(info.defaults.root); void save(info.defaults.root) } },
                  }, t('resetDefault')),
                  h('button', {
                    type: 'button', className: 'dg-btn dg-primaryBtn', key: 'close2',
                    onClick: onClose,
                  }, t('done')),
                ]),
              ]),
        ]),
      ])
    }

    /** 画廊正文：Header（刷新）+ 网格 + 面板内放大。 */

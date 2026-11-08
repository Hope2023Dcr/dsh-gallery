/*__FEEDBACK_TEXT__*/

    /**
     * 反馈篮状态与草稿生成（S3-a）。
     *
     * 设计要点（严格按调研结论与老板指令）：
     *  1. **零 inject**：不依赖 conversation.input 服务也能工作 ——
     *     优先用 ctx.get('conversation.input') 的官方 setDraft；
     *     拿不到时退化为「把草稿文本塞进剪贴板 + 提示用户粘贴」，绝不自动发送。
     *  2. **人确认闸门**：只写 composer 草稿，**永不调用 submit()**。
     *  3. **攒批合并**：连点防抖，多条标记合成一条消息。
     *  4. **显式目标会话**：全局视图下必须标明这份反馈发给哪个会话。
     *  5. **历史会话禁用**：卡片归属会话不是当前会话时，提交按钮禁用。
     */

    /** 最近一次生成的草稿文本（供 seam.getFeedbackDraft() 读）。 */
    const draftRef = { current: '' }

    /** 反馈篮内部使用的动作定义（与 shared 的 ACTIONS 对齐，这里只放 UI 需要的）。 */
    const FEEDBACK_ACTIONS_UI = [
      { id: 'approve', labelZh: '通过', labelEn: 'Approve', icon: '✓' },
      { id: 'reject', labelZh: '不要这张', labelEn: 'Reject', icon: '✕' },
      { id: 'finalize', labelZh: '定为最终版', labelEn: 'Finalize', icon: '★' },
      { id: 'redo-one-dim', labelZh: '单维重做', labelEn: 'Redo one dim', icon: '↻' },
      { id: 'regenerate-selected', labelZh: '选择性重生成', labelEn: 'Regenerate', icon: '⟳' },
      { id: 'set-reference', labelZh: '设为参照', labelEn: 'Set reference', icon: '◎' },
    ]

    /**
     * 把草稿写进 composer —— **优先官方通道，拿不到就退化为剪贴板**。
     *
     * 官方通道（已实证）：ctx.get('conversation.input').for(ctx).setDraft(text)
     *   · setDraft 只替换草稿文本，不会发送 —— 满足「人确认闸门」。
     *   · 若 actx 没有 session 绑定会抛错，此时退化为剪贴板。
     *
     * @returns { ok: boolean, via: 'composer' | 'clipboard' | 'failed', reason?: string }
     */
    /**
     * 把草稿写进 composer —— **零 inject 的纯 DOM 路径**。
     *
     * 为什么不用官方 conversation.input 服务（A 方案已废弃）：
     *   实测在 inject 里声明 `conversation.input` 会让 Cordis 插件在 web boot
     *   阶段一直 pending（"waiting for service: conversation.input"），宿主判定
     *   启动失败、页面永久停在 "Loading plugins…"、主进程退出。
     *   且源码 L19270/19278 实证：slot props 只传 `{}`，不透传 input，
     *   所以零 inject 根本拿不到这个服务。
     *
     * 实现三条纯 DOM 路径，按序尝试，用 **Lexical 内部 state** 判断成功：
     *   1) beforeinput + input 事件（Lexical 的 onBeforeInput 入口）
     *   2) 模拟 paste（ClipboardEvent + DataTransfer，Lexical 有完整 paste 处理）
     *   3) execCommand('insertText')  ← 已知只改 DOM 不同步 state，仅最后兜底
     *
     * 判据不是 innerText（那会假的通过），而是 editor.getEditorState() 里真实文本增长。
     * 绝不调用 submit() / 任何发送动作。
     *
     * @returns { ok, via, detail?, reason? }
     */
    /**
     * 把草稿写进 composer —— **零 inject 的纯 DOM 路径**。
     *
     * 为什么不用官方 conversation.input 服务（A 方案已废弃）：
     *   实测在 inject 里声明 `conversation.input` 会让 Cordis 插件在 web boot
     *   阶段一直 pending（"waiting for service: conversation.input"），宿主判定
     *   启动失败、页面永久停在 "Loading plugins…"、主进程退出。
     *   且源码 L19270/19278 实证：slot props 只传 `{}`，不透传 input，
     *   所以零 inject 根本拿不到这个服务。
     *
     * ⚠️ **关键：Lexical 的 state 更新是异步 flush。**
     *   dispatch 事件后**立即**读 getEditorState() 永远读到旧 state ——
     *   这会把"其实成功"的路径判成失败（假阴性），进而让后续路径重复插入，
     *   最终草稿被写进 4 份（真机实测：1524 字 ≈ 381×4）。
     *
     *   所以每条路径 dispatch 后必须 **await 一个宏任务再读 state**，
     *   并且**一旦成功立即 return 短路**，不再尝试后续路径。
     *
     * 三条路径（按序，成功即停）：
     *   1) beforeinput + input 事件（Lexical 的 onBeforeInput 入口，L6592）
     *   2) 模拟 paste（ClipboardEvent + DataTransfer，Lexical 有完整 paste 处理，L6587/L10559）
     *   3) execCommand('insertText') —— 仅最后兜底
     *
     * 判据始终是 **Lexical 内部 state 的真实文本**（不是 innerText），且必须等 flush。
     * 绝不调用 submit() / 任何发送动作。
     *
     * @returns { ok, via, detail?, reason? }
     */
    async function writeDraftToComposer(text, sessionId) {
      const COMPOSER_SEL = '[data-composer-input][data-lexical-editor="true"]'
      const FALLBACK_SEL = '[data-lexical-editor="true"]'
      /** 等 Lexical flush 的宏任务时间。80ms 是实测稳妥值（60 起，留余量）。 */
      const FLUSH_WAIT_MS = 80

      const waitFlush = () => new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))

      const findComposer = () => document.querySelector(COMPOSER_SEL)
        ?? document.querySelector(FALLBACK_SEL)
        ?? document.querySelector('[contenteditable="true"]')

      /** 从 DOM 拿 Lexical editor 实例（Lexical 官方在 editable 元素上挂）。 */
      const editorOf = (el) => (el === null ? null : (el.__lexicalEditor ?? el._lexicalEditor ?? null))

      /** 读编辑器**内部 state** 的真实文本。 */
      const stateText = (ed) => {
        if (ed === null) return { ok: false, size: -1, text: '', why: 'no-editor' }
        try {
          const st = ed.getEditorState()
          let out = ''
          st.read(() => {
            const root = st._nodeMap.get('root')
            if (root === undefined) return
            const walk = (n) => {
              if (n === null || n === undefined) return ''
              if (typeof n.getTextContent === 'function') {
                const t = n.getTextContent()
                if (t !== '') return t
              }
              const kids = typeof n.getChildren === 'function' ? n.getChildren() : []
              return kids.map(walk).join('')
            }
            out = walk(root)
          })
          return { ok: true, size: out.length, text: out }
        } catch (error) {
          return { ok: false, size: -1, text: '', why: String(error?.message ?? error) }
        }
      }

      const el = findComposer()
      if (el === null) {
        // composer 不在此刻的 DOM 里（还没渲染/不在会话页）→ 只能落剪贴板
        const copied = await copyText(text)
        draftRef.current = text
        return copied
          ? { ok: false, via: 'clipboard', reason: 'composer-not-found' }
          : { ok: false, via: 'failed', reason: 'composer-not-found-copy-failed' }
      }

      const ed = editorOf(el)

      // ---- 幂等：写入前先等一次 flush，确认当前 state，避免重复插入 ----
      await waitFlush()
      const before = stateText(ed)

      // 用草稿头（前 24 字）判断，而不是全串匹配 ——
      // 全串匹配在「草稿后面跟了用户自己打的字」时会失效（state 里包含但不再是完整 text）。
      const headProbe = text.trim().slice(0, Math.min(24, text.trim().length))
      if (before.ok && headProbe !== '' && before.text.includes(headProbe)) {
        draftRef.current = text
        return { ok: true, via: 'composer', detail: 'already-present' }
      }

      try { el.focus() } catch { /* 忽略 */ }

      /** 统一判定：等 flush → 读 state → 看是否比 before 长且含目标片段。 */
      const verify = async (probeFragment) => {
        await waitFlush()
        const after = stateText(ed)
        if (!after.ok) return { ok: false, size: -1 }
        // 双重判据：长度增长 + 含目标片段（防止别的操作同时改 state 造成误判）
        const grew = after.size > before.size
        const contains = probeFragment === undefined
          ? true
          : after.text.includes(probeFragment)
        return { ok: grew && contains, size: after.size }
      }

      // 用于确认"确实插入了本次文本"的探针片段（取前 24 字，足够区分）
      const probe = text.trim().slice(0, Math.min(24, text.trim().length))

      // ---- 路径 1：**只发 beforeinput**（不跟 input）----
      // ⚠️ 真机实证：beforeinput 与 input 在同一同步块连发时，Lexical 在 flush 前
      // 把两次都排进更新队列 → **各插入一份 → 草稿变 2 份**（770 字 ≈ 385×2）。
      // 微探针：单独 beforeinput → 等 160ms → state 6 字；
      //         再单独 input → 等 160ms → state 仍 6 字（第二个被忽略）。
      // 即：只要中间等 flush 就不会双插；最可靠是根本不发 input。
      // 实证：只发一次 beforeinput（完整 385 字草稿）+ 等 300ms
      //      → draftLen=385、stateLen=385、"Annotation 1" 恰 2 次、singleCopy=true。
      try {
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true,
        }))
        const v1 = await verify(probe)
        if (v1.ok) {
          draftRef.current = text
          return { ok: true, via: 'composer', detail: 'beforeinput' }
        }
      } catch (error) {
        console.warn('dsh-gallery: beforeinput 路径失败', error)
      }

      // 路径 1 失败后，重新取 before（可能 state 已被上面的动作部分改动）
      await waitFlush()
      const before2 = stateText(ed)

      // ---- 路径 2：模拟 paste（成功即短路）----
      try {
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        dt.setData('text/html', '<p>' + text
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>') + '</p>')
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
        try { Object.defineProperty(ev, 'clipboardData', { value: dt, configurable: true }) } catch { /* 忽略 */ }
        el.dispatchEvent(ev)
        await waitFlush()
        const after2 = stateText(ed)
        if (after2.ok && after2.size > before2.size && after2.text.includes(probe)) {
          draftRef.current = text
          return { ok: true, via: 'composer', detail: 'paste' }
        }
      } catch (error) {
        console.warn('dsh-gallery: paste 路径失败', error)
      }

      // ---- 路径 3：execCommand（仅最后兜底，同样等 flush 后判）----
      await waitFlush()
      const before3 = stateText(ed)
      try {
        document.execCommand('insertText', false, text)
        await waitFlush()
        const after3 = stateText(ed)
        if (after3.ok && after3.size > before3.size && after3.text.includes(probe)) {
          draftRef.current = text
          return { ok: true, via: 'composer', detail: 'execCommand' }
        }
      } catch (error) {
        console.warn('dsh-gallery: execCommand 路径失败', error)
      }

      // ---- 全部路径都没让 state 增长 ----
      // 最后复查一次：只有「长度接近 + 草稿头出现恰 1 次」才算成功。
      // 不能用 includes(probe) 就判 —— 半份写入也会通过（那是静默的数据污染）。
      await waitFlush()
      const finalState = stateText(ed)
      if (finalState.ok) {
        const headCount = headProbe === ''
          ? 0
          : (finalState.text.split(headProbe).length - 1)
        const lengthClose = Math.abs(finalState.text.length - text.length) <= 8
        if (headCount === 1 && lengthClose) {
          draftRef.current = text
          return { ok: true, via: 'composer', detail: 'late-flush' }
        }
        if (headCount > 1) {
          // 出现多次 = 重复写入，这是数据污染，必须如实报失败
          console.warn('dsh-gallery: 检测到草稿重复写入 ' + headCount + ' 份')
          return { ok: false, via: 'failed', reason: 'duplicate-write-' + headCount }
        }
      }

      // 真失败 → 剪贴板，notice 明确「未写入输入框」
      const copied = await copyText(text)
      draftRef.current = text
      return copied
        ? { ok: false, via: 'clipboard', reason: 'all-dom-paths-failed' }
        : { ok: false, via: 'failed', reason: 'all-dom-paths-failed-copy-failed' }
    }

    /**
     * 反馈篮：一个受控组件，管理条目列表 + 生成草稿。
     *
     * @param t - 文案
     * @param items - 已标记条目（由 GalleryBody 传入，含 relPath / category / mark）
     * @param currentSessionId - 当前会话 id（用于判断「历史会话卡片禁止提交」）
     * @param targetSessionTitle - 目标会话标题（全局视图展示用）
     * @param onClose - 关闭
     * @param onRemove - 删除某条
     * @param onEdit - 编辑某条
     * @param onClear - 清空
     * @param onSubmitDraft - 生成草稿后的回调（用于提示）
     */
    function FeedbackBasket({ t, items, currentSessionId, targetSessionTitle,
                              onClose, onRemove, onEdit, onClear, onEditSave }) {
      // 语言判断：用 t 探测一个已知键 —— 命中中文就按 zh 渲染，否则 en。
      // （不引入 detectLocale，插件没有这个工具函数）
      const [locale] = React.useState(() => {
        try {
          const probe = t('feedbackBasketTitle')
          return (typeof probe === 'string' && /[\u4e00-\u9fa5]/.test(probe)) ? 'zh' : 'en'
        } catch { return 'zh' }
      })
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      // 编辑弹窗：正在编辑的条目 + 三个字段的草稿值
      const [editing, setEditing] = React.useState(null)
      const [editReason, setEditReason] = React.useState('')
      const [editChangeOnly, setEditChangeOnly] = React.useState('')
      const [editKeep, setEditKeep] = React.useState('')

      /** 打开编辑弹窗，把该条已有值填进去。 */
      const beginEdit = React.useCallback((it) => {
        setEditing(it)
        setEditReason(typeof it.mark?.reason === 'string' ? it.mark.reason : '')
        setEditChangeOnly(Array.isArray(it.mark?.changeOnly) ? it.mark.changeOnly.join('，') : '')
        setEditKeep(Array.isArray(it.mark?.keep) ? it.mark.keep.join('，') : '')
      }, [])

      /** 保存编辑：逗号/中文逗号分隔 → 数组。 */
      const commitEdit = React.useCallback(() => {
        if (editing === null) return
        const splitList = (text) => String(text ?? '')
          .split(/[,，、;；]/)
          .map((x) => x.trim())
          .filter((x) => x !== '')
        const patch = {
          reason: editReason.trim() === '' ? undefined : editReason.trim(),
          changeOnly: splitList(editChangeOnly),
          keep: splitList(editKeep),
        }
        // 空数组不写进契约（避免草稿里出现空的「只改：」）
        if (patch.changeOnly.length === 0) delete patch.changeOnly
        if (patch.keep.length === 0) delete patch.keep
        if (typeof onEditSave === 'function') onEditSave(editing.relPath, patch)
        setEditing(null)
      }, [editing, editReason, editChangeOnly, editKeep, onEditSave])

      // 历史会话判定：条目归属会话与当前会话不同 → 禁止提交
      const foreignItems = items.filter((it) => it.sessionId !== undefined
        && it.sessionId !== '' && currentSessionId !== '' && it.sessionId !== currentSessionId)
      const canSubmit = items.length > 0 && foreignItems.length === 0 && busy === false

      /** 生成草稿并写进 composer（不发送）。 */
      const generateDraft = React.useCallback(async () => {
        if (!canSubmit) return
        setBusy(true)
        setNotice(null)
        try {
          const feedback = makeFeedback({
            sessionId: currentSessionId,
            items: items.map((it) => ({
              relPath: it.relPath,
              category: it.category ?? 'unknown',
              action: it.mark?.action ?? 'approve',
              reason: it.mark?.reason,
              changeOnly: it.mark?.changeOnly,
              keep: it.mark?.keep,
              preserve: it.mark?.preserve,
            })),
          })
          const text = renderFeedbackText(feedback, { locale, targetSessionTitle })
          const result = await writeDraftToComposer(text, currentSessionId)
          if (result.ok) {
            setNotice({
              kind: result.via === 'composer' ? 'ok' : 'failed',
              text: result.via === 'composer'
                ? t('feedbackDraftReady')
                : t('feedbackDraftInClipboard'),
            })
          } else {
            setNotice({ kind: 'failed', text: t('feedbackDraftFailed') })
          }
        } catch (error) {
          setNotice({ kind: 'failed', text: `${t('feedbackDraftFailed')}：${String(error?.message ?? error)}` })
        } finally {
          setBusy(false)
        }
      }, [canSubmit, items, currentSessionId, locale, targetSessionTitle, t])

      return h('div', { className: 'dg-feedbackLayer', key: 'feedbackLayer' }, [
        h('div', {
          className: 'dg-feedback',
          key: 'panel',
          role: 'dialog',
          'aria-modal': false,
          'aria-label': t('feedbackBasketTitle'),
          'data-gallery-feedback-panel': true,
        }, [
          h('div', { className: 'dg-feedbackHead', key: 'head' }, [
            h('span', { className: 'dg-feedbackTitle', key: 'title' },
              format(t('feedbackBasketTitleN'), { n: items.length }),
            ),
            h('button', {
              type: 'button', className: 'dg-btn', key: 'close',
              'aria-label': t('close'), onClick: onClose,
            }, '✕'),
          ]),

          // 目标会话提示（全局视图必须显式标）
          targetSessionTitle !== ''
            ? h('div', { className: 'dg-feedbackTarget', key: 'target', 'data-gallery-feedback-target': targetSessionTitle },
                format(t('feedbackTargetSession'), { title: targetSessionTitle }))
            : null,

          // 历史会话条目警告
          foreignItems.length > 0
            ? h('div', { className: 'dg-feedbackWarn', key: 'foreign', 'data-gallery-feedback-foreign': foreignItems.length },
                format(t('feedbackForeignWarn'), { n: foreignItems.length }))
            : null,

          items.length === 0
            ? h('p', { className: 'dg-status', key: 'empty' }, t('feedbackBasketEmpty'))
            : h('ul', { className: 'dg-feedbackList', key: 'list' },
                items.map((it, idx) => {
                  const actionDef = FEEDBACK_ACTIONS_UI.find((a) => a.id === it.mark?.action)
                  const label = actionDef === undefined
                    ? (it.mark?.action ?? '')
                    : (locale === 'en' ? actionDef.labelEn : actionDef.labelZh)
                  return h('li', {
                    className: 'dg-feedbackItem',
                    key: it.relPath,
                    'data-gallery-feedback-item': it.relPath,
                    'data-gallery-feedback-no': idx + 1,
                  }, [
                    h('span', { className: 'dg-feedbackNo', key: 'n' }, String(idx + 1)),
                    h('span', { className: 'dg-feedbackAction', key: 'a' }, label),
                    h('span', { className: 'dg-feedbackName', key: 'name', title: it.relPath },
                      it.relPath.split('/').pop() ?? it.relPath),
                    (it.mark?.changeOnly !== undefined && it.mark.changeOnly.length > 0)
                      ? h('span', { className: 'dg-feedbackDim', key: 'co' },
                          `${t('feedbackChangeOnly')}：${it.mark.changeOnly.join('/')}`)
                      : null,
                    h('span', { className: 'dg-feedbackOps', key: 'ops' }, [
                      h('button', {
                        type: 'button', className: 'dg-btn dg-btnSmall', key: 'edit',
                        'data-gallery-feedback-edit': it.relPath,
                        onClick: () => beginEdit(it),
                      }, t('feedbackEdit')),
                      h('button', {
                        type: 'button', className: 'dg-btn dg-btnSmall', key: 'del',
                        'data-gallery-feedback-remove': it.relPath,
                        onClick: () => onRemove(it.relPath),
                      }, '✕'),
                    ]),
                  ])
                }),
              ),

          notice === null
            ? null
            : h('p', {
                className: `dg-status ${notice.kind === 'ok' ? 'dg-ok' : 'dg-error'}`,
                key: 'notice',
                'data-gallery-feedback-notice': notice.kind,
              }, notice.text),

          // ---- 编辑弹窗（理由 / 只改 / 锁死）----
          editing === null
            ? null
            : h('div', { className: 'dg-feedbackEdit', key: 'editForm', 'data-gallery-feedback-edit-form': editing.relPath }, [
                h('div', { className: 'dg-feedbackEditHead', key: 'h' },
                  format(t('feedbackEditTitle'), { name: editing.relPath.split('/').pop() ?? editing.relPath }),
                ),
                h('label', { className: 'dg-feedbackField', key: 'reason' }, [
                  h('span', { className: 'dg-feedbackLabel', key: 'l' }, t('feedbackReasonLabel')),
                  h('textarea', {
                    className: 'dg-input dg-feedbackTextarea',
                    key: 'in',
                    rows: 2,
                    value: editReason,
                    placeholder: t('feedbackReasonPlaceholder'),
                    'data-gallery-feedback-edit-reason': true,
                    onChange: (event) => setEditReason(event.target.value),
                  }),
                ]),
                h('label', { className: 'dg-feedbackField', key: 'co' }, [
                  h('span', { className: 'dg-feedbackLabel', key: 'l' }, t('feedbackChangeOnlyLabel')),
                  h('input', {
                    type: 'text',
                    className: 'dg-input',
                    key: 'in',
                    value: editChangeOnly,
                    placeholder: t('feedbackChangePlaceholder'),
                    'data-gallery-feedback-edit-change': true,
                    onChange: (event) => setEditChangeOnly(event.target.value),
                  }),
                ]),
                h('label', { className: 'dg-feedbackField', key: 'keep' }, [
                  h('span', { className: 'dg-feedbackLabel', key: 'l' }, t('feedbackKeepLabel')),
                  h('input', {
                    type: 'text',
                    className: 'dg-input',
                    key: 'in',
                    value: editKeep,
                    placeholder: t('feedbackKeepPlaceholder'),
                    'data-gallery-feedback-edit-keep': true,
                    onChange: (event) => setEditKeep(event.target.value),
                  }),
                ]),
                h('div', { className: 'dg-feedbackEditActions', key: 'acts' }, [
                  h('button', {
                    type: 'button', className: 'dg-btn', key: 'cancel',
                    'data-gallery-feedback-edit-cancel': true,
                    onClick: () => setEditing(null),
                  }, t('cancel')),
                  h('button', {
                    type: 'button', className: 'dg-btn dg-primaryBtn', key: 'save',
                    'data-gallery-feedback-edit-save': true,
                    onClick: commitEdit,
                  }, t('feedbackEditSave')),
                ]),
              ]),

          h('div', { className: 'dg-feedbackActions', key: 'actions' }, [
            h('button', {
              type: 'button', className: 'dg-btn', key: 'clear',
              'data-gallery-feedback-clear': true,
              disabled: busy || items.length === 0,
              onClick: onClear,
            }, t('feedbackClear')),
            h('button', {
              type: 'button', className: 'dg-btn dg-primaryBtn', key: 'submit',
              'data-gallery-feedback-generate': true,
              disabled: !canSubmit,
              title: foreignItems.length > 0 ? t('feedbackForeignWarnShort') : t('feedbackGenerateHint'),
              onClick: () => { void generateDraft() },
            }, busy
              ? t('feedbackGenerating')
              // 禁用时直接把原因写在按钮上，不只靠悬停 title
              : foreignItems.length > 0
                ? t('feedbackBlockedForeign')
                : items.length === 0
                  ? t('feedbackBlockedEmpty')
                  : t('feedbackGenerateDraft')),
          ]),
        ]),
      ])
    }

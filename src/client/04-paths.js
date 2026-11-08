
    /**
     * 复制文本到剪贴板。优先 Clipboard API，失败回退 execCommand。
     * @param text - 要复制的内容。
     * @returns 是否成功。
     */
    /**
     * 用根目录与相对路径拼出 Windows 绝对路径。
     * 全程用 split/join，不用正则，避免转义歧义。
     * @param root - 根目录（可能以 \ 或 / 结尾）。
     * @param relPath - 相对路径（以 / 分隔）。
     * @returns 绝对路径。
     */
    /**
     * 构造 DSH 原生资源地址（session 作用域）。
     * 文档预览的 canOpen 只认 scope=session，故必须用 session 形式，不能用 absolute。
     * @param sessionId - 当前会话 id（slot props.sessionId）。
     * @param absPath - 文件绝对路径。
     * @returns dsh-resource://file/session/<sessionId>/<path>
     */
    function sessionFileAddressOf(sessionId, absPath) {
      const norm = String(absPath).split(String.fromCharCode(92)).join('/').replace(/^\.\//, '')
      const segs = norm.split('/').filter((s) => s !== '')
      const encoded = segs.map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/')
      return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encoded
    }

    function buildAbsPath(root, relPath) {
      const BS = String.fromCharCode(92)   // 反斜杠
      const cleanedRoot = String(root).split('/').join(BS).split(BS).filter((s) => s !== '').join(BS)
      const parts = String(relPath).split('/').filter((s) => s !== '')
      return cleanedRoot + BS + parts.join(BS)
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && navigator.clipboard !== null) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        console.warn('dsh-gallery: clipboard API 失败，回退', error)
      }
      try {
        const host = document.createElement('textarea')
        host.value = text
        host.style.position = 'fixed'
        host.style.opacity = '0'
        document.body.appendChild(host)
        host.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(host)
        return ok
      } catch (error) {
        console.error('dsh-gallery: 复制失败', error)
        return false
      }
    }

    /**
     * 文件卡片：三段式布局。
     *   ① 头部：类型图标 + 文件名 + 简介（悬停展开，此处用大小/时间）
     *   ② 中部：三个操作按钮（侧边预览 / 复制路径 / 打开本地位置）
     *   ③ 底部：元信息
     */
    /**
     * 右键菜单：隐藏 / 打开位置 / 复制路径 / 删除。
     * 挂在卡片上，位置跟随鼠标；点外部或按 Esc 关闭。
     * 删除需要二次确认（走 ConfirmDialog）。
     */

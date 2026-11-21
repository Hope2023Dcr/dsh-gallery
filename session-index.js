/**
 * session-index 的根级转出（S1 拆分后实际实现在 host/session-index.js）。
 *
 * 保留本文件是为了让外部 `import './session-index.js'` 仍然可用。
 */

export { buildSessionIndex, clearSessionIndexCache } from './host/session-index.js'

window.__ModuleLoader__.load({
  id: 'dsh-markdown-outline',
  factory(require) {
    const React = require('react');
    const {
      createElement: h,
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React;

    /**
     * Render one overlay outside the outline's own column.
     *
     * The column is a 0-width anchor with an absolutely positioned panel, so a
     * fixed-position dialog inside it inherits that cramped containing block
     * and loses its width. A portal puts the dialog on `document.body` instead.
     * @param {object} node - the element to mount elsewhere.
     * @returns {object} the portal, or the node itself when portals are unavailable.
     */
    function renderOverlay(node) {
      const portal = React.createPortal;
      if (typeof portal !== 'function' || typeof document === 'undefined') return node;
      return portal(node, document.body);
    }

    const NS = 'dsh-markdown-outline';
    const STORAGE_OPEN_KEY = 'dsh.mdOutline.open';
    const STORAGE_WIDTH_KEY = 'dsh.mdOutline.width';
    const SEARCH_ROUTE = 'md-outline/search';
    const HIDE_ROUTE = 'md-outline/hide';
    const RESTORE_ROUTE = 'md-outline/restore';
    const DEFAULT_WIDTH = 252;
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 420;
    const HEADING_TEXT_LIMIT = 140;
    const MAX_LIVE_BODY_HITS = 80;
    const SNIPPET_RADIUS = 36;
    /** Longest reference body sent with one prompt, in characters. */
    const MAX_REFERENCE_CHARS = 60_000;
    /** Shared empty list for a session with no hidden turns; a stable identity keeps hooks quiet. */
    const EMPTY_TURNS = Object.freeze([]);

    const EN_DICT = {
      title: 'Outline',
      collapse: 'Collapse outline',
      expand: 'Show outline',
      empty: 'No Markdown headings in AI replies yet',
      turnLabel: 'Reply #{turn}',
      resize: 'Drag to resize outline width',
      foldSection: 'Collapse section',
      unfoldSection: 'Expand section',
      loadingTurn: 'Loading earlier message…',
      searchPlaceholder: 'Search headings & replies…',
      clearSearch: 'Clear search',
      noResults: 'No matching headings or reply text',
      searchingOlder: 'Searching earlier history…',
      headingResults: 'Headings ({count})',
      bodyResults: 'Reply text ({count})',
      selectMode: 'Select sections',
      selectModeOn: 'Exit selection',
      selectedCount: '{count} selected',
      selectionBar: 'Reference {count} sections in the next message',
      openSelection: 'Open selection',
      selectionTitle: 'Referenced sections',
      selectionClose: 'Close',
      selectionEmpty: 'Nothing selected yet',
      insertReference: 'Insert into composer',
      clearSelection: 'Clear selection',
      referenceHeading: 'Referenced context',
      hiddenTitle: 'Hidden turns ({count})',
      hiddenShow: 'Show hidden turns',
      hiddenHide: 'Hide list',
      hiddenEmpty: 'No hidden turns',
      hideTurns: 'Hide {count} turns',
      hideTurnsExplain:
        'Each ticked turn is hidden whole — your prompt and the AI reply both leave this conversation and stop being sent to the model. Only the ticked turns are affected. The original log keeps them, so you can restore them at any time.',
      hideConfirm: 'Hide',
      hideCancel: 'Cancel',
      restoreTurn: 'Show again',
      restoring: 'Restoring…',
      hiding: 'Hiding…',
      hideFailed: 'Could not hide turns: {message}',
      restoreFailed: 'Could not restore the turn: {message}',
      insertFailed: 'Could not insert the reference',
      selectionPartial: 'The reference was truncated to fit one message',
      hiddenBadge: 'hidden',
    };

    const ZH_DICT = {
      title: '目录',
      collapse: '收起目录',
      expand: '展开目录',
      empty: '当前对话暂无 Markdown 目录',
      turnLabel: '第 {turn} 轮回复',
      resize: '拖动调整目录栏宽度',
      foldSection: '折叠子标题',
      unfoldSection: '展开子标题',
      loadingTurn: '正在加载历史消息…',
      searchPlaceholder: '搜索标题与回复正文…',
      clearSearch: '清空搜索',
      noResults: '未找到匹配的标题或正文',
      searchingOlder: '正在检索早期历史…',
      headingResults: '目录标题 ({count})',
      bodyResults: '正文匹配 ({count})',
      selectMode: '多选章节',
      selectModeOn: '退出多选',
      selectedCount: '已选 {count} 项',
      selectionBar: '引用 {count} 个章节，随下一条消息一起发送',
      openSelection: '查看引用',
      selectionTitle: '已引用章节',
      selectionClose: '关闭',
      selectionEmpty: '还没有选中任何章节',
      insertReference: '插入到输入框',
      clearSelection: '清空选择',
      referenceHeading: '引用的上下文',
      hiddenTitle: '已隐藏的轮次 ({count})',
      hiddenShow: '查看已隐藏的轮次',
      hiddenHide: '收起列表',
      hiddenEmpty: '没有被隐藏的轮次',
      hideTurns: '隐藏 {count} 个轮次',
      hideTurnsExplain:
        '每勾选一轮就隐藏整轮——你的提问和 AI 的回复都会从这段对话中消失，也不再发送给模型。只有勾选的轮次受影响，没勾选的保持不变。原始会话日志仍然保留，随时可以恢复。',
      hideConfirm: '隐藏',
      hideCancel: '取消',
      restoreTurn: '重新显示',
      restoring: '正在恢复…',
      hiding: '正在隐藏…',
      hideFailed: '隐藏失败：{message}',
      restoreFailed: '恢复失败：{message}',
      insertFailed: '无法插入引用',
      selectionPartial: '内容过长，已截断为一条消息',
      hiddenBadge: '已隐藏',
    };

    const STYLESHEET = `
[data-conversation-header-leading]:has(> [data-slot="conversation.header.leading"] > .dsh-mdo-anchor:only-child) {
  gap: 0;
}

.dsh-mdo-anchor {
  width: 0;
  height: 0;
  margin: 0;
  padding: 0;
  overflow: visible;
  flex: none;
  pointer-events: none;
}

[data-phase="active"] > [data-conversation-content] {
  transition: margin-left 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

[data-phase="active"]:has(.dsh-mdo-root[data-md-outline-resizing="true"]) > [data-conversation-content] {
  transition: none;
}

[data-phase="active"]:has(.dsh-mdo-root[data-md-outline-state="open"]) > [data-conversation-content]:not(:has([data-conversation-composer-overlay])) {
  margin-left: var(--dsh-mdo-w, 252px);
}

[data-phase="active"]:has([data-conversation-composer-overlay]) .dsh-mdo-root {
  display: none;
}

.dsh-mdo-panel {
  position: absolute;
  left: 0;
  top: var(--dsh-mdo-top, 52px);
  bottom: 0;
  width: var(--dsh-mdo-w, 252px);
  z-index: 8;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  border-right: 0.5px solid var(--dsw-alias-border-l1);
  pointer-events: auto;
  user-select: none;
  -webkit-app-region: no-drag;
}

.dsh-mdo-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 8px 12px 4px 12px;
  box-sizing: border-box;
}

.dsh-mdo-collapse-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  flex: none;
  transition: background-color 120ms ease, color 120ms ease;
}

.dsh-mdo-collapse-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-collapse-btn:focus-visible,
.dsh-mdo-trigger:focus-visible,
.dsh-mdo-item-btn:focus-visible,
.dsh-mdo-fold-btn:focus-visible,
.dsh-mdo-turn-btn:focus-visible,
.dsh-mdo-clear-btn:focus-visible,
.dsh-mdo-hit-btn:focus-visible {
  outline: 1.5px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  outline-offset: -1.5px;
}

.dsh-mdo-search-wrap {
  flex: none;
  padding: 2px 10px 6px 10px;
}

.dsh-mdo-search-box {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 7px;
  border-radius: 6px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  transition: border-color 120ms ease, background-color 120ms ease;
}

.dsh-mdo-search-box:focus-within {
  border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2));
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-search-icon {
  display: inline-flex;
  flex: none;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.8;
}

.dsh-mdo-search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}

.dsh-mdo-search-input::placeholder {
  color: var(--dsw-alias-label-secondary);
  opacity: 0.7;
}

.dsh-mdo-clear-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  flex: none;
}

.dsh-mdo-clear-btn:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-section-label {
  padding: 6px 6px 4px 6px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.85;
}

.dsh-mdo-section-divider {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dsh-mdo-mark {
  padding: 0 1px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 18%, transparent);
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  font-weight: 500;
}

.dsh-mdo-row[data-ancestor-only="true"] .dsh-mdo-item-btn {
  opacity: 0.65;
}

.dsh-mdo-hit-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 2px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background-color 100ms ease;
}

.dsh-mdo-hit-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.dsh-mdo-hit-btn[data-active="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 8%, transparent);
}

.dsh-mdo-hit-btn[data-jumping="true"] {
  opacity: 0.65;
}

.dsh-mdo-hit-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-hit-snippet {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}

.dsh-mdo-searching-hint {
  padding: 6px 8px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.8;
}

.dsh-mdo-header-title {
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-count {
  margin-left: auto;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.dsh-mdo-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  padding: 4px 8px 20px 8px;
  margin-right: 2px;
}

.dsh-mdo-empty {
  padding: 24px 12px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* --- selection mode ------------------------------------------------------ */

.dsh-mdo-select-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  flex: none;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.dsh-mdo-select-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-select-btn[data-on="true"] {
  border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  background: var(--dsw-alias-brand-bg, var(--dsw-alias-bg-layer-2));
}

.dsh-mdo-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex: none;
  border: 1.5px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  border-radius: 4px;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-bg-base);
  cursor: pointer;
  padding: 0;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.dsh-mdo-check:hover {
  border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  transform: scale(1.06);
}

.dsh-mdo-check[data-checked="true"] {
  border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
}

/* --- reference card above the composer ----------------------------------- */

.dsh-mdo-refcard {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin: 0 0 6px 0;
  padding: 7px 10px;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.dsh-mdo-refcard:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
}

.dsh-mdo-refcard[data-open="true"] {
  border-color: var(--dsw-alias-brand-primary, var(--dsw-alias-border-l2));
}

.dsh-mdo-refcard-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  background: var(--dsw-alias-brand-bg, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
}

.dsh-mdo-refcard-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-refcard-count {
  flex: none;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--dsw-alias-brand-bg, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

/* --- selection sidebar --------------------------------------------------- */

.dsh-mdo-side {
  position: fixed;
  top: 56px;
  right: 12px;
  bottom: 12px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 360px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-alias-shadow-lg, 0 8px 28px rgba(15, 23, 42, 0.16));
  overflow: hidden;
  -webkit-app-region: no-drag;
}

.dsh-mdo-side-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 10px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}

.dsh-mdo-side-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-side-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.dsh-mdo-side-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  padding: 8px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dsh-mdo-btn {
  height: 28px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.dsh-mdo-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.dsh-mdo-btn[data-primary="true"] {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary));
  color: var(--dsw-alias-bg-base);
}

.dsh-mdo-btn[data-primary="true"]:hover {
  opacity: 0.9;
}

.dsh-mdo-btn[data-danger="true"] {
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  color: var(--dsw-alias-label-error, #d14343);
}

.dsh-mdo-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dsh-mdo-sel-item {
  margin: 0 0 8px 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
}

.dsh-mdo-sel-item-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.dsh-mdo-sel-item-meta {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-mdo-sel-item-title {
  margin: 2px 0 0 0;
  font-size: 12px;
  line-height: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  word-break: break-word;
  user-select: text;
}

.dsh-mdo-sel-item-body {
  margin: 6px 0 0 0;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.dsh-mdo-sel-item-remove {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.dsh-mdo-sel-item-remove:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

/* --- hidden turns -------------------------------------------------------- */

.dsh-mdo-hidden {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dsh-mdo-hidden-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.dsh-mdo-hidden-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-hidden-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-mdo-hidden-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

.dsh-mdo-hidden-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-hidden-restore {
  flex: none;
  height: 20px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}

.dsh-mdo-hidden-restore:hover {
  background: var(--dsw-alias-bg-base);
  border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
}

.dsh-mdo-hidden-badge {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  line-height: 15px;
}

.dsh-mdo-hide-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  box-sizing: border-box;
  min-height: 36px;
  padding: 6px 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}

/* The hide action shares the bar with its count; keep the button compact so a
   narrow column never clips it. */
.dsh-mdo-hide-bar .dsh-mdo-btn {
  flex: none;
  height: 24px;
  padding: 0 10px;
  font-size: 11px;
  line-height: 16px;
}

.dsh-mdo-hide-bar-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-confirm {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 80;
  width: 380px;
  max-width: calc(100vw - 32px);
  padding: 16px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
  box-shadow: var(--dsw-alias-shadow-lg, 0 16px 40px rgba(15, 23, 42, 0.22));
  -webkit-app-region: no-drag;
}

.dsh-mdo-confirm-scrim {
  position: fixed;
  inset: 0;
  z-index: 79;
  background: rgba(15, 23, 42, 0.32);
}

.dsh-mdo-confirm-title {
  margin: 0 0 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-confirm-text {
  margin: 0 0 14px 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

.dsh-mdo-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dsh-mdo-turn-group + .dsh-mdo-turn-group {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}

.dsh-mdo-turn-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 6px;
  margin-bottom: 2px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

/* The turn header carries its own checkbox, aligned with the heading column
   so ticking a whole turn reads as one action over the rows below it. */
.dsh-mdo-turn-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 4px;
}

.dsh-mdo-turn-row .dsh-mdo-turn-btn {
  margin-bottom: 0;
}

.dsh-mdo-turn-row .dsh-mdo-turn-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-turn-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-turn-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsh-mdo-row {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  border-radius: 6px;
  transition: background-color 100ms ease;
}

.dsh-mdo-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
}

/* A selected row keeps one background across checkbox, fold chevron, and label
   so the selection reads as one block rather than a loose checkbox. */
.dsh-mdo-row[data-checked="true"] {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)) 10%, transparent);
}

.dsh-mdo-row[data-checked="true"]:hover {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, var(--dsw-alias-label-primary)) 15%, transparent);
}

.dsh-mdo-row[data-checked="true"] .dsh-mdo-item-btn {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}

.dsh-mdo-row[data-active="true"]::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 6px;
  bottom: 6px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
}

.dsh-mdo-row[data-active="true"][data-checked="true"]::before {
  background: var(--dsw-alias-label-primary);
}

.dsh-mdo-fold-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 28px;
  flex: none;
}

/* One fixed track for the selection checkbox in every row, so the checkbox
   column and the fold column line up across nesting levels. */
.dsh-mdo-check-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 28px;
  flex: none;
}

/* Indentation guides: each extra nesting level draws a thin rule, which keeps
   deep rows readable once the checkbox column shifts the text right. */
.dsh-mdo-row[data-level]:not([data-level="0"])::after {
  content: '';
  position: absolute;
  top: 4px;
  bottom: 4px;
  width: 1px;
  border-radius: 1px;
  background: var(--dsw-alias-border-l1);
  opacity: 0.7;
  pointer-events: none;
}

.dsh-mdo-fold-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  opacity: 0.65;
}

.dsh-mdo-fold-btn:hover {
  opacity: 1;
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-item-btn {
  flex: 1;
  min-width: 0;
  padding: 5px 8px 5px 2px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
  font-weight: 400;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.dsh-mdo-row[data-sub="true"] .dsh-mdo-item-btn {
  color: var(--dsw-alias-label-secondary);
}

.dsh-mdo-row:hover .dsh-mdo-item-btn {
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-row[data-active="true"] .dsh-mdo-item-btn {
  color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  font-weight: 500;
}

.dsh-mdo-row[data-jumping="true"] .dsh-mdo-item-btn {
  opacity: 0.65;
}

.dsh-mdo-resizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.dsh-mdo-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2.5px;
  width: 1.5px;
  background: transparent;
  transition: background-color 120ms ease;
}

.dsh-mdo-resizer:hover::after,
.dsh-mdo-resizer[data-dragging="true"]::after {
  background: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2));
}

.dsh-mdo-trigger {
  position: absolute;
  left: 12px;
  top: calc(var(--dsh-mdo-top, 52px) + 12px);
  z-index: 8;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 9px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  -webkit-app-region: no-drag;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.dsh-mdo-trigger:hover {
  background: var(--dsw-alias-bg-layer-2);
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}

.dsh-mdo-trigger-icon-hover {
  display: none;
}

.dsh-mdo-trigger:hover .dsh-mdo-trigger-icon-rest {
  display: none;
}

.dsh-mdo-trigger:hover .dsh-mdo-trigger-icon-hover {
  display: inline-flex;
}

.dsh-mdo-trigger-badge {
  font-size: 11px;
  line-height: 14px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
}

[data-conversation-scroll] > [data-slot="conversation.session"] > *::after {
  content: '';
  display: block;
  flex: none;
  height: var(--dsh-mdo-jump-room, 0px);
  pointer-events: none;
}

@keyframes dsh-mdo-heading-flash {
  0% {
    background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 16%, transparent);
    box-shadow: -6px 0 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 16%, transparent),
                -9px 0 0 0 var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  }
  65% {
    background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 10%, transparent);
    box-shadow: -6px 0 0 0 color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 10%, transparent),
                -9px 0 0 0 var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));
  }
  100% {
    background-color: transparent;
    box-shadow: -6px 0 0 0 transparent, -9px 0 0 0 transparent;
  }
}

[data-mdo-flash="true"] {
  border-radius: 4px;
  animation: dsh-mdo-heading-flash 1.2s ease-out forwards;
}

@media (max-width: 860px) {
  [data-phase="active"]:has(.dsh-mdo-root[data-md-outline-state="open"]) > [data-conversation-content]:not(:has([data-conversation-composer-overlay])) {
    margin-left: 0;
  }
  .dsh-mdo-panel {
    background: var(--dsw-alias-bg-layer-1);
    border-right: 1px solid var(--dsw-alias-border-l2);
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-phase="active"] > [data-conversation-content],
  .dsh-mdo-collapse-btn,
  .dsh-mdo-row,
  .dsh-mdo-trigger {
    transition: none;
  }
}
`;

    function cleanHeadingText(raw) {
      let s = raw.trim();
      if (s === '') return '';
      s = s.replace(/(`+)([\s\S]*?)\1/g, '$2');
      s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
      s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
      s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
      s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
      s = s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
      s = s.replace(/\s+/g, ' ').trim();
      if (s.length > HEADING_TEXT_LIMIT) {
        return `${s.slice(0, HEADING_TEXT_LIMIT - 1).trimEnd()}…`;
      }
      return s;
    }

    function isNonParagraphLine(line) {
      return (
        /^\s*$/.test(line) ||
        /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line) ||
        /^ {0,3}>/.test(line) ||
        /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(line) ||
        /^ {0,3}(?:[-*_][ \t]*){3,}$/.test(line) ||
        /^ {0,3}(?:`{3,}|~{3,})/.test(line)
      );
    }

    function extractBlockHeadings(markdown) {
      if (!markdown) return [];
      const lines = markdown.split(/\r?\n/);
      const result = [];
      let fenceChar = '';
      let fenceLen = 0;
      let paragraphLines = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (fenceChar !== '') {
          const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
          if (
            closeMatch !== null &&
            closeMatch[1][0] === fenceChar &&
            closeMatch[1].length >= fenceLen
          ) {
            fenceChar = '';
            fenceLen = 0;
          }
          continue;
        }
        const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (
          openFence !== null &&
          !(openFence[1][0] === '`' && openFence[2].includes('`'))
        ) {
          fenceChar = openFence[1][0];
          fenceLen = openFence[1].length;
          paragraphLines = [];
          continue;
        }
        const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
        if (atx !== null) {
          const afterHashes = line.replace(/^ {0,3}#{1,6}/, '');
          if (afterHashes === '' || /^[ \t]/.test(afterHashes)) {
            paragraphLines = [];
            const rawBody = (atx[2] ?? '').replace(/^#+[ \t]*$/, '');
            const text = cleanHeadingText(rawBody);
            if (text !== '') {
              result.push({ depth: atx[1].length, text });
            }
            continue;
          }
        }
        if (paragraphLines.length > 0) {
          const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
          if (setext !== null) {
            const depth = setext[1][0] === '=' ? 1 : 2;
            const text = cleanHeadingText(paragraphLines.join(' '));
            paragraphLines = [];
            if (text !== '') {
              result.push({ depth, text });
            }
            continue;
          }
        }
        if (isNonParagraphLine(line)) {
          paragraphLines = [];
        } else {
          paragraphLines.push(line.trim());
        }
      }
      return result;
    }

    function readStoredOpen() {
      try {
        const raw = localStorage.getItem(STORAGE_OPEN_KEY);
        return raw === null ? true : raw !== 'false';
      } catch (_err) {
        return true;
      }
    }

    function writeStoredOpen(open) {
      try {
        localStorage.setItem(STORAGE_OPEN_KEY, open ? 'true' : 'false');
      } catch (_err) {
        // Ignore storage quota / privacy mode failures.
      }
    }

    function readStoredWidth() {
      try {
        const raw = localStorage.getItem(STORAGE_WIDTH_KEY);
        if (raw === null) return DEFAULT_WIDTH;
        const n = Number(raw);
        return Number.isFinite(n)
          ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n)))
          : DEFAULT_WIDTH;
      } catch (_err) {
        return DEFAULT_WIDTH;
      }
    }

    function writeStoredWidth(width) {
      try {
        localStorage.setItem(STORAGE_WIDTH_KEY, String(width));
      } catch (_err) {
        // Ignore storage quota / privacy mode failures.
      }
    }

    /** Extract loaded turns, assistant headings, and live step text blocks from ChatSnapshot. */
    function selectLoadedOutline(chat) {
      if (!chat || !Array.isArray(chat.order)) {
        return { loadedTurnSet: [], turns: [], allSteps: [] };
      }
      const navPrompts = new Map();
      const navItems = chat.navigation?.items?.() ?? [];
      for (const nav of navItems) {
        if (typeof nav.turn === 'number' && typeof nav.prompt === 'string') {
          navPrompts.set(nav.turn, nav.prompt);
        }
      }
      const turnMap = new Map();
      const loadedTurnNums = new Set();
      const allSteps = [];

      for (const key of chat.order) {
        const node = chat.nodes?.get?.(key);
        if (!node) continue;
        const loc = node.location;
        if (loc && (loc.kind === 'turn' || loc.kind === 'step') && loc.turn) {
          loadedTurnNums.add(loc.turn.turn);
        }
        if (node.kind !== 'assistant-step' || !node.data) continue;
        const turnNum = node.data.turn;
        const stepNum = typeof node.data.step === 'number' ? node.data.step : 0;
        const blocks = node.data.blocks;
        if (typeof turnNum !== 'number' || !Array.isArray(blocks)) continue;
        loadedTurnNums.add(turnNum);

        const textBlocks = [];
        const headings = [];
        for (const block of blocks) {
          if (!block || block.kind !== 'text' || typeof block.text !== 'string') continue;
          const blockIndex = textBlocks.length;
          textBlocks.push(block.text);
          const parsed = extractBlockHeadings(block.text);
          for (const item of parsed) headings.push({ ...item, blockIndex });
        }

        if (textBlocks.length > 0) {
          allSteps.push({
            turn: turnNum,
            step: stepNum,
            nodeKey: node.key,
            prompt: navPrompts.get(turnNum) ?? '',
            texts: textBlocks,
          });
        }

        if (headings.length === 0) continue;

        let turnEntry = turnMap.get(turnNum);
        if (!turnEntry) {
          turnEntry = {
            turn: turnNum,
            prompt: navPrompts.get(turnNum) ?? '',
            steps: [],
          };
          turnMap.set(turnNum, turnEntry);
        }
        turnEntry.steps.push({
          step: stepNum,
          nodeKey: node.key,
          headings,
        });
      }

      const turns = [...turnMap.values()].sort((a, b) => a.turn - b.turn);
      for (const t of turns) {
        t.steps.sort((a, b) => a.step - b.step);
      }
      allSteps.sort((a, b) => a.turn - b.turn || a.step - b.step);
      return {
        loadedTurnSet: [...loadedTurnNums].sort((a, b) => a - b),
        turns,
        allSteps,
      };
    }

    function sameHeadingsList(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i].depth !== b[i].depth || a[i].text !== b[i].text) return false;
      }
      return true;
    }

    function sameStringsList(a, b) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    function equalLoadedOutline(left, right) {
      if (left === right) return true;
      if (!left || !right) return false;
      if (left.loadedTurnSet.length !== right.loadedTurnSet.length) return false;
      for (let i = 0; i < left.loadedTurnSet.length; i++) {
        if (left.loadedTurnSet[i] !== right.loadedTurnSet[i]) return false;
      }
      if (left.turns.length !== right.turns.length) return false;
      for (let i = 0; i < left.turns.length; i++) {
        const lt = left.turns[i];
        const rt = right.turns[i];
        if (lt.turn !== rt.turn || lt.prompt !== rt.prompt) return false;
        if (lt.steps.length !== rt.steps.length) return false;
        for (let j = 0; j < lt.steps.length; j++) {
          const ls = lt.steps[j];
          const rs = rt.steps[j];
          if (
            ls.step !== rs.step ||
            ls.nodeKey !== rs.nodeKey ||
            !sameHeadingsList(ls.headings, rs.headings)
          ) {
            return false;
          }
        }
      }
      if (left.allSteps.length !== right.allSteps.length) return false;
      for (let i = 0; i < left.allSteps.length; i++) {
        const la = left.allSteps[i];
        const ra = right.allSteps[i];
        if (
          la.turn !== ra.turn ||
          la.step !== ra.step ||
          la.nodeKey !== ra.nodeKey ||
          la.prompt !== ra.prompt ||
          !sameStringsList(la.texts, ra.texts)
        ) {
          return false;
        }
      }
      return true;
    }

    function stripInlineMarkdown(raw) {
      let s = raw.trim();
      if (s === '') return '';
      s = s.replace(/(`+)([\s\S]*?)\1/g, '$2');
      s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
      s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
      s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
      s = s.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
      s = s.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
      s = s.replace(/^ {0,3}(?:>\s*)+/, '');
      s = s.replace(/^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/, '');
      return s.replace(/\s+/g, ' ').trim();
    }

    function buildMatchSnippet(text, needleLower) {
      const lower = text.toLowerCase();
      const idx = lower.indexOf(needleLower);
      if (idx === -1) return null;
      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(text.length, idx + needleLower.length + SNIPPET_RADIUS + 18);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      const slice = text.slice(start, end);
      return {
        snippet: `${prefix}${slice}${suffix}`,
        matchStart: prefix.length + (idx - start),
        matchLength: needleLower.length,
        needleText: text.slice(idx, idx + needleLower.length),
      };
    }

    function searchMarkdownBody(markdown, needleLower, initialHeadingCount, maxHits) {
      if (!markdown || maxHits <= 0) {
        return { headingCount: initialHeadingCount, hits: [] };
      }
      const lines = markdown.split(/\r?\n/);
      const hits = [];
      let headingCount = initialHeadingCount;
      let fenceChar = '';
      let fenceLen = 0;
      let paragraphLines = [];

      const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        const joined = stripInlineMarkdown(paragraphLines.join(' '));
        paragraphLines = [];
        if (joined === '' || hits.length >= maxHits) return;
        const match = buildMatchSnippet(joined, needleLower);
        if (match) {
          const pos = joined.toLowerCase().indexOf(needleLower);
          hits.push({
            sectionIndex: headingCount - 1,
            ...match,
            anchorPhrase: joined.slice(
              Math.max(0, pos - 10),
              Math.min(joined.length, pos + needleLower.length + 18),
            ),
          });
        }
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (fenceChar !== '') {
          const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
          if (
            closeMatch !== null &&
            closeMatch[1][0] === fenceChar &&
            closeMatch[1].length >= fenceLen
          ) {
            fenceChar = '';
            fenceLen = 0;
          } else if (hits.length < maxHits) {
            const trimmedCode = line.trim();
            if (trimmedCode !== '') {
              const match = buildMatchSnippet(trimmedCode, needleLower);
              if (match) {
                hits.push({
                  sectionIndex: headingCount - 1,
                  ...match,
                  anchorPhrase: trimmedCode.slice(0, 48),
                });
              }
            }
          }
          continue;
        }

        const openFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (
          openFence !== null &&
          !(openFence[1][0] === '`' && openFence[2].includes('`'))
        ) {
          flushParagraph();
          fenceChar = openFence[1][0];
          fenceLen = openFence[1].length;
          continue;
        }

        const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
        if (atx !== null) {
          const afterHashes = line.replace(/^ {0,3}#{1,6}/, '');
          if (afterHashes === '' || /^[ \t]/.test(afterHashes)) {
            flushParagraph();
            const rawBody = (atx[2] ?? '').replace(/^#+[ \t]*$/, '');
            const text = cleanHeadingText(rawBody);
            if (text !== '') headingCount += 1;
            continue;
          }
        }

        if (paragraphLines.length > 0) {
          const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
          if (setext !== null) {
            const text = cleanHeadingText(paragraphLines.join(' '));
            paragraphLines = [];
            if (text !== '') headingCount += 1;
            continue;
          }
        }

        if (/^\s*$/.test(line) || /^ {0,3}(?:[-*_][ \t]*){3,}$/.test(line)) {
          flushParagraph();
        } else if (
          /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line) ||
          /^ {0,3}>/.test(line) ||
          line.includes('|')
        ) {
          flushParagraph();
          if (hits.length < maxHits) {
            const cleaned = stripInlineMarkdown(line.replace(/^\|+|\|+$/g, ' '));
            if (cleaned !== '' && !/^[-:\s|]+$/.test(cleaned)) {
              const match = buildMatchSnippet(cleaned, needleLower);
              if (match) {
                const pos = cleaned.toLowerCase().indexOf(needleLower);
                hits.push({
                  sectionIndex: headingCount - 1,
                  ...match,
                  anchorPhrase: cleaned.slice(
                    Math.max(0, pos - 10),
                    Math.min(cleaned.length, pos + needleLower.length + 18),
                  ),
                });
              }
            }
          }
        } else {
          paragraphLines.push(line.trim());
        }
      }
      flushParagraph();
      return { headingCount, hits };
    }

    /** Instant client-side search across all loaded assistant steps (including streaming). */
    function searchLoadedSteps(allSteps, rawQuery) {
      const query = rawQuery.trim();
      if (query === '' || !Array.isArray(allSteps)) return [];
      const needleLower = query.toLowerCase();
      const hits = [];

      for (const stepEntry of allSteps) {
        if (hits.length >= MAX_LIVE_BODY_HITS) break;
        let headingCount = 0;
        let hitOrdinal = 0;
        for (const text of stepEntry.texts) {
          const rem = MAX_LIVE_BODY_HITS - hits.length;
          if (rem <= 0) break;
          const res = searchMarkdownBody(text, needleLower, headingCount, rem);
          headingCount = res.headingCount;
          for (const hItem of res.hits) {
            hits.push({
              id: `body:t${stepEntry.turn}:s${stepEntry.step}:m${hitOrdinal++}`,
              turn: stepEntry.turn,
              step: stepEntry.step,
              nodeKey: stepEntry.nodeKey,
              turnStartSeq: undefined,
              prompt: stepEntry.prompt,
              sectionIndex: hItem.sectionIndex,
              snippet: hItem.snippet,
              matchStart: hItem.matchStart,
              matchLength: hItem.matchLength,
              needleText: hItem.needleText,
              anchorPhrase: hItem.anchorPhrase,
              loaded: true,
            });
          }
        }
      }
      return hits;
    }

    /** Render text with all case-insensitive occurrences of `query` highlighted. */
    function renderHighlightedText(text, query) {
      const q = (query ?? '').trim();
      if (q === '' || !text) return text;
      const lowerText = text.toLowerCase();
      const lowerQ = q.toLowerCase();
      const parts = [];
      let cursor = 0;
      let keyIdx = 0;
      while (cursor < text.length) {
        const idx = lowerText.indexOf(lowerQ, cursor);
        if (idx === -1) {
          parts.push(text.slice(cursor));
          break;
        }
        if (idx > cursor) parts.push(text.slice(cursor, idx));
        parts.push(
          h(
            'mark',
            { key: keyIdx++, className: 'dsh-mdo-mark' },
            text.slice(idx, idx + lowerQ.length),
          ),
        );
        cursor = idx + lowerQ.length;
      }
      return parts.length > 0 ? parts : text;
    }

    /**
     * Merge whole-log Host `mdOutline` projection with live loaded `useChat` turns,
     * computing normalized indentation levels and tree parent relationships.
     */
    function buildMergedOutline(projectedTurns, loadedOutline, hiddenTurnNums) {
      const loadedByTurn = new Map();
      const loadedNums = new Set(loadedOutline.loadedTurnSet);
      for (const t of loadedOutline.turns) loadedByTurn.set(t.turn, t);
      const hidden = new Set(hiddenTurnNums ?? []);

      const allTurnNums = new Set();
      const projectedByTurn = new Map();
      if (Array.isArray(projectedTurns)) {
        for (const pt of projectedTurns) {
          if (pt && typeof pt.turn === 'number') {
            allTurnNums.add(pt.turn);
            projectedByTurn.set(pt.turn, pt);
          }
        }
      }
      for (const num of loadedByTurn.keys()) allTurnNums.add(num);

      const sortedNums = [...allTurnNums].sort((a, b) => a - b);
      const groups = [];

      for (const turnNum of sortedNums) {
        // A hidden turn leaves the outline entirely; it stays addressable only
        // through the hidden-turn list, which offers the restore action.
        if (hidden.has(turnNum)) continue;
        const isLoaded = loadedNums.has(turnNum);
        const lt = loadedByTurn.get(turnNum);
        const pt = projectedByTurn.get(turnNum);
        const sourceSteps = isLoaded ? (lt ? lt.steps : []) : (pt ? pt.steps : []);
        if (!sourceSteps || sourceSteps.length === 0) continue;

        const rawItems = [];
        for (const stepEntry of sourceSteps) {
          const hs = stepEntry.headings ?? [];
          for (let idx = 0; idx < hs.length; idx++) {
            const hItem = hs[idx];
            const id = `t${turnNum}:s${stepEntry.step}:h${idx}`;
            rawItems.push({
              id,
              turn: turnNum,
              step: stepEntry.step,
              indexInStep: idx,
              nodeKey: stepEntry.nodeKey ?? null,
              turnStartSeq: pt?.seq,
              loaded: isLoaded,
              depth: hItem.depth,
              text: hItem.text,
            });
          }
        }
        if (rawItems.length === 0) continue;

        // Normalize indentation per turn so e.g. H2+H3 starts flush at level 0
        let minDepth = 6;
        for (const item of rawItems) {
          if (item.depth < minDepth) minDepth = item.depth;
        }

        // Compute parentId & hasChildren for Feishu-like section folding
        const stack = [];
        const items = rawItems.map((item) => {
          const level = Math.max(0, Math.min(5, item.depth - minDepth));
          while (stack.length > 0 && stack[stack.length - 1].depth >= item.depth) {
            stack.pop();
          }
          const parentId = stack.length > 0 ? stack[stack.length - 1].id : null;
          const enriched = {
            ...item,
            level,
            parentId,
            hasChildren: false,
          };
          stack.push(enriched);
          return enriched;
        });

        const byId = new Map(items.map((it) => [it.id, it]));
        for (const it of items) {
          if (it.parentId !== null) {
            const parent = byId.get(it.parentId);
            if (parent) parent.hasChildren = true;
          }
        }

        groups.push({
          turn: turnNum,
          prompt: (lt?.prompt || pt?.prompt || '').trim(),
          turnStartSeq: pt?.seq,
          loaded: isLoaded,
          items,
        });
      }

      return groups;
    }

    /** Query non-reasoning top-level Markdown heading elements inside one assistant node seat. */
    function querySeatHeadings(seatEl) {
      if (!seatEl) return [];
      const nodes = seatEl.querySelectorAll('h1, h2, h3, h4, h5, h6');
      const out = [];
      for (const el of nodes) {
        if (el.id === 'footnote-label') continue;
        if (el.closest('[data-slot="conversation.chat.reasoning.body"]')) continue;
        if (el.closest('[data-markdown-variant="compact"]')) continue;
        if (el.closest('[data-turn-process-inline]')) continue;
        if (el.closest('blockquote, li, td, th, details, section')) continue;
        out.push(el);
      }
      return out;
    }

    function normalizeDomHeadingText(el) {
      return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    /** Resolve the enclosing ConversationRoot element, skipping display:contents slot wrappers. */
    function findConversationRoot(el) {
      if (!el) return null;
      const byPhase = el.closest('[data-phase]');
      if (byPhase) return byPhase;
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        if (cur.querySelector && cur.querySelector(':scope > [data-conversation-content]')) {
          return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }

    /** Resolve the scrollable conversation viewport containing the transcript. */
    function resolveScrollContainer(rootEl, targetEl) {
      if (!rootEl) return null;
      const marked = rootEl.querySelector('[data-conversation-scroll]');
      if (marked) {
        const style = getComputedStyle(marked);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return marked;
      }
      let cur = targetEl ? targetEl.parentElement : rootEl.querySelector('[data-chat-flow]');
      while (cur && cur !== document.body) {
        const style = getComputedStyle(cur);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') return cur;
        if (cur === rootEl) break;
        cur = cur.parentElement;
      }
      return marked;
    }

    /** Resolve the rendered DOM heading element corresponding to an outline item. */
    function findHeadingElement(scrollRoot, item, turnGroup) {
      if (!scrollRoot) return null;
      const targetText = (item.text ?? '').replace(/…$/, '').trim();

      if (item.nodeKey) {
        const seats = scrollRoot.querySelectorAll(
          '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])',
        );
        for (const seat of seats) {
          if (seat.getAttribute('data-chat-node-key') === item.nodeKey) {
            const headings = querySeatHeadings(seat);
            const exact = headings[item.indexInStep];
            if (exact) return exact;
            if (targetText !== '') {
              const byText = headings.find((hEl) =>
                normalizeDomHeadingText(hEl).startsWith(targetText),
              );
              if (byText) return byText;
            }
          }
        }
      }

      // Fallback lookup by data-chat-turn + ordered heading index within that turn
      const turnSeats = scrollRoot.querySelectorAll(
        `[data-chat-turn="${String(item.turn)}"][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])`,
      );
      if (turnSeats.length > 0) {
        const allTurnHeadings = [];
        for (const seat of turnSeats) {
          for (const hEl of querySeatHeadings(seat)) allTurnHeadings.push(hEl);
        }
        if (turnGroup) {
          const idxInTurn = turnGroup.items.findIndex((x) => x.id === item.id);
          if (idxInTurn >= 0 && allTurnHeadings[idxInTurn]) {
            return allTurnHeadings[idxInTurn];
          }
        }
        if (targetText !== '') {
          const byText = allTurnHeadings.find((hEl) =>
            normalizeDomHeadingText(hEl).startsWith(targetText),
          );
          if (byText) return byText;
        }
        return null;
      }

      return null;
    }

    /** Resolve the rendered DOM block (paragraph, list item, table row, code block, or section heading) for a body hit. */
    function findBodyHitElement(scrollRoot, hit, turnGroup) {
      if (!scrollRoot || !hit) return null;

      const candidateSeats = [];
      if (hit.nodeKey) {
        const seats = scrollRoot.querySelectorAll(
          '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])',
        );
        for (const seat of seats) {
          if (seat.getAttribute('data-chat-node-key') === hit.nodeKey) {
            candidateSeats.push(seat);
          }
        }
      }
      if (candidateSeats.length === 0) {
        const turnSeats = scrollRoot.querySelectorAll(
          `[data-chat-turn="${String(hit.turn)}"][data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"])`,
        );
        for (const seat of turnSeats) candidateSeats.push(seat);
      }
      if (candidateSeats.length === 0) return null;

      const phraseLower = (hit.anchorPhrase ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const needleLower = (hit.needleText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

      const matchInsideSeat = (seat) => {
        const blocks = seat.querySelectorAll('p, li, tr, blockquote, pre');
        const filtered = [];
        for (const el of blocks) {
          if (el.closest('[data-slot="conversation.chat.reasoning.body"]')) continue;
          if (el.closest('[data-markdown-variant="compact"]')) continue;
          if (el.closest('[data-turn-process-inline]')) continue;
          filtered.push(el);
        }
        if (phraseLower !== '') {
          for (const el of filtered) {
            const norm = normalizeDomHeadingText(el).toLowerCase();
            if (norm.includes(phraseLower)) return el;
          }
        }
        if (needleLower !== '') {
          for (const el of filtered) {
            const norm = normalizeDomHeadingText(el).toLowerCase();
            if (norm.includes(needleLower)) return el;
          }
        }
        if (typeof hit.sectionIndex === 'number' && hit.sectionIndex >= 0) {
          const headings = querySeatHeadings(seat);
          if (headings[hit.sectionIndex]) return headings[hit.sectionIndex];
        }
        return null;
      };

      for (const seat of candidateSeats) {
        const matched = matchInsideSeat(seat);
        if (matched) return matched;
      }

      // Fallback to nearest section heading in the turn, or the turn's first assistant seat
      if (turnGroup && typeof hit.sectionIndex === 'number' && hit.sectionIndex >= 0) {
        const secItem = turnGroup.items.find(
          (it) => it.step === hit.step && it.indexInStep === hit.sectionIndex,
        );
        if (secItem) {
          const secEl = findHeadingElement(scrollRoot, secItem, turnGroup);
          if (secEl) return secEl;
        }
      }
      return candidateSeats[0] ?? null;
    }

    /** Reveal any collapsed searchable-hidden ancestors (`hidden="until-found"`). */
    function revealHiddenAncestors(targetEl, stopEl) {
      let cur = targetEl;
      let revealed = false;
      while (cur && cur !== stopEl) {
        if (cur.getAttribute && cur.getAttribute('hidden') === 'until-found') {
          cur.dispatchEvent(new Event('beforematch'));
          revealed = true;
        }
        cur = cur.parentElement;
      }
      return revealed;
    }

    function IconDoubleChevronLeft() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M7.5 3.5L3 8l4.5 4.5M12.5 3.5L8 8l4.5 4.5',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function IconDoubleChevronRight() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.5 3.5L8 8l-4.5 4.5M8.5 3.5L13 8l-4.5 4.5',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function IconOutlineList() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 4h11M2.5 8h7.5M5 12h8.5',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
      );
    }

    function IconCaret({ collapsed }) {
      return h(
        'svg',
        {
          viewBox: '0 0 12 12',
          width: 10,
          height: 10,
          fill: 'none',
          'aria-hidden': 'true',
          style: {
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease',
          },
        },
        h('path', {
          d: 'M3 4.5L6 7.5L9 4.5',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function IconSearch() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': 'true' },
        h('circle', {
          cx: '7',
          cy: '7',
          r: '4.5',
          stroke: 'currentColor',
          strokeWidth: '1.4',
        }),
        h('path', {
          d: 'M10.4 10.4L13.5 13.5',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      );
    }

    function IconClear() {
      return h(
        'svg',
        { viewBox: '0 0 12 12', width: 11, height: 11, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 3l6 6M9 3l-6 6',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      );
    }

    function IconCheck() {
      return h(
        'svg',
        { viewBox: '0 0 12 12', width: 9, height: 9, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 6.2l2.3 2.3L9.5 3.8',
          stroke: 'currentColor',
          strokeWidth: '1.8',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function IconQuote() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3 4.5h4.5M3 8h6M3 11.5h3.5',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M11 5v6M9.5 9.5L11 11l1.5-1.5',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: '0.6',
        }),
      );
    }

    /**
     * Flatten one turn group's outline rows into display order, carrying the
     * ancestor heading titles so a reference keeps its section path.
     * @param {object} group - one built outline group.
     * @returns {Array<{ item: object, path: string[] }>}
     */
    function flattenGroupRows(group) {
      const rows = [];
      const walk = (parentId, path) => {
        for (const item of group.items) {
          if ((item.parentId ?? null) !== parentId) continue;
          const nextPath = [...path, item.text];
          rows.push({ item, path });
          walk(item.id, nextPath);
        }
      };
      walk(null, []);
      return rows;
    }

    /**
     * Collect the reply text under one heading, from its own line to the next
     * heading at the same or a shallower depth.
     * @param {ReadonlyArray<string>} texts - the step's Markdown text blocks.
     * @param {string} headingText - the heading this section starts at.
     * @param {number} headingIndex - that heading's ordinal within the step.
     * @returns {string}
     */
    function collectSectionBody(texts, headingText, headingIndex) {
      const lines = texts.join('\n').split(/\r?\n/);
      const out = [];
      let seen = -1;
      let started = false;
      let startDepth = 0;
      let fence = '';
      for (const line of lines) {
        const atx = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(line);
        if (atx !== null) {
          const depth = atx[1].length;
          const title = atx[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
          if (!started) {
            if (title !== headingText) continue;
            seen += 1;
            if (seen !== headingIndex) continue;
            started = true;
            startDepth = depth;
            continue;
          }
          if (depth <= startDepth) break;
          out.push(line);
          continue;
        }
        if (started) {
          const openFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
          if (fence === '') {
            if (openFence !== null) fence = openFence[1][0];
          } else if (openFence !== null && openFence[1][0] === fence) {
            fence = '';
          }
          out.push(line);
        }
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /**
     * Assemble one selectable section, with the reply text that follows it.
     * @param {object} group - the turn group the heading belongs to.
     * @param {object} item - the heading row.
     * @param {ReadonlyArray<object>} allSteps - loaded assistant steps.
     * @param {ReadonlyArray<string>} path - ancestor heading titles, outermost first.
     * @returns {object} the selection entry.
     */
    function buildSectionSelection(group, item, allSteps, path) {
      const step = (allSteps ?? []).find(
        (candidate) => candidate.turn === group.turn && candidate.step === item.step,
      );
      const text = item.text;
      let body = '';
      const blockText = step?.texts?.[item.blockIndex ?? 0];
      if (typeof blockText === 'string') {
        body = collectSectionBody(blockText.split('\n'), text, item.indexInStep ?? 0);
      }
      return {
        id: item.id,
        kind: 'section',
        turn: group.turn,
        step: item.step,
        prompt: group.prompt ?? '',
        heading: text,
        path: [...(path ?? [])],
        depth: item.depth,
        body,
      };
    }

    /**
     * Render the selected sections as the reference block inserted into the composer.
     * File references in `@path` form are spelled `@ path` so the composer's
     * mention trigger does not rewrite them.
     * @param {ReadonlyArray<object>} entries - selection entries in selection order.
     * @returns {{ text: string, truncated: boolean }}
     */
    function buildReferenceText(entries) {
      const lines = ['<md-outline-reference>', '参考以下对话片段：', ''];
      let truncated = false;
      for (const entry of entries) {
        const meta = [`第 ${entry.turn} 轮`];
        if (entry.prompt) meta.push(entry.prompt);
        lines.push(`## ${entry.heading}`, `（${meta.join(' · ')}）`, '');
        if (entry.body) {
          lines.push(entry.body.replace(/(^|\s)@(?=\S)/g, '$1@ '), '');
        }
      }
      lines.push('</md-outline-reference>');
      let text = lines.join('\n');
      if (text.length > MAX_REFERENCE_CHARS) {
        text = `${text.slice(0, MAX_REFERENCE_CHARS)}\n…（内容过长，已截断）\n</md-outline-reference>`;
        truncated = true;
      }
      return { text, truncated };
    }

    /**
     * POST one of this plugin's mutating routes.
     * @param {string} route - route path relative to the page origin.
     * @param {object} payload - JSON body.
     * @returns {Promise<{ ok: boolean, body: object }>}
     */
    async function postRoute(route, payload) {
      const resp = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      let body = {};
      try {
        body = await resp.json();
      } catch (error) {
        // A non-JSON body is reported through the status alone.
        void error;
      }
      return { ok: resp.ok, body };
    }

    const EMPTY_BRIDGE = Object.freeze({
      active: false,
      sessionId: null,
      running: false,
      hasMore: false,
      loadedTurnNums: [],
      allSteps: [],
      groups: [],
      hiddenTurns: [],
      loadThrough: undefined,
    });

    /**
     * Cross-slot store for the selection, the reference card, and the Hide
     * action's confirmation.
     *
     * The outline lives in the header slot, the card above the composer, and
     * the composer itself is reachable only from the dock slot, so neither end
     * can reach the other through props. This one observable is their shared
     * owner: the outline writes selections and asks for a confirmation, and the
     * dock owns the confirmation UI because it is the only place holding both
     * `inputActions` and the session id the Host routes need.
     */
    function createSelectionStore() {
      let state = { entries: [], selecting: false, sidebarOpen: false, confirmIds: null };
      const listeners = new Set();
      const read = () => state;
      const write = (next) => {
        if (next === state) return;
        state = next;
        for (const fn of listeners) fn();
      };
      return {
        observable: {
          getSnapshot: read,
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        read,
        setSelecting: (selecting) => write({ ...state, selecting }),
        setSidebarOpen: (sidebarOpen) => write({ ...state, sidebarOpen }),
        toggleEntry: (entry) => {
          const exists = state.entries.some((it) => it.id === entry.id);
          write({
            ...state,
            entries: exists ? state.entries.filter((it) => it.id !== entry.id) : [...state.entries, entry],
          });
        },
        removeEntry: (id) => write({ ...state, entries: state.entries.filter((it) => it.id !== id) }),
        clearEntries: () => write({ ...state, entries: [], selecting: false }),
        requestHide: (ids) => write({ ...state, confirmIds: ids }),
        cancelHide: () => write({ ...state, confirmIds: null }),
        finishHide: (ids) => write({
          ...state,
          confirmIds: null,
          entries: state.entries.filter((it) => !ids.has(it.id)),
        }),
        reset: () => write({ entries: [], selecting: false, sidebarOpen: false, confirmIds: null }),
      };
    }

    /** Hidden-turn state per Session, written by the card and read by the outline. */
    function createHiddenStore() {
      let state = { bySession: {} };
      const listeners = new Set();
      const write = (next) => {
        state = next;
        for (const fn of listeners) fn();
      };
      return {
        observable: {
          getSnapshot: () => state,
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        read: () => state,
        setTurns: (sessionId, turns) => {
          const current = state.bySession[sessionId];
          const next = turns.length === 0 ? undefined : turns;
          if (current === next) return;
          const bySession = { ...state.bySession };
          if (next === undefined) delete bySession[sessionId];
          else bySession[sessionId] = next;
          write({ bySession });
        },
        clear: () => write({ bySession: {} }),
      };
    }

    /**
     * Restore action published by the composer dock, which is the only slot
     * holding the session id the Host routes need. The outline calls it without
     * carrying a second copy of the transport, and a missing function simply
     * leaves the restore buttons disabled.
     */
    const restoreActionRef = { current: null };


    return {
      name: 'md-outline',
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN_DICT));
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH_DICT));

        ctx.effect(() => {
          const styleEl = document.createElement('style');
          styleEl.setAttribute('data-dsh-plugin', 'dsh-markdown-outline');
          styleEl.textContent = STYLESHEET;
          document.head.appendChild(styleEl);
          return () => {
            styleEl.remove();
          };
        });

        let bridgeState = EMPTY_BRIDGE;
        const bridgeListeners = new Set();
        const bridgeObservable = {
          getSnapshot: () => bridgeState,
          subscribe: (fn) => {
            bridgeListeners.add(fn);
            return () => {
              bridgeListeners.delete(fn);
            };
          },
        };

        const selectionStore = createSelectionStore();
        const hiddenStore = createHiddenStore();

        // One plugin-owned stylesheet carries the transcript rule for the whole
        // Client run. Writing it here rather than inside a component keeps the
        // rule in place across session switches and component remounts.
        let transcriptSheet = null;
        ctx.effect(() => {
          const styleEl = document.createElement('style');
          styleEl.setAttribute('data-dsh-plugin', 'dsh-markdown-outline-transcript');
          document.head.appendChild(styleEl);
          transcriptSheet = styleEl;
          return () => {
            transcriptSheet = null;
            styleEl.remove();
          };
        });

        /**
         * Publish the transcript hiding rule for the current hidden turns.
         * @param {ReadonlyArray<number>} turns - hidden turn numbers; empty clears the rule.
         */
        function publishTranscriptRule(turns) {
          if (transcriptSheet === null) return;
          transcriptSheet.textContent = turns.length === 0
            ? ''
            : `${turns.map((turn) => `[data-chat-turn="${turn}"]`).join(',\n')} { display: none !important; }`;
        }

        function publishBridge(next) {
          bridgeState = next;
          for (const fn of bridgeListeners) fn();
        }

        /** Zero-DOM session bridge mounted in the active Session header. */
        function SessionOutlineBridge(props) {
          const { sessionId, useSession, useChat, useProjection, loadThrough } = props;
          const running = useSession((s) => s.running);
          const hasMore = useSession((s) => s.hasMore);
          const projected = useProjection('mdOutline');
          const loaded = useChat(selectLoadedOutline, equalLoadedOutline);
          // The projection carries both the outline and the hidden-turn ledger;
          // a client that sees an older array-only value still renders.
          const projectedTurns = Array.isArray(projected) ? projected : (projected?.turns ?? null);
          const hiddenTurns = Array.isArray(projected?.hiddenTurns) ? projected.hiddenTurns : EMPTY_TURNS;
          const groups = useMemo(
            () => buildMergedOutline(projectedTurns, loaded, hiddenTurns),
            [projectedTurns, loaded, hiddenTurns],
          );

          useEffect(() => {
            publishBridge({
              active: true,
              sessionId,
              running,
              hasMore,
              loadedTurnNums: loaded.loadedTurnSet,
              allSteps: loaded.allSteps,
              groups,
              hiddenTurns,
              loadThrough,
            });
          }, [sessionId, running, hasMore, loaded, groups, hiddenTurns, loadThrough]);

          useEffect(() => {
            return () => {
              if (bridgeState.sessionId === sessionId) {
                publishBridge(EMPTY_BRIDGE);
              }
            };
          }, [sessionId]);

          return null;
        }

        /**
         * Reference card above the composer, its detail sidebar, and the
         * hide/restore actions.
         *
         * This slot is the only place with both `inputActions` (to write the
         * composer) and `sessionId` (to address the Host routes), so the
         * outline's selections are acted on from here.
         */
        function ReferenceDock(props) {
          const { useSelection, useHiddenTurns, sessionId, inputActions, t } = props;
          const selection = useSelection((s) => s);
          const [busy, setBusy] = useState(false);
          const [notice, setNotice] = useState(null);

          useEffect(() => {
            if (notice === null) return undefined;
            const timer = setTimeout(() => setNotice(null), 6000);
            return () => clearTimeout(timer);
          }, [notice]);

          useEffect(() => {
            selectionStore.reset();
            hiddenStore.clear();
            return () => {
              selectionStore.reset();
            };
          }, [sessionId]);

          const insertReference = useCallback(() => {
            const entries = selectionStore.read().entries;
            if (entries.length === 0) return;
            const { text } = buildReferenceText(entries);
            const span = inputActions.captureInsertion();
            const ok = inputActions.insertText(`${text}\n\n`, span);
            if (!ok) {
              setNotice({ text: t('insertFailed') });
              return;
            }
            selectionStore.clearEntries();
          }, [inputActions, t]);

          const applyHidden = useCallback(async (rawTurns, route) => {
            if (busy) return;
            setBusy(true);
            try {
              const { ok, body } = await postRoute(route, { sessionId, turns: rawTurns });
              if (!ok) {
                const message = typeof body?.message === 'string' ? body.message : 'unexpected failure';
                setNotice({ text: t(route === HIDE_ROUTE ? 'hideFailed' : 'restoreFailed', { message }) });
                return;
              }
              const current = new Set(hiddenStore.read().bySession[sessionId] ?? []);
              if (route === HIDE_ROUTE) {
                for (const turn of rawTurns) current.add(turn);
              } else {
                for (const turn of rawTurns) current.delete(turn);
              }
              hiddenStore.setTurns(sessionId, [...current].sort((a, b) => a - b));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setNotice({ text: t(route === HIDE_ROUTE ? 'hideFailed' : 'restoreFailed', { message }) });
            } finally {
              setBusy(false);
            }
          }, [busy, sessionId, t]);

          // The outline asks for a confirmation through the store; this slot
          // owns the dialog because only it can reach the composer and routes.
          useEffect(() => {
            restoreActionRef.current = async (turns) => {
              await applyHidden(turns, RESTORE_ROUTE);
            };
            return () => {
              restoreActionRef.current = null;
            };
          }, [applyHidden]);          const confirmIds = selection.confirmIds;
          const selectedTurns = useMemo(() => {
            if (confirmIds === null) return [];
            const all = new Set();
            for (const entry of selection.entries) {
              if (confirmIds.has(entry.id)) all.add(entry.turn);
            }
            return [...all].sort((a, b) => a - b);
          }, [confirmIds, selection.entries]);

          const card =
            selection.entries.length === 0
              ? null
              : h(
                  'div',
                  { className: 'dsh-mdo-refcard-wrap' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-mdo-refcard',
                      'data-open': selection.sidebarOpen ? 'true' : undefined,
                      onClick: () => selectionStore.setSidebarOpen(!selection.sidebarOpen),
                      title: t('openSelection'),
                    },
                    h('span', { className: 'dsh-mdo-refcard-icon' }, h(IconQuote)),
                    h(
                      'span',
                      { className: 'dsh-mdo-refcard-text' },
                      t('selectionBar', { count: selection.entries.length }),
                    ),
                    h(
                      'span',
                      { className: 'dsh-mdo-refcard-count' },
                      String(selection.entries.length),
                    ),
                  ),
                );

          const sidebar = selection.sidebarOpen
            ? h(
                'aside',
                {
                  className: 'dsh-mdo-side',
                  role: 'dialog',
                  'aria-label': t('selectionTitle'),
                },
                h(
                  'div',
                  { className: 'dsh-mdo-side-head' },
                  h('span', { className: 'dsh-mdo-side-title' }, t('selectionTitle')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-mdo-sel-item-remove',
                      title: t('selectionClose'),
                      'aria-label': t('selectionClose'),
                      onClick: () => selectionStore.setSidebarOpen(false),
                    },
                    h(IconClear),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsh-mdo-side-body' },
                  selection.entries.length === 0
                    ? h('div', { className: 'dsh-mdo-empty' }, t('selectionEmpty'))
                    : selection.entries.map((entry) =>
                        h(
                          'div',
                          { key: entry.id, className: 'dsh-mdo-sel-item' },
                          h(
                            'div',
                            { className: 'dsh-mdo-sel-item-head' },
                            h(
                              'span',
                              { className: 'dsh-mdo-sel-item-meta' },
                              entry.prompt
                                ? `#${entry.turn} · ${entry.prompt}`
                                : t('turnLabel', { turn: entry.turn }),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dsh-mdo-sel-item-remove',
                                title: t('clearSelection'),
                                'aria-label': t('clearSelection'),
                                onClick: () => selectionStore.removeEntry(entry.id),
                              },
                              h(IconClear),
                            ),
                          ),
                          h('div', { className: 'dsh-mdo-sel-item-title' }, entry.heading),
                          entry.body
                            ? h('div', { className: 'dsh-mdo-sel-item-body' }, entry.body)
                            : null,
                        ),
                      ),
                ),
                h(
                  'div',
                  { className: 'dsh-mdo-side-foot' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-mdo-btn',
                      onClick: () => selectionStore.clearEntries(),
                    },
                    t('clearSelection'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-mdo-btn',
                      'data-primary': 'true',
                      disabled: selection.entries.length === 0,
                      onClick: insertReference,
                    },
                    t('insertReference'),
                  ),
                ),
              )
            : null;

          const sidebarOverlay = sidebar === null ? null : renderOverlay(sidebar);

          const confirmDialog = confirmIds === null
            ? null
            : renderOverlay(
                h(
                  React.Fragment,
                  null,
                  h('div', {
                    className: 'dsh-mdo-confirm-scrim',
                    onClick: () => selectionStore.cancelHide(),
                  }),
                  h(
                    'div',
                    { className: 'dsh-mdo-confirm', role: 'dialog', 'aria-modal': 'true' },
                    h(
                      'div',
                      { className: 'dsh-mdo-confirm-title' },
                      t('hideTurns', { count: selectedTurns.length }),
                    ),
                    h('p', { className: 'dsh-mdo-confirm-text' }, t('hideTurnsExplain')),
                    h(
                      'div',
                      { className: 'dsh-mdo-confirm-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-mdo-btn',
                          disabled: busy,
                          onClick: () => selectionStore.cancelHide(),
                        },
                        t('hideCancel'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-mdo-btn',
                          'data-danger': 'true',
                          disabled: busy || selectedTurns.length === 0,
                          onClick: async () => {
                            const ids = confirmIds;
                            selectionStore.finishHide(ids);
                            await applyHidden(selectedTurns, HIDE_ROUTE);
                          },
                        },
                        busy ? t('hiding') : t('hideConfirm'),
                      ),
                    ),
                  ),
                ),
              );

          const noticeLine = notice === null
            ? null
            : h(
                'div',
                { className: 'dsh-mdo-hide-bar' },
                h('span', { className: 'dsh-mdo-hide-bar-text' }, notice.text),
              );

          if (card === null && sidebar === null && confirmDialog === null && noticeLine === null) {
            return null;
          }

          return h(
            React.Fragment,
            null,
            card,
            sidebarOverlay,
            confirmDialog,
            noticeLine,
          );
        }

        /**
         * Collapsible list of the turns hidden from the model, with a restore
         * action per turn. It sits under the outline so a hidden turn keeps a
         * visible address instead of vanishing without trace.
         */
        function HiddenTurnsSection(props) {
          const { t, hiddenTurnNums, hiddenOpen, setHiddenOpen, groups, restoringTurns, onRestore } = props;
          if (hiddenTurnNums === undefined || hiddenTurnNums.length === 0) return null;
          const groupByTurn = new Map(groups.map((group) => [group.turn, group]));
          return h(
            'div',
            { className: 'dsh-mdo-hidden' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-mdo-hidden-toggle',
                'aria-expanded': hiddenOpen,
                title: hiddenOpen ? t('hiddenHide') : t('hiddenShow'),
                onClick: () => setHiddenOpen(!hiddenOpen),
              },
              h(IconCaret, { collapsed: !hiddenOpen }),
              h(
                'span',
                { className: 'dsh-mdo-turn-text' },
                t('hiddenTitle', { count: hiddenTurnNums.length }),
              ),
            ),
            hiddenOpen
              ? hiddenTurnNums.map((turn) => {
                  const group = groupByTurn.get(turn);
                  const label = group?.prompt ? `#${turn} · ${group.prompt}` : t('turnLabel', { turn });
                  const restoring = restoringTurns.has(turn);
                  return h(
                    'div',
                    { key: turn, className: 'dsh-mdo-hidden-row' },
                    h('span', { className: 'dsh-mdo-hidden-label', title: label }, label),
                    h('span', { className: 'dsh-mdo-hidden-badge' }, t('hiddenBadge')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-mdo-hidden-restore',
                        disabled: restoring,
                        onClick: () => {
                          void onRestore([turn]);
                        },
                      },
                      restoring ? t('restoring') : t('restoreTurn'),
                    ),
                  );
                })
              : null,
          );
        }

        function OutlineColumnHost(props) {
          const { useOutlineBridge, useSelection, useHiddenTurns, t } = props;
          const bridge = useOutlineBridge((s) => s);
          const selection = useSelection((s) => s);
          const hiddenState = useHiddenTurns((s) => s);
          const anchorRef = useRef(null);
          const listScrollRef = useRef(null);
          const pointerInsideOutlineRef = useRef(false);
          const programmaticUntilRef = useRef(0);
          const flashTimerRef = useRef(null);
          const flashedElRef = useRef(null);
          const jumpRoomRef = useRef(0);
          const jumpCancelRef = useRef(null);
          const jumpReqIdRef = useRef(0);
          const prevRunningRef = useRef(false);

          const [userOpen, setUserOpen] = useState(readStoredOpen);
          const [manualEmptyOpen, setManualEmptyOpen] = useState(false);
          const [width, setWidth] = useState(readStoredWidth);
          const [resizing, setResizing] = useState(false);
          const [activeId, setActiveId] = useState(null);
          const [jumpingId, setJumpingId] = useState(null);
          const [collapsedIds, setCollapsedIds] = useState(() => new Set());
          const [collapsedTurns, setCollapsedTurns] = useState(() => new Set());
          const [searchQuery, setSearchQuery] = useState('');
          const [remoteBodyHits, setRemoteBodyHits] = useState([]);
          const [searchingRemote, setSearchingRemote] = useState(false);
          const [hiddenOpen, setHiddenOpen] = useState(false);
          const [restoringTurns, setRestoringTurns] = useState(() => new Set());
          const [notice, setNotice] = useState(null);
          const searchInputRef = useRef(null);

          const selecting = selection.selecting;
          const selectedIds = useMemo(
            () => new Set(selection.entries.map((it) => it.id)),
            [selection.entries],
          );
          // The projection is authoritative after a hide lands; the local store
          // covers the moment between the request and the projection update.
          const hiddenTurnNums = useMemo(() => {
            const merged = new Set(bridge.hiddenTurns ?? []);
            for (const turn of hiddenState.bySession[bridge.sessionId] ?? []) merged.add(turn);
            return [...merged].sort((a, b) => a - b);
          }, [bridge.hiddenTurns, hiddenState.bySession, bridge.sessionId]);

          // The transcript marks every rendered row with data-chat-turn, so a
          // hidden turn leaves the conversation by rule rather than by wrapping
          // the shipped renderers. The rule is written through the plugin-owned
          // sheet, which outlives this component.
          useEffect(() => {
            publishTranscriptRule(hiddenTurnNums);
          }, [hiddenTurnNums]);

          useEffect(() => {
            if (notice === null) return undefined;
            const timer = setTimeout(() => setNotice(null), 6000);
            return () => clearTimeout(timer);
          }, [notice]);

          useEffect(() => {
            if (!selecting) return;
            const onKey = (e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                selectionStore.setSelecting(false);
              }
            };
            window.addEventListener('keydown', onKey, true);
            return () => window.removeEventListener('keydown', onKey, true);
          }, [selecting]);

          const applyJumpRoom = useCallback((rootEl, px) => {
            const next = Math.max(0, Math.ceil(px));
            jumpRoomRef.current = next;
            if (!rootEl) return;
            if (next <= 0) rootEl.style.removeProperty('--dsh-mdo-jump-room');
            else rootEl.style.setProperty('--dsh-mdo-jump-room', `${next}px`);
          }, []);

          const cancelJumpAnim = useCallback(() => {
            if (jumpCancelRef.current) {
              jumpCancelRef.current();
              jumpCancelRef.current = null;
            }
          }, []);

          // Reset transient per-session collapse/jump/search state when switching sessions
          useEffect(() => {
            cancelJumpAnim();
            const rootEl = findConversationRoot(anchorRef.current);
            applyJumpRoom(rootEl, 0);
            setManualEmptyOpen(false);
            setActiveId(null);
            setJumpingId(null);
            setCollapsedIds(new Set());
            setCollapsedTurns(new Set());
            setSearchQuery('');
            setRemoteBodyHits([]);
            setSearchingRemote(false);
          }, [bridge.sessionId, cancelJumpAnim, applyJumpRoom]);

          // Release temporary bottom jump room when a new turn starts running so tail-follow lands on real content
          useEffect(() => {
            if (bridge.running && !prevRunningRef.current) {
              cancelJumpAnim();
              const rootEl = findConversationRoot(anchorRef.current);
              applyJumpRoom(rootEl, 0);
            }
            prevRunningRef.current = bridge.running;
          }, [bridge.running, cancelJumpAnim, applyJumpRoom]);

          const totalHeadings = useMemo(() => {
            let sum = 0;
            for (const g of bridge.groups) sum += g.items.length;
            return sum;
          }, [bridge.groups]);

          const trimmedQuery = searchQuery.trim();
          const hasAnySearchableContent = totalHeadings > 0 || bridge.allSteps.length > 0 || bridge.hasMore;
          const panelOpen = totalHeadings > 0 ? userOpen : manualEmptyOpen;

          // Debounced Host full-log body search when session has unloaded history or extra turns
          useEffect(() => {
            if (!panelOpen || !bridge.active || !bridge.sessionId || trimmedQuery === '') {
              setRemoteBodyHits([]);
              setSearchingRemote(false);
              return;
            }
            if (!bridge.hasMore) {
              setRemoteBodyHits([]);
              setSearchingRemote(false);
              return;
            }
            const controller = new AbortController();
            setSearchingRemote(true);
            const timer = setTimeout(async () => {
              try {
                const params = new URLSearchParams({
                  sessionId: bridge.sessionId,
                  q: trimmedQuery,
                });
                const resp = await fetch(`${SEARCH_ROUTE}?${params.toString()}`, {
                  headers: { accept: 'application/json' },
                  signal: controller.signal,
                });
                if (!resp.ok) {
                  if (!controller.signal.aborted) {
                    setRemoteBodyHits([]);
                    setSearchingRemote(false);
                  }
                  return;
                }
                const payload = await resp.json();
                if (!controller.signal.aborted) {
                  setRemoteBodyHits(Array.isArray(payload?.hits) ? payload.hits : []);
                  setSearchingRemote(false);
                }
              } catch (_err) {
                if (!controller.signal.aborted) {
                  setRemoteBodyHits([]);
                  setSearchingRemote(false);
                }
              }
            }, 180);
            return () => {
              clearTimeout(timer);
              controller.abort();
            };
          }, [panelOpen, bridge.active, bridge.sessionId, bridge.hasMore, trimmedQuery]);

          // Filtered heading groups (preserving ancestor breadcrumb context)
          const filteredHeadingResult = useMemo(() => {
            if (trimmedQuery === '') return { groups: bridge.groups, matchCount: totalHeadings };
            const lowerQ = trimmedQuery.toLowerCase();
            let matchCount = 0;
            const outGroups = [];
            for (const group of bridge.groups) {
              const directIds = new Set();
              const visibleIds = new Set();
              const byId = new Map(group.items.map((it) => [it.id, it]));
              for (const it of group.items) {
                if (it.text.toLowerCase().includes(lowerQ)) {
                  directIds.add(it.id);
                  visibleIds.add(it.id);
                  matchCount += 1;
                  let pid = it.parentId;
                  while (pid !== null) {
                    visibleIds.add(pid);
                    pid = byId.get(pid)?.parentId ?? null;
                  }
                }
              }
              if (directIds.size > 0) {
                outGroups.push({
                  ...group,
                  directIds,
                  items: group.items.filter((it) => visibleIds.has(it.id)),
                });
              }
            }
            return { groups: outGroups, matchCount };
          }, [bridge.groups, totalHeadings, trimmedQuery]);

          // Merged body hits: live loaded turns + Host unloaded historical turns
          const mergedBodyHits = useMemo(() => {
            if (trimmedQuery === '') return [];
            const liveHits = searchLoadedSteps(bridge.allSteps, trimmedQuery);
            const loadedSet = new Set(bridge.loadedTurnNums);
            const groupMap = new Map(bridge.groups.map((g) => [g.turn, g]));
            const enrichSectionTitle = (hit) => {
              const g = groupMap.get(hit.turn);
              let sectionTitle = '';
              if (g && typeof hit.sectionIndex === 'number' && hit.sectionIndex >= 0) {
                const sec = g.items.find(
                  (it) => it.step === hit.step && it.indexInStep === hit.sectionIndex,
                );
                if (sec) sectionTitle = sec.text;
              }
              return {
                ...hit,
                turnStartSeq: hit.turnStartSeq ?? g?.turnStartSeq,
                prompt: hit.prompt || g?.prompt || '',
                sectionTitle,
              };
            };

            const combined = [];
            for (const rh of remoteBodyHits) {
              if (!loadedSet.has(rh.turn)) {
                combined.push(enrichSectionTitle({ ...rh, loaded: false }));
              }
            }
            for (const lh of liveHits) {
              combined.push(enrichSectionTitle(lh));
            }
            combined.sort((a, b) => a.turn - b.turn || a.step - b.step);
            return combined.slice(0, MAX_LIVE_BODY_HITS);
          }, [trimmedQuery, bridge.allSteps, bridge.loadedTurnNums, bridge.groups, remoteBodyHits]);

          const toggleOpen = useCallback(() => {
            if (totalHeadings > 0) {
              setUserOpen((prev) => {
                const next = !prev;
                writeStoredOpen(next);
                return next;
              });
            } else {
              setManualEmptyOpen((prev) => !prev);
            }
          }, [totalHeadings]);

          // Sync header height and column width CSS custom properties onto Conversation .root
          useEffect(() => {
            const anchor = anchorRef.current;
            if (!anchor || !bridge.active) return;
            const headerEl = anchor.closest('header');
            const rootEl = findConversationRoot(anchor);
            if (!headerEl || !rootEl) return;

            const updateTop = () => {
              rootEl.style.setProperty('--dsh-mdo-top', `${headerEl.offsetHeight}px`);
            };
            updateTop();
            let ro = null;
            if (typeof ResizeObserver !== 'undefined') {
              ro = new ResizeObserver(updateTop);
              ro.observe(headerEl);
            }
            return () => {
              if (ro) ro.disconnect();
              rootEl.style.removeProperty('--dsh-mdo-top');
              rootEl.style.removeProperty('--dsh-mdo-w');
              rootEl.style.removeProperty('--dsh-mdo-jump-room');
              jumpRoomRef.current = 0;
            };
          }, [bridge.active, bridge.sessionId]);

          useEffect(() => {
            const anchor = anchorRef.current;
            if (!anchor || !bridge.active) return;
            const rootEl = findConversationRoot(anchor);
            if (!rootEl) return;
            rootEl.style.setProperty('--dsh-mdo-w', `${width}px`);
          }, [bridge.active, width]);

          // Cleanup flash highlight & jump animation on unmount
          useEffect(() => {
            return () => {
              cancelJumpAnim();
              if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
              if (flashedElRef.current) {
                flashedElRef.current.removeAttribute('data-mdo-flash');
                flashedElRef.current = null;
              }
            };
          }, [cancelJumpAnim]);

          // Scroll-spy + progressive reclamation of temporary bottom jump room
          useEffect(() => {
            if (!bridge.active || totalHeadings === 0) return;
            const anchor = anchorRef.current;
            const rootEl = findConversationRoot(anchor);
            if (!rootEl) return;

            let rafId = null;
            const computeActive = () => {
              rafId = null;
              const scrollRoot = resolveScrollContainer(rootEl, null);
              if (!scrollRoot) return;

              // Reclaim unused bottom jump room when reader scrolls back up or content grows
              if (jumpCancelRef.current === null && jumpRoomRef.current > 0) {
                const naturalHeight = Math.max(
                  scrollRoot.clientHeight,
                  scrollRoot.scrollHeight - jumpRoomRef.current,
                );
                const naturalFloor = Math.max(0, naturalHeight - scrollRoot.clientHeight);
                const stillNeeded =
                  scrollRoot.scrollTop > naturalFloor
                    ? Math.ceil(scrollRoot.scrollTop + 40 - naturalFloor)
                    : 0;
                if (stillNeeded < jumpRoomRef.current) {
                  applyJumpRoom(rootEl, stillNeeded);
                }
              }

              if (Date.now() < programmaticUntilRef.current) return;
              const rootRect = scrollRoot.getBoundingClientRect();
              const threshold = rootRect.top + 88;

              let candidateId = null;
              let firstLoadedId = null;

              for (const group of bridge.groups) {
                if (!group.loaded) continue;
                for (const item of group.items) {
                  if (firstLoadedId === null) firstLoadedId = item.id;
                  const el = findHeadingElement(scrollRoot, item, group);
                  if (!el) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.height === 0 && rect.width === 0) continue;
                  if (rect.top <= threshold) {
                    candidateId = item.id;
                  }
                }
              }

              // If naturally scrolled to the physical floor (without jump room), prefer last visible heading
              const naturalFloor = Math.max(
                0,
                scrollRoot.scrollHeight - jumpRoomRef.current - scrollRoot.clientHeight,
              );
              if (jumpRoomRef.current === 0 && naturalFloor - scrollRoot.scrollTop <= 8) {
                for (let gi = bridge.groups.length - 1; gi >= 0; gi--) {
                  const group = bridge.groups[gi];
                  if (!group.loaded) continue;
                  for (let ii = group.items.length - 1; ii >= 0; ii--) {
                    const item = group.items[ii];
                    const el = findHeadingElement(scrollRoot, item, group);
                    if (!el) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.top >= rootRect.top && rect.bottom <= rootRect.bottom) {
                      candidateId = item.id;
                      break;
                    }
                  }
                  if (candidateId !== null) break;
                }
              }

              const resolved = candidateId ?? firstLoadedId;
              if (resolved !== null) {
                setActiveId((prev) => (prev === resolved ? prev : resolved));
              }
            };

            const schedule = () => {
              if (rafId === null) {
                rafId = requestAnimationFrame(computeActive);
              }
            };

            const scrollRoot = resolveScrollContainer(rootEl, null);
            if (scrollRoot) {
              scrollRoot.addEventListener('scroll', schedule, { passive: true });
            }
            let ro = null;
            const flowEl = rootEl.querySelector('[data-chat-flow]');
            if (typeof ResizeObserver !== 'undefined' && flowEl) {
              ro = new ResizeObserver(schedule);
              ro.observe(flowEl);
            }
            schedule();

            return () => {
              if (rafId !== null) cancelAnimationFrame(rafId);
              if (scrollRoot) scrollRoot.removeEventListener('scroll', schedule);
              if (ro) ro.disconnect();
            };
          }, [bridge.active, bridge.sessionId, bridge.groups, totalHeadings, applyJumpRoom]);

          // Keep the active item visible inside the outline panel when scrolling the conversation
          useEffect(() => {
            if (!panelOpen || !activeId || pointerInsideOutlineRef.current) return;
            const container = listScrollRef.current;
            if (!container) return;
            const escaped =
              typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                ? CSS.escape(activeId)
                : activeId;
            const activeRow = container.querySelector(`[data-outline-id="${escaped}"]`);
            if (activeRow && typeof activeRow.scrollIntoView === 'function') {
              activeRow.scrollIntoView({ block: 'nearest' });
            }
          }, [activeId, panelOpen]);

          const flashTargetElement = useCallback((targetEl) => {
            if (flashedElRef.current) {
              flashedElRef.current.removeAttribute('data-mdo-flash');
            }
            if (flashTimerRef.current !== null) {
              clearTimeout(flashTimerRef.current);
            }
            // Force animation restart if clicking the same heading twice
            void targetEl.offsetWidth;
            targetEl.setAttribute('data-mdo-flash', 'true');
            flashedElRef.current = targetEl;
            flashTimerRef.current = setTimeout(() => {
              if (flashedElRef.current === targetEl) {
                targetEl.removeAttribute('data-mdo-flash');
                flashedElRef.current = null;
              }
              flashTimerRef.current = null;
            }, 1250);
          }, []);

          const jumpToItem = useCallback(
            async (item, group) => {
              const anchor = anchorRef.current;
              const rootEl = findConversationRoot(anchor);
              if (!rootEl) return;

              const reqId = ++jumpReqIdRef.current;
              cancelJumpAnim();
              setActiveId(item.id);
              programmaticUntilRef.current = Date.now() + 650;

              const scrollToElement = (initialScroller, targetEl) => {
                const scrollRoot = resolveScrollContainer(rootEl, targetEl) ?? initialScroller;
                if (!scrollRoot) return;
                const revealed = revealHiddenAncestors(targetEl, scrollRoot);

                const performScroll = () => {
                  // If heading sits inside an inner process group scroller, align it inside that group first
                  const innerBody = targetEl.closest('[data-step-process-body]');
                  if (
                    innerBody &&
                    innerBody !== scrollRoot &&
                    innerBody.scrollHeight > innerBody.clientHeight
                  ) {
                    const ibRect = innerBody.getBoundingClientRect();
                    const tgRect = targetEl.getBoundingClientRect();
                    innerBody.scrollTop = Math.max(
                      0,
                      innerBody.scrollTop + (tgRect.top - ibRect.top) - 12,
                    );
                  }

                  const TOP_INSET = 24;
                  const TAIL_CLEARANCE = 40; // > ChatReading FOLLOW_THRESHOLD (24px) so tail-follow releases cleanly

                  const measureDesiredTop = () => {
                    const sRect = scrollRoot.getBoundingClientRect();
                    const tRect = targetEl.getBoundingClientRect();
                    return Math.max(
                      0,
                      Math.round(scrollRoot.scrollTop + (tRect.top - sRect.top) - TOP_INSET),
                    );
                  };

                  const ensureRoomFor = (desiredTop) => {
                    const naturalHeight = Math.max(
                      scrollRoot.clientHeight,
                      scrollRoot.scrollHeight - jumpRoomRef.current,
                    );
                    const naturalFloor = Math.max(0, naturalHeight - scrollRoot.clientHeight);
                    const requiredFloor = desiredTop > 0 ? desiredTop + TAIL_CLEARANCE : 0;
                    const needed = Math.max(0, Math.ceil(requiredFloor - naturalFloor));
                    if (needed > jumpRoomRef.current) {
                      applyJumpRoom(rootEl, needed);
                    }
                    return { naturalFloor, needed };
                  };

                  // Notify ChatViewport of explicit reader navigation intent so active follow/fold yields
                  scrollRoot.dispatchEvent(new Event('beforematch'));

                  const startTop = scrollRoot.scrollTop;
                  const desiredTop = measureDesiredTop();
                  ensureRoomFor(desiredTop);
                  const delta = desiredTop - startTop;

                  flashTargetElement(targetEl);

                  const reduced =
                    typeof matchMedia === 'function' &&
                    matchMedia('(prefers-reduced-motion: reduce)').matches;

                  if (Math.abs(delta) <= 1) {
                    return;
                  }

                  if (reduced || Math.abs(delta) <= 6) {
                    const { needed } = ensureRoomFor(desiredTop);
                    scrollRoot.scrollTop = desiredTop;
                    applyJumpRoom(rootEl, needed);
                    scrollRoot.dispatchEvent(new Event('scrollend'));
                    return;
                  }

                  // Frame-0 synchronous step >= 2px guarantees ChatViewport.readScroll() attributes
                  // movedByReader = true (> 0.5px) instead of snapping back to tail when followingTail was true.
                  const firstStep =
                    Math.sign(delta) * Math.max(2, Math.round(Math.abs(delta) * 0.1));
                  scrollRoot.scrollTop = startTop + firstStep;

                  const durationMs = 220;
                  const startTime = performance.now();
                  let frameId = null;
                  let cancelled = false;

                  const onUserInterrupt = () => {
                    stopAnim(false);
                  };
                  const interruptEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];

                  function stopAnim(completed) {
                    if (cancelled) return;
                    cancelled = true;
                    if (frameId !== null) {
                      cancelAnimationFrame(frameId);
                      frameId = null;
                    }
                    for (const ev of interruptEvents) {
                      scrollRoot.removeEventListener(ev, onUserInterrupt, true);
                    }
                    if (jumpCancelRef.current === stopAnim) {
                      jumpCancelRef.current = null;
                    }
                    if (completed) {
                      const naturalHeight = Math.max(
                        scrollRoot.clientHeight,
                        scrollRoot.scrollHeight - jumpRoomRef.current,
                      );
                      const naturalFloor = Math.max(0, naturalHeight - scrollRoot.clientHeight);
                      const finalNeeded =
                        scrollRoot.scrollTop > naturalFloor - TAIL_CLEARANCE
                          ? Math.max(
                              0,
                              Math.ceil(scrollRoot.scrollTop + TAIL_CLEARANCE - naturalFloor),
                            )
                          : 0;
                      applyJumpRoom(rootEl, finalNeeded);
                      scrollRoot.dispatchEvent(new Event('scrollend'));
                    }
                  }

                  for (const ev of interruptEvents) {
                    scrollRoot.addEventListener(ev, onUserInterrupt, {
                      capture: true,
                      passive: true,
                    });
                  }
                  jumpCancelRef.current = stopAnim;

                  const tick = (now) => {
                    if (cancelled) return;
                    const tProg = Math.min(1, (now - startTime) / durationMs);
                    const eased = 1 - Math.pow(1 - tProg, 3);
                    const liveDesired = measureDesiredTop();
                    ensureRoomFor(liveDesired);
                    const nextTop =
                      tProg >= 1
                        ? liveDesired
                        : Math.round(startTop + (liveDesired - startTop) * eased);
                    scrollRoot.scrollTop = nextTop;
                    programmaticUntilRef.current = Date.now() + 250;
                    if (tProg >= 1) {
                      stopAnim(true);
                    } else {
                      frameId = requestAnimationFrame(tick);
                    }
                  };

                  frameId = requestAnimationFrame(tick);
                };

                if (revealed) {
                  requestAnimationFrame(() => requestAnimationFrame(performScroll));
                } else {
                  performScroll();
                }
              };

              let scrollRoot = resolveScrollContainer(rootEl, null);
              if (!scrollRoot) return;

              const locateTarget = (scroller) => {
                if (item.isBodyHit) {
                  const g = bridgeState.groups.find((x) => x.turn === item.turn) ?? group;
                  const refreshedStep = bridgeState.allSteps.find(
                    (s) => s.turn === item.turn && s.step === item.step,
                  );
                  const enrichedHit = refreshedStep
                    ? { ...item, nodeKey: item.nodeKey || refreshedStep.nodeKey }
                    : item;
                  return findBodyHitElement(scroller, enrichedHit, g);
                }
                const refreshedGroup =
                  bridgeState.groups.find((g) => g.turn === group.turn) ?? group;
                const refreshedItem =
                  refreshedGroup.items.find((x) => x.id === item.id) ?? item;
                return findHeadingElement(scroller, refreshedItem, refreshedGroup);
              };

              let targetEl = locateTarget(scrollRoot);
              if (targetEl) {
                scrollToElement(scrollRoot, targetEl);
                return;
              }

              // Unloaded older turn: page history back through turnStartSeq first
              const targetSeq = item.isBodyHit ? item.turnStartSeq : group?.turnStartSeq;
              if (
                typeof targetSeq === 'number' &&
                typeof bridge.loadThrough === 'function'
              ) {
                setJumpingId(item.id);
                try {
                  const waitForTarget = async (maxFrames) => {
                    for (let f = 0; f < maxFrames; f++) {
                      if (jumpReqIdRef.current !== reqId) return null;
                      await new Promise((resolve) => requestAnimationFrame(resolve));
                      if (jumpReqIdRef.current !== reqId) return null;
                      scrollRoot = resolveScrollContainer(rootEl, null);
                      if (!scrollRoot) continue;
                      const el = locateTarget(scrollRoot);
                      if (el) return el;
                    }
                    return null;
                  };

                  for (let attempt = 0; attempt < 5 && !targetEl; attempt++) {
                    if (jumpReqIdRef.current !== reqId) return;
                    await bridge.loadThrough(targetSeq);
                    targetEl = await waitForTarget(20);
                  }
                  if (jumpReqIdRef.current === reqId && targetEl && scrollRoot) {
                    programmaticUntilRef.current = Date.now() + 650;
                    scrollToElement(scrollRoot, targetEl);
                  }
                } finally {
                  if (jumpReqIdRef.current === reqId) {
                    setJumpingId((cur) => (cur === item.id ? null : cur));
                  }
                }
              }
            },
            [bridge.loadThrough, cancelJumpAnim, applyJumpRoom, flashTargetElement],
          );

          const toggleItemFold = useCallback((id, event) => {
            event.stopPropagation();
            setCollapsedIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }, []);

          const toggleTurnFold = useCallback((turnNum) => {
            setCollapsedTurns((prev) => {
              const next = new Set(prev);
              if (next.has(turnNum)) next.delete(turnNum);
              else next.add(turnNum);
              return next;
            });
          }, []);

          // Resize drag handlers
          const dragStartRef = useRef({ x: 0, w: DEFAULT_WIDTH });
          const onResizerPointerDown = useCallback(
            (event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragStartRef.current = { x: event.clientX, w: width };
              setResizing(true);
            },
            [width],
          );
          const onResizerPointerMove = useCallback(
            (event) => {
              if (!resizing) return;
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const delta = event.clientX - dragStartRef.current.x;
              const next = Math.max(
                MIN_WIDTH,
                Math.min(MAX_WIDTH, Math.round(dragStartRef.current.w + delta)),
              );
              setWidth(next);
            },
            [resizing],
          );
          const onResizerPointerEnd = useCallback(
            (event) => {
              if (!resizing) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              setResizing(false);
              writeStoredWidth(width);
            },
            [resizing, width],
          );

          if (!bridge.active) return null;

          const showTurnHeaders = bridge.groups.length > 1;

          return h(
            'div',
            {
              ref: anchorRef,
              className: 'dsh-mdo-anchor dsh-mdo-root',
              'data-md-outline-state': panelOpen ? 'open' : 'closed',
              'data-md-outline-resizing': resizing ? 'true' : undefined,
            },
            panelOpen
              ? h(
                  'aside',
                  {
                    className: 'dsh-mdo-panel',
                    'aria-label': t('title'),
                    onPointerEnter: () => {
                      pointerInsideOutlineRef.current = true;
                    },
                    onPointerLeave: () => {
                      pointerInsideOutlineRef.current = false;
                    },
                  },
                  h(
                    'div',
                    { className: 'dsh-mdo-header' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-mdo-collapse-btn',
                        title: t('collapse'),
                        'aria-label': t('collapse'),
                        onClick: toggleOpen,
                      },
                      h(IconDoubleChevronLeft),
                    ),
                    h('span', { className: 'dsh-mdo-header-title' }, t('title')),
                    totalHeadings > 0
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-mdo-select-btn',
                            'data-on': selecting ? 'true' : undefined,
                            title: selecting ? t('selectModeOn') : t('selectMode'),
                            'aria-pressed': selecting,
                            onClick: () => selectionStore.setSelecting(!selecting),
                          },
                          selecting
                            ? t('selectedCount', { count: selection.entries.length })
                            : t('selectMode'),
                        )
                      : null,
                    trimmedQuery !== ''
                      ? h(
                          'span',
                          { className: 'dsh-mdo-count' },
                          String(filteredHeadingResult.matchCount + mergedBodyHits.length),
                        )
                      : totalHeadings > 0
                        ? h('span', { className: 'dsh-mdo-count' }, String(totalHeadings))
                        : null,
                  ),
                  hasAnySearchableContent
                    ? h(
                        'div',
                        { className: 'dsh-mdo-search-wrap' },
                        h(
                          'div',
                          { className: 'dsh-mdo-search-box' },
                          h('span', { className: 'dsh-mdo-search-icon' }, h(IconSearch)),
                          h('input', {
                            ref: searchInputRef,
                            type: 'text',
                            className: 'dsh-mdo-search-input',
                            value: searchQuery,
                            placeholder: t('searchPlaceholder'),
                            'aria-label': t('searchPlaceholder'),
                            onChange: (e) => setSearchQuery(e.target.value),
                            onKeyDown: (e) => {
                              if (e.key === 'Escape' && searchQuery !== '') {
                                e.stopPropagation();
                                setSearchQuery('');
                              } else if (e.key === 'Enter' && trimmedQuery !== '') {
                                e.preventDefault();
                                const firstHeadingGroup = filteredHeadingResult.groups[0];
                                const firstDirect = firstHeadingGroup?.items.find((it) =>
                                  firstHeadingGroup.directIds?.has(it.id),
                                );
                                if (firstDirect) {
                                  void jumpToItem(firstDirect, firstHeadingGroup);
                                } else if (mergedBodyHits.length > 0) {
                                  void jumpToItem({ ...mergedBodyHits[0], isBodyHit: true }, null);
                                }
                              }
                            },
                          }),
                          searchQuery !== ''
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsh-mdo-clear-btn',
                                  title: t('clearSearch'),
                                  'aria-label': t('clearSearch'),
                                  onClick: () => {
                                    setSearchQuery('');
                                    searchInputRef.current?.focus();
                                  },
                                },
                                h(IconClear),
                              )
                            : null,
                        ),
                      )
                    : null,
                  h(
                    'div',
                    { ref: listScrollRef, className: 'dsh-mdo-scroll' },
                    trimmedQuery === ''
                      ? totalHeadings === 0
                        ? h('div', { className: 'dsh-mdo-empty' }, t('empty'))
                        : bridge.groups.map((group) => {
                            const turnCollapsed = collapsedTurns.has(group.turn);
                            // A turn counts as ticked when every one of its headings is
                            // selected; the header checkbox then writes that whole set.
                            const turnChecked =
                              group.items.length > 0 &&
                              group.items.every((it) => selectedIds.has(it.id));
                            const itemMap = new Map(group.items.map((it) => [it.id, it]));
                            const isHiddenByAncestor = (item) => {
                              let pid = item.parentId;
                              while (pid !== null) {
                                if (collapsedIds.has(pid)) return true;
                                pid = itemMap.get(pid)?.parentId ?? null;
                              }
                              return false;
                            };

                            const turnTitle = group.prompt
                              ? `#${group.turn} · ${group.prompt}`
                              : t('turnLabel', { turn: group.turn });

                            return h(
                              'div',
                              { key: group.turn, className: 'dsh-mdo-turn-group' },
                              showTurnHeaders
                                ? h(
                                    'div',
                                    { className: 'dsh-mdo-turn-row' },
                                    selecting
                                      ? h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'dsh-mdo-check',
                                            'data-checked': turnChecked ? 'true' : undefined,
                                            'aria-checked': turnChecked,
                                            role: 'checkbox',
                                            'aria-label': turnTitle,
                                            title: turnTitle,
                                            onClick: () => {
                                              const rows = flattenGroupRows(group);
                                              const next = !turnChecked;
                                              for (const row of rows) {
                                                const entry = buildSectionSelection(
                                                  group,
                                                  row.item,
                                                  bridge.allSteps,
                                                  row.path,
                                                );
                                                const on = selectedIds.has(row.item.id);
                                                if (on !== next) selectionStore.toggleEntry(entry);
                                              }
                                            },
                                          },
                                          turnChecked ? h(IconCheck) : null,
                                        )
                                      : null,
                                    h(
                                      'button',
                                      {
                                        type: 'button',
                                        className: 'dsh-mdo-turn-btn',
                                        title: turnTitle,
                                        'aria-expanded': !turnCollapsed,
                                        onClick: () => toggleTurnFold(group.turn),
                                      },
                                      h(IconCaret, { collapsed: turnCollapsed }),
                                      h('span', { className: 'dsh-mdo-turn-text' }, turnTitle),
                                    ),
                                  )
                                : null,
                              turnCollapsed
                                ? null
                                : group.items.map((item) => {
                                    if (isHiddenByAncestor(item)) return null;
                                    const isActive = item.id === activeId;
                                    const isJumping = item.id === jumpingId;
                                    const isFolded = collapsedIds.has(item.id);
                                    const isChecked = selectedIds.has(item.id);
                                    return h(
                                      'div',
                                      {
                                        key: item.id,
                                        className: 'dsh-mdo-row',
                                        'data-outline-id': item.id,
                                        'data-active': isActive ? 'true' : undefined,
                                        'data-sub': item.level > 0 ? 'true' : undefined,
                                        'data-level': item.level,
                                        'data-jumping': isJumping ? 'true' : undefined,
                                        'data-checked': isChecked ? 'true' : undefined,
                                        style: {
                                          paddingLeft: `${4 + item.level * 14}px`,
                                        },
                                      },
                                      h(
                                        'span',
                                        { className: 'dsh-mdo-check-slot' },
                                        selecting
                                          ? h(
                                              'button',
                                              {
                                                type: 'button',
                                                className: 'dsh-mdo-check',
                                                'data-checked': isChecked ? 'true' : undefined,
                                                'aria-checked': isChecked,
                                                role: 'checkbox',
                                                'aria-label': item.text,
                                                onClick: () => {
                                                  const found = flattenGroupRows(group).find(
                                                    (row) => row.item.id === item.id,
                                                  );
                                                  selectionStore.toggleEntry(
                                                    buildSectionSelection(
                                                      group,
                                                      item,
                                                      bridge.allSteps,
                                                      found?.path ?? [],
                                                    ),
                                                  );
                                                },
                                              },
                                              isChecked ? h(IconCheck) : null,
                                            )
                                          : null,
                                      ),
                                      h(
                                        'span',
                                        { className: 'dsh-mdo-fold-slot' },
                                        item.hasChildren
                                          ? h(
                                              'button',
                                              {
                                                type: 'button',
                                                className: 'dsh-mdo-fold-btn',
                                                title: isFolded
                                                  ? t('unfoldSection')
                                                  : t('foldSection'),
                                                'aria-label': isFolded
                                                  ? t('unfoldSection')
                                                  : t('foldSection'),
                                                'aria-expanded': !isFolded,
                                                onClick: (e) => toggleItemFold(item.id, e),
                                              },
                                              h(IconCaret, { collapsed: isFolded }),
                                            )
                                          : null,
                                      ),
                                      h(
                                        'button',
                                        {
                                          type: 'button',
                                          className: 'dsh-mdo-item-btn',
                                          title: isJumping
                                            ? `${item.text} (${t('loadingTurn')})`
                                            : item.text,
                                          'aria-current': isActive ? 'location' : undefined,
                                          onClick: () => {
                                            // In selection mode a label click toggles the
                                            // checkbox; jumping stays on the plain outline.
                                            if (!selecting) {
                                              void jumpToItem(item, group);
                                              return;
                                            }
                                            const found = flattenGroupRows(group).find(
                                              (row) => row.item.id === item.id,
                                            );
                                            selectionStore.toggleEntry(
                                              buildSectionSelection(
                                                group,
                                                item,
                                                bridge.allSteps,
                                                found?.path ?? [],
                                              ),
                                            );
                                          },
                                        },
                                        item.text,
                                      ),
                                    );
                                  }),
                            );
                          })
                      : filteredHeadingResult.groups.length === 0 &&
                          mergedBodyHits.length === 0 &&
                          !searchingRemote
                        ? h('div', { className: 'dsh-mdo-empty' }, t('noResults'))
                        : h(
                            React.Fragment,
                            null,
                            filteredHeadingResult.groups.length > 0
                              ? h(
                                  'div',
                                  null,
                                  h(
                                    'div',
                                    { className: 'dsh-mdo-section-label' },
                                    t('headingResults', {
                                      count: filteredHeadingResult.matchCount,
                                    }),
                                  ),
                                  filteredHeadingResult.groups.map((group) => {
                                    const turnTitle = group.prompt
                                      ? `#${group.turn} · ${group.prompt}`
                                      : t('turnLabel', { turn: group.turn });
                                    return h(
                                      'div',
                                      { key: group.turn, className: 'dsh-mdo-turn-group' },
                                      showTurnHeaders
                                        ? h(
                                            'div',
                                            {
                                              className: 'dsh-mdo-turn-btn',
                                              style: { cursor: 'default' },
                                              title: turnTitle,
                                            },
                                            h(
                                              'span',
                                              { className: 'dsh-mdo-turn-text' },
                                              turnTitle,
                                            ),
                                          )
                                        : null,
                                      group.items.map((item) => {
                                        const isActive = item.id === activeId;
                                        const isJumping = item.id === jumpingId;
                                        const isDirect = group.directIds?.has(item.id);
                                        return h(
                                          'div',
                                          {
                                            key: item.id,
                                            className: 'dsh-mdo-row',
                                            'data-outline-id': item.id,
                                            'data-active': isActive ? 'true' : undefined,
                                            'data-sub': item.level > 0 ? 'true' : undefined,
                                            'data-ancestor-only': !isDirect ? 'true' : undefined,
                                            'data-jumping': isJumping ? 'true' : undefined,
                                            style: {
                                              paddingLeft: `${8 + item.level * 12}px`,
                                            },
                                          },
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              className: 'dsh-mdo-item-btn',
                                              title: isJumping
                                                ? `${item.text} (${t('loadingTurn')})`
                                                : item.text,
                                              onClick: () => {
                                                void jumpToItem(item, group);
                                              },
                                            },
                                            isDirect
                                              ? renderHighlightedText(item.text, trimmedQuery)
                                              : item.text,
                                          ),
                                        );
                                      }),
                                    );
                                  }),
                                )
                              : null,
                            mergedBodyHits.length > 0 || searchingRemote
                              ? h(
                                  'div',
                                  {
                                    className:
                                      filteredHeadingResult.groups.length > 0
                                        ? 'dsh-mdo-section-divider'
                                        : undefined,
                                  },
                                  h(
                                    'div',
                                    { className: 'dsh-mdo-section-label' },
                                    t('bodyResults', { count: mergedBodyHits.length }),
                                  ),
                                  mergedBodyHits.map((hit) => {
                                    const isActive = hit.id === activeId;
                                    const isJumping = hit.id === jumpingId;
                                    const metaParts = [`#${hit.turn}`];
                                    if (hit.sectionTitle) metaParts.push(hit.sectionTitle);
                                    else if (hit.prompt) metaParts.push(hit.prompt);
                                    const metaText = metaParts.join(' · ');
                                    return h(
                                      'button',
                                      {
                                        key: hit.id,
                                        type: 'button',
                                        className: 'dsh-mdo-hit-btn',
                                        'data-outline-id': hit.id,
                                        'data-active': isActive ? 'true' : undefined,
                                        'data-jumping': isJumping ? 'true' : undefined,
                                        title: isJumping
                                          ? `${hit.snippet} (${t('loadingTurn')})`
                                          : hit.snippet,
                                        onClick: () => {
                                          void jumpToItem({ ...hit, isBodyHit: true }, null);
                                        },
                                      },
                                      h('span', { className: 'dsh-mdo-hit-meta' }, metaText),
                                      h(
                                        'span',
                                        { className: 'dsh-mdo-hit-snippet' },
                                        renderHighlightedText(hit.snippet, trimmedQuery),
                                      ),
                                    );
                                  }),
                                  searchingRemote
                                    ? h(
                                        'div',
                                        { className: 'dsh-mdo-searching-hint' },
                                        t('searchingOlder'),
                                      )
                                    : null,
                                )
                              : null,
                          ),
                  ),
                  h(HiddenTurnsSection, {
                    t,
                    hiddenTurnNums,
                    hiddenOpen,
                    setHiddenOpen,
                    groups: bridge.groups,
                    restoringTurns,
                    onRestore: async (turns) => {
                      const action = restoreActionRef.current;
                      if (action === null) return;
                      setRestoringTurns((prev) => {
                        const next = new Set(prev);
                        for (const turn of turns) next.add(turn);
                        return next;
                      });
                      try {
                        await action(turns);
                      } finally {
                        setRestoringTurns((prev) => {
                          const next = new Set(prev);
                          for (const turn of turns) next.delete(turn);
                          return next;
                        });
                      }
                    },
                  }),
                  notice !== null
                    ? h(
                        'div',
                        { className: 'dsh-mdo-hide-bar' },
                        h('span', { className: 'dsh-mdo-hide-bar-text' }, notice.text),
                      )
                    : null,
                  selecting
                    ? h(
                        'div',
                        { className: 'dsh-mdo-hide-bar' },
                        h(
                          'span',
                          { className: 'dsh-mdo-hide-bar-text' },
                          selection.entries.length === 0
                            ? t('selectMode')
                            : t('selectedCount', { count: selection.entries.length }),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsh-mdo-btn',
                            disabled: selection.entries.length === 0,
                            onClick: () =>
                              selectionStore.requestHide(
                                new Set(selection.entries.map((it) => it.id)),
                              ),
                          },
                          t('hideConfirm'),
                        ),
                      )
                    : null,
                  h('div', {
                    className: 'dsh-mdo-resizer',
                    role: 'separator',
                    'aria-orientation': 'vertical',
                    'aria-label': t('resize'),
                    'data-dragging': resizing ? 'true' : undefined,
                    onPointerDown: onResizerPointerDown,
                    onPointerMove: onResizerPointerMove,
                    onPointerUp: onResizerPointerEnd,
                    onPointerCancel: onResizerPointerEnd,
                    onLostPointerCapture: onResizerPointerEnd,
                  }),
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-mdo-trigger',
                    title: t('expand'),
                    'aria-label': t('expand'),
                    onClick: toggleOpen,
                  },
                  h('span', { className: 'dsh-mdo-trigger-icon-rest' }, h(IconOutlineList)),
                  h(
                    'span',
                    { className: 'dsh-mdo-trigger-icon-hover' },
                    h(IconDoubleChevronRight),
                  ),
                  totalHeadings > 0
                    ? h(
                        'span',
                        { className: 'dsh-mdo-trigger-badge' },
                        String(totalHeadings),
                      )
                    : null,
                ),
          );
        }

        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'md-outline-session-bridge',
              order: 999,
              inject: (sessionId) => ({
                loadThrough: (seq) =>
                  ctx.sessions.binding(sessionId)?.session.loadThrough(seq),
              }),
            },
            SessionOutlineBridge,
          ),
        );

        ctx.slots.inject('conversation.header.leading', () =>
          ctx.slots.register(
            {
              name: 'conversation.header.leading',
              locale: NS,
              inject: () => ({
                hooks: {
                  outlineBridge: bridgeObservable,
                  selection: selectionStore.observable,
                  hiddenTurns: hiddenStore.observable,
                },
              }),
            },
            OutlineColumnHost,
          ),
        );

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'md-outline-reference',
              order: 30,
              locale: NS,
              inject: () => ({
                hooks: {
                  selection: selectionStore.observable,
                  hiddenTurns: hiddenStore.observable,
                },
              }),
            },
            ReferenceDock,
          ),
        );
      },
    };
  },
});

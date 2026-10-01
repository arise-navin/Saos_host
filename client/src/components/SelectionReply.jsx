import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * JOB UI-4 — select a passage in a reply or in your own message, and Reply to
 * it: the passage goes into the composer as a quote, the way Claude's "Reply"
 * and ChatGPT's "Ask" work. Copy is offered beside it.
 *
 * Only selections inside one chat bubble count: a drag across two messages,
 * or into a tool card, is ordinary page selection and shows nothing.
 */
const MAX_QUOTE = 1200;

export default function SelectionReply({ containerRef, onReply }) {
  const [sel, setSel] = useState(null); // { text, top, left, below }

  useEffect(() => {
    const box = containerRef.current;
    if (!box) return undefined;

    const read = () => {
      const s = window.getSelection();
      const text = s && !s.isCollapsed ? s.toString().trim() : '';
      if (!text || !s.rangeCount) { setSel(null); return; }
      const bubble = (n) => (n?.nodeType === 1 ? n : n?.parentElement)?.closest('.msg .bubble');
      const a = bubble(s.anchorNode);
      if (!a || a !== bubble(s.focusNode) || !box.contains(a)) { setSel(null); return; }
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const below = rect.top < 70;
      setSel({
        text: text.slice(0, MAX_QUOTE),
        top: below ? rect.bottom + 8 : rect.top - 8,
        left: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90),
        below,
      });
    };
    // After the browser has settled the selection for this gesture.
    const later = () => setTimeout(read, 0);
    const onSelectionChange = () => { if (window.getSelection()?.isCollapsed) setSel(null); };
    const hide = () => setSel(null);

    box.addEventListener('mouseup', later);
    box.addEventListener('keyup', later);
    box.addEventListener('scroll', hide, { passive: true });
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('resize', hide);
    return () => {
      box.removeEventListener('mouseup', later);
      box.removeEventListener('keyup', later);
      box.removeEventListener('scroll', hide);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('resize', hide);
    };
  }, [containerRef]);

  if (!sel) return null;
  const keep = (e) => e.preventDefault(); // a click on the bar must not clear the selection first
  const reply = () => {
    onReply(sel.text);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(sel.text); } catch { /* the selection is still there to copy by hand */ }
    setSel(null);
  };
  return createPortal(
    <div
      className={`sel-pop${sel.below ? ' is-below' : ''}`}
      style={{ top: sel.top, left: sel.left }}
      role="toolbar"
      aria-label="Selected text"
    >
      <button type="button" onMouseDown={keep} onClick={reply}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
        Reply
      </button>
      <span className="sel-pop-sep" aria-hidden="true" />
      <button type="button" onMouseDown={keep} onClick={copy}>Copy</button>
    </div>,
    document.body,
  );
}

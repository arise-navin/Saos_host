import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * JOB UI-5 — editing one of your messages in place, as in ChatGPT and Claude.
 *
 * Enter sends, Shift+Enter is a new line, Escape cancels. A Reply quote the
 * message carried is shown above the text and travels with it unchanged.
 */
export default function MessageEditor({ initial, quote, busy, onCancel, onSubmit }) {
  const [draft, setDraft] = useState(initial || '');
  const ref = useRef(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  // Grow with the text, up to a limit, then scroll.
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 320)}px`;
  }, [draft]);

  const submit = () => { if (draft.trim() && !busy) onSubmit(draft); };

  return (
    <div className="msg-editor">
      {quote && <div className="msg-quote">{quote}</div>}
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) { e.preventDefault(); submit(); }
        }}
        aria-label="Edit your message"
        disabled={busy}
      />
      <div className="msg-editor-actions">
        <button type="button" className="btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn sm" onClick={submit} disabled={!draft.trim() || busy}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  );
}

import { useState } from 'react';

const ICON = {
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>,
  done: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>,
  edit: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
};

/** Copy `text` to the clipboard, saying "Copied" for a moment. */
function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused — the text stays selectable */ }
  };
  return (
    <button type="button" className="reply-action" onClick={copy} aria-label={copied ? 'Copied' : label}>
      {copied ? ICON.done : ICON.copy}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/**
 * JOB UI-3 / UI-5 — the row under a finished reply: Copy (the reply as the
 * agent wrote it, its markdown, so a table pastes as a table). The time sits in
 * the reply card itself.
 */
export default function ReplyActions({ text }) {
  return (
    <div className="reply-actions">
      <CopyButton text={text} label="Copy reply" />
    </div>
  );
}

/**
 * JOB UI-5 — the row under your own message: Copy, and Edit. Edit is offered
 * only when the message can be rewound to (`canEdit`); `editHint` says why not.
 */
export function UserActions({ text, onEdit, canEdit, editHint }) {
  return (
    <div className="user-actions">
      <CopyButton text={text} label="Copy message" />
      <button type="button" className="reply-action" onClick={onEdit} disabled={!canEdit} title={canEdit ? 'Edit and resend' : editHint} aria-label="Edit message">
        {ICON.edit}
        <span>Edit</span>
      </button>
    </div>
  );
}

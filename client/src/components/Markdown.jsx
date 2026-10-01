import { memo, useState, Children, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import { REMARK_PLUGINS, MD_COMPONENTS } from './markdownConfig.js';

/**
 * D-1 — agent prose, rendered.
 *
 * The defect this removes was visible on every interesting turn: the model
 * writes GitHub-flavoured markdown, and the bubble printed it verbatim, so a
 * comparison table arrived as a wall of ASCII pipes and `**Vendor issue: **`
 * kept its asterisks. On a page whose whole claim is "you can read what the
 * agent did", that is not cosmetic.
 *
 * The plugin list and the element overrides live in ./markdownConfig.js; what
 * is left here is the wrapper the styles hang off and the code block. Paragraphs
 * keep `white-space: pre-wrap` (see styles.css): markdown folds single newlines,
 * which would silently reflow the model's line-broken output.
 */

/**
 * JOB UI-3 — a fenced block with its language and a Copy button, the way a
 * chat assistant shows code. The text copied is the block's own source, not
 * whatever the browser selection happens to hold.
 */
function CodeBlock({ node, children, ...rest }) { // eslint-disable-line no-unused-vars
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement);
  const lang = /language-([\w+#-]+)/.exec(code?.props?.className || '')?.[1] || '';
  const source = String(code?.props?.children ?? '').replace(/\n$/, '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard refused — the text stays selectable */ }
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'code'}</span>
        <button type="button" className="md-code-copy" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const COMPONENTS = { ...MD_COMPONENTS, pre: CodeBlock };

/*
 * JOB UI-3 — memoised on the text. A streamed reply re-renders the transcript
 * every 50 ms; without this every earlier message was parsed again each time,
 * which is what made long chats sluggish while an answer arrived.
 */
function Markdown({ text }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text || ''}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);

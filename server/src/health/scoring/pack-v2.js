import { scoreCatalogueControls } from './itsm-v2.js';

/**
 * A WORKBOOK PACK'S QUALITY SCORE on the promoted model (D-016), for any pack on the
 * shared engine (ITOM Phase 5, Platform Phase 6): the ITSM arithmetic
 * (scoreCatalogueControls) over the pack's profile dimensions. Rules that could not
 * be judged are coverage gaps, never health; equivalent rules are counted in the
 * module that evaluates them; correlation, trend and context rules are not scored.
 */

/**
 * The threshold a rate rule is graded against, from its configuration: an
 * aggregate `threshold { op, value: { $param } }`, or a comparator's
 * `args.threshold` (a bad share — `gt`). `as: 'complement'` marks a threshold the
 * workbook states as the good share.
 */
export function packThresholdOf(entry) {
  if (!entry) return null;
  const c = entry.config || {};
  const t = entry.engine === 'aggregate' ? c.threshold : null;
  if (t?.value?.$param) return { op: t.op, key: t.value.$param, complement: t.value.as === 'complement' };
  const a = entry.engine === 'configuration' ? c.compare?.args?.threshold : null;
  if (a?.$param) return { op: 'gt', key: a.$param, complement: a.as === 'complement' };
  return null;
}

/* `policy`: ITOM passes CONTROL_POLICY (itsm-v2.js); every other pack leaves it null and scores exactly as before. */
export function scorePackV2({ model, text, rows = [], overlay, configs, dimensions, config, coverage = null, policy = null }) {
  return scoreCatalogueControls({
    rows, overlay, dimensions, config, coverage, model, text, policy,
    threshold: (id) => packThresholdOf(configs?.get?.(id)),
    exclude: (row) => row.status === 'equivalent',
  });
}

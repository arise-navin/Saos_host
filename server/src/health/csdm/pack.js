import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sheet from '../rules/workbook/sheets/csdm.json' with { type: 'json' };
import architecture from '../rules/csdm/architecture-map.json' with { type: 'json' };
import equivalents from '../rules/csdm/equivalents.json' with { type: 'json' };
import parametersDoc from '../rules/csdm/parameters.json' with { type: 'json' };
import recordPredicate from './rules/record_predicate.json' with { type: 'json' };
import aggregate from './rules/aggregate.json' with { type: 'json' };
import auditHistory from './rules/audit_history.json' with { type: 'json' };
import configuration from './rules/configuration.json' with { type: 'json' };
import referenceIntegrity from './rules/reference_integrity.json' with { type: 'json' };
import linkage from './rules/linkage.json' with { type: 'json' };
import relationshipGraph from './rules/relationship_graph.json' with { type: 'json' };
import temporalCorrelation from './rules/temporal_correlation.json' with { type: 'json' };
import textAnalysis from './rules/text_analysis.json' with { type: 'json' };
import { createWorkbookPack } from '../itsm/workbook-pack.js';

/**
 * HEALTH ASSIST PHASE 9 — the CSDM pack: the CSDM sheet's 80 rules (transcribed from the
 * product owner's CSDM KPI Articulation, supplements/csdm-kpi-articulation.md) on the
 * shared rule engine, built from the decision table (scripts/lib/csdm-decisions.mjs →
 * scripts/build-workbook-pack.mjs --pack csdm). The catalogue's gates (CSDM-032 lifecycle,
 * CSDM-050 environment, CSDM-062 offerings) are encoded as `gated_by` in the rules.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CSDM = createWorkbookPack({
  key: 'csdm', prefix: 'CSDM', count: 80, domain: 'CSDM_MODEL', agent: 'csdm_model_agent',
  sheet, architecture, equivalents, parametersDoc,
  ruleFiles: [recordPredicate, aggregate, auditHistory, configuration, referenceIntegrity, linkage, relationshipGraph, temporalCorrelation, textAnalysis],
  sourceDir: HERE,
});

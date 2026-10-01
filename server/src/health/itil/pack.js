import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sheet from '../rules/workbook/sheets/itil.json' with { type: 'json' };
import architecture from '../rules/itil/architecture-map.json' with { type: 'json' };
import equivalents from '../rules/itil/equivalents.json' with { type: 'json' };
import parametersDoc from '../rules/itil/parameters.json' with { type: 'json' };
import recordPredicate from './rules/record_predicate.json' with { type: 'json' };
import aggregate from './rules/aggregate.json' with { type: 'json' };
import auditHistory from './rules/audit_history.json' with { type: 'json' };
import configuration from './rules/configuration.json' with { type: 'json' };
import referenceIntegrity from './rules/reference_integrity.json' with { type: 'json' };
import linkage from './rules/linkage.json' with { type: 'json' };
import relationshipGraph from './rules/relationship_graph.json' with { type: 'json' };
import temporalCorrelation from './rules/temporal_correlation.json' with { type: 'json' };
import textAnalysis from './rules/text_analysis.json' with { type: 'json' };
import composite from './rules/composite.json' with { type: 'json' };
import { createWorkbookPack } from '../itsm/workbook-pack.js';

/**
 * HEALTH ASSIST PHASE 10 — the ITIL pack: the ITIL sheet's 148 practice rules (supplied as
 * ITIL.xlsx, added to the master workbook — supplements/itil-rules.json) on the shared rule
 * engine, built from the decision table (scripts/lib/itil-decisions.mjs →
 * scripts/build-workbook-pack.mjs --pack itil). Rules that restate a rule another module
 * already evaluates are equivalents, counted once where they are built (D-034).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ITIL = createWorkbookPack({
  key: 'itil', prefix: 'ITIL', count: 148, domain: 'ITIL_PRACTICE', agent: 'itil_practice_agent',
  sheet, architecture, equivalents, parametersDoc,
  ruleFiles: [recordPredicate, aggregate, auditHistory, configuration, referenceIntegrity, linkage, relationshipGraph, temporalCorrelation, textAnalysis, composite],
  sourceDir: HERE,
});

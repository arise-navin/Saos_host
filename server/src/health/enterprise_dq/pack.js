import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dataQuality from '../rules/workbook/sheets/data-quality.json' with { type: 'json' };
import architecture from '../rules/enterprise_dq/architecture-map.json' with { type: 'json' };
import equivalents from '../rules/enterprise_dq/equivalents.json' with { type: 'json' };
import parametersDoc from '../rules/enterprise_dq/parameters.json' with { type: 'json' };
import recordPredicate from './rules/record_predicate.json' with { type: 'json' };
import configuration from './rules/configuration.json' with { type: 'json' };
import referenceIntegrity from './rules/reference_integrity.json' with { type: 'json' };
import linkage from './rules/linkage.json' with { type: 'json' };
import relationshipGraph from './rules/relationship_graph.json' with { type: 'json' };
import temporalCorrelation from './rules/temporal_correlation.json' with { type: 'json' };
import textAnalysis from './rules/text_analysis.json' with { type: 'json' };
import { createWorkbookPack } from '../itsm/workbook-pack.js';

/**
 * HEALTH ASSIST PHASE 7 — the Enterprise Data Quality pack: DQ-084 … DQ-139, the
 * data-quality sheet's "Enterprise Data Quality" model, on the shared rule engine,
 * built from the decision table (scripts/lib/enterprise_dq-decisions.mjs →
 * scripts/build-workbook-pack.mjs --pack enterprise_dq). DQ-001 … DQ-083 (the
 * sheet's "CMDB Quality" model) restate CMDB rules and are scored in CMDB.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = 'Enterprise Data Quality';
const rules = dataQuality.rules.filter((r) => r.model === MODEL);
const sheet = { ...dataQuality, rules, rule_count: rules.length, groups_observed: (dataQuality.groups_observed || []).filter((g) => g.model === MODEL) };

export const ENTERPRISE_DQ = createWorkbookPack({
  key: 'enterprise_dq', prefix: 'DQ', count: 56, first: 84, domain: 'ENTERPRISE_DQ', agent: 'enterprise_dq_agent',
  sheet, architecture, equivalents, parametersDoc,
  ruleFiles: [recordPredicate, configuration, referenceIntegrity, linkage, relationshipGraph, temporalCorrelation, textAnalysis],
  sourceDir: HERE,
});

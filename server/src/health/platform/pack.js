import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sheet from '../rules/workbook/sheets/platform.json' with { type: 'json' };
import architecture from '../rules/platform/architecture-map.json' with { type: 'json' };
import equivalents from '../rules/platform/equivalents.json' with { type: 'json' };
import parametersDoc from '../rules/platform/parameters.json' with { type: 'json' };
import recordPredicate from './rules/record_predicate.json' with { type: 'json' };
import aggregate from './rules/aggregate.json' with { type: 'json' };
import configuration from './rules/configuration.json' with { type: 'json' };
import referenceIntegrity from './rules/reference_integrity.json' with { type: 'json' };
import linkage from './rules/linkage.json' with { type: 'json' };
import relationshipGraph from './rules/relationship_graph.json' with { type: 'json' };
import temporalCorrelation from './rules/temporal_correlation.json' with { type: 'json' };
import textAnalysis from './rules/text_analysis.json' with { type: 'json' };
import composite from './rules/composite.json' with { type: 'json' };
import { createWorkbookPack } from '../itsm/workbook-pack.js';

/**
 * HEALTH ASSIST PHASE 6 — the Platform catalogue pack: the workbook's 183 Platform
 * rules on the shared rule engine, built from the decision table
 * (scripts/lib/platform-decisions.mjs → scripts/build-workbook-pack.mjs --pack platform).
 * The script and design rules judge customer-authored records only (D-024).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PLATFORM = createWorkbookPack({
  key: 'platform', prefix: 'PLT', count: 183, domain: 'PLATFORM', agent: 'platform_agent',
  sheet, architecture, equivalents, parametersDoc,
  ruleFiles: [recordPredicate, aggregate, configuration, referenceIntegrity, linkage, relationshipGraph, temporalCorrelation, textAnalysis, composite],
  sourceDir: HERE,
});

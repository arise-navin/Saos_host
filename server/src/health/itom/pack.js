import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sheet from '../rules/workbook/sheets/itom.json' with { type: 'json' };
import architecture from '../rules/itom/architecture-map.json' with { type: 'json' };
import equivalents from '../rules/itom/equivalents.json' with { type: 'json' };
import parametersDoc from '../rules/itom/parameters.json' with { type: 'json' };
import recordPredicate from './rules/record_predicate.json' with { type: 'json' };
import aggregate from './rules/aggregate.json' with { type: 'json' };
import configuration from './rules/configuration.json' with { type: 'json' };
import referenceIntegrity from './rules/reference_integrity.json' with { type: 'json' };
import linkage from './rules/linkage.json' with { type: 'json' };
import relationshipGraph from './rules/relationship_graph.json' with { type: 'json' };
import temporalCorrelation from './rules/temporal_correlation.json' with { type: 'json' };
import composite from './rules/composite.json' with { type: 'json' };
import { createWorkbookPack } from '../itsm/workbook-pack.js';

/**
 * HEALTH ASSIST PHASE 5 (on the Phase 6 factory) — the ITOM catalogue pack: the
 * workbook's 156 ITOM rules, their architecture map, parameters, rule files and
 * equivalents. The modules beside this one (catalogue, parameters, rules/index,
 * integration, engine-key) keep their exported names and read from here.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ITOM = createWorkbookPack({
  key: 'itom', prefix: 'ITOM', count: 156, domain: 'ITOM', agent: 'itom_agent',
  sheet, architecture, equivalents, parametersDoc,
  ruleFiles: [recordPredicate, aggregate, configuration, referenceIntegrity, linkage, relationshipGraph, temporalCorrelation, composite],
  sourceDir: HERE,
});

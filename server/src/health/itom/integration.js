import { ITOM } from './pack.js';

/**
 * HEALTH ASSIST PHASE 5 — the ITOM catalogue's results as the Health Checker
 * receives them: the ITSM normalisation over the ITOM pack (156 rows), findings
 * traced under `itom`. ITOM-001 / ITOM-002 are rows of their own carrying their
 * CMDB owner's outcome (D-019, D-023), with no finding or skip, never scored in ITOM.
 */
export const normalizeITOMRun = ITOM.normalize;
export const attachEquivalentOutcomes = ITOM.attachEquivalentOutcomes;
export const buildItomParameterRegistry = ITOM.buildParameterRegistry;

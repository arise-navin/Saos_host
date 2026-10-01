import { ITOM } from './pack.js';

/**
 * HEALTH ASSIST PHASE 5 — the ITOM parameter declarations in the shared
 * ParameterRegistry: the workbook's default where it gives one, UNDEFINED where it
 * leaves the value to the customer (DECISION 3). Precedence as ITSM's: workbook →
 * instance → runtime.
 */
export const newItomParameterRegistry = ITOM.newParameterRegistry;
export const ITOM_PARAMETERS = ITOM.parameters;

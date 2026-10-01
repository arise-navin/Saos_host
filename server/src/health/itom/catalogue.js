import { ITOM } from './pack.js';

/**
 * HEALTH ASSIST PHASE 5 — the ITOM catalogue pack's rule view: the 156 rules of the
 * workbook's ITOM sheet (pinned to its sha256) joined slot for slot to the
 * architecture map, validated on load (itsm/workbook-catalogue.js). Built by the
 * Phase 6 pack factory (itom/pack.js); these names are the pack's public face.
 */
export const ITOM_RULE_COUNT = 156;
export const ITOM_CATALOGUE = ITOM.catalogue;
export const getITOMRule = ITOM.get;
export const hasITOMRule = ITOM.has;
export const getAllITOMRules = ITOM.all;
export const getITOMCatalogueMeta = () => ITOM.meta;
export const adaptITOMRule = ITOM.adapt;
/** Rules evaluated by another module's rule — the same condition, counted once (D-019, D-023). */
export const ITOM_EQUIVALENTS = ITOM.equivalents;
export const ITOM_PACK = ITOM.pack;

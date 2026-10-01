import { ITOM } from './itom/pack.js';
import { PLATFORM } from './platform/pack.js';
import { ENTERPRISE_DQ } from './enterprise_dq/pack.js';
import { CSDM } from './csdm/pack.js';
import { ITIL } from './itil/pack.js';
import { scoreItomV2 } from './scoring/itom-v2.js';
import { scorePlatformV2 } from './scoring/platform-v2.js';
import { scoreEnterpriseDqV2 } from './scoring/enterprise-dq-v2.js';
import { scoreCsdmV2 } from './scoring/csdm-v2.js';
import { scoreItilV2 } from './scoring/itil-v2.js';

/**
 * HEALTH ASSIST — the workbook catalogue packs a scan runs on the shared rule engine
 * (Phase 5: ITOM; Phase 6: Platform; Phase 7: Enterprise Data Quality; Phase 9: CSDM). One entry per scanned module: its pack, the
 * promoted model that scores it, and the progress label. index.js, incremental.js
 * and the parameter registry iterate this list — a new pack is one entry here.
 */
export const SCAN_PACKS = Object.freeze([
  Object.freeze({ module: 'itom', pack: ITOM, score: scoreItomV2, progress: ['checking ITOM rules', 67] }),
  Object.freeze({ module: 'platform', pack: PLATFORM, score: scorePlatformV2, progress: ['checking Platform rules', 68] }),
  Object.freeze({ module: 'enterprise_dq', pack: ENTERPRISE_DQ, score: scoreEnterpriseDqV2, progress: ['checking Enterprise Data Quality rules', 69] }),
  Object.freeze({ module: 'csdm', pack: CSDM, score: scoreCsdmV2, progress: ['checking CSDM rules', 69] }),
  /* Phase 10: the ITIL practice catalogue. */
  Object.freeze({ module: 'itil', pack: ITIL, score: scoreItilV2, progress: ['checking ITIL rules', 69] }),
]);

export const packFor = (module) => SCAN_PACKS.find((p) => p.module === module) ?? null;

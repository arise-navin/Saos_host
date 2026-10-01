import { Router } from 'express';
import { licence } from '../licence/licence.js';
import { licencePageHtml } from '../licence/page.js';

/*
 * THE LICENCE (installed desktop app) — licence/licence.js decides.
 *
 *   GET  /api/licence   its state: active / expired / none / invalid / wrong-machine,
 *                       who it is for, when it ends, this computer's ID
 *   POST /api/licence   { key } — check a pasted key and keep it if it works here
 *   GET  /licence       the page to do that from (reachable while locked)
 */
export function createLicenceRouter({ store = licence } = {}) {
  const router = Router();
  router.get('/', (_req, res) => res.json(store.status()));
  router.post('/', (req, res) => {
    const result = store.activate(req.body?.key);
    if (!result.ok) return res.status(400).json({ message: result.message });
    return res.json(result.status);
  });
  return router;
}

export const licenceRouter = createLicenceRouter();

export function licencePage(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(licencePageHtml());
}

import { Router } from 'express';
import {
  setupStatus, saveProfileName, completeSetup, resetSetup, workspaceChecks, cleanName, NAME_MAX,
} from '../config/onboarding.js';
import { resolveSdkEntry } from '../servicenow/fluent.js';
import { getDb } from '../memory/db.js';

/*
 * SETUP — the first-run wizard's API. Configuration itself still goes through
 * the routes that already own it (/system/settings, /system/connection/test,
 * /agent/model/test); this only records who the install is for and whether
 * setup is owed on this machine.
 */
export const onboardingRouter = Router();

onboardingRouter.get('/', (_req, res) => res.json(setupStatus()));

onboardingRouter.get('/checks', async (req, res, next) => {
  try {
    const clientVersion = typeof req.query.client === 'string' ? req.query.client.slice(0, 32) : null;
    res.json(await workspaceChecks({ clientVersion, sdkEntry: resolveSdkEntry, db: getDb }));
  } catch (err) { next(err); }
});

onboardingRouter.post('/profile', (req, res) => {
  const name = cleanName(req.body?.name);
  if (name === null) return res.status(400).json({ message: `The name must be text of at most ${NAME_MAX} characters.` });
  saveProfileName(name);
  return res.json(setupStatus());
});

onboardingRouter.post('/complete', (req, res) => {
  const name = req.body?.name === undefined ? undefined : cleanName(req.body.name);
  if (name === null) return res.status(400).json({ message: `The name must be text of at most ${NAME_MAX} characters.` });
  return res.json(completeSetup({ name }));
});

onboardingRouter.post('/reset', (_req, res) => res.json(resetSetup()));

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/*
 * THE BUILT INTERFACE, served by the API itself.
 *
 * For the installed desktop app, where there is no Vite dev server to proxy
 * through: the window opens this server's own origin, so /api stays relative
 * and same-origin exactly as it is under Vite. Run from the repository,
 * SAOS_CLIENT_DIR is unset and none of this is mounted.
 *
 * Hashed assets are cached; index.html is not, so an upgraded install never
 * serves a page that points at the previous build's assets.
 */
export function clientApp(dir) {
  const root = path.resolve(dir);
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`SAOS_CLIENT_DIR has no index.html: ${root}`);
  const router = express.Router();
  router.use(express.static(root, {
    index: false,
    maxAge: '7d',
    setHeaders(res, file) {
      if (path.basename(file) === 'index.html') res.setHeader('Cache-Control', 'no-store');
    },
  }));
  /* The React router owns every other GET path (/health, /agent …). An unknown
     /api path is still the API's 404, never the page. */
  router.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(index);
  });
  return router;
}

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { Store } from './store.mjs';
import { services } from './services.mjs';
import { authentication } from './auth.mjs';
import { HttpError, Launcher } from './launcher.mjs';

export async function body(req) {
  let length = 0; const chunks = [];
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON is required');
  for await (const chunk of req) { length += chunk.length; if (length > 8192) throw new HttpError(413, 'Request too large'); chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(); return result; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function createApp(config, store, launcher, auth) {
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/identity-cli.mjs': ['workstations/scripts/identity.mjs', 'text/javascript; charset=utf-8'] };
  const rates = new Map();
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, config.appURL); const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') return reply(200, { ready: true });
      const address = req.socket.remoteAddress || 'unknown'; const rate = rates.get(address);
      if (rate && rate.until > Date.now() && rate.count >= 300) throw new HttpError(429, 'Too many requests');
      if (!rate || rate.until <= Date.now()) rates.set(address, { until: Date.now() + 60_000, count: 1 }); else rate.count++;
      if (rates.size > 10000) for (const [key, value] of rates) if (value.until <= Date.now()) rates.delete(key);
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path]; res.setHeader('Content-Type', type);
        if (path === '/identity-cli.mjs') res.setHeader('Content-Disposition', 'attachment; filename="identity.mjs"');
        res.end(await readFile(new URL(`../${file}`, import.meta.url))); return;
      }
      if (req.method === 'GET' && path === '/auth/login') return await auth.login(req, res);
      if (req.method === 'GET' && path === '/auth/callback') return await auth.callback(req, res);
      const bootstrap = /^\/api\/bootstrap\/([a-f0-9-]{36})\/(challenge|verify|ready)$/.exec(path);
      if (req.method === 'POST' && bootstrap) {
        const token = req.headers.authorization?.replace(/^Bearer /, ''); const input = await body(req);
        if (bootstrap[2] === 'ready') return reply(200, await launcher.ready(bootstrap[1], token));
        if (bootstrap[2] === 'challenge') return reply(200, await launcher.challenge(bootstrap[1], token, input.publicJwk));
        return reply(200, await launcher.verify(bootstrap[1], token, input));
      }
      const { data: session } = auth.session(req);
      if (req.method === 'GET' && path === '/api/session') {
        if (!session?.subject) return reply(200, { authenticated: false });
        launcher.authorized(session.subject);
        return reply(200, { authenticated: true, name: session.name, csrf: session.csrf, launches: store.list(session.subject).map(row => launcher.view(row)) });
      }
      if (!session?.subject) throw new HttpError(401, 'Sign in to Identity to launch a workspace');
      launcher.authorized(session.subject);
      if (req.method === 'POST') auth.csrf(req, session);
      if (req.method === 'POST' && path === '/auth/logout') return auth.logout(req, res);
      if (req.method === 'POST' && path === '/api/launch') return reply(202, await launcher.launch(session.subject, (await body(req)).requestId));
      const launch = /^\/api\/launch\/([a-f0-9-]{36})$/.exec(path);
      if (req.method === 'GET' && launch) return reply(200, await launcher.status(session.subject, launch[1]));
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.message });
      console.error(`Request ${req.method} ${new URL(req.url, config.appURL).pathname}: ${error.name}`);
      reply(502, { error: 'A backend service is unavailable. Please retry or contact the administrator.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const config = readConfig(); const store = new Store(config.database);
  const api = services(config); const launcher = new Launcher(config, store, api); const auth = await authentication(config, store);
  const server = createApp(config, store, launcher, auth);
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  const cleanup = setInterval(() => store.cleanup(), 60_000); cleanup.unref();
  server.listen(config.port, '0.0.0.0', () => console.log(`Identity workspace launcher listening on ${config.port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => { store.close(); process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); });
}

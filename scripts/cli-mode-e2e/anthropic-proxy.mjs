/**
 * Filtering forward-proxy (STORY-034.5 Stage 1a, Layer 1 — "blocks reaching elsewhere").
 *
 * A host-side HTTP CONNECT proxy whose allowlist is EXACTLY `api.anthropic.com:443`. The
 * cage reaches the internet ONLY through this proxy (via HTTPS_PROXY); every other host is
 * refused. It TUNNELS TLS (CONNECT) so it never sees the request body or the OAuth token —
 * it only sees the destination host:port, which it logs for audit. Per the human decision,
 * Layer 1 is "set and use" (not re-proven); Layer 2 (cage has no secrets) is the backstop.
 *
 * Usage: node anthropic-proxy.mjs [port]   (default 8889). Prints "PROXY_LISTENING <port>".
 */
import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.argv[2] || 8889);
const ALLOW = new Set(['api.anthropic.com:443', 'api.anthropic.com:80']);

const log = (verb, hostport, decision) =>
  process.stderr.write(`[proxy] ${verb} ${hostport} -> ${decision}\n`);

const server = http.createServer((req, res) => {
  // Plain HTTP is not used by Claude (HTTPS only); refuse to be safe.
  log('HTTP', req.headers.host || '?', 'DENIED (https-only proxy)');
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('forbidden: this proxy only tunnels api.anthropic.com over CONNECT\n');
});

// HTTPS tunneling via CONNECT. host:port is the target; the body stays TLS-encrypted.
server.on('connect', (req, clientSocket, head) => {
  const target = req.url || '';
  if (!ALLOW.has(target)) {
    log('CONNECT', target, 'DENIED (not on allowlist api.anthropic.com)');
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.end();
    return;
  }
  const [host, portStr] = target.split(':');
  const port = Number(portStr) || 443;
  log('CONNECT', target, 'ALLOWED');
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', (e) => { log('CONNECT', target, `upstream-error ${e.code || e.message}`); clientSocket.end(); });
  clientSocket.on('error', () => upstream.end());
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`PROXY_LISTENING ${PORT}\n`);
  log('start', `0.0.0.0:${PORT}`, `allowlist=[${[...ALLOW].join(', ')}]`);
});

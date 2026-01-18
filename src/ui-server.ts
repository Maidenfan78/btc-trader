/**
 * Lightweight UI server for the trading dashboard.
 *
 * Serves static UI assets and proxies API requests to the dashboard API.
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

const uiPort = Number(process.env.UI_PORT || 5173);
const apiBase = process.env.DASHBOARD_API_URL || '';
const rootDir = process.cwd();
const uiDir = path.join(rootDir, 'ui');

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(res: http.ServerResponse, status: number, body: string, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function sendFile(res: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    send(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath);
  const type = mimeTypes[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': type });
  res.end(data);
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const targetBase = apiBase || `http://${req.headers.host?.split(':')[0]}:3001`;
  const targetUrl = new URL(req.url || '/', targetBase);
  const isHttps = targetUrl.protocol === 'https:';
  const client = isHttps ? https : http;

  const proxyReq = client.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers: {
        ...req.headers,
        host: targetUrl.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    send(res, 502, `Proxy error: ${error.message}`);
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    send(res, 400, 'Bad request');
    return;
  }

  if (req.url.startsWith('/api/')) {
    proxyRequest(req, res);
    return;
  }

  if (req.url === '/config.js') {
    const config = {
      apiBase,
    };
    send(res, 200, `window.__DASHBOARD_CONFIG__ = ${JSON.stringify(config)};`, 'text/javascript');
    return;
  }

  const cleanPath = req.url.split('?')[0];
  if (cleanPath === '/' || cleanPath === '') {
    sendFile(res, path.join(uiDir, 'index.html'));
    return;
  }

  const filePath = path.join(uiDir, cleanPath);
  sendFile(res, filePath);
});

server.listen(uiPort, () => {
  console.log(`UI server running at http://localhost:${uiPort}`);
  console.log(`Serving assets from ${uiDir}`);
  console.log(`API base: ${apiBase || 'auto (same host:3001)'}`);
});

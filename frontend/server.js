import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, 'dist');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 5173);
const runtimeApiBaseUrl = normalizeBaseUrl(process.env.VITE_API_BASE_URL || process.env.API_BASE_URL || '');
const apiProxyBasePath = runtimeApiBaseUrl.startsWith('/') ? runtimeApiBaseUrl : '/api';
const apiProxyTargetUrl = createProxyTargetUrl(process.env.VITE_API_PROXY_TARGET || process.env.API_PROXY_TARGET || 'http://backend:8000');
const proxyRoutes = [
  { publicPath: apiProxyBasePath, targetPath: '/', prefix: true },
  { publicPath: '/docs', targetPath: '/docs', prefix: true },
  { publicPath: '/openapi.json', targetPath: '/openapi.json', prefix: false },
  { publicPath: '/healthz', targetPath: '/healthz', prefix: false },
];

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().replace(/\/+$/, '');
}

function createProxyTargetUrl(value) {
  try {
    return new URL(normalizeBaseUrl(value));
  } catch {
    return new URL('http://backend:8000');
  }
}

function joinPaths(prefix, suffix) {
  const normalizedPrefix = prefix.replace(/\/+$/, '');
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;

  if (!normalizedPrefix) {
    return normalizedSuffix;
  }

  if (normalizedSuffix === '/') {
    return `${normalizedPrefix}/`;
  }

  return `${normalizedPrefix}${normalizedSuffix}`;
}

function isProxyPath(pathname) {
  return getProxyRoute(pathname) !== null;
}

function getProxyRoute(pathname) {
  for (const route of proxyRoutes) {
    if (pathname === route.publicPath) {
      return route;
    }

    if (route.prefix && pathname.startsWith(`${route.publicPath}/`)) {
      return route;
    }
  }

  return null;
}

function getProxyPath(pathname) {
  const route = getProxyRoute(pathname);
  if (!route) {
    return null;
  }

  if (pathname === route.publicPath) {
    return route.targetPath;
  }

  const remainder = pathname.slice(route.publicPath.length);
  return joinPaths(route.targetPath, remainder);
}

function getForwardedHeaders(request) {
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['proxy-connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers.upgrade;
  delete headers.te;
  delete headers.trailer;
  delete headers.expect;

  const remoteAddress = request.socket.remoteAddress;
  if (remoteAddress) {
    const forwardedFor = headers['x-forwarded-for'];
    headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${remoteAddress}` : remoteAddress;
  }

  if (request.headers.host) {
    headers['x-forwarded-host'] = request.headers.host;
  }

  headers['x-forwarded-proto'] = request.socket.encrypted ? 'https' : 'http';

  return headers;
}

function filterProxyResponseHeaders(headers) {
  const filteredHeaders = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) {
      continue;
    }

    const lowerName = headerName.toLowerCase();
    if (
      lowerName === 'connection' ||
      lowerName === 'proxy-authenticate' ||
      lowerName === 'proxy-authorization' ||
      lowerName === 'keep-alive' ||
      lowerName === 'te' ||
      lowerName === 'trailer' ||
      lowerName === 'transfer-encoding' ||
      lowerName === 'upgrade'
    ) {
      continue;
    }

    filteredHeaders[headerName] = headerValue;
  }

  return filteredHeaders;
}

function proxyApiRequest(request, response, pathname, search) {
  const proxyUrl = new URL(apiProxyTargetUrl.toString());
  proxyUrl.pathname = joinPaths(proxyUrl.pathname, getProxyPath(pathname));
  proxyUrl.search = search;

  const proxyClient = proxyUrl.protocol === 'https:' ? https : http;
  const proxyRequest = proxyClient.request(
    proxyUrl,
    {
      method: request.method,
      headers: getForwardedHeaders(request),
    },
    (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 502, filterProxyResponseHeaders(proxyResponse.headers));

      if (request.method === 'HEAD') {
        proxyResponse.resume();
        response.end();
        return;
      }

      proxyResponse.pipe(response);
    },
  );

  proxyRequest.on('error', (error) => {
    console.error(error);

    if (!response.headersSent) {
      sendText(response, 502, 'Bad Gateway');
      return;
    }

    response.end();
  });

  request.pipe(proxyRequest);
}

function buildRuntimeConfigScript() {
  const runtimeConfig = runtimeApiBaseUrl ? { apiBaseUrl: runtimeApiBaseUrl } : {};
  return `window.__BOODSCHAPPEN_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;
}

function getContentType(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function getCacheControl(requestPath) {
  if (requestPath === '/runtime-config.js' || requestPath === '/' || requestPath === '/index.html') {
    return 'no-cache';
  }

  if (requestPath.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }

  return 'no-cache';
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
  });
  response.end(body);
}

function resolveFilePath(requestPath) {
  const relativePath = requestPath.replace(/^\/+/, '') || 'index.html';
  const resolvedPath = path.resolve(distDir, relativePath);

  if (resolvedPath !== distDir && !resolvedPath.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function readStaticFile(filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }

    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function handleRequest(request, response) {
  let pathname;
  try {
    pathname = new URL(request.url || '/', 'http://localhost').pathname;
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }

  const search = new URL(request.url || '/', 'http://localhost').search;

  if (isProxyPath(pathname)) {
    proxyApiRequest(request, response, pathname, search);
    return;
  }

  if (!request.method || !['GET', 'HEAD'].includes(request.method)) {
    sendText(response, 405, 'Method Not Allowed');
    return;
  }

  if (pathname === '/runtime-config.js') {
    response.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    response.end(buildRuntimeConfigScript());
    return;
  }

  const resolvedPath = resolveFilePath(pathname);
  if (!resolvedPath) {
    sendText(response, 400, 'Bad Request');
    return;
  }

  const directFile = await readStaticFile(resolvedPath);
  const hasFileExtension = Boolean(path.extname(pathname));
  const filePath = directFile ? resolvedPath : hasFileExtension ? null : path.join(distDir, 'index.html');
  const body = directFile || (filePath ? await readStaticFile(filePath) : null);

  if (!body) {
    sendText(response, 404, 'Not Found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': getContentType(filePath || resolvedPath),
    'Cache-Control': getCacheControl(pathname),
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  response.end(body);
}

async function main() {
  try {
    const distStat = await stat(distDir);
    if (!distStat.isDirectory()) {
      throw new Error('dist is not a directory');
    }
  } catch {
    console.error(`Build output not found at ${distDir}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const server = http.createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      console.error(error);
      if (!response.headersSent) {
        sendText(response, 500, 'Internal Server Error');
        return;
      }

      response.end();
    });
  });

  server.listen(port, host, () => {
    console.log(`Serving ${distDir} on http://${host}:${port}`);
  });
}

void main();
// A bare request/response pair, enough to drive a connect middleware in tests and the gate.
export function fakeResponse() {
  const headers = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
    getHeader: (name) => headers[name.toLowerCase()],
    writeHead(status, extra = {}) {
      res.statusCode = status;
      for (const [name, value] of Object.entries(extra))
        headers[name.toLowerCase()] = value;
      res.headersSent = true;
      return res;
    },
    write(chunk) {
      res.chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined && typeof chunk !== 'function')
        res.chunks.push(Buffer.from(chunk));
      res.ended = true;
    },
    get body() {
      return Buffer.concat(res.chunks).toString('utf8');
    },
  };
  return res;
}

/** Run `middleware` for a GET of `url`, with `handler` standing in for the provider behind it. */
export async function request(middleware, url, handler, method = 'GET') {
  const req = {
    method,
    url: url.replace(/^\/api/, '') || '/',
    originalUrl: url,
    headers: {},
  };
  const res = fakeResponse();
  await new Promise((resolve, reject) => {
    middleware(req, res, () => {
      Promise.resolve(handler(req, res)).then(resolve, reject);
    });
  });
  // The tee works after the response is sent.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

/** Send a fixture's priming answers (for example station_information) through `middleware`. */
export async function prime(middleware, requests) {
  for (const { path, body } of requests ?? []) {
    await request(middleware, path, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  }
}

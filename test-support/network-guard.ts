/**
 * Preloaded into every test process (and spawned tracker processes in
 * integration tests): fetch may only reach loopback hosts, so no test can
 * ever send data to a real Matomo instance.
 */
const realFetch = globalThis.fetch;

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!isLoopback(url.hostname)) {
    return Promise.reject(new Error(`network-guard: blocked non-loopback request to ${url.host}`));
  }
  return realFetch(input, init);
};

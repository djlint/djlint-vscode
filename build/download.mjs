const ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;

/**
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
export async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        throw new Error(`${res.status} fetching ${url}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= ATTEMPTS) {
        throw e;
      }
      console.warn(`retry ${attempt}/${ATTEMPTS} for ${url}: ${String(e)}`);
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * attempt);
      });
    }
  }
}

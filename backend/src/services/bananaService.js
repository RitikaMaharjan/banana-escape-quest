const config = require('../config');

const TIMEOUT_MS = 5000;

class BananaApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BananaApiError';
    this.status = status;
  }
}

async function fetchPuzzle() {
  if (!config.bananaApiUrl) {
    throw new BananaApiError('BANANA_API_URL is not configured', 500);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(config.bananaApiUrl, { signal: controller.signal });

    if (!response.ok) {
      throw new BananaApiError(`Banana API returned status ${response.status}`, 502);
    }

    return await response.json();
  } catch (err) {
    if (err instanceof BananaApiError) throw err;
    if (err.name === 'AbortError') {
      throw new BananaApiError('Banana API timed out', 504);
    }
    throw new BananaApiError('Banana API is unreachable or returned invalid data', 502);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPuzzle, BananaApiError };
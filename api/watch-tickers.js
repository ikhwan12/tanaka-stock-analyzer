import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Serves gas/watch-tickers.json for the GAS market scan (and optional tooling).
 * Path is stable on Vercel so Code.gs can UrlFetch the deployed URL.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const filePath = join(process.cwd(), 'gas', 'watch-tickers.json');
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return res.status(500).json({ error: 'watch-tickers.json must be a JSON array' });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to load tickers' });
  }
}

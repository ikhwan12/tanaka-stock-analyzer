// ══════════════════════════════════════════════
//  One-time setup: registers Telegram webhook
//  Visit: YOUR_VERCEL_URL/api/setup
//  Requires env: TELEGRAM_BOT_TOKEN
//  Optional: PUBLIC_BASE_URL (e.g. https://tanaka-stock-analyzer.vercel.app) for webhook URL
// ══════════════════════════════════════════════

function telegramApiBase() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t || !String(t).trim()) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN (Vercel → Environment Variables)');
  }
  return `https://api.telegram.org/bot${String(t).trim()}`;
}

/**
 * Telegram must hit a stable, public origin. Do NOT use VERCEL_URL: it is the per-deployment
 * hostname (…-hash-….vercel.app), which often returns 401 (Deployment Protection) while the
 * production alias (VERCEL_PROJECT_PRODUCTION_URL / custom domain) works.
 */
function resolveWebhookBaseUrl() {
  const explicit = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (explicit) return { base: explicit, source: 'PUBLIC_BASE_URL' };

  const prodHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim().replace(/\/$/, '');
  if (prodHost) {
    const base = /^https?:\/\//i.test(prodHost) ? prodHost : `https://${prodHost}`;
    return { base, source: 'VERCEL_PROJECT_PRODUCTION_URL' };
  }

  const fallback = 'https://tanaka-stock-analyzer.vercel.app';
  return {
    base:     fallback,
    source:   'default production host',
    warning:
      'No PUBLIC_BASE_URL or VERCEL_PROJECT_PRODUCTION_URL — using default. Set PUBLIC_BASE_URL in Vercel to your real site (custom domain) if different.'
  };
}

export default async function handler(req, res) {
  try {
    const TG_API = telegramApiBase();
    const { base, source, warning } = resolveWebhookBaseUrl();
    const WEBHOOK_URL = `${base}/api/telegram`;

    // 1. Set webhook
    const whResp = await fetch(`${TG_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url:             WEBHOOK_URL,
        allowed_updates: ['message', 'edited_message']
      })
    });
    const whData = await whResp.json();

    // 2. Set bot commands menu
    const cmdsResp = await fetch(`${TG_API}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'register',  description: 'Get full access - support this project' },
          { command: 'start',     description: 'Welcome and login status' },
          { command: 'help',      description: 'Show all commands' },
          { command: 'login',     description: 'Sign in: LOGIN user pass' },
          { command: 'logout',    description: 'Sign out' },
          { command: 'buy',       description: 'Buy signal: BUY TICKER AMOUNT' },
          { command: 'sell',      description: 'Sell signal: SELL TICKER AMOUNT' },
          { command: 'update',    description: 'Record trade: UPDATE TICKER B100 185.20' },
          { command: 'check',     description: 'Portfolio and P and L (login first)' },
          { command: 'watchlist', description: 'Manage and scan watchlist' },
          { command: 'profile',   description: 'Risk: PROFILE LOW MEDIUM HIGH' },
          { command: 'explain',   description: 'EXPLAIN BUY or SELL' },
          { command: 'balance',   description: 'Set balance: BALANCE 1000' },
          { command: 'clear',     description: 'Reset portfolio: CLEAR YES' },
          { command: 'check_top_mover', description: 'Top movers from daily scan' }
        ]
      })
    });
    const cmdsData = await cmdsResp.json();

    // 3. Get webhook info to confirm
    const infoResp = await fetch(`${TG_API}/getWebhookInfo`);
    const infoData = await infoResp.json();

    res.status(200).json({
      success:         true,
      webhook_url:     WEBHOOK_URL,
      webhook_base:    base,
      webhook_source:  source,
      webhook_warning: warning || null,
      webhook:         whData,
      commands:        cmdsData,
      webhook_info:    infoData.result
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

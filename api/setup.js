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

export default async function handler(req, res) {
  try {
    const TG_API = telegramApiBase();
    const base =
      (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
      'https://tanaka-stock-analyzer.vercel.app';
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
          { command: 'register',  description: '🌟 Get Full Access — Support this project' },
          { command: 'start',     description: 'Welcome and login status' },
          { command: 'help',      description: 'Show all commands' },
          { command: 'login',     description: 'Sign in — LOGIN username password' },
          { command: 'logout',    description: 'Sign out' },
          { command: 'buy',       description: 'Check buy signal — BUY TICKER AMOUNT' },
          { command: 'sell',      description: 'Check sell signal — SELL TICKER AMOUNT' },
          { command: 'update',    description: 'Record a trade — UPDATE TICKER B100 185.20' },
          { command: 'check',     description: 'View portfolio and P&L' },
          { command: 'watchlist', description: 'Manage and scan watchlist' },
          { command: 'profile',   description: 'Set risk level — LOW / MEDIUM / HIGH' },
          { command: 'explain',   description: 'Understand results — EXPLAIN BUY or SELL' },
          { command: 'balance',   description: 'Set initial balance — BALANCE 1000' },
          { command: 'clear',     description: 'Reset portfolio — CLEAR YES' },
          { command: 'check_top_mover', description: 'Top movers — live during daily scan' }
        ]
      })
    });
    const cmdsData = await cmdsResp.json();

    // 3. Get webhook info to confirm
    const infoResp = await fetch(`${TG_API}/getWebhookInfo`);
    const infoData = await infoResp.json();

    res.status(200).json({
      success:      true,
      webhook:      whData,
      commands:     cmdsData,
      webhook_info: infoData.result
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════════════
//  One-time setup: registers Telegram webhook
//  Visit: YOUR_VERCEL_URL/api/setup
// ══════════════════════════════════════════════

const BOT_TOKEN   = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';
const TG_API      = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WEBHOOK_URL = 'https://tanaka-stock-analyzer.vercel.app/api/telegram';

export default async function handler(req, res) {
  try {
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
          { command: 'clear',     description: 'Reset portfolio — CLEAR YES' }
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

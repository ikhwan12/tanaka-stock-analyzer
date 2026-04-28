// ══════════════════════════════════════════════
//  Vercel Serverless — Telegram Webhook Handler
//  Synchronous: wait for GAS, then reply
// ══════════════════════════════════════════════

const GAS_URL   = 'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';
const BOT_TOKEN = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Correct config export for Vercel API routes (not Next.js App Router)
export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'Tanaka Stock Bot webhook' });
  }

  try {
    const update = req.body;
    const msg    = update.message || update.edited_message;

    // Always ACK non-text updates immediately
    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = String(msg.chat.id);
    const text   = msg.text.trim();
    const msgId  = msg.message_id;

    // Fire typing indicator — no await, runs in background
    fetch(`${TG_API}/sendChatAction`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, action: 'typing' })
    });

    // ── Call GAS (synchronous — wait for full response) ──
    let replyText = '⚠️ Bot error — please try again.';
    try {
      const gasUrl  = `${GAS_URL}?message=${encodeURIComponent(text)}&chatId=${encodeURIComponent(chatId)}`;
      const gasResp = await fetch(gasUrl, {
        method:   'GET',
        headers:  { 'User-Agent': 'TanakaStockBot/2.0' },
        redirect: 'follow'
      });

      if (gasResp.ok) {
        const data = await gasResp.json();
        if (data && data.message) replyText = data.message;
      } else {
        replyText = `⚠️ GAS returned ${gasResp.status}. Please try again.`;
        console.error('GAS HTTP error:', gasResp.status);
      }
    } catch (gasErr) {
      replyText = `⚠️ Failed to reach the bot server.\n\nPlease try again in a moment.`;
      console.error('GAS fetch error:', gasErr.message);
    }

    // ── Send reply to user ──
    await fetch(`${TG_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:             chatId,
        text:                replyText,
        reply_to_message_id: msgId
      })
    });

    // ── Return 200 to Telegram ──
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(200).json({ ok: true }); // Always 200 so Telegram doesn't retry
  }
}

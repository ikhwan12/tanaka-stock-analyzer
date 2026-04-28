// ══════════════════════════════════════════════
//  Vercel Serverless — Telegram Webhook Handler
//  Pattern: ACK Telegram immediately, process async
// ══════════════════════════════════════════════

export const maxDuration = 60; // Vercel Hobby allows up to 60s

const GAS_URL   = 'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';
const BOT_TOKEN = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTelegram(chatId, text, replyToId) {
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:             chatId,
        text:                text || '⚠️ No response.',
        reply_to_message_id: replyToId
      })
    });
  } catch (err) {
    console.error('sendTelegram error:', err.message);
  }
}

async function processMessage(chatId, text, msgId) {
  let replyText = '⚠️ Bot error — please try again.';
  try {
    // Send "typing..." indicator while processing
    await fetch(`${TG_API}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });

    const gasUrl  = `${GAS_URL}?message=${encodeURIComponent(text)}&chatId=${encodeURIComponent(chatId)}`;
    const gasResp = await fetch(gasUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'TanakaStockBot/2.0' },
      redirect: 'follow'
    });

    if (gasResp.ok) {
      const data = await gasResp.json();
      if (data && data.message) replyText = data.message;
    } else {
      replyText = `⚠️ Server returned ${gasResp.status}. Please try again.`;
    }
  } catch (err) {
    console.error('GAS call failed:', err.message);
    replyText = `⚠️ Request failed: ${err.message}\n\nPlease try again.`;
  }

  await sendTelegram(chatId, replyText, msgId);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'Telegram webhook endpoint' });
  }

  try {
    const update = req.body;
    const msg    = update.message || update.edited_message;

    // Always ACK Telegram immediately (must reply within 10s or Telegram retries)
    res.status(200).json({ ok: true });

    if (!msg || !msg.text) return;

    const chatId = String(msg.chat.id);
    const text   = msg.text.trim();
    const msgId  = msg.message_id;

    // Process AFTER response is sent — Vercel keeps function alive until maxDuration
    await processMessage(chatId, text, msgId);

  } catch (err) {
    console.error('Webhook error:', err.message);
    if (!res.headersSent) res.status(200).json({ ok: true });
  }
}

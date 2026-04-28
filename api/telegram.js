// ══════════════════════════════════════════════
//  Vercel Serverless — Telegram Webhook Handler
//  Replaces Make.com entirely
// ══════════════════════════════════════════════

const GAS_URL   = 'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';
const BOT_TOKEN = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

export default async function handler(req, res) {
  // Only accept POST from Telegram
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'Telegram webhook endpoint' });
  }

  try {
    const update = req.body;

    // Extract message (handle regular messages and edited messages)
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true }); // Ignore non-text updates
    }

    const chatId  = msg.chat.id;
    const text    = msg.text.trim();
    const msgId   = msg.message_id;

    // Call GAS with message + chatId
    let replyText = '⚠️ Bot error — please try again.';
    try {
      const gasUrl  = `${GAS_URL}?message=${encodeURIComponent(text)}&chatId=${encodeURIComponent(chatId)}`;
      const gasResp = await fetch(gasUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'TanakaStockBot/2.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(35000) // 35s timeout
      });

      if (gasResp.ok) {
        const data = await gasResp.json();
        if (data && data.message) replyText = data.message;
      }
    } catch (gasErr) {
      console.error('GAS call failed:', gasErr.message);
      replyText = `⚠️ Request timed out or failed.\n\nPlease try again in a moment.`;
    }

    // Send reply back to Telegram
    await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:             chatId,
        text:                replyText,
        reply_to_message_id: msgId,
        parse_mode:          'HTML' // allow basic formatting
      })
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(200).json({ ok: true }); // Always return 200 to Telegram
  }
}

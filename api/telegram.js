const GAS_URL = 'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';

function telegramApiBase() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t || !String(t).trim()) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN (set in Vercel → Settings → Environment Variables)');
  }
  return `https://api.telegram.org/bot${String(t).trim()}`;
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'Tanaka Stock Bot webhook' });
  }

  let TG_API;
  try {
    TG_API = telegramApiBase();
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  try {
    const update = req.body;
    const msg    = update.message || update.edited_message;

    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId     = String(msg.chat.id);
    const text       = msg.text.trim();
    const msgId      = msg.message_id;
    const tgUsername = msg.from?.username || '';  // Telegram @username
    const tgId       = String(msg.from?.id || ''); // Telegram user ID

    // Typing indicator (fire and forget)
    fetch(`${TG_API}/sendChatAction`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, action: 'typing' })
    });

    // Call GAS — pass tgUsername and tgId alongside message + chatId
    let replyText = '⚠️ Bot error — please try again.';
    try {
      const params  = new URLSearchParams({
        message:    text,
        chatId:     chatId,
        tgUsername: tgUsername,
        tgId:       tgId
      });
      const gasResp = await fetch(`${GAS_URL}?${params}`, {
        method:   'GET',
        headers:  { 'User-Agent': 'TanakaStockBot/2.0' },
        redirect: 'follow'
      });

      if (gasResp.ok) {
        const data = await gasResp.json();
        if (data && data.message) replyText = data.message;
      } else {
        replyText = `⚠️ Server error (${gasResp.status}). Please try again.`;
        console.error('GAS HTTP error:', gasResp.status);
      }
    } catch (gasErr) {
      replyText = `⚠️ Request failed. Please try again in a moment.`;
      console.error('GAS fetch error:', gasErr.message);
    }

    // Send reply to Telegram
    await fetch(`${TG_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:             chatId,
        text:                replyText,
        reply_to_message_id: msgId
      })
    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(200).json({ ok: true });
  }
}

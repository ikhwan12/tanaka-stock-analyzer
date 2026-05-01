/** Web app /exec URL — set GAS_WEBAPP_URL in Vercel if you deploy a new Apps Script version */
const GAS_URL_DEFAULT =
  'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';

function gasWebAppUrl() {
  const u = (process.env.GAS_WEBAPP_URL || GAS_URL_DEFAULT).trim();
  return u.replace(/\/$/, '');
}

function telegramApiBase() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t || !String(t).trim()) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN (set in Vercel → Settings → Environment Variables)');
  }
  return `https://api.telegram.org/bot${String(t).trim()}`;
}

export const config = { maxDuration: 60 };

/** Call GAS: POST JSON first (doPost); fallback GET for older deployments without doPost */
async function callGas({ message, chatId, tgUsername, tgId }) {
  const url = gasWebAppUrl();
  const payload = {
    message:    String(message || ''),
    chatId:     String(chatId || ''),
    tgUsername: String(tgUsername || ''),
    tgId:       String(tgId || '')
  };

  let res = await fetch(url, {
    method:      'POST',
    redirect:    'follow',
    headers:     { 'Content-Type': 'application/json', 'User-Agent': 'TanakaStockBot/2.1' },
    body:        JSON.stringify(payload)
  });
  let raw = await res.text();

  const looksWrong = !res.ok || !raw || raw.trim().charAt(0) !== '{';
  if (looksWrong) {
    const qs = new URLSearchParams(payload);
    res = await fetch(`${url}?${qs}`, {
      method:   'GET',
      redirect: 'follow',
      headers:  { 'User-Agent': 'TanakaStockBot/2.1' }
    });
    raw = await res.text();
  }

  return { res, raw };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok:   true,
      info: 'Tanaka Stock Bot webhook — POST Telegram updates here. Set webhook to /api/telegram'
    });
  }

  let TG_API;
  try {
    TG_API = telegramApiBase();
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }

  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch (_) {
      update = null;
    }
  }

  const msg = update && (update.message || update.edited_message);
  const text = msg && (msg.text || msg.caption);
  const chatId = msg && msg.chat && msg.chat.id != null ? String(msg.chat.id) : '';

  if (!msg || !text || typeof text !== 'string') {
    return res.status(200).json({ ok: true, skipped: 'no text' });
  }

  const trimmed = text.trim();
  const msgId     = msg.message_id;
  const tgUsername = (msg.from && msg.from.username) || '';
  const tgId       = msg.from && msg.from.id != null ? String(msg.from.id) : '';

  fetch(`${TG_API}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action: 'typing' })
  }).catch(() => {});

  let replyText = '⚠️ Bot error — please try again.';

  try {
    const { res: gasResp, raw: rawBody } = await callGas({
      message:    trimmed,
      chatId,
      tgUsername,
      tgId
    });

    let data = null;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (parseErr) {
      console.error('GAS non-JSON body:', (rawBody || '').slice(0, 500));
    }

    const gasMsg =
      data && data.message != null && String(data.message).trim()
        ? String(data.message)
        : null;

    if (gasResp.ok && gasMsg) {
      replyText = gasMsg;
    } else if (gasResp.ok && data && !gasMsg) {
      replyText =
        (data.error && String(data.error)) ||
        (data.success === false && data.message != null ? String(data.message) : null) ||
        '⚠️ Empty reply from server. Try again or use the web app.';
      console.error('GAS JSON missing message:', JSON.stringify(data).slice(0, 400));
    } else if (gasResp.ok && !data) {
      replyText =
        '⚠️ Backend did not return JSON (wrong URL or old deploy). In Vercel set GAS_WEBAPP_URL to your Apps Script Web app /exec URL, then redeploy this project.';
      console.error('GAS non-JSON:', (rawBody || '').slice(0, 500));
    } else {
      replyText = `⚠️ Backend HTTP ${gasResp.status}. Check GAS deploy and GAS_WEBAPP_URL on Vercel.`;
      console.error('GAS HTTP error:', gasResp.status, (rawBody || '').slice(0, 400));
    }
  } catch (gasErr) {
    replyText = '⚠️ Could not reach backend. Check GAS_WEBAPP_URL and redeploy Apps Script.';
    console.error('GAS fetch error:', gasErr.message);
  }

  const TG_MAX = 4080;
  if (replyText.length > TG_MAX) {
    replyText =
      replyText.slice(0, TG_MAX - 80) +
      '\n\n… (truncated — open Tanaka Stock web app → Top Mover for full list)';
  }

  const sendOnce = async (payload) => {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });
    return r;
  };

  try {
    let sendPayload = {
      chat_id:             chatId,
      text:                replyText,
      reply_to_message_id: msgId
    };

    let tgSend = await sendOnce(sendPayload);
    if (!tgSend.ok) {
      const errBody = await tgSend.text();
      console.error('sendMessage failed:', tgSend.status, errBody);
      sendPayload = {
        chat_id: chatId,
        text:    '⚠️ Could not send full reply. Try the web app or a shorter command.'
      };
      tgSend = await sendOnce(sendPayload);
      if (!tgSend.ok) console.error('sendMessage retry failed:', await tgSend.text());
    }
  } catch (sendErr) {
    console.error('sendMessage exception:', sendErr.message);
  }

  return res.status(200).json({ ok: true });
}

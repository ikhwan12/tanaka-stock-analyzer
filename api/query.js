const GAS_URL = 'https://script.google.com/macros/s/AKfycbwC0vqFfZJyG59JsvZLvBHFTdPdA3RByl0zEWJMLACLNfKxFMtR7JS7uMqWix8EeXms/exec';

export default async function handler(req, res) {
  // Allow CORS from the frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { message } = req.query;

  if (!message) {
    return res.status(400).json({ message: '⚠️ No message provided.' });
  }

  try {
    const url = `${GAS_URL}?message=${encodeURIComponent(message)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'TanakaStockBot/1.0' },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`GAS returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ message: `⚠️ Server error: ${err.message}` });
  }
}

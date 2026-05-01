// api/generate-yahoo-tickers.js

const fs = require('fs');

async function generateTickers() {
  const url =
    'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true';

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://www.nasdaq.com',
      'Referer': 'https://www.nasdaq.com/market-activity/stocks/screener'
    }
  });

  const json = await res.json();
  const rows = json?.data?.rows || [];

  const tickers = rows
    .map(row => row.symbol)
    .filter(Boolean)
    .filter(symbol => !symbol.includes('^'))
    .filter(symbol => !symbol.includes('/'))
    .filter(symbol => !symbol.includes('.'))
    .sort();

  const uniqueTickers = [...new Set(tickers)];

  const jsContent = `const WATCH_TICKERS = ${JSON.stringify(
    uniqueTickers,
    null,
    2
  )};

export default WATCH_TICKERS;
`;

  fs.writeFileSync('watch-tickers.js', jsContent);
  fs.writeFileSync('watch-tickers.json', JSON.stringify(uniqueTickers, null, 2));

  console.log(`Done. Total tickers: ${uniqueTickers.length}`);
}

generateTickers().catch(console.error);
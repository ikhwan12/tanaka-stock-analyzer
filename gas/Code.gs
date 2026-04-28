// ══════════════════════════════════════════════
//  TANAKA US STOCK BOT — Google Apps Script
//  Features: Multi-user, Watchlist, Smart SELL
// ══════════════════════════════════════════════

const SPREADSHEET_ID = '1VqEPNEgGlhCQqO-g7yNwwFeiRi2JuzwM-758JgTw2Fg';

function doGet(e) {
  try {
    const msg = (e.parameter.message || '').trim().replace(/\s+/g, ' ');
    if (msg) return handleMessage(msg);

    // Legacy direct API
    const type = e.parameter.type;
    if (type === 'ANALYZE')   return analyze(e);
    if (type === 'UPDATE')    return updatePortfolio(e);
    if (type === 'CHECK')     return checkPortfolio(e.parameter.username);
    if (type === 'AUTH')      return authUser(e.parameter.username, e.parameter.password);
    return json({ message: '⚠️ Unknown type.' });
  } catch (err) {
    return json({ message: '⚠️ Error: ' + err.toString() });
  }
}

// ── Route by message text ─────────────────────
function handleMessage(message) {
  const parts = message.split(' ');
  const cmd   = parts[0].toUpperCase();

  if (cmd === 'AUTH') {
    // AUTH username password
    return authUser(parts[1], parts[2]);

  } else if (cmd === 'BUY') {
    // BUY AMZN 100 [username]
    if (parts.length < 3) return json({ message: '❓ Usage: BUY AMZN 100' });
    return analyze({ parameter: { ticker: parts[1].toUpperCase(), amount: parts[2], analyzeType: 'BUY', username: parts[3] || '' } });

  } else if (cmd === 'SELL') {
    // SELL AMZN 100 username
    if (parts.length < 3) return json({ message: '❓ Usage: SELL AMZN 100 username' });
    return analyzeSell(parts[1].toUpperCase(), parseFloat(parts[2]), parts[3] || '');

  } else if (cmd === 'UPDATE') {
    // UPDATE AMZN B100 185.20 username
    if (parts.length < 4) return json({ message: '❓ Usage: UPDATE AMZN B100 185.20 username' });
    return updatePortfolio({ parameter: {
      ticker:    parts[1].toUpperCase(),
      tradeType: parts[2][0].toUpperCase(),
      amount:    parts[2].slice(1),
      price:     parts[3],
      username:  parts[4] || ''
    }});

  } else if (cmd === 'CHECK') {
    // CHECK [username]
    return checkPortfolio(parts[1] || '');

  } else if (cmd === 'WATCHLIST') {
    // WATCHLIST ADD|REMOVE|LIST|SCAN username [TICKER]
    const sub  = (parts[1] || '').toUpperCase();
    const user = parts[2] || '';
    const tick = (parts[3] || '').toUpperCase();

    if (sub === 'ADD')    return watchlistAdd(user, tick);
    if (sub === 'REMOVE') return watchlistRemove(user, tick);
    if (sub === 'LIST')   return watchlistList(user);
    if (sub === 'SCAN')   return watchlistScan(user);
    return json({ message: '❓ Usage: WATCHLIST ADD|REMOVE|LIST|SCAN username [TICKER]' });

  } else if (cmd === 'POSITIONS') {
    // POSITIONS username
    return getPositions(parts[1] || '');

  } else {
    return json({ message: '❓ Unknown command: ' + cmd + '\n\nSupported:\nBUY AMZN 100\nSELL AMZN 100 username\nUPDATE AMZN B100 185.20 username\nCHECK username\nWATCHLIST SCAN username\nPOSITIONS username' });
  }
}

// ══════════════════════════════════════════════
//  AUTH — Check credentials from users sheet
// ══════════════════════════════════════════════
function authUser(username, password) {
  if (!username || !password) return json({ success: false, message: '⚠️ Username and password required.' });

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName('users');

  // Auto-create users sheet with default admin if missing
  if (!sheet) {
    sheet = ss.insertSheet('users');
    sheet.appendRow(['username', 'password', 'watchlist']);
    sheet.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }

  const rows = sheet.getDataRange().getValues().slice(1);
  for (const row of rows) {
    if (row[0] === username && row[1] === password) {
      return json({ success: true, username: username, watchlist: (row[2] || '').toString() });
    }
  }
  return json({ success: false, message: '⚠️ Invalid username or password.' });
}

// ══════════════════════════════════════════════
//  FETCH PRICES — Yahoo Finance direct
// ══════════════════════════════════════════════
function fetchPrices(ticker) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker +
              '?interval=1d&range=2mo&includePrePost=false';
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode() + ' for ' + ticker);
  const data = JSON.parse(resp.getContentText());
  if (!data.chart || !data.chart.result || !data.chart.result[0]) throw new Error('No data for ' + ticker);
  return data.chart.result[0].indicators.quote[0].close.filter(p => p !== null && !isNaN(p));
}

// ══════════════════════════════════════════════
//  CALCULATE Z-SCORE + RSI
// ══════════════════════════════════════════════
function calcIndicators(closes) {
  const current = closes[closes.length - 1];

  // Z-Score 20-day
  const zSlice   = closes.slice(-20);
  const mean     = zSlice.reduce((a, b) => a + b, 0) / 20;
  const variance = zSlice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
  const stdDev   = Math.sqrt(variance);
  const zScore   = stdDev === 0 ? 0 : (current - mean) / stdDev;

  // RSI 14-day (Wilder smoothing)
  const rSlice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const d = rSlice[i] - rSlice[i - 1];
    d > 0 ? gains += d : losses += Math.abs(d);
  }
  const rsi = losses === 0 ? 100 : 100 - (100 / (1 + (gains / 14) / (losses / 14)));

  return { current, mean, stdDev, zScore, rsi };
}

// ══════════════════════════════════════════════
//  BUY ANALYSIS
// ══════════════════════════════════════════════
function analyze(e) {
  const ticker = (e.parameter.ticker || '').toUpperCase();
  const amount = parseFloat(e.parameter.amount) || 100;

  const closes = fetchPrices(ticker);
  if (closes.length < 21) throw new Error('Not enough history for ' + ticker);

  const { current, mean, zScore, rsi } = calcIndicators(closes);
  const fee      = Math.max(amount * 0.003, 0.10);
  const zOk      = zScore < -1.5;
  const rsiOk    = rsi < 35;
  const target   = Math.min(mean, current * 1.03);
  const stopLoss = current * 0.98;
  const netRet   = ((target - current) / current * 100 - (fee * 2 / amount * 100)).toFixed(2);
  const signal   = (zOk && rsiOk) ? 'GOOD_BUY' : (zOk || rsiOk) ? 'MIXED' : 'NOT_YET';

  return json({
    type: 'BUY', ticker, current, mean: +mean.toFixed(2),
    zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1),
    zOk, rsiOk, fee: +fee.toFixed(2),
    target: +target.toFixed(2), stopLoss: +stopLoss.toFixed(2),
    netReturn: +netRet, signal, amount,
    message: formatBuyMessage(ticker, amount, current, mean, zScore, rsi, zOk, rsiOk, fee, target, stopLoss, netRet, signal)
  });
}

function formatBuyMessage(ticker, amount, current, mean, zScore, rsi, zOk, rsiOk, fee, target, stopLoss, netRet, signal) {
  const sig = signal === 'GOOD_BUY' ? '🟢 GOOD TO BUY' : signal === 'MIXED' ? '🟡 MIXED SIGNALS' : '🔴 NOT YET';
  return `📊 BUY Check: ${ticker}
─────────────────────
Trade size: $${amount.toFixed(2)}
Current:    $${current.toFixed(2)}
20d avg:    $${mean.toFixed(2)}

Z-Score: ${zScore.toFixed(2)} ${zOk ? '✅' : '❌'} (need < -1.5)
RSI(14): ${rsi.toFixed(1)} ${rsiOk ? '✅' : '❌'} (need < 35)
─────────────────────
Fee:        $${fee.toFixed(2)} (GoTrade 0.3%)
Target:     $${target.toFixed(2)}
Stop-loss:  $${stopLoss.toFixed(2)}
Net return: +${netRet}%
─────────────────────
${sig}`;
}

// ══════════════════════════════════════════════
//  SMART SELL — checks existing positions
// ══════════════════════════════════════════════
function analyzeSell(ticker, amount, username) {
  const closes = fetchPrices(ticker);
  if (closes.length < 21) throw new Error('Not enough history for ' + ticker);

  const { current, mean, zScore, rsi } = calcIndicators(closes);
  const fee  = Math.max(amount * 0.003, 0.10);
  const zOk  = zScore > 1.5;
  const rsiOk = rsi > 65;

  // Get user's position in this ticker
  let positionInfo = null;
  if (username) {
    const holdings = getUserHoldings(username);
    if (holdings[ticker] && holdings[ticker].shares > 0.0001) {
      const h       = holdings[ticker];
      const avgCost = h.invested / h.shares;
      const pnl     = current - avgCost;
      const pnlPct  = (pnl / avgCost * 100);
      positionInfo  = { shares: h.shares, invested: h.invested, avgCost, pnl, pnlPct };
    }
  }

  // Sell recommendation logic
  let recommendation = '';
  let signal = 'HOLD';

  if (positionInfo) {
    const { pnlPct, avgCost } = positionInfo;
    if (pnlPct >= 3) {
      signal = 'GOOD_SELL';
      recommendation = `✅ You're up ${pnlPct.toFixed(1)}% — profit target reached!`;
    } else if (pnlPct <= -2) {
      signal = 'STOP_LOSS';
      recommendation = `🛑 You're down ${Math.abs(pnlPct).toFixed(1)}% — stop-loss triggered!`;
    } else if (zOk && rsiOk) {
      signal = 'GOOD_SELL';
      recommendation = `📈 Technically overbought — good exit point`;
    } else if (zOk || rsiOk) {
      signal = 'MIXED';
      recommendation = `🟡 Mixed signals — consider partial sell`;
    } else {
      signal = 'HOLD';
      recommendation = `💎 Hold — price near avg cost, no strong sell signal`;
    }
  } else {
    if (zOk && rsiOk) { signal = 'GOOD_SELL'; recommendation = '🟢 Technically overbought'; }
    else if (zOk || rsiOk) { signal = 'MIXED'; recommendation = '🟡 Mixed signals'; }
    else { signal = 'HOLD'; recommendation = '🔴 No position found — hold or buy dip'; }
  }

  const sigEmoji = signal === 'GOOD_SELL' ? '🟢 GOOD TO SELL'
                 : signal === 'STOP_LOSS' ? '🛑 STOP LOSS — SELL NOW'
                 : signal === 'MIXED' ? '🟡 MIXED SIGNALS'
                 : '🔴 HOLD FOR NOW';

  let positionLine = '';
  if (positionInfo) {
    positionLine = `\nYour position:
  Shares:   ${positionInfo.shares.toFixed(4)}
  Avg cost: $${positionInfo.avgCost.toFixed(2)}
  P&L:      ${positionInfo.pnl >= 0 ? '+' : ''}$${positionInfo.pnl.toFixed(2)} (${positionInfo.pnlPct.toFixed(1)}%) ${positionInfo.pnl >= 0 ? '📈' : '📉'}`;
  } else {
    positionLine = '\nNo recorded position found for ' + ticker;
  }

  const message = `📊 SELL Check: ${ticker}
─────────────────────
Current:  $${current.toFixed(2)}
20d avg:  $${mean.toFixed(2)}
${positionLine}
─────────────────────
Z-Score: ${zScore.toFixed(2)} ${zOk ? '✅' : '❌'} (need > +1.5)
RSI(14): ${rsi.toFixed(1)} ${rsiOk ? '✅' : '❌'} (need > 65)
─────────────────────
Fee: $${fee.toFixed(2)} (GoTrade 0.3%)
Advice: ${recommendation}
─────────────────────
${sigEmoji}`;

  return json({
    type: 'SELL', ticker, current, mean: +mean.toFixed(2),
    zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1),
    zOk, rsiOk, signal, positionInfo, message
  });
}

// ══════════════════════════════════════════════
//  PORTFOLIO — Record & Check
// ══════════════════════════════════════════════
function updatePortfolio(e) {
  const ticker    = (e.parameter.ticker || '').toUpperCase();
  const tradeType = e.parameter.tradeType === 'B' ? 'BUY' : 'SELL';
  const amount    = parseFloat(e.parameter.amount);
  const price     = parseFloat(e.parameter.price);
  const username  = e.parameter.username || 'tanaka00';
  const shares    = amount / price;
  const fee       = Math.max(amount * 0.003, 0.10);
  const date      = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');

  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName('transactions');
  if (!sheet) {
    sheet = ss.insertSheet('transactions');
    sheet.appendRow(['date','username','ticker','type','amount_usd','price','shares','fee']);
  }

  // Check if headers have username column
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('username')) {
    // Old format — insert username col
    sheet.insertColumnAfter(1);
    sheet.getRange(1, 2).setValue('username');
  }

  sheet.appendRow([date, username, ticker, tradeType, amount, price, +shares.toFixed(6), +fee.toFixed(2)]);

  return json({ message:
`✅ Portfolio Updated!
─────────────────────
${ticker} ${tradeType} [${username}]
Amount: $${amount.toFixed(2)}
Price:  $${price.toFixed(4)}
Shares: ${shares.toFixed(4)}
Fee:    $${fee.toFixed(2)} (GoTrade)
─────────────────────
Date: ${date}` });
}

function getUserHoldings(username) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('transactions');
  if (!sheet || sheet.getLastRow() <= 1) return {};

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const uIdx    = headers.indexOf('username');
  const tIdx    = headers.indexOf('ticker');
  const typeIdx = headers.indexOf('type');
  const aIdx    = headers.indexOf('amount_usd');
  const sIdx    = headers.indexOf('shares');

  const holdings = {};
  rows.slice(1).forEach(r => {
    const rowUser   = uIdx >= 0 ? r[uIdx] : 'tanaka00';
    if (username && rowUser !== username) return;
    const ticker = r[tIdx];
    const type   = r[typeIdx];
    const amount = +r[aIdx];
    const shares = +r[sIdx];
    if (!holdings[ticker]) holdings[ticker] = { shares: 0, invested: 0 };
    if (type === 'BUY')  { holdings[ticker].shares += shares; holdings[ticker].invested += amount; }
    else                 { holdings[ticker].shares -= shares; holdings[ticker].invested -= amount; }
  });
  return holdings;
}

function checkPortfolio(username) {
  const holdings = getUserHoldings(username);

  if (Object.keys(holdings).length === 0) {
    return json({ message: '💼 Portfolio is empty.\n\nRecord trades with UPDATE first.' });
  }

  let lines = ['💼 Portfolio' + (username ? ' — ' + username : ''), '─────────────────────'];
  let totalInvested = 0, totalValue = 0;
  const positions = [];

  for (const ticker of Object.keys(holdings)) {
    const h = holdings[ticker];
    if (h.shares < 0.0001) continue;
    let currentPrice;
    try { const c = fetchPrices(ticker); currentPrice = c[c.length - 1]; }
    catch (_) { lines.push(ticker + ' │ ⚠️ Price fetch failed'); continue; }

    const value   = h.shares * currentPrice;
    const avgCost = h.invested / h.shares;
    const pnl     = value - h.invested;
    const pnlPct  = (pnl / h.invested * 100);
    totalInvested += h.invested;
    totalValue    += value;
    positions.push({ ticker, shares: +h.shares.toFixed(4), avgCost: +avgCost.toFixed(2), currentPrice: +currentPrice.toFixed(2), value: +value.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(1) });
    lines.push(`${ticker}\n  ${h.shares.toFixed(4)} shares @ avg $${avgCost.toFixed(2)}\n  Now: $${currentPrice.toFixed(2)}\n  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) ${pnl >= 0 ? '📈' : '📉'}`);
  }

  const totalPnl    = totalValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested * 100).toFixed(1) : '0.0';
  lines.push('─────────────────────');
  lines.push('Total invested: $' + totalInvested.toFixed(2));
  lines.push('Total value:    $' + totalValue.toFixed(2));
  lines.push('Net P&L: ' + (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2) + ' (' + totalPnlPct + '%)');

  return json({ message: lines.join('\n'), positions, totalInvested: +totalInvested.toFixed(2), totalValue: +totalValue.toFixed(2), totalPnl: +totalPnl.toFixed(2) });
}

function getPositions(username) {
  return checkPortfolio(username);
}

// ══════════════════════════════════════════════
//  WATCHLIST — Add, Remove, List, Scan
// ══════════════════════════════════════════════
function getSheet() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function getUserRow(sheet, username) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === username) return { row: i + 1, data: rows[i] };
  }
  return null;
}

function ensureUsersSheet() {
  const ss    = getSheet();
  let sheet   = ss.getSheetByName('users');
  if (!sheet) {
    sheet = ss.insertSheet('users');
    sheet.appendRow(['username', 'password', 'watchlist']);
    sheet.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }
  return sheet;
}

function watchlistAdd(username, ticker) {
  if (!ticker) return json({ message: '❓ Usage: WATCHLIST ADD username TICKER' });
  const sheet = ensureUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found: ' + username });

  const current = (found.data[2] || '').toString();
  const list    = current ? current.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!list.includes(ticker)) list.push(ticker);
  sheet.getRange(found.row, 3).setValue(list.join(','));
  return json({ message: `✅ Added ${ticker} to watchlist.\nWatchlist: ${list.join(', ')}`, watchlist: list });
}

function watchlistRemove(username, ticker) {
  if (!ticker) return json({ message: '❓ Usage: WATCHLIST REMOVE username TICKER' });
  const sheet = ensureUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found: ' + username });

  const current = (found.data[2] || '').toString();
  const list    = current.split(',').map(t => t.trim()).filter(t => t && t !== ticker);
  sheet.getRange(found.row, 3).setValue(list.join(','));
  return json({ message: `✅ Removed ${ticker} from watchlist.\nWatchlist: ${list.join(', ') || 'empty'}`, watchlist: list });
}

function watchlistList(username) {
  const sheet = ensureUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });
  const list = (found.data[2] || '').toString().split(',').map(t => t.trim()).filter(Boolean);
  return json({ message: `📋 Watchlist for ${username}:\n${list.join(', ') || 'empty'}`, watchlist: list });
}

function watchlistScan(username) {
  const sheet = ensureUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });

  const list = (found.data[2] || '').toString().split(',').map(t => t.trim()).filter(Boolean);
  if (list.length === 0) return json({ message: '📋 Watchlist is empty. Add tickers first.', results: [] });

  const results = [];
  for (const ticker of list) {
    try {
      const closes = fetchPrices(ticker);
      if (closes.length < 21) { results.push({ ticker, error: 'Not enough data' }); continue; }
      const { current, mean, zScore, rsi } = calcIndicators(closes);
      const zOk   = zScore < -1.5;
      const rsiOk = rsi < 35;
      const zSell = zScore > 1.5;
      const rsiSell = rsi > 65;
      let signal = 'HOLD';
      if (zOk && rsiOk)         signal = 'BUY';
      else if (zOk || rsiOk)    signal = 'WEAK_BUY';
      else if (zSell && rsiSell) signal = 'SELL';
      else if (zSell || rsiSell) signal = 'WEAK_SELL';
      results.push({ ticker, current: +current.toFixed(2), mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), signal });
    } catch (err) {
      results.push({ ticker, error: err.message });
    }
  }

  // Format table message
  const lines = ['📡 Watchlist Scan — ' + username, '─────────────────────'];
  results.forEach(r => {
    if (r.error) { lines.push(`${r.ticker}: ⚠️ ${r.error}`); return; }
    const sig = r.signal === 'BUY' ? '🟢 BUY' : r.signal === 'WEAK_BUY' ? '🟡 WEAK BUY' : r.signal === 'SELL' ? '🔴 SELL' : r.signal === 'WEAK_SELL' ? '🟠 WEAK SELL' : '⚪ HOLD';
    lines.push(`${r.ticker.padEnd(6)} $${r.current}  Z:${r.zScore}  RSI:${r.rsi}  ${sig}`);
  });

  return json({ message: lines.join('\n'), results });
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
//  TANAKA US STOCK BOT — Google Apps Script
//  Features: Sessions, Multi-user, Watchlist, Smart SELL
// ══════════════════════════════════════════════

const SPREADSHEET_ID = '1VqEPNEgGlhCQqO-g7yNwwFeiRi2JuzwM-758JgTw2Fg';
const BOT_TOKEN      = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';

function doGet(e) {
  try {
    const msg    = (e.parameter.message || '').trim().replace(/\s+/g, ' ');
    const chatId = e.parameter.chatId || '';

    if (msg) return handleMessage(msg, chatId);

    // Legacy direct API (for web frontend)
    const type = e.parameter.type;
    if (type === 'ANALYZE')  return analyze(e);
    if (type === 'UPDATE')   return updatePortfolio(e);
    if (type === 'CHECK')    return checkPortfolio(e.parameter.username);
    if (type === 'AUTH')     return authUser(e.parameter.username, e.parameter.password);
    return json({ message: '⚠️ Unknown type.' });
  } catch (err) {
    return json({ message: '⚠️ Error: ' + err.toString() });
  }
}

// ══════════════════════════════════════════════
//  SESSION MANAGEMENT
// ══════════════════════════════════════════════
function getSessionSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName('sessions');
  if (!sheet) {
    sheet = ss.insertSheet('sessions');
    sheet.appendRow(['chat_id', 'username', 'logged_in_at']);
  }
  return sheet;
}

function getSession(chatId) {
  if (!chatId) return null;
  const sheet = getSessionSheet();
  const rows  = sheet.getDataRange().getValues().slice(1);
  for (const row of rows) {
    if (String(row[0]) === String(chatId)) {
      return { chatId: row[0], username: row[1], loggedInAt: row[2] };
    }
  }
  return null;
}

function createSession(chatId, username) {
  const sheet = getSessionSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(chatId)) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[username, new Date().toISOString()]]);
      return;
    }
  }
  sheet.appendRow([chatId, username, new Date().toISOString()]);
}

function deleteSession(chatId) {
  const sheet = getSessionSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(chatId)) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// ══════════════════════════════════════════════
//  MESSAGE ROUTER
// ══════════════════════════════════════════════
function handleMessage(message, chatId) {
  const parts = message.split(' ');
  // Strip leading slash and @botname (e.g. /buy@MyBot → BUY)
  const cmd   = parts[0].toUpperCase().replace(/^\//, '').split('@')[0];

  // ── Public commands (no login required) ──
  if (cmd === 'START')  return sendWelcome(chatId);
  if (cmd === 'HELP')   return sendHelp(chatId);
  if (cmd === 'LOGIN')  return handleLogin(parts, chatId);
  if (cmd === 'LOGOUT') return handleLogout(chatId);

  // ── Auth wall ──
  const session = getSession(chatId);
  if (chatId && !session) {
    return json({ message:
`🔒 ACCESS DENIED

You are not logged in.

Use: LOGIN username password

Type HELP for instructions.` });
  }

  const username = session ? session.username : (parts[parts.length - 1] || '');

  // ── Authenticated commands ──
  if (cmd === 'BUY') {
    if (parts.length < 3) return json({ message: '❓ Usage: BUY AMZN 100' });
    return analyze({ parameter: { ticker: parts[1].toUpperCase(), amount: parts[2], analyzeType: 'BUY', username } });

  } else if (cmd === 'SELL') {
    if (parts.length < 3) return json({ message: '❓ Usage: SELL AMZN 100' });
    return analyzeSell(parts[1].toUpperCase(), parseFloat(parts[2]), username);

  } else if (cmd === 'UPDATE') {
    if (parts.length < 4) return json({ message: '❓ Usage: UPDATE AMZN B100 185.20' });
    return updatePortfolio({ parameter: {
      ticker: parts[1].toUpperCase(), tradeType: parts[2][0].toUpperCase(),
      amount: parts[2].slice(1), price: parts[3], username
    }});

  } else if (cmd === 'CHECK') {
    return checkPortfolio(username);

  } else if (cmd === 'WATCHLIST') {
    const sub  = (parts[1] || '').toUpperCase();
    const tick = (parts[2] || '').toUpperCase();
    if (sub === 'ADD')    return watchlistAdd(username, tick);
    if (sub === 'REMOVE') return watchlistRemove(username, tick);
    if (sub === 'LIST')   return watchlistList(username);
    if (sub === 'SCAN')   return watchlistScan(username);
    return json({ message: '❓ Usage:\nWATCHLIST ADD AMZN\nWATCHLIST REMOVE AMZN\nWATCHLIST LIST\nWATCHLIST SCAN' });

  } else if (cmd === 'POSITIONS') {
    return checkPortfolio(username);

  } else if (cmd === 'AUTH') {
    return authUser(parts[1], parts[2]);

  } else {
    return json({ message:
`❓ Unknown command: ${cmd}

Type HELP to see all commands.` });
  }
}

// ══════════════════════════════════════════════
//  LOGIN / LOGOUT
// ══════════════════════════════════════════════
function handleLogin(parts, chatId) {
  // parts[0] = LOGIN or /LOGIN, parts[1] = username, parts[2] = password
  if (parts.length < 3 || !parts[1] || !parts[2]) {
    return json({ message:
`❓ Usage: LOGIN username password

Example:
LOGIN tanaka00 mypassword

Or tap the LOGIN command and type:
tanaka00 mypassword` });
  }

  const username = parts[1];
  const password = parts[2];
  const data     = checkCredentials(username, password);

  if (data.success) {
    if (chatId) createSession(chatId, data.username);
    return json({ message:
`✅ LOGIN SUCCESSFUL

Welcome back, ${data.username.toUpperCase()}! 👋

You now have full access to the bot.
Type HELP to see all commands.` });
  } else {
    return json({ message:
`❌ LOGIN FAILED

Invalid username or password.
Please try again.

LOGIN username password` });
  }
}

function handleLogout(chatId) {
  const session = getSession(chatId);
  if (!session) {
    return json({ message: '⚠️ You are not logged in.' });
  }
  deleteSession(chatId);
  return json({ message:
`👋 LOGGED OUT

You have been logged out successfully.
Your data is safe.

Use LOGIN to sign back in.` });
}

// ══════════════════════════════════════════════
//  HELP & WELCOME
// ══════════════════════════════════════════════
function sendWelcome(chatId) {
  const session = getSession(chatId);
  const loggedIn = session ? `✅ Logged in as: ${session.username}` : '🔒 Not logged in';

  return json({ message:
`🏦 TANAKA US STOCK TERMINAL
─────────────────────────────
Your personal stock analysis bot
powered by Yahoo Finance.

Status: ${loggedIn}

${session ? 'Type HELP to see all commands.' : 'To get started:\nLOGIN username password'}

─────────────────────────────
Type /help or HELP anytime.` });
}

function sendHelp(chatId) {
  const session = getSession(chatId);

  const authSection = `
🔐 AUTHENTICATION
─────────────────────────────
LOGIN username password
  → Sign in to the bot

LOGOUT
  → Sign out of the bot`;

  const mainSection = `
📊 ANALYSIS
─────────────────────────────
BUY TICKER amount
  → Check if good to buy
  → Example: BUY AMZN 100

SELL TICKER amount
  → Smart sell analysis
  → Compares vs your buy price
  → Example: SELL AMZN 100

📁 PORTFOLIO
─────────────────────────────
UPDATE TICKER B/S amount price
  → Record a trade
  → B = Buy, S = Sell
  → Example: UPDATE AMZN B100 185.20
  → Example: UPDATE AMZN S100 195.00

CHECK
  → View all holdings + P&L

📡 WATCHLIST
─────────────────────────────
WATCHLIST ADD TICKER
  → Add ticker to watchlist
  → Example: WATCHLIST ADD NVDA

WATCHLIST REMOVE TICKER
  → Remove from watchlist

WATCHLIST LIST
  → Show your watchlist

WATCHLIST SCAN
  → Analyze all watchlist tickers
  → Shows buy/sell signals table

ℹ️ GENERAL
─────────────────────────────
HELP → Show this menu
START → Show welcome message`;

  if (!session && chatId) {
    return json({ message:
`📖 HELP MENU
${authSection}

🔒 Login first to access all features.` });
  }

  return json({ message: `📖 HELP MENU\n${authSection}\n${mainSection}` });
}

// ══════════════════════════════════════════════
//  AUTH — Check credentials from users sheet
// ══════════════════════════════════════════════
// Returns plain object — use this internally (not from doGet)
function checkCredentials(username, password) {
  if (!username || !password) return { success: false, message: '⚠️ Username and password required.' };
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName('users');
  if (!sheet) {
    sheet = ss.insertSheet('users');
    sheet.appendRow(['username', 'password', 'watchlist']);
    sheet.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }
  const rows = sheet.getDataRange().getValues().slice(1);
  for (const row of rows) {
    if (String(row[0]).trim() === String(username).trim() &&
        String(row[1]).trim() === String(password).trim()) {
      return { success: true, username: String(row[0]).trim(), watchlist: (row[2] || '').toString() };
    }
  }
  return { success: false, message: '⚠️ Invalid username or password.' };
}

// Returns JSON response — use this from doGet / web frontend
function authUser(username, password) {
  return json(checkCredentials(username, password));
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

function calcIndicators(closes) {
  const current  = closes[closes.length - 1];
  const zSlice   = closes.slice(-20);
  const mean     = zSlice.reduce((a, b) => a + b, 0) / 20;
  const variance = zSlice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 20;
  const stdDev   = Math.sqrt(variance);
  const zScore   = stdDev === 0 ? 0 : (current - mean) / stdDev;
  const rSlice   = closes.slice(-15);
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
  const signal   = (zOk && rsiOk) ? '🟢 GOOD TO BUY' : (zOk || rsiOk) ? '🟡 MIXED SIGNALS' : '🔴 NOT YET';
  return json({ type: 'BUY', ticker, current, mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), zOk, rsiOk, fee: +fee.toFixed(2), target: +target.toFixed(2), stopLoss: +stopLoss.toFixed(2), netReturn: +netRet, signal: signal.includes('GOOD') ? 'GOOD_BUY' : signal.includes('MIXED') ? 'MIXED' : 'NOT_YET', amount,
    message:
`📊 BUY Check: ${ticker}
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
${signal}` });
}

// ══════════════════════════════════════════════
//  SMART SELL
// ══════════════════════════════════════════════
function analyzeSell(ticker, amount, username) {
  const closes = fetchPrices(ticker);
  if (closes.length < 21) throw new Error('Not enough history for ' + ticker);
  const { current, mean, zScore, rsi } = calcIndicators(closes);
  const fee   = Math.max(amount * 0.003, 0.10);
  const zOk   = zScore > 1.5;
  const rsiOk = rsi > 65;
  let positionInfo = null;
  if (username) {
    const holdings = getUserHoldings(username);
    if (holdings[ticker] && holdings[ticker].shares > 0.0001) {
      const h      = holdings[ticker];
      const avgCost = h.invested / h.shares;
      const pnl    = current - avgCost;
      const pnlPct = (pnl / avgCost * 100);
      positionInfo = { shares: h.shares, invested: h.invested, avgCost, pnl, pnlPct };
    }
  }
  let recommendation = '', signal = 'HOLD';
  if (positionInfo) {
    const { pnlPct } = positionInfo;
    if (pnlPct >= 3)       { signal = 'GOOD_SELL'; recommendation = `✅ Up ${pnlPct.toFixed(1)}% — profit target reached!`; }
    else if (pnlPct <= -2) { signal = 'STOP_LOSS'; recommendation = `🛑 Down ${Math.abs(pnlPct).toFixed(1)}% — stop-loss triggered!`; }
    else if (zOk && rsiOk) { signal = 'GOOD_SELL'; recommendation = `📈 Technically overbought — good exit`; }
    else if (zOk || rsiOk) { signal = 'MIXED';     recommendation = `🟡 Mixed signals — consider partial sell`; }
    else                   { signal = 'HOLD';       recommendation = `💎 Hold — no strong sell signal yet`; }
  } else {
    if (zOk && rsiOk)      { signal = 'GOOD_SELL'; recommendation = '🟢 Technically overbought'; }
    else if (zOk || rsiOk) { signal = 'MIXED';     recommendation = '🟡 Mixed signals'; }
    else                   { signal = 'HOLD';       recommendation = '⚪ No sell signal — hold'; }
  }
  const sigLabel = signal === 'GOOD_SELL' ? '🟢 GOOD TO SELL' : signal === 'STOP_LOSS' ? '🛑 STOP LOSS — SELL NOW' : signal === 'MIXED' ? '🟡 MIXED SIGNALS' : '🔴 HOLD FOR NOW';
  let posLine = positionInfo
    ? `\nYour position:\n  Shares: ${positionInfo.shares.toFixed(4)}\n  Avg:    $${positionInfo.avgCost.toFixed(2)}\n  P&L:    ${positionInfo.pnl >= 0 ? '+' : ''}$${positionInfo.pnl.toFixed(2)} (${positionInfo.pnlPct.toFixed(1)}%) ${positionInfo.pnl >= 0 ? '📈' : '📉'}`
    : '\nNo recorded position for ' + ticker;
  return json({ type: 'SELL', ticker, current, mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), signal, positionInfo,
    message:
`📊 SELL Check: ${ticker}
─────────────────────
Current: $${current.toFixed(2)}
20d avg: $${mean.toFixed(2)}
${posLine}
─────────────────────
Z-Score: ${zScore.toFixed(2)} ${zOk ? '✅' : '❌'} (need > +1.5)
RSI(14): ${rsi.toFixed(1)} ${rsiOk ? '✅' : '❌'} (need > 65)
─────────────────────
Fee:    $${fee.toFixed(2)} (GoTrade)
Advice: ${recommendation}
─────────────────────
${sigLabel}` });
}

// ══════════════════════════════════════════════
//  PORTFOLIO
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
  const ss        = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet       = ss.getSheetByName('transactions');
  if (!sheet) { sheet = ss.insertSheet('transactions'); sheet.appendRow(['date','username','ticker','type','amount_usd','price','shares','fee']); }
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
    const rowUser = uIdx >= 0 ? r[uIdx] : 'tanaka00';
    if (username && rowUser !== username) return;
    const ticker = r[tIdx]; const type = r[typeIdx]; const amount = +r[aIdx]; const shares = +r[sIdx];
    if (!holdings[ticker]) holdings[ticker] = { shares: 0, invested: 0 };
    if (type === 'BUY') { holdings[ticker].shares += shares; holdings[ticker].invested += amount; }
    else                { holdings[ticker].shares -= shares; holdings[ticker].invested -= amount; }
  });
  return holdings;
}

function checkPortfolio(username) {
  const holdings = getUserHoldings(username);
  if (Object.keys(holdings).length === 0) return json({ message: '💼 Portfolio is empty.\n\nRecord trades with:\nUPDATE AMZN B100 185.20', positions: [] });
  let lines = ['💼 Portfolio — ' + username, '─────────────────────'];
  let totalInvested = 0, totalValue = 0;
  const positions = [];
  for (const ticker of Object.keys(holdings)) {
    const h = holdings[ticker];
    if (h.shares < 0.0001) continue;
    let currentPrice;
    try { const c = fetchPrices(ticker); currentPrice = c[c.length - 1]; } catch (_) { lines.push(ticker + ' │ ⚠️ Price fetch failed'); continue; }
    const value   = h.shares * currentPrice;
    const avgCost = h.invested / h.shares;
    const pnl     = value - h.invested;
    const pnlPct  = (pnl / h.invested * 100);
    totalInvested += h.invested; totalValue += value;
    positions.push({ ticker, shares: +h.shares.toFixed(4), avgCost: +avgCost.toFixed(2), currentPrice: +currentPrice.toFixed(2), value: +value.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(1) });
    lines.push(`${ticker}\n  ${h.shares.toFixed(4)} sh @ avg $${avgCost.toFixed(2)}\n  Now: $${currentPrice.toFixed(2)}\n  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) ${pnl >= 0 ? '📈' : '📉'}`);
  }
  const totalPnl    = totalValue - totalInvested;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested * 100).toFixed(1) : '0.0';
  lines.push('─────────────────────');
  lines.push('Invested: $' + totalInvested.toFixed(2));
  lines.push('Value:    $' + totalValue.toFixed(2));
  lines.push('P&L: ' + (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2) + ' (' + totalPnlPct + '%)');
  return json({ message: lines.join('\n'), positions, totalInvested: +totalInvested.toFixed(2), totalValue: +totalValue.toFixed(2), totalPnl: +totalPnl.toFixed(2) });
}

// ══════════════════════════════════════════════
//  WATCHLIST
// ══════════════════════════════════════════════
function ensureUsersSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet   = ss.getSheetByName('users');
  if (!sheet) { sheet = ss.insertSheet('users'); sheet.appendRow(['username','password','watchlist']); sheet.appendRow(['tanaka00','Q1w2_e3r4','AMZN,AAPL,NVDA']); }
  return sheet;
}
function getUserRow(sheet, username) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) { if (rows[i][0] === username) return { row: i + 1, data: rows[i] }; }
  return null;
}
function watchlistAdd(username, ticker) {
  if (!ticker) return json({ message: '❓ Usage: WATCHLIST ADD TICKER' });
  const sheet = ensureUsersSheet(); const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found' });
  const current = (found.data[2] || '').toString();
  const list    = current ? current.split(',').map(t => t.trim()).filter(Boolean) : [];
  if (!list.includes(ticker)) list.push(ticker);
  sheet.getRange(found.row, 3).setValue(list.join(','));
  return json({ message: `✅ Added ${ticker} to watchlist.\n\nWatchlist: ${list.join(', ')}`, watchlist: list });
}
function watchlistRemove(username, ticker) {
  if (!ticker) return json({ message: '❓ Usage: WATCHLIST REMOVE TICKER' });
  const sheet = ensureUsersSheet(); const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found' });
  const list = (found.data[2] || '').toString().split(',').map(t => t.trim()).filter(t => t && t !== ticker);
  sheet.getRange(found.row, 3).setValue(list.join(','));
  return json({ message: `✅ Removed ${ticker}.\n\nWatchlist: ${list.join(', ') || 'empty'}`, watchlist: list });
}
function watchlistList(username) {
  const sheet = ensureUsersSheet(); const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });
  const list = (found.data[2] || '').toString().split(',').map(t => t.trim()).filter(Boolean);
  return json({ message: `📋 Watchlist:\n${list.join(', ') || 'empty'}`, watchlist: list });
}
function watchlistScan(username) {
  const sheet = ensureUsersSheet(); const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });
  const list = (found.data[2] || '').toString().split(',').map(t => t.trim()).filter(Boolean);
  if (list.length === 0) return json({ message: '📋 Watchlist is empty.\n\nWATCHLIST ADD AMZN', results: [] });
  const results = [];
  for (const ticker of list) {
    try {
      const closes = fetchPrices(ticker);
      if (closes.length < 21) { results.push({ ticker, error: 'Not enough data' }); continue; }
      const { current, mean, zScore, rsi } = calcIndicators(closes);
      const zOk = zScore < -1.5, rsiOk = rsi < 35, zSell = zScore > 1.5, rsiSell = rsi > 65;
      let signal = 'HOLD';
      if (zOk && rsiOk) signal = 'BUY'; else if (zOk || rsiOk) signal = 'WEAK_BUY';
      else if (zSell && rsiSell) signal = 'SELL'; else if (zSell || rsiSell) signal = 'WEAK_SELL';
      results.push({ ticker, current: +current.toFixed(2), mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), signal });
    } catch (err) { results.push({ ticker, error: err.message }); }
  }
  const lines = ['📡 Watchlist Scan', '─────────────────────'];
  const sigMap = { BUY: '🟢 BUY', WEAK_BUY: '🟡 WEAK BUY', SELL: '🔴 SELL', WEAK_SELL: '🟠 WEAK SELL', HOLD: '⚪ HOLD' };
  results.forEach(r => {
    if (r.error) { lines.push(`${r.ticker}: ⚠️ ${r.error}`); return; }
    lines.push(`${r.ticker.padEnd(6)} $${r.current}  Z:${r.zScore}  RSI:${r.rsi}  ${sigMap[r.signal] || r.signal}`);
  });
  return json({ message: lines.join('\n'), results });
}

// ══════════════════════════════════════════════
//  SET TELEGRAM BOT COMMANDS (run once manually)
// ══════════════════════════════════════════════
function setTelegramCommands() {
  const commands = [
    { command: 'start',  description: '🏦 Welcome & status' },
    { command: 'help',   description: '📖 Show all commands' },
    { command: 'login',  description: '🔐 Login to the bot' },
    { command: 'logout', description: '👋 Logout from the bot' },
    { command: 'buy',    description: '📈 Analyze buy signal — BUY AMZN 100' },
    { command: 'sell',   description: '📉 Smart sell analysis — SELL AMZN 100' },
    { command: 'update', description: '📝 Record a trade — UPDATE AMZN B100 185.20' },
    { command: 'check',  description: '💼 View portfolio & P&L' },
    { command: 'watchlist', description: '📡 Manage & scan watchlist' }
  ];
  const url  = 'https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands';
  const resp = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({ commands })
  });
  Logger.log(resp.getContentText());
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
//  TANAKA US STOCK BOT — Google Apps Script v3
// ══════════════════════════════════════════════

const SPREADSHEET_ID = '1VqEPNEgGlhCQqO-g7yNwwFeiRi2JuzwM-758JgTw2Fg';
const BOT_TOKEN      = '8777002152:AAGlHUUQ2C5b1MoAUhRzPZMLUTvYYC5Q4lg';

// ── Risk Profile Thresholds ───────────────────
const PROFILES = {
  LOW:    { zBuy: -2.0, rBuy: 25, zSell: 2.0, rSell: 75, label: '🟢 Low Risk',    emoji: '🟢' },
  MEDIUM: { zBuy: -1.5, rBuy: 35, zSell: 1.5, rSell: 65, label: '🟡 Medium Risk', emoji: '🟡' },
  HIGH:   { zBuy: -1.0, rBuy: 45, zSell: 1.0, rSell: 55, label: '🔴 High Risk',   emoji: '🔴' }
};

function getProfile(username) {
  if (!username) return PROFILES.MEDIUM;
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('users');
    if (!sheet) return PROFILES.MEDIUM;
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    const uCol    = headers.indexOf('username');
    const prCol   = headers.indexOf('risk_profile');
    if (prCol < 0) return PROFILES.MEDIUM;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
        const p = String(rows[i][prCol]).trim().toUpperCase();
        return PROFILES[p] || PROFILES.MEDIUM;
      }
    }
  } catch(e) {}
  return PROFILES.MEDIUM;
}

function setProfile(username, profileKey) {
  profileKey = profileKey.toUpperCase();
  if (!PROFILES[profileKey]) return json({ message: '❓ Invalid profile. Choose: LOW, MEDIUM, or HIGH' });
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('users');
  if (!sheet) return json({ message: '⚠️ Users sheet not found.' });
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const uCol    = headers.indexOf('username');
  let prCol     = headers.indexOf('risk_profile');

  // Add risk_profile column if missing
  if (prCol < 0) {
    prCol = headers.length;
    sheet.getRange(1, prCol + 1).setValue('risk_profile');
  }

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      sheet.getRange(i + 1, prCol + 1).setValue(profileKey);
      const p = PROFILES[profileKey];
      return json({ message:
`✅ Profile Updated!

Your risk profile: ${p.label}

New thresholds:
📉 Buy signal:
  Price Drift < ${p.zBuy}
  Momentum   < ${p.rBuy}

📈 Sell signal:
  Price Drift > ${p.zSell}
  Momentum   > ${p.rSell}

${profileKey === 'LOW'    ? 'Conservative — only strongest signals.' :
  profileKey === 'MEDIUM' ? 'Balanced — standard signals.' :
  'Aggressive — picks up smaller opportunities.'}` });
    }
  }
  return json({ message: '⚠️ User not found: ' + username });
}

// ══════════════════════════════════════════════
//  ENTRY POINT
// ══════════════════════════════════════════════
function doGet(e) {
  try {
    const msg    = (e.parameter.message || '').trim();
    const chatId = (e.parameter.chatId  || '').toString().trim();

    if (e.parameter.debug === '1') {
      return json({ status: 'OK', version: 'v3', spreadsheetId: SPREADSHEET_ID, timestamp: new Date().toISOString() });
    }
    if (msg) return handleMessage(msg, chatId);

    // Legacy web frontend calls
    const type = e.parameter.type;
    if (type === 'AUTH')    return json(checkCredentials(e.parameter.username, e.parameter.password));
    if (type === 'ANALYZE') return analyze(e.parameter.ticker, parseFloat(e.parameter.amount) || 100, e.parameter.analyzeType, e.parameter.username);
    if (type === 'UPDATE')  return recordTrade(e.parameter.ticker, e.parameter.tradeType, parseFloat(e.parameter.amount), parseFloat(e.parameter.price), e.parameter.username);
    if (type === 'CHECK')   return portfolio(e.parameter.username);
    return json({ message: '⚠️ No command provided.' });

  } catch (err) {
    return json({ message: '⚠️ Server error: ' + err.toString() });
  }
}

// ══════════════════════════════════════════════
//  MESSAGE ROUTER
// ══════════════════════════════════════════════
function handleMessage(raw, chatId, tgUsername, tgId) {
  // Normalize: strip slash, strip @botname, uppercase first word
  const parts   = raw.trim().split(/\s+/);
  const cmd     = parts[0].toUpperCase().replace(/^\//, '').split('@')[0];
  const hasArgs = parts.length > 1;

  // ── Always-public commands ──
  if (cmd === 'START')    return sendWelcome(chatId, tgUsername);
  if (cmd === 'HELP')     return sendHelp(chatId);
  if (cmd === 'REGISTER') return sendRegisterInfo();
  if (cmd === 'EXPLAIN')  return sendExplain(parts[1] || '');
  if (cmd === 'PROFILE')  { /* handled below with auth */ }

  // ── Menu taps with NO args → show instruction prompt ──
  if (!hasArgs) {
    if (cmd === 'LOGIN' || cmd === 'AUTH') return promptLogin();
    if (cmd === 'LOGOUT')    return handleLogout(chatId);
    if (cmd === 'REGISTER')  return sendRegisterInfo();
    if (cmd === 'EXPLAIN')   return sendExplain('');
    if (cmd === 'PROFILE')   return promptProfile();
    if (cmd === 'BUY')       return promptBuy();
    if (cmd === 'SELL')      return promptSell();
    if (cmd === 'UPDATE')    return promptUpdate();
    if (cmd === 'CHECK')     return runCheck(chatId, tgUsername, tgId);
    if (cmd === 'WATCHLIST') return promptWatchlist();
    return sendHelp(chatId);
  }

  // ── Commands with args ──
  if (cmd === 'LOGIN' || cmd === 'AUTH') return handleLogin(parts, chatId);
  if (cmd === 'LOGOUT') return handleLogout(chatId);

  // ── Auth wall + free usage tracking ──
  const session = getSession(chatId);
  if (chatId && !session) {
    // Track and limit free usage for unauthenticated Telegram users
    if (tgUsername || tgId) {
      const usageResult = checkAndIncrementUsage(tgUsername, tgId, chatId);
      if (!usageResult.allowed) {
        return json({ message:
`⏰ You've used your 5 free analyses!

To continue, please register for full access.

Tap /register to learn more or type REGISTER.` });
      }
      // Show remaining uses on first few uses
      if (usageResult.count <= 5 && usageResult.count >= 4) {
        // Will prepend warning to response — handled in each command
      }
    } else {
      // Web app — no chatId, just block
      return json({ message:
`🔒 You are not logged in.

Please login first.` });
    }
  }

  // Store Telegram username in session if logged in
  if (session && tgUsername && !session.tgUsername) {
    updateSessionTgUsername(chatId, tgUsername);
  }

  // Username priority: 1) Telegram session, 2) embedded in message (web app)
  // Web app always appends username to commands: BUY AMZN 100 username
  const sessionUser = session ? session.username : '';

  if (cmd === 'BUY') {
    if (parts.length < 3) return promptBuy();
    const uBuy = sessionUser || parts[3] || '';
    return analyze(parts[1].toUpperCase(), parseFloat(parts[2]) || 100, 'BUY', uBuy);
  }
  if (cmd === 'SELL') {
    if (parts.length < 3) return promptSell();
    const uSell = sessionUser || parts[3] || '';
    return analyzeSell(parts[1].toUpperCase(), parseFloat(parts[2]) || 100, uSell);
  }
  if (cmd === 'UPDATE') {
    if (parts.length < 4) return promptUpdate();
    const uUpd = sessionUser || parts[4] || '';
    return recordTrade(parts[1].toUpperCase(), parts[2][0].toUpperCase(), parseFloat(parts[2].slice(1)), parseFloat(parts[3]), uUpd);
  }
  if (cmd === 'CHECK') {
    const uChk = sessionUser || parts[1] || '';
    return portfolio(uChk);
  }
  if (cmd === 'PROFILE' || cmd === 'PROFILE') {
    const uPro = sessionUser || parts[2] || '';
    const key  = (parts[1] || '').toUpperCase();
    if (!key || key === 'PROFILE') return promptProfile();
    return setProfile(uPro, key);
  }
  if (cmd === 'WATCHLIST') {
    const sub = (parts[1] || '').toUpperCase();
    // Web format:      WATCHLIST ADD username TICKER  (4 parts)
    // Telegram format: WATCHLIST ADD TICKER           (3 parts, username from session)
    let wlUser, tick;
    if (sessionUser) {
      // Telegram: username from session
      wlUser = sessionUser;
      tick   = (parts[2] || '').toUpperCase();
    } else {
      // Web app: username embedded in message
      wlUser = parts[2] || '';
      tick   = (parts[3] || '').toUpperCase();
    }
    if (sub === 'ADD')    return watchlistAdd(wlUser, tick);
    if (sub === 'REMOVE') return watchlistRemove(wlUser, tick);
    if (sub === 'LIST')   return watchlistList(sessionUser || parts[2] || '');
    if (sub === 'SCAN')   return watchlistScan(sessionUser || parts[2] || '');
    return promptWatchlist();
  }
  if (cmd === 'POSITIONS') {
    const uPos = sessionUser || parts[1] || '';
    return portfolio(uPos);
  }

  return json({ message: `❓ Unknown command: ${cmd}\n\nTap /help to see all commands.` });
}

function runCheck(chatId, tgUsername, tgId) {
  const session = getSession(chatId);
  if (chatId && !session) {
    if (tgUsername || tgId) {
      const usageResult = checkAndIncrementUsage(tgUsername, tgId, chatId);
      if (!usageResult.allowed) {
        return json({ message: '⏰ You\'ve used your 5 free analyses!\n\nTap /register to learn more.' });
      }
    } else {
      return json({ message: '🔒 You are not logged in.\n\nTap LOGIN or type:\nLOGIN username password' });
    }
  }
  return portfolio(session ? session.username : '');
}

// ══════════════════════════════════════════════
//  INSTRUCTION PROMPTS (shown when menu tapped)
// ══════════════════════════════════════════════
function promptLogin() {
  return json({ message:
`🔐 LOGIN

To login, type:
LOGIN username password

Example:
LOGIN tanaka00 mypassword` });
}

function promptBuy() {
  return json({ message:
`📈 BUY ANALYSIS

To analyze a buy signal, type:
BUY TICKER AMOUNT

Example:
BUY AMZN 100

This will check Z-score, RSI,
fee impact, and give a signal.` });
}

function promptSell() {
  return json({ message:
`📉 SELL ANALYSIS

To analyze a sell signal, type:
SELL TICKER AMOUNT

Example:
SELL AMZN 100

This checks your position vs
current price and gives advice.` });
}

function promptUpdate() {
  return json({ message:
`📝 RECORD A TRADE

To record a BUY:
UPDATE TICKER BAMOUNT PRICE
Example: UPDATE AMZN B100 185.20

To record a SELL:
UPDATE TICKER SAMOUNT PRICE
Example: UPDATE AMZN S100 195.00

B = Buy, S = Sell
AMOUNT = total USD spent
PRICE = price per share` });
}

function promptWatchlist() {
  return json({ message:
`📡 WATCHLIST

Available commands:

Add a ticker:
WATCHLIST ADD TICKER
→ WATCHLIST ADD NVDA

Remove a ticker:
WATCHLIST REMOVE TICKER
→ WATCHLIST REMOVE NVDA

Show your list:
WATCHLIST LIST

Scan all tickers:
WATCHLIST SCAN` });
}

// ══════════════════════════════════════════════
//  LOGIN / LOGOUT
// ══════════════════════════════════════════════
function handleLogin(parts, chatId) {
  if (parts.length < 3) return promptLogin();

  const username = (parts[1] || '').toString().trim();
  const password = (parts[2] || '').toString().trim();
  const result   = checkCredentials(username, password);

  if (result.success) {
    if (chatId) createSession(chatId, result.username);
    return json({
      success:   true,
      username:  result.username,
      watchlist: result.watchlist || '',
      message:
`✅ LOGIN SUCCESSFUL

Welcome, ${result.username.toUpperCase()}! 👋

You now have full access.
Tap /help to see all commands.`
    });
  }

  return json({
    success: false,
    message:
`❌ LOGIN FAILED

Wrong username or password.
Please try again.`
  });
}

function handleLogout(chatId) {
  const session = getSession(chatId);
  if (!session) return json({ message: '⚠️ You are not logged in.' });
  deleteSession(chatId);
  return json({ message:
`👋 LOGGED OUT

See you next time!
Tap LOGIN to sign back in.` });
}

// ══════════════════════════════════════════════
//  WELCOME & HELP
// ══════════════════════════════════════════════
function sendWelcome(chatId, tgUsername) {
  const session = getSession(chatId);
  let usageInfo = '';
  if (!session && tgUsername) {
    const sheet = getUsageSheet();
    const rows  = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][1]).trim() === tgUsername) {
        const used = parseInt(rows[i][2] || 0);
        const remaining = Math.max(0, 5 - used);
        usageInfo = remaining > 0
          ? `\n🆓 Free analyses remaining: ${remaining}/5`
          : '\n⏰ Free analyses used up — type REGISTER';
        break;
      }
    }
    if (!usageInfo) usageInfo = '\n🆓 Free analyses remaining: 5/5';
  }

  return json({ message:
`🏦 TANAKA US STOCK TERMINAL

${session ? '✅ Logged in as: ' + session.username.toUpperCase() : '🔒 Not logged in' + usageInfo}

${session
  ? 'Tap any command from the menu\nor type HELP to see all options.'
  : 'To get started, tap LOGIN\nor type: LOGIN username password\n\nType REGISTER to learn about full access.'}

Powered by Yahoo Finance 📊` });
}

function sendHelp(chatId) {
  const session = getSession(chatId);
  const status  = session ? '✅ Logged in as: ' + session.username.toUpperCase() : '🔒 Not logged in';

  return json({ message:
`📖 HELP MENU
Status: ${status}
─────────────────────
🔐 ACCOUNT
/login    → Sign in to the bot
/logout   → Sign out
/register → Get full access

⚙️ SETTINGS
/profile → Set your risk level
→ PROFILE LOW / MEDIUM / HIGH

📊 ANALYSIS (type these)
BUY TICKER AMOUNT
→ Example: BUY AMZN 100

SELL TICKER AMOUNT
→ Example: SELL AMZN 100

/explain → What do the results mean?

📁 PORTFOLIO
UPDATE TICKER B/SAMOUNT PRICE
→ Buy:  UPDATE AMZN B100 185.20
→ Sell: UPDATE AMZN S100 195.00

/check → View holdings & P&L

📡 WATCHLIST
WATCHLIST ADD TICKER
WATCHLIST REMOVE TICKER
WATCHLIST LIST
WATCHLIST SCAN
─────────────────────
Tap any menu command for
step-by-step instructions.` });
}

// ══════════════════════════════════════════════
//  SESSION MANAGEMENT (Google Sheets)
// ══════════════════════════════════════════════
function getSessionSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let s    = ss.getSheetByName('sessions');
  if (!s) {
    s = ss.insertSheet('sessions');
    s.appendRow(['chat_id', 'username', 'logged_in_at']);
  }
  return s;
}

function getSession(chatId) {
  if (!chatId) return null;
  const rows = getSessionSheet().getDataRange().getValues().slice(1);
  for (const r of rows) {
    if (String(r[0]).trim() === String(chatId).trim()) {
      return { chatId: r[0], username: String(r[1]).trim() };
    }
  }
  return null;
}

function createSession(chatId, username) {
  const sheet = getSessionSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(chatId).trim()) {
      sheet.getRange(i + 1, 2, 1, 2).setValues([[username, new Date().toISOString()]]);
      return;
    }
  }
  sheet.appendRow([String(chatId), username, new Date().toISOString()]);
}

function deleteSession(chatId) {
  const sheet = getSessionSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(chatId).trim()) {
      sheet.deleteRow(i + 1);
      return;
    }
  }
}

// ══════════════════════════════════════════════
//  CREDENTIALS CHECK
// ══════════════════════════════════════════════
function checkCredentials(username, password) {
  if (!username || !password) return { success: false, message: 'Username and password required.' };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let s    = ss.getSheetByName('users');
  if (!s) {
    s = ss.insertSheet('users');
    s.appendRow(['username', 'password', 'watchlist']);
    s.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }

  const rows    = s.getDataRange().getValues().slice(1);
  const headers = s.getDataRange().getValues()[0].map(h => String(h).trim().toLowerCase());
  const uCol  = Math.max(headers.indexOf('username'), 0);
  const pCol  = headers.indexOf('password') >= 0 ? headers.indexOf('password') : 1;
  const wCol  = headers.indexOf('watchlist') >= 0 ? headers.indexOf('watchlist') : 2;
  const prCol = headers.indexOf('risk_profile');
  for (const r of rows) {
    const u = String(r[uCol]).trim();
    const p = String(r[pCol]).trim();
    if (u.toLowerCase() === String(username).trim().toLowerCase() && p === String(password).trim()) {
      const profile = prCol >= 0 ? (String(r[prCol]).trim().toUpperCase() || 'MEDIUM') : 'MEDIUM';
      return { success: true, username: u, watchlist: String(r[wCol] || ''), profile };
    }
  }
  return { success: false, message: 'Invalid username or password.' };
}

// For web frontend only (returns JSON response wrapper)
function authUser(username, password) {
  return json(checkCredentials(username, password));
}

// ══════════════════════════════════════════════
//  YAHOO FINANCE + INDICATORS
// ══════════════════════════════════════════════
function fetchPrices(ticker) {
  const url  = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
               '?interval=1d&range=2mo&includePrePost=false';
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('Yahoo Finance error for ' + ticker);
  const data = JSON.parse(resp.getContentText());
  if (!data.chart || !data.chart.result || !data.chart.result[0]) throw new Error('No price data for ' + ticker + '. Check the ticker symbol.');
  const closes = data.chart.result[0].indicators.quote[0].close;
  return closes.filter(p => p !== null && !isNaN(p));
}

function calcIndicators(closes) {
  const current  = closes[closes.length - 1];
  const zSlice   = closes.slice(-20);
  const mean     = zSlice.reduce((a, b) => a + b, 0) / 20;
  const variance = zSlice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / 20;
  const stdDev   = Math.sqrt(variance);
  const zScore   = stdDev === 0 ? 0 : (current - mean) / stdDev;
  const rSlice   = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < rSlice.length; i++) {
    const d = rSlice[i] - rSlice[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains / 14;
  const avgL = losses / 14;
  const rsi  = avgL === 0 ? 100 : 100 - (100 / (1 + avgG / avgL));
  return { current, mean, stdDev, zScore, rsi };
}

// ══════════════════════════════════════════════
//  BUY ANALYSIS
// ══════════════════════════════════════════════
function analyze(ticker, amount, type, username) {
  if (!ticker) return json({ message: '❓ Ticker required.\nExample: BUY AMZN 100' });
  amount = amount || 100;
  const closes  = fetchPrices(ticker);
  if (closes.length < 21) return json({ message: '⚠️ Not enough price history for ' + ticker });
  const { current, mean, zScore, rsi } = calcIndicators(closes);
  const profile  = getProfile(username);
  const fee      = Math.max(amount * 0.003, 0.10);
  const zOk      = zScore < profile.zBuy;
  const rsiOk    = rsi < profile.rBuy;
  const target   = Math.min(mean, current * 1.03);
  const stopLoss = current * 0.98;
  const netRet   = ((target - current) / current * 100 - fee * 2 / amount * 100).toFixed(2);
  const signal   = (zOk && rsiOk) ? '🟢 GOOD TO BUY' : (zOk || rsiOk) ? '🟡 MIXED SIGNALS' : '🔴 NOT YET';

  // Friendly signal bar
  const driftBar = zScore < -3 ? '████░' : zScore < -2 ? '███░░' : zScore < -1 ? '██░░░' : zScore < 0 ? '█░░░░' : '░░░░░';
  const momBar   = rsi < 20 ? '████░' : rsi < 30 ? '███░░' : rsi < 40 ? '██░░░' : rsi < 50 ? '█░░░░' : '░░░░░';

  return json({
    type: 'BUY', ticker, current, mean: +mean.toFixed(2), zScore: +zScore.toFixed(2),
    rsi: +rsi.toFixed(1), zOk, rsiOk, fee: +fee.toFixed(2), target: +target.toFixed(2),
    stopLoss: +stopLoss.toFixed(2), netReturn: +netRet,
    signal: zOk && rsiOk ? 'GOOD_BUY' : zOk || rsiOk ? 'MIXED' : 'NOT_YET', amount,
    message:
`📊 BUY CHECK: ${ticker}
─────────────────────
Trade:   $${amount.toFixed(2)}
Current: $${current.toFixed(2)}
Average: $${mean.toFixed(2)}
Profile: ${profile.label}
─────────────────────
Price Drift  [${driftBar}] ${zOk ? '✅' : '❌'}
Momentum     [${momBar}] ${rsiOk ? '✅' : '❌'}
─────────────────────
Fee:       $${fee.toFixed(2)} (GoTrade 0.3%)
Target:    $${target.toFixed(2)}
Stop-loss: $${stopLoss.toFixed(2)}
Est. net:  ${parseFloat(netRet) >= 0 ? '+' : ''}${netRet}%
─────────────────────
${signal}` });
}

// ══════════════════════════════════════════════
//  SMART SELL
// ══════════════════════════════════════════════
function analyzeSell(ticker, amount, username) {
  if (!ticker) return json({ message: '❓ Ticker required.\nExample: SELL AMZN 100' });
  amount = amount || 100;
  const closes = fetchPrices(ticker);
  if (closes.length < 21) return json({ message: '⚠️ Not enough price history for ' + ticker });
  const { current, mean, zScore, rsi } = calcIndicators(closes);
  const profile  = getProfile(username);
  const fee     = Math.max(amount * 0.003, 0.10);
  const zSell   = zScore > profile.zSell;
  const rsiSell = rsi > profile.rSell;

  let posLine = 'No recorded position for ' + ticker;
  let recommendation = '', signal = 'HOLD';
  let positionInfo = null;

  if (username) {
    const h = getUserHoldings(username)[ticker];
    if (h && h.shares > 0.0001) {
      const avgCost = h.invested / h.shares;
      const pnl     = current - avgCost;
      const pnlPct  = pnl / avgCost * 100;
      positionInfo  = { shares: h.shares, avgCost, pnl, pnlPct };
      posLine = `Shares:   ${h.shares.toFixed(4)}
Avg cost: $${avgCost.toFixed(2)}
P&L:      ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) ${pnl >= 0 ? '📈' : '📉'}`;
      if      (pnlPct >= 3)       { signal = 'GOOD_SELL'; recommendation = `✅ Up ${pnlPct.toFixed(1)}% — target hit!`; }
      else if (pnlPct <= -2)      { signal = 'STOP_LOSS'; recommendation = `🛑 Down ${Math.abs(pnlPct).toFixed(1)}% — stop-loss!`; }
      else if (zSell && rsiSell)  { signal = 'GOOD_SELL'; recommendation = '📈 Overbought — good exit point'; }
      else if (zSell || rsiSell)  { signal = 'MIXED';     recommendation = '🟡 Mixed — consider partial sell'; }
      else                        { signal = 'HOLD';       recommendation = '💎 Hold — no strong sell signal'; }
    }
  }
  if (!positionInfo) {
    if      (zSell && rsiSell) { signal = 'GOOD_SELL'; recommendation = 'Technically overbought'; }
    else if (zSell || rsiSell) { signal = 'MIXED';     recommendation = 'Mixed signals'; }
    else                       { signal = 'HOLD';       recommendation = 'No sell signal'; }
  }

  const sigLabel = signal === 'GOOD_SELL' ? '🟢 GOOD TO SELL' : signal === 'STOP_LOSS' ? '🛑 SELL NOW — STOP LOSS' : signal === 'MIXED' ? '🟡 MIXED SIGNALS' : '🔴 HOLD FOR NOW';
  const driftBar = zScore > 3 ? '████░' : zScore > 2 ? '███░░' : zScore > 1 ? '██░░░' : zScore > 0 ? '█░░░░' : '░░░░░';
  const momBar   = rsi > 80 ? '████░' : rsi > 70 ? '███░░' : rsi > 60 ? '██░░░' : rsi > 50 ? '█░░░░' : '░░░░░';

  return json({ type: 'SELL', ticker, current, mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), signal, positionInfo,
    message:
`📊 SELL CHECK: ${ticker}
─────────────────────
Current: $${current.toFixed(2)}
Average: $${mean.toFixed(2)}
Profile: ${profile.label}

Your position:
${posLine}
─────────────────────
Price Drift  [${driftBar}] ${zSell   ? '✅' : '❌'}
Momentum     [${momBar}] ${rsiSell ? '✅' : '❌'}
─────────────────────
Fee:    $${fee.toFixed(2)} (GoTrade)
Advice: ${recommendation}
─────────────────────
${sigLabel}` });
}

// ══════════════════════════════════════════════
//  PORTFOLIO — Record & View
// ══════════════════════════════════════════════
function recordTrade(ticker, tradeType, amount, price, username) {
  if (!ticker || !amount || !price) return json({ message: '❓ Missing fields.\n\nExample:\nUPDATE AMZN B100 185.20' });
  const type   = tradeType === 'B' ? 'BUY' : 'SELL';
  const shares = amount / price;
  const fee    = Math.max(amount * 0.003, 0.10);
  const date   = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet    = ss.getSheetByName('transactions');
  if (!sheet) {
    sheet = ss.insertSheet('transactions');
    sheet.appendRow(['date', 'username', 'ticker', 'type', 'amount_usd', 'price', 'shares', 'fee']);
  }
  sheet.appendRow([date, username || 'tanaka00', ticker, type, amount, price, +shares.toFixed(6), +fee.toFixed(2)]);
  return json({ message:
`✅ TRADE RECORDED
─────────────────────
${ticker} ${type}
User:   ${username || 'tanaka00'}
Amount: $${amount.toFixed(2)}
Price:  $${price.toFixed(4)}
Shares: ${shares.toFixed(4)}
Fee:    $${fee.toFixed(2)}
Date:   ${date}` });
}

function getUserHoldings(username) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('transactions');
  if (!sheet || sheet.getLastRow() <= 1) return {};
  const rows    = sheet.getDataRange().getValues();
  const h       = rows[0];
  const uIdx    = h.indexOf('username');
  const tIdx    = h.indexOf('ticker');
  const typeIdx = h.indexOf('type');
  const aIdx    = h.indexOf('amount_usd');
  const sIdx    = h.indexOf('shares');
  const result  = {};

  rows.slice(1).forEach(r => {
    const rowUser = uIdx >= 0 ? String(r[uIdx]).trim() : 'tanaka00';
    if (username && rowUser !== username) return;
    const ticker = String(r[tIdx]).trim();
    const type   = String(r[typeIdx]).trim();
    const amount = +r[aIdx];
    const shares = +r[sIdx];

    if (!result[ticker]) result[ticker] = { shares: 0, invested: 0, realizedPnl: 0, closed: false };

    if (type === 'BUY') {
      result[ticker].shares   += shares;
      result[ticker].invested += amount;
    } else {
      // Proportional cost basis reduction
      const avgCost = result[ticker].shares > 0 ? result[ticker].invested / result[ticker].shares : 0;
      const costOfSharesSold = avgCost * shares;
      const sellRevenue      = amount; // what we actually got
      result[ticker].realizedPnl += sellRevenue - costOfSharesSold;
      result[ticker].invested    -= costOfSharesSold;
      result[ticker].shares      -= shares;
      // Mark as closed if shares near zero
      if (result[ticker].shares < 0.001) {
        result[ticker].shares   = 0;
        result[ticker].invested = 0;
        result[ticker].closed   = true;
      }
    }
  });
  return result;
}

function portfolio(username) {
  const holdings = getUserHoldings(username);
  const tickers  = Object.keys(holdings).filter(t => holdings[t].shares > 0.0001 || holdings[t].closed);
  if (tickers.length === 0) return json({ message: '💼 Portfolio is empty.\n\nRecord trades with:\nUPDATE AMZN B100 185.20', positions: [] });

  let lines = ['💼 PORTFOLIO — ' + (username || 'all'), '─────────────────────'];
  let totalInvested = 0, totalValue = 0;
  const positions = [];

  for (const ticker of tickers) {
    const h = holdings[ticker];

    // Closed position — show realized P&L, no live price needed
    if (h.closed || h.shares < 0.001) {
      const rpnl    = h.realizedPnl || 0;
      positions.push({ ticker, shares: 0, closed: true, realizedPnl: +rpnl.toFixed(2) });
      lines.push(`${ticker} [CLOSED]\n  Realized P&L: ${rpnl >= 0 ? '+' : ''}$${rpnl.toFixed(2)} ${rpnl >= 0 ? '📈' : '📉'}`);
      continue;
    }

    let price;
    try { const c = fetchPrices(ticker); price = c[c.length - 1]; }
    catch (_) { lines.push(ticker + ' │ ⚠️ Price unavailable'); continue; }
    const value   = h.shares * price;
    const avgCost = h.invested / h.shares;
    const pnl     = value - h.invested;
    const pnlPct  = pnl / h.invested * 100;
    totalInvested += h.invested;
    totalValue    += value;
    positions.push({ ticker, shares: +h.shares.toFixed(4), avgCost: +avgCost.toFixed(2), currentPrice: +price.toFixed(2), value: +value.toFixed(2), pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(1), closed: false });
    lines.push(`${ticker}\n  ${h.shares.toFixed(4)} sh @ avg $${avgCost.toFixed(2)}\n  Now: $${price.toFixed(2)}\n  P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) ${pnl >= 0 ? '📈' : '📉'}`);
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
function getUsersSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let s    = ss.getSheetByName('users');
  if (!s) {
    s = ss.insertSheet('users');
    s.appendRow(['username', 'password', 'watchlist']);
    s.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }
  return s;
}

function getUserRow(sheet, username) {
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const uCol    = headers.indexOf('username');
  const pCol    = headers.indexOf('password');
  const wCol    = headers.indexOf('watchlist');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][uCol >= 0 ? uCol : 0]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      return { row: i + 1, data: rows[i], uCol, pCol, wCol: wCol >= 0 ? wCol : 2 };
    }
  }
  return null;
}

function getWatchlist(found) {
  const wCol = found.wCol >= 0 ? found.wCol : 2;
  return (found.data[wCol] || '').toString().split(',').map(t => t.trim()).filter(Boolean);
}

function watchlistAdd(username, ticker) {
  if (!ticker) return promptWatchlist();
  const sheet = getUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found: ' + username + '\n\nCheck the users sheet.' });
  const list = getWatchlist(found);
  if (!list.includes(ticker.toUpperCase())) list.push(ticker.toUpperCase());
  sheet.getRange(found.row, found.wCol + 1).setValue(list.join(','));
  return json({ message: '✅ Added ' + ticker + ' to watchlist.\n\nWatchlist: ' + list.join(', '), watchlist: list });
}

function watchlistRemove(username, ticker) {
  if (!ticker) return promptWatchlist();
  const sheet = getUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found: ' + username });
  const list = getWatchlist(found).filter(t => t !== ticker.toUpperCase());
  sheet.getRange(found.row, found.wCol + 1).setValue(list.join(','));
  return json({ message: '✅ Removed ' + ticker + '.\n\nWatchlist: ' + (list.join(', ') || 'empty'), watchlist: list });
}

function watchlistList(username) {
  const sheet = getUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });
  const list = getWatchlist(found);
  return json({ message: '📋 Watchlist:\n' + (list.length ? list.join(', ') : 'empty') + '\n\nWATCHLIST SCAN to analyze all', watchlist: list });
}

function watchlistScan(username) {
  const sheet = getUsersSheet();
  const found = getUserRow(sheet, username);
  if (!found) return json({ message: '⚠️ User not found.' });
  const list = getWatchlist(found);
  if (!list.length) return json({ message: '📋 Watchlist is empty.\n\nWATCHLIST ADD AMZN', results: [] });

  const results = [];
  for (const ticker of list) {
    try {
      const closes = fetchPrices(ticker);
      if (closes.length < 21) { results.push({ ticker, error: 'Not enough data' }); continue; }
      const { current, mean, zScore, rsi } = calcIndicators(closes);
      const prof = getProfile(username);
      const zOk = zScore < prof.zBuy, rsiOk = rsi < prof.rBuy, zSell = zScore > prof.zSell, rsiSell = rsi > prof.rSell;
      let signal = 'HOLD';
      if      (zOk   && rsiOk)    signal = 'BUY';
      else if (zOk   || rsiOk)    signal = 'WEAK_BUY';
      else if (zSell && rsiSell)  signal = 'SELL';
      else if (zSell || rsiSell)  signal = 'WEAK_SELL';
      results.push({ ticker, current: +current.toFixed(2), mean: +mean.toFixed(2), zScore: +zScore.toFixed(2), rsi: +rsi.toFixed(1), signal });
    } catch (err) { results.push({ ticker, error: err.message }); }
  }

  const sigMap = { BUY: '🟢 BUY', WEAK_BUY: '🟡 WEAK BUY', SELL: '🔴 SELL', WEAK_SELL: '🟠 WEAK SELL', HOLD: '⚪ HOLD' };
  const lines  = ['📡 WATCHLIST SCAN', '─────────────────────'];
  results.forEach(r => {
    if (r.error) { lines.push(`${r.ticker}: ⚠️ ${r.error}`); return; }
    lines.push(`${r.ticker.padEnd(5)} $${String(r.current).padEnd(8)} ${sigMap[r.signal] || r.signal}`);
  });
  return json({ message: lines.join('\n'), results });
}

// ══════════════════════════════════════════════
//  SET BOT COMMANDS — run once manually in GAS
// ══════════════════════════════════════════════
function setTelegramCommands() {
  const commands = [
    { command: 'start',     description: 'Welcome & status' },
    { command: 'help',      description: 'Show all commands' },
    { command: 'login',     description: 'Sign in to the bot' },
    { command: 'logout',    description: 'Sign out' },
    { command: 'buy',       description: 'Analyze buy signal' },
    { command: 'sell',      description: 'Smart sell analysis' },
    { command: 'update',    description: 'Record a trade' },
    { command: 'check',     description: 'View portfolio and P&L' },
    { command: 'watchlist', description: 'Manage and scan watchlist' }
  ];
  const resp = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + BOT_TOKEN + '/setMyCommands',
    { method: 'POST', contentType: 'application/json', payload: JSON.stringify({ commands }) }
  );
  Logger.log(resp.getContentText());
}


// ══════════════════════════════════════════════
//  DEBUG — test this URL in browser to verify GAS is live
//  URL: YOUR_GAS_URL?debug=1
// ══════════════════════════════════════════════
function testSetup() {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheets = ss.getSheets().map(s => s.getName());
    Logger.log('Sheets: ' + sheets.join(', '));
    // Ensure all required sheets exist
    ['users','sessions','transactions'].forEach(name => {
      if (!ss.getSheetByName(name)) {
        Logger.log('Creating sheet: ' + name);
      }
    });
    Logger.log('Setup OK');
  } catch(e) {
    Logger.log('Error: ' + e.toString());
  }
}


// ══════════════════════════════════════════════
//  FREE USAGE TRACKING (5 free per Telegram user)
// ══════════════════════════════════════════════
function getUsageSheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let s    = ss.getSheetByName('usage');
  if (!s) {
    s = ss.insertSheet('usage');
    s.appendRow(['telegram_id', 'telegram_username', 'use_count', 'first_used', 'last_used', 'chat_id']);
  }
  return s;
}

function checkAndIncrementUsage(tgUsername, tgId, chatId) {
  const FREE_LIMIT = 5;
  const sheet = getUsageSheet();
  const rows  = sheet.getDataRange().getValues();

  // Find existing row by tgId or tgUsername
  for (let i = 1; i < rows.length; i++) {
    const rowId   = String(rows[i][0]).trim();
    const rowUser = String(rows[i][1]).trim();
    if ((tgId && rowId === tgId) || (tgUsername && rowUser === tgUsername)) {
      const count = parseInt(rows[i][2] || 0) + 1;
      // Update row
      sheet.getRange(i + 1, 1, 1, 6).setValues([[
        tgId || rowId,
        tgUsername || rowUser,
        count,
        rows[i][3] || new Date().toISOString(),
        new Date().toISOString(),
        chatId
      ]]);
      return { allowed: count <= FREE_LIMIT, count, remaining: Math.max(0, FREE_LIMIT - count) };
    }
  }

  // New user — first use
  sheet.appendRow([tgId, tgUsername, 1, new Date().toISOString(), new Date().toISOString(), chatId]);
  return { allowed: true, count: 1, remaining: FREE_LIMIT - 1 };
}

function updateSessionTgUsername(chatId, tgUsername) {
  try {
    const sheet = getSessionSheet();
    const rows  = sheet.getDataRange().getValues();
    const headers = rows[0];
    // Add tgUsername column if not exists
    let tgCol = headers.indexOf('tg_username');
    if (tgCol === -1) {
      sheet.getRange(1, headers.length + 1).setValue('tg_username');
      tgCol = headers.length;
    }
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === String(chatId).trim()) {
        sheet.getRange(i + 1, tgCol + 1).setValue(tgUsername);
        return;
      }
    }
  } catch(e) { /* non-critical */ }
}

// ══════════════════════════════════════════════
//  PROFILE COMMAND
// ══════════════════════════════════════════════
function promptProfile() {
  return json({ message:
`⚙️ RISK PROFILE

Set how sensitive your buy/sell signals are.

Choose your profile:

🟢 PROFILE LOW
  Conservative — only the strongest signals
  Best for: beginners, long-term holders
  More patient, fewer but safer signals

🟡 PROFILE MEDIUM
  Balanced — standard signals (default)
  Best for: most investors
  Good balance of opportunity and safety

🔴 PROFILE HIGH
  Aggressive — catches smaller moves
  Best for: active traders
  More signals, higher risk

Type one of the above to set your profile.` });
}

// ══════════════════════════════════════════════
//  EXPLAIN COMMAND
// ══════════════════════════════════════════════
function sendExplain(topic) {
  const t = (topic || '').toUpperCase();

  const buyExplain =
`📖 UNDERSTANDING BUY RESULTS

📊 BUY CHECK: AMZN
─────────────────────
Trade:   $100    ← How much you plan to invest
Current: $185    ← Today's stock price
Average: $190    ← Normal price (20-day average)
Profile: 🟡 Medium Risk ← Your risk setting
─────────────────────
Price Drift  [████░] ✅
  How far the price has FALLEN below its
  average. More bars = bigger drop.
  ✅ means it's fallen enough to be a
  potential buying opportunity.

Momentum     [███░░] ✅
  How fast the price is moving DOWN.
  More bars = stronger oversold condition.
  ✅ means momentum supports buying.
─────────────────────
Fee:       $0.30  ← GoTrade trading fee
Target:    $190   ← Price we expect it to reach
Stop-loss: $181   ← Sell here if things go wrong
Est. net:  +2.4% ← Expected profit after fees
─────────────────────
🟢 GOOD TO BUY  ← Both signals are green
🟡 MIXED        ← Only one signal is green
🔴 NOT YET      ← Neither signal is green`;

  const sellExplain =
`📖 UNDERSTANDING SELL RESULTS

📊 SELL CHECK: AMZN
─────────────────────
Current: $195    ← Today's stock price
Average: $190    ← Normal price (20-day average)

Your position:
  Shares:   0.54  ← How many shares you hold
  Avg cost: $185  ← What you paid per share
  P&L: +$5.40 (2.9%) 📈 ← Your current profit
─────────────────────
Price Drift  [███░░] ✅
  How far the price has RISEN above its
  average. More bars = bigger rise above normal.
  ✅ means it may be a good time to sell.

Momentum     [██░░░] ✅
  How fast the price is moving UP.
  More bars = stronger overbought condition.
  ✅ means momentum supports selling.
─────────────────────
Advice: Up 2.9% — profit target reached!
─────────────────────
🟢 GOOD TO SELL   ← Strong sell signal
🛑 STOP LOSS      ← Down 2%+ → cut losses
🟡 MIXED SIGNALS  ← Weak signal
🔴 HOLD FOR NOW   ← No sell signal yet`;

  if (t === 'BUY')  return json({ message: buyExplain });
  if (t === 'SELL') return json({ message: sellExplain });

  // Default: show both with choice
  return json({ message:
`📖 WHAT DO THE RESULTS MEAN?

Type one of the following for a full guide:

EXPLAIN BUY  → Understand BUY results
EXPLAIN SELL → Understand SELL results

Quick summary:

Price Drift [████░]
  How far price moved from its average.
  More bars = bigger move.

Momentum [███░░]
  How fast price is moving.
  More bars = stronger trend.

✅ = Signal supports the trade
❌ = Signal does not support it

Your Profile (LOW / MEDIUM / HIGH) sets
how sensitive these signals are.` });
}

// ══════════════════════════════════════════════
//  REGISTER COMMAND
// ══════════════════════════════════════════════
function sendRegisterInfo() {
  return json({ message:
`🌟 JOIN TANAKA STOCK TERMINAL

You've been enjoying the free analysis tools —
thank you for being here! 🙏

To continue with full, unlimited access,
we warmly invite you to support this project.

━━━━━━━━━━━━━━━━━━━━━
📬 Contact for Registration:
    @ikhwantan on Telegram

💝 One-time contribution: IDR 49,000
━━━━━━━━━━━━━━━━━━━━━

Think of it less as a fee and more as
a small act of kindness — a way to help
keep this project alive and growing for
everyone who uses it.

What you get:
✅ Unlimited BUY/SELL analysis
✅ Portfolio tracking
✅ Watchlist scanning
✅ Access to all future features
✅ Lifetime access*

*As long as the project continues to run.
We'll always do our best to keep it going,
but we can't make promises about forever —
technology changes, and so does life.

📋 Please note: Contributions are
non-refundable, as they go directly toward
maintaining and improving this project.

━━━━━━━━━━━━━━━━━━━━━
Ready? Just message @ikhwantan 😊` });
}

// ══════════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════════
function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

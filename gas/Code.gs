// ══════════════════════════════════════════════
//  TANAKA US STOCK BOT — Google Apps Script v3
// ══════════════════════════════════════════════

// Secrets: Apps Script → Project Settings → Script properties (not in source control).
//   SPREADSHEET_ID — Google Sheet id from the sheet URL
//   BOT_TOKEN      — Telegram bot token from @BotFather
var __cfgSpreadsheetId;
var __cfgBotToken;
function getSpreadsheetId_() {
  if (__cfgSpreadsheetId) return __cfgSpreadsheetId;
  const v = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!v || !String(v).trim()) {
    throw new Error('Missing Script property SPREADSHEET_ID. Project Settings → Script properties.');
  }
  __cfgSpreadsheetId = String(v).trim();
  return __cfgSpreadsheetId;
}
function getBotToken_() {
  if (__cfgBotToken) return __cfgBotToken;
  const v = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!v || !String(v).trim()) {
    throw new Error('Missing Script property BOT_TOKEN. Project Settings → Script properties.');
  }
  __cfgBotToken = String(v).trim();
  return __cfgBotToken;
}

// Deployed JSON list (repo: gas/watch-tickers.json → /api/watch-tickers). Override via Script Properties key WATCH_TICKERS_JSON_URL if needed.
const WATCH_TICKERS_JSON_URL_DEFAULT = 'https://tanaka-stock-analyzer.vercel.app/api/watch-tickers';
const WATCH_TICKERS_CACHE_KEY        = 'watch_tickers_deduped_v2';
const WATCH_TICKERS_CACHE_SEC        = 3600;

/** If fetch fails, scan still runs on this minimal set */
const WATCH_TICKERS_FALLBACK = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA'];

const SCAN_SESSION_PROP = 'market_scan_session_v1';
/** Tickers processed per HTTP request (web) or per inner step (Telegram multi-step) */
/** Keep small so each GAS chunk finishes before Vercel/proxy timeouts (e.g. HTTP 504). */
const SCAN_CHUNK_SIZE = 10;
/** Top Mover scan: exclude stocks at or below this USD price (must be strictly above). */
const TOP_MOVER_MIN_PRICE_USD = 5;
/** Only this web user may run SCAN-INIT (market scan). */
const MARKET_SCAN_WEB_USER = 'tanaka00';
const TOP_MOVER_LIVE_CACHE_KEY = 'TOP_MOVER_LIVE_';
const TOP_MOVER_CACHE_TTL_SEC  = 21600;

function isMarketScanWebUser_(u) {
  return String(u || '').trim().toLowerCase() === MARKET_SCAN_WEB_USER;
}

/** Web-only SCAN-INIT; Telegram gets a redirect message. */
function scanInitFromRouter_(parts, chatId) {
  if (chatId) {
    return json({
      message:
        '🔒 The market scan runs only on the Tanaka Stock web app.\n\n' +
        'Tap CHECK-TOP-MOVER (or type CHECK-TOP-MOVER) to see today\'s list — it updates while the scan runs.'
    });
  }
  const webScanner = (parts[1] || '').trim().toLowerCase();
  if (!webScanner) {
    return json({ success: false, message: '🔒 Use the web app while signed in as tanaka00 to run the market scan.' });
  }
  if (!isMarketScanWebUser_(webScanner)) {
    return json({ success: false, message: '🔒 Only user tanaka00 can run the market scan from the web app.' });
  }
  return scanInit(webScanner, '');
}

function getWatchTickersJsonUrl() {
  try {
    const u = PropertiesService.getScriptProperties().getProperty('WATCH_TICKERS_JSON_URL');
    if (u && String(u).trim()) return String(u).trim();
  } catch (e) {}
  return WATCH_TICKERS_JSON_URL_DEFAULT;
}

function dedupeTickerStrings(arr) {
  const seen = {};
  const out  = [];
  for (let i = 0; i < arr.length; i++) {
    const t = String(arr[i]).trim().toUpperCase();
    if (!t || seen[t]) continue;
    seen[t] = true;
    out.push(t);
  }
  return out;
}

/**
 * Full scan universe: fetched from Vercel /api/watch-tickers (gas/watch-tickers.json), cached 1h.
 */
function getDedupedWatchTickers() {
  const cache = CacheService.getScriptCache();
  const hit   = cache.get(WATCH_TICKERS_CACHE_KEY);
  if (hit) {
    try {
      const parsed = JSON.parse(hit);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {}
  }
  let list = [];
  try {
    const url  = getWatchTickersJsonUrl();
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects:    true,
      headers:          { 'User-Agent': 'TanakaStockBot/1.0', 'Accept': 'application/json' }
    });
    if (resp.getResponseCode() !== 200) throw new Error('HTTP ' + resp.getResponseCode());
    const arr = JSON.parse(resp.getContentText());
    if (!Array.isArray(arr)) throw new Error('not an array');
    list = dedupeTickerStrings(arr);
  } catch (e) {
    list = dedupeTickerStrings(WATCH_TICKERS_FALLBACK);
  }
  if (list.length) {
    try {
      cache.put(WATCH_TICKERS_CACHE_KEY, JSON.stringify(list), WATCH_TICKERS_CACHE_SEC);
    } catch (e) {
      /* list may exceed 100KB Script Cache limit — scan still works without cache */
    }
  }
  return list;
}

// ── Risk Profile Thresholds ───────────────────
const PROFILES = {
  LOW:    { zBuy: -2.0, rBuy: 25, zSell: 2.0, rSell: 75, label: '🟢 Low Risk',    emoji: '🟢' },
  MEDIUM: { zBuy: -1.5, rBuy: 35, zSell: 1.5, rSell: 65, label: '🟡 Medium Risk', emoji: '🟡' },
  HIGH:   { zBuy: -1.0, rBuy: 45, zSell: 1.0, rSell: 55, label: '🔴 High Risk',   emoji: '🔴' }
};

function getProfile(username) {
  if (!username) return PROFILES.MEDIUM;
  try {
    const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
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
  const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
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
      return json({ status: 'OK', version: 'v3', spreadsheetId: getSpreadsheetId_(), timestamp: new Date().toISOString() });
    }
    if (msg) {
      const tgU = (e.parameter.tgUsername || '').toString().trim();
      const tgI = (e.parameter.tgId || '').toString().trim();
      return handleMessage(msg, chatId, tgU, tgI);
    }

    // Legacy web frontend calls
    const type = e.parameter.type;
    if (type === 'AUTH')    return json(checkCredentials(e.parameter.username, e.parameter.password));
    if (type === 'ANALYZE') return analyze(e.parameter.ticker, parseFloat(e.parameter.amount) || 100, e.parameter.analyzeType, e.parameter.username);
    if (type === 'UPDATE')  return recordTrade(e.parameter.ticker, e.parameter.tradeType, parseFloat(e.parameter.amount), parseFloat(e.parameter.price), e.parameter.username);
    if (type === 'CHECK')   return portfolio(e.parameter.username);
    if (type === 'DEPOSIT')  return recordCashFlow('DEPOSIT',  parseFloat(e.parameter.amount), e.parameter.username);
    if (type === 'WITHDRAW') return recordCashFlow('WITHDRAW', parseFloat(e.parameter.amount), e.parameter.username);
    if (type === 'SCAN_INIT') {
      const u = (e.parameter.username || '').trim().toLowerCase();
      if (!isMarketScanWebUser_(u)) return json({ success: false, message: 'Forbidden.' });
      return scanInit(u, '');
    }
    if (type === 'CHECK_GOOD_STOCK' || type === 'CHECK_TOP_MOVER') return checkTopMover();
    return json({ message: '⚠️ No command provided.' });

  } catch (err) {
    return json({ message: '⚠️ Server error: ' + err.toString() });
  }
}

/**
 * Telegram webhook (Vercel) should POST JSON here — avoids long query strings and encoding issues.
 * Body: { message, chatId, tgUsername, tgId }
 */
function doPost(e) {
  try {
    var msg = '';
    var chatId = '';
    var tgU = '';
    var tgI = '';
    if (e.postData && e.postData.contents) {
      var ctype = String(e.postData.type || '').toLowerCase();
      if (ctype.indexOf('json') >= 0) {
        var b = JSON.parse(e.postData.contents);
        msg    = String(b.message || '').trim();
        chatId = String(b.chatId || '').trim();
        tgU    = String(b.tgUsername || '').trim();
        tgI    = String(b.tgId || '').trim();
      }
    }
    if (msg) return handleMessage(msg, chatId, tgU, tgI);
    return json({ message: '⚠️ No message in POST body.' });
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

  // ── Define session early so it's available everywhere ──
  const session     = getSession(chatId);
  const sessionUser = session ? session.username : '';

  // ── Always-public commands ──
  if (cmd === 'START')    return sendWelcome(chatId, tgUsername);
  if (cmd === 'HELP')     return sendHelp(chatId);
  if (cmd === 'REGISTER') return sendRegisterInfo();
  if (cmd === 'EXPLAIN')  return sendExplain(parts[1] || '');
  if (cmd === 'SCAN-INIT' || cmd === 'SCANINIT') return scanInitFromRouter_(parts, chatId);
  if (cmd === 'SCAN-PROGRESS' || cmd === 'SCANPROGRESS' || cmd === 'SCAN_PROGRESS') return getMarketScanProgress();
  if (cmd === 'CHECK-TOP-MOVER' || cmd === 'CHECKTOPMOVER' || cmd === 'CHECK_TOP_MOVER' ||
      cmd === 'CHECK-GOOD-STOCK' || cmd === 'CHECKGOODSTOCK' || cmd === 'CHECK_GOOD_STOCK') return checkTopMover();
  if (cmd === 'GETPROFILE') {
    // Web app calls: GETPROFILE username — returns current profile from sheet
    const uGP = parts[1] || '';
    if (!uGP) return json({ profile: 'MEDIUM' });
    const p = getProfile(uGP);
    const key = Object.keys(PROFILES).find(k => PROFILES[k] === p) || 'MEDIUM';
    return json({ profile: key, label: p.label });
  }
  if (cmd === 'PROFILE')  { /* handled below with auth */ }

  // ── Menu taps with NO args → show instruction prompt ──
  if (!hasArgs) {
    if (cmd === 'LOGIN' || cmd === 'AUTH') return promptLogin();
    if (cmd === 'LOGOUT')    return handleLogout(chatId);
    if (cmd === 'REGISTER')  return sendRegisterInfo();
    if (cmd === 'EXPLAIN')   return sendExplain('');
    if (cmd === 'PROFILE')   return promptProfile();
    if (cmd === 'BALANCE')   return getBalance(sessionUser);
    if (cmd === 'DEPOSIT')   return promptDeposit();
    if (cmd === 'WITHDRAW')  return promptWithdraw();
    if (cmd === 'CLEAR')     return promptClear();
    if (cmd === 'BUY')       return promptBuy();
    if (cmd === 'SELL')      return promptSell();
    if (cmd === 'UPDATE')    return promptUpdate();
    if (cmd === 'CHECK')     return runCheck(chatId, tgUsername, tgId, sessionUser);
    if (cmd === 'SCAN-PROGRESS' || cmd === 'SCANPROGRESS' || cmd === 'SCAN_PROGRESS') return getMarketScanProgress();
    if (cmd === 'CHECK-TOP-MOVER' || cmd === 'CHECKTOPMOVER' || cmd === 'CHECK_TOP_MOVER' ||
        cmd === 'CHECK-GOOD-STOCK' || cmd === 'CHECKGOODSTOCK' || cmd === 'CHECK_GOOD_STOCK') return checkTopMover();
    if (cmd === 'WATCHLIST') return promptWatchlist();
    return sendHelp(chatId);
  }

  // ── Commands with args ──
  if (cmd === 'LOGIN' || cmd === 'AUTH') return handleLogin(parts, chatId);
  if (cmd === 'LOGOUT') return handleLogout(chatId);

  // ── Auth wall + free usage tracking ──
  const isTelegram = !!chatId; // chatId always present for Telegram, empty for web

  if (!session) {
    if (isTelegram) {
      // Telegram user not logged in — check free usage (tracked by chatId)
      const usageResult = checkAndIncrementUsage(tgUsername, tgId || chatId, chatId);
      if (!usageResult.allowed) {
        return json({ message:
`⏰ FREE LIMIT REACHED

You've used all 5 free analyses.

To keep going, get full access:
👉 Tap /register

Contact @ikhwantan for registration.
One-time contribution: IDR 49,000` });
      }
    } else {
      // Web app path — MUST be logged in, no free uses allowed
      // Extract username based on command format:
      // WATCHLIST ADD/REMOVE: parts[2] is username (ticker is last)
      // BALANCE/CLEAR/PROFILE: parts[1] is username
      // All others: last token is username
      let webUser = '';
      if (cmd === 'WATCHLIST') {
        const sub = (parts[1] || '').toUpperCase();
        if (sub === 'ADD' || sub === 'REMOVE') {
          webUser = parts[2] || ''; // WATCHLIST ADD username TICKER
        } else {
          webUser = parts[parts.length - 1] || ''; // WATCHLIST LIST/SCAN username
        }
      } else if (cmd === 'PROFILE') {
        webUser = parts[2] || ''; // PROFILE KEY username → username at parts[2]
      } else if (cmd === 'BALANCE' || cmd === 'CLEAR') {
        webUser = parts[1] || ''; // BALANCE username / CLEAR username YES
      } else if (cmd === 'DEPOSIT' || cmd === 'WITHDRAW') {
        webUser = parts[1] || ''; // DEPOSIT username amount / WITHDRAW username amount
      } else {
        webUser = parts[parts.length - 1] || ''; // BUY/SELL/UPDATE/CHECK username
      }
      if (!webUser || !isValidUser(webUser)) {
        return json({ success: false, unauthorized: true, message: '🔒 Please login to use this feature.' });
      }
      // Valid web user — continue
    }
  }

  // Store Telegram username in session if logged in
  if (session && tgUsername && !session.tgUsername) {
    updateSessionTgUsername(chatId, tgUsername);
  }

  // Username priority: 1) Telegram session, 2) embedded in message (web app)
  // Web app always appends username to commands: BUY AMZN 100 username

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
    // Telegram: CHECK (username from session)
    // Web app:  CHECK username (parts[1] = username)
    const uChk = sessionUser || parts[1] || '';
    return runCheck(chatId, tgUsername, tgId, uChk);
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
  if (cmd === 'BALANCE') {
    // Telegram: BALANCE          → show balance (username from session)
    // Telegram: BALANCE 500      → set balance (username from session)
    // Web app:  BALANCE username → show balance
    // Web app:  BALANCE username 500 → set balance
    if (sessionUser) {
      // Telegram path
      if (parts.length >= 2 && !isNaN(parseFloat(parts[1]))) {
        return setBalance(sessionUser, parseFloat(parts[1]));
      }
      return getBalance(sessionUser);
    } else {
      // Web app path (no session)
      const uBal = parts[1] || '';
      if (parts.length >= 3 && !isNaN(parseFloat(parts[2]))) {
        return setBalance(uBal, parseFloat(parts[2]));
      }
      return getBalance(uBal);
    }
  }
  if (cmd === 'DEPOSIT') {
    const uDep = sessionUser || parts[1] || '';
    const amt  = sessionUser ? parseFloat(parts[1]) : parseFloat(parts[2]);
    if (isNaN(amt) || amt <= 0) return promptDeposit();
    return recordCashFlow('DEPOSIT', amt, uDep);
  }
  if (cmd === 'WITHDRAW') {
    const uWit = sessionUser || parts[1] || '';
    const amt  = sessionUser ? parseFloat(parts[1]) : parseFloat(parts[2]);
    if (isNaN(amt) || amt <= 0) return promptWithdraw();
    return recordCashFlow('WITHDRAW', amt, uWit);
  }

  if (cmd === 'CLEAR') {
    const uClr = sessionUser || parts[1] || '';
    const confirmed = (parts[parts.length - 1] || '').toUpperCase() === 'YES';
    if (!confirmed) return promptClear();
    return clearPortfolio(uClr);
  }

  if (cmd === 'SCAN' && (parts[1] || '').toUpperCase() === 'INIT') {
    if (chatId) {
      return json({ message: '🔒 Market scan runs only on the Tanaka Stock web app.\n\nUse CHECK-TOP-MOVER to see today\'s top movers.' });
    }
    const webScanner = (parts[2] || '').trim().toLowerCase();
    if (!isMarketScanWebUser_(webScanner)) {
      return json({ success: false, message: '🔒 Only tanaka00 can run the market scan from the web app.' });
    }
    return scanInit(webScanner, '');
  }
  if ((cmd === 'CHECK' && (parts[1] || '').toUpperCase() === 'GOOD') || cmd === 'CHECKGOODSTOCK' || cmd === 'CHECK-GOOD-STOCK' || cmd === 'CHECK_GOOD_STOCK') {
    return checkTopMover();
  }
  if (cmd === 'CHECK' && (parts[1] || '').toUpperCase() === 'TOP' && (parts[2] || '').toUpperCase() === 'MOVER') {
    return checkTopMover();
  }

  return json({ message: `❓ Unknown command: ${cmd}\n\nTap /help to see all commands.` });
}

function runCheck(chatId, tgUsername, tgId, webUsername) {
  const session    = getSession(chatId);
  const isTelegram = !!chatId;
  if (!session) {
    if (isTelegram) {
      // /check without LOGIN used to call portfolio('') which merged ALL users' rows and timed out
      return json({ message:
`🔒 LOGIN REQUIRED

To view your portfolio:
LOGIN username password

Example:
LOGIN tanaka00 yourpassword` });
    }
    if (!webUsername || !isValidUser(webUsername)) {
      return json({ message: '🔒 You are not logged in. Please login first.' });
    }
  }
  // hideClose: always hide closed/sold positions in /check (both Telegram and web)
  const hideClose = true;
  return portfolio(session ? session.username : webUsername || '', hideClose);
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

This checks price momentum and drift,
then gives you a clear signal.` });
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
PRICE = price per share

💵 CASH FLOW
DEPOSIT 500   → deposit funds (free)
WITHDRAW 200  → withdraw funds ($5 fee)` });
}

function promptDeposit() {
  return json({ message:
`💵 DEPOSIT FUNDS

GoTrade deposit fee: FREE

Type:
DEPOSIT amount
Example: DEPOSIT 500

Updates your portfolio balance
and records the transaction.` });
}

function promptWithdraw() {
  return json({ message:
`🏦 WITHDRAW FUNDS

GoTrade withdrawal fee: $5.00 flat

Type:
WITHDRAW amount
Example: WITHDRAW 200

The $5 fee is automatically deducted
from your portfolio balance.` });
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
  // Password may contain spaces — use everything after username
  const password = parts.slice(2).join(' ').trim();
  const result   = checkCredentials(username, password);

  if (result.success) {
    if (chatId) createSession(chatId, result.username);
    return json({
      success:   true,
      username:  result.username,
      watchlist: result.watchlist || '',
      profile:   result.profile   || 'MEDIUM',
      message:
`✅ LOGIN SUCCESSFUL

Welcome, ${result.username.toUpperCase()}! 👋

You now have full access.
Tap /help to see all commands.

─────────────────────
📋 By using this service you agree to our Terms & Conditions:
https://tanaka-stock-analyzer.vercel.app/terms
─────────────────────
⚠️ Not financial advice. Trade at your own risk. No profit is guaranteed. Not affiliated with GoTrade.`
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
  if (!session && chatId) {
    const sheet = getUsageSheet();
    const rows  = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const rowChatId  = String(rows[i][5] || '').trim();
      const rowTgId    = String(rows[i][0] || '').trim();
      const rowUser    = String(rows[i][1] || '').trim();
      const match = (chatId && rowChatId === chatId)
                 || (tgUsername && rowUser === tgUsername);
      if (match) {
        const used      = parseInt(rows[i][2] || 0);
        const remaining = Math.max(0, 5 - used);
        usageInfo = remaining > 0
          ? `\n🆓 Free uses left: ${remaining}/5`
          : '\n⏰ Free limit reached — /register for full access';
        break;
      }
    }
    if (!usageInfo) usageInfo = '\n🆓 Free uses left: 5/5';
  }

  return json({ message:
`🏦 TANAKA US STOCK TERMINAL

${session ? '✅ Logged in as: ' + session.username.toUpperCase() : '🔒 Not logged in' + usageInfo}

${session
  ? 'Tap any command from the menu\nor type HELP to see all options.'
  : 'To get started, tap LOGIN\nor type: LOGIN username password\n\nType REGISTER to learn about full access.'}

` });
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
BALANCE amount → Set initial balance
→ Example: BALANCE 1000
CLEAR YES → Reset portfolio

📡 WATCHLIST
WATCHLIST ADD TICKER
WATCHLIST REMOVE TICKER
WATCHLIST LIST
WATCHLIST SCAN

📉 TOP MOVER (daily market drop scan)
CHECK-TOP-MOVER → Live list while the scan runs; full list when done
(The market scan itself runs on the web app only.)
─────────────────────
Tap any menu command for
step-by-step instructions.

─────────────────────
📋 Terms & Conditions:
https://tanaka-stock-analyzer.vercel.app/terms
⚠️ Not financial advice. No profit guaranteed.` });
}

// ══════════════════════════════════════════════
//  SESSION MANAGEMENT (Google Sheets)
// ══════════════════════════════════════════════
function getSessionSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
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

  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  let s    = ss.getSheetByName('users');
  if (!s) {
    s = ss.insertSheet('users');
    s.appendRow(['username', 'password', 'watchlist']);
    s.appendRow(['tanaka00', 'Q1w2_e3r4', 'AMZN,AAPL,NVDA']);
  }

  const allRows = s.getDataRange().getValues();
  const headers = allRows[0].map(h => String(h).trim().toLowerCase());
  const uCol  = Math.max(headers.indexOf('username'), 0);
  const pCol  = headers.indexOf('password') >= 0 ? headers.indexOf('password') : 1;
  const wCol  = headers.indexOf('watchlist') >= 0 ? headers.indexOf('watchlist') : 2;
  const prCol = headers.indexOf('risk_profile');
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    const u = String(r[uCol]).trim();
    const p = String(r[pCol]).trim();
    if (u.toLowerCase() === String(username).trim().toLowerCase() && p === String(password).trim()) {
      const rawProfile = prCol >= 0 ? String(r[prCol] || '').trim().toUpperCase() : '';
      const profile    = ['LOW','MEDIUM','HIGH'].includes(rawProfile) ? rawProfile : 'MEDIUM';
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
  const ss     = SpreadsheetApp.openById(getSpreadsheetId_());
  let sheet    = ss.getSheetByName('transactions');
  if (!sheet) {
    sheet = ss.insertSheet('transactions');
    sheet.appendRow(['date', 'username', 'ticker', 'type', 'amount_usd', 'price', 'shares', 'fee']);
  }
  sheet.appendRow([date, username || 'tanaka00', ticker, type, amount, price, +shares.toFixed(6), +fee.toFixed(2)]);
  SpreadsheetApp.flush(); // Force write to complete immediately
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
  const u = String(username || '').trim();
  if (!u) return {};
  SpreadsheetApp.flush(); // Ensure all pending writes are committed before reading
  const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
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
    if (rowUser.toLowerCase() !== u.toLowerCase()) return;
    const ticker = String(r[tIdx]).trim();
    const type   = String(r[typeIdx]).trim();
    // Skip CASH rows — DEPOSIT/WITHDRAW affect balance only, not stock holdings
    if (ticker === 'CASH') return;
    const amount = +r[aIdx];
    const shares = +r[sIdx];

    if (!result[ticker]) result[ticker] = { shares: 0, invested: 0, realizedPnl: 0, closed: false, hasSell: false };

    if (type === 'BUY') {
      result[ticker].shares   += shares;
      result[ticker].invested += amount;
    } else {
      // Proportional cost basis reduction
      result[ticker].hasSell = true;
      const avgCost          = result[ticker].shares > 0 ? result[ticker].invested / result[ticker].shares : 0;
      const costOfSharesSold = avgCost * shares;
      result[ticker].realizedPnl += amount - costOfSharesSold; // sell revenue - cost basis
      result[ticker].invested    -= costOfSharesSold;
      result[ticker].shares      -= shares;
      // Only mark as closed if there was a SELL and remaining shares ≤ 0.1
      // This prevents small legitimate BUY-only positions from being marked closed
      if (result[ticker].hasSell && result[ticker].shares <= 0.1) {
        result[ticker].shares   = 0;
        result[ticker].invested = 0;
        result[ticker].closed   = true;
      }
    }
  });
  // Final pass: re-open any position that has shares > 0
  // Handles: sell all → closed → buy again → must show as open position
  Object.keys(result).forEach(ticker => {
    const h = result[ticker];
    if (h.shares > 0) {
      h.closed  = false; // New buy after full sell — position is open again
    }
    if (h.shares < 0) h.shares = 0; // Guard against data entry errors
  });

  return result;
}

function portfolio(username, hideClose) {
  const holdings = getUserHoldings(username);
  // Show: open positions (any share count) + closed positions (had a sell)
  const tickers  = Object.keys(holdings).filter(t => t && (
    holdings[t].shares > 0 || holdings[t].closed
  ));
  if (tickers.length === 0) return json({ message: '💼 Portfolio is empty.\n\nRecord trades with:\nUPDATE AMZN B100 185.20', positions: [] });

  let lines = ['💼 PORTFOLIO — ' + (username || 'all'), '─────────────────────'];
  let totalInvested = 0, totalValue = 0, totalRealizedPnl = 0;
  const positions = [];

  for (const ticker of tickers) {
    const h = holdings[ticker];

    // Closed position — show realized P&L, no live price needed
    if (h.closed) {
      const rpnl = h.realizedPnl || 0;
      totalRealizedPnl += rpnl;
      positions.push({ ticker, shares: 0, closed: true, realizedPnl: +rpnl.toFixed(2) });
      if (!hideClose) {
        lines.push(`${ticker} [CLOSED]\n  Realized P&L: ${rpnl >= 0 ? '+' : ''}$${rpnl.toFixed(2)} ${rpnl >= 0 ? '📈' : '📉'}`);
      }
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

  const openPnl     = totalValue - totalInvested;
  const totalPnl    = openPnl + totalRealizedPnl;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested * 100).toFixed(1) : '0.0';
  // Get initial balance for context
  let initBal = 0;
  try {
    const bd = JSON.parse(getBalance(username).getContent());
    initBal  = bd.balance || 0;
  } catch(e) {}

  // Calculate total withdrawn and deposited from transactions (CASH rows)
  let totalWithdrawn = 0, totalDeposited = 0;
  try {
    const ss2 = SpreadsheetApp.openById(getSpreadsheetId_());
    const txS  = ss2.getSheetByName('transactions');
    if (txS && txS.getLastRow() > 1) {
      const txRows    = txS.getDataRange().getValues().slice(1);
      const txHeaders = txS.getDataRange().getValues()[0].map(h => String(h).trim().toLowerCase());
      const txUCol    = txHeaders.indexOf('username');
      const txTkCol   = txHeaders.indexOf('ticker');
      const txTypCol  = txHeaders.indexOf('type');
      const txAmtCol  = txHeaders.indexOf('amount_usd');
      const txFeeCol  = txHeaders.indexOf('fee');
      txRows.forEach(r => {
        if (String(r[txUCol]||'').trim().toLowerCase() !== String(username).trim().toLowerCase()) return;
        if (String(r[txTkCol]||'').trim() !== 'CASH') return;
        const typ = String(r[txTypCol]||'').trim().toUpperCase();
        const amt = parseFloat(r[txAmtCol]) || 0;
        const fee = parseFloat(r[txFeeCol]) || 0;
        if (typ === 'WITHDRAW') totalWithdrawn += amt + fee;
        if (typ === 'DEPOSIT')  totalDeposited += amt;
      });
    }
  } catch(e) {}

  lines.push('─────────────────────');
  if (initBal > 0) lines.push('Capital:  $' + initBal.toFixed(2));
  if (totalDeposited > 0)  lines.push('Deposited: +$' + totalDeposited.toFixed(2));
  if (totalWithdrawn > 0)  lines.push('Withdrawn: -$' + totalWithdrawn.toFixed(2));
  lines.push('Invested: $' + totalInvested.toFixed(2));
  lines.push('Value:    $' + totalValue.toFixed(2));
  if (totalRealizedPnl !== 0) {
    lines.push('Realized: ' + (totalRealizedPnl >= 0 ? '+' : '') + '$' + totalRealizedPnl.toFixed(2));
  }
  const totalPnlStr = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
  if (initBal > 0) {
    const fromStart = totalPnl / initBal * 100;
    lines.push('Total P&L: ' + totalPnlStr + ' (' + (fromStart >= 0 ? '+' : '') + fromStart.toFixed(1) + '% of capital)');
  } else {
    lines.push('Total P&L: ' + totalPnlStr);
  }
  return json({ message: lines.join('\n'), positions, totalInvested: +totalInvested.toFixed(2), totalValue: +totalValue.toFixed(2), totalPnl: +totalPnl.toFixed(2), totalRealizedPnl: +totalRealizedPnl.toFixed(2), initialBalance: initBal, totalWithdrawn: +totalWithdrawn.toFixed(2), totalDeposited: +totalDeposited.toFixed(2) });
}

// ══════════════════════════════════════════════
//  WATCHLIST
// ══════════════════════════════════════════════
function getUsersSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
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
  // Descriptions: plain ASCII, no em dashes (Telegram setMyCommands can reject some Unicode)
  const commands = [
    { command: 'register',  description: 'Get full access - support this project' },
    { command: 'start',     description: 'Welcome and login status' },
    { command: 'help',      description: 'Show all commands' },
    { command: 'login',     description: 'Sign in: LOGIN user pass' },
    { command: 'logout',    description: 'Sign out' },
    { command: 'buy',       description: 'Buy signal: BUY TICKER AMOUNT' },
    { command: 'sell',      description: 'Sell signal: SELL TICKER AMOUNT' },
    { command: 'update',    description: 'Record trade: UPDATE TICKER B100 185.20' },
    { command: 'check',     description: 'Portfolio and P and L (login first)' },
    { command: 'watchlist', description: 'Manage and scan watchlist' },
    { command: 'profile',   description: 'Risk: PROFILE LOW MEDIUM HIGH' },
    { command: 'explain',   description: 'EXPLAIN BUY or SELL' },
    { command: 'balance',   description: 'Set balance: BALANCE 1000' },
    { command: 'clear',     description: 'Reset portfolio: CLEAR YES' },
    { command: 'check_top_mover', description: 'Top movers from daily scan' }
  ];
  const resp = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + getBotToken_() + '/setMyCommands',
    {
      method:            'post',
      contentType:       'application/json',
      muteHttpExceptions: true,
      payload:           JSON.stringify({ commands })
    }
  );
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  Logger.log('setMyCommands HTTP ' + code + ' ' + body);
  if (code !== 200) throw new Error('setMyCommands failed: ' + code + ' ' + body);
}


// ══════════════════════════════════════════════
//  DEBUG — test this URL in browser to verify GAS is live
//  URL: YOUR_GAS_URL?debug=1
// ══════════════════════════════════════════════
function testSetup() {
  try {
    const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
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
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
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

  // Primary key: chatId (always present for Telegram)
  // Secondary: tgId (numeric user ID), tgUsername (may be absent)
  const primaryKey = chatId || tgId || tgUsername;

  for (let i = 1; i < rows.length; i++) {
    const rowChatId = String(rows[i][5] || '').trim();
    const rowTgId   = String(rows[i][0] || '').trim();
    const rowUser   = String(rows[i][1] || '').trim();

    const match = (chatId && rowChatId === chatId)
               || (tgId   && rowTgId   === tgId)
               || (tgUsername && rowUser === tgUsername);

    if (match) {
      const count = parseInt(rows[i][2] || 0) + 1;
      sheet.getRange(i + 1, 1, 1, 6).setValues([[
        tgId || rowTgId,
        tgUsername || rowUser,
        count,
        rows[i][3] || new Date().toISOString(),
        new Date().toISOString(),
        chatId || rowChatId
      ]]);
      return { allowed: count <= FREE_LIMIT, count, remaining: Math.max(0, FREE_LIMIT - count) };
    }
  }

  // New user — first use
  sheet.appendRow([tgId || '', tgUsername || '', 1, new Date().toISOString(), new Date().toISOString(), chatId]);
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
`🌟✨ GET FULL ACCESS ✨🌟
━━━━━━━━━━━━━━━━━━━━━━━━
 Support Tanaka Stock Terminal
━━━━━━━━━━━━━━━━━━━━━━━━

Hey! You've been using Tanaka Stock Terminal
and we're glad it's been helpful 🙏

━━━━━━━━━━━━━━━━━━━━━━━━
💎 WHAT YOU UNLOCK:
━━━━━━━━━━━━━━━━━━━━━━━━
✅ Unlimited buy/sell analysis
✅ Full portfolio tracking & P&L
✅ Watchlist scanning
✅ Risk profile settings
✅ All future features
✅ Lifetime access*

━━━━━━━━━━━━━━━━━━━━━━━━
💝 ONE-TIME CONTRIBUTION
━━━━━━━━━━━━━━━━━━━━━━━━
IDR 49,000 — paid once, yours forever*

Think of it as a small act of support
to keep this project alive and growing
for everyone. Not a subscription. Not
a recurring fee. Just once. 

📬 Message to register:
👉 @ikhwantan on Telegram

━━━━━━━━━━━━━━━━━━━━━━━━
*We'll always do our best to keep things
running, but can't guarantee forever —
contributions are non-refundable.

Tap 👉 @ikhwantan to get started 😊

─────────────────────
📋 Terms & Conditions:
https://tanaka-stock-analyzer.vercel.app/terms

⚠️ Not financial advice. No profit guaranteed.` });
}

// ══════════════════════════════════════════════
//  BALANCE — Initial balance per user
// ══════════════════════════════════════════════
function getBalance(username) {
  const ss      = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet   = ss.getSheetByName('users');
  if (!sheet) return json({ message: '⚠️ Users sheet not found.', balance: 0 });
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const uCol    = headers.indexOf('username');
  let bCol      = headers.indexOf('initial_balance');

  if (bCol < 0) {
    // Create column
    sheet.getRange(1, headers.length + 1).setValue('initial_balance');
    bCol = headers.length;
  }

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      const bal = parseFloat(rows[i][bCol] || 0) || 0;
      return json({
        balance: bal,
        message:
`💰 INITIAL BALANCE

User: ${username}
Balance: $${bal.toFixed(2)}

${bal === 0
  ? 'Not set yet.\n\nTo set your balance:\nBALANCE amount\nExample: BALANCE 1000'
  : 'To update: BALANCE amount\nExample: BALANCE 1500'}`
      });
    }
  }
  return json({ balance: 0, message: '⚠️ User not found: ' + username });
}

function setBalance(username, amount) {
  if (isNaN(amount) || amount < 0) return json({ message: '❓ Invalid amount.\n\nExample: BALANCE 1000' });
  const ss      = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet   = ss.getSheetByName('users');
  if (!sheet) return json({ message: '⚠️ Users sheet not found.' });
  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0].map(h => String(h).trim().toLowerCase());
  const uCol    = headers.indexOf('username');
  let bCol      = headers.indexOf('initial_balance');

  if (bCol < 0) {
    sheet.getRange(1, headers.length + 1).setValue('initial_balance');
    bCol = headers.length;
  }

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()) {
      sheet.getRange(i + 1, bCol + 1).setValue(amount);
      return json({
        balance: amount,
        message:
`✅ Balance Updated!

User: ${username}
Initial Balance: $${amount.toFixed(2)}

Your portfolio P&L will now be calculated
against this starting balance.`
      });
    }
  }
  return json({ message: '⚠️ User not found: ' + username });
}

// ══════════════════════════════════════════════
//  CLEAR PORTFOLIO
// ══════════════════════════════════════════════
function promptClear() {
  return json({ message:
`⚠️ CLEAR PORTFOLIO

This will delete ALL your trade history
and reset your portfolio to your initial balance.

This action CANNOT be undone.

To confirm, type:
CLEAR YES` });
}

function clearPortfolio(username) {
  const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
  const sheet = ss.getSheetByName('transactions');
  if (!sheet || sheet.getLastRow() <= 1) {
    return json({ message: '💼 Portfolio is already empty.' });
  }

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const uIdx    = headers.indexOf('username');

  // Delete rows belonging to this user (iterate backwards)
  let deleted = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    const rowUser = uIdx >= 0 ? String(rows[i][uIdx]).trim() : 'tanaka00';
    if (rowUser.toLowerCase() === String(username).trim().toLowerCase()) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }

  // Get initial balance to show in confirmation
  const balData = JSON.parse(getBalance(username).getContent());

  return json({ message:
`✅ PORTFOLIO CLEARED

User: ${username}
Trades deleted: ${deleted}
${balData.balance > 0
  ? 'Reset to initial balance: $' + balData.balance.toFixed(2)
  : 'Initial balance: not set (use BALANCE amount to set one)'}

Your portfolio is now empty.
Start recording new trades with UPDATE.` });
}

// ══════════════════════════════════════════════
//  HELPER
// ══════════════════════════════════════════════

// Check if a username exists in the users sheet (for web app auth)
function isValidUser(username) {
  if (!username) return false;
  try {
    const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
    const sheet = ss.getSheetByName('users');
    if (!sheet) return false;
    const rows    = sheet.getDataRange().getValues();
    const headers = rows[0].map(h => String(h).trim().toLowerCase());
    const uCol    = Math.max(headers.indexOf('username'), 0);
    return rows.slice(1).some(r =>
      String(r[uCol]).trim().toLowerCase() === String(username).trim().toLowerCase()
    );
  } catch(e) { return false; }
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════
//  Market scan (web app only, operator user)
//  Sheets: scan_results, scan_meta
// ══════════════════════════════════════════════

function getScanResultsSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  let s    = ss.getSheetByName('scan_results');
  if (!s) {
    s = ss.insertSheet('scan_results');
    s.appendRow(['date', 'ticker', 'change_pct', 'current_price', 'avg_volume']);
  }
  return s;
}

function getScanMetaSheet() {
  const ss = SpreadsheetApp.openById(getSpreadsheetId_());
  let s    = ss.getSheetByName('scan_meta');
  if (!s) {
    s = ss.insertSheet('scan_meta');
    s.appendRow(['key', 'value']);
    s.appendRow(['last_scan_date', '']);
  }
  return s;
}

/**
 * scan_results / scan_meta date cells may be text, Date from getValues(), or a Sheets serial.
 * Normalize to yyyy-MM-dd (Asia/Jakarta).
 */
function scanResultsDateCellToIso_(cell) {
  if (cell == null || cell === '') return '';
  if (Object.prototype.toString.call(cell) === '[object Date]' && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  if (typeof cell === 'number' && isFinite(cell) && cell > 20000 && cell < 80000) {
    var ms = (cell - 25569) * 86400 * 1000;
    var d0 = new Date(ms);
    if (!isNaN(d0.getTime())) return Utilities.formatDate(d0, 'Asia/Jakarta', 'yyyy-MM-dd');
  }
  const s = String(cell).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, 'Asia/Jakarta', 'yyyy-MM-dd');
  return '';
}

function getLastScanDate() {
  const sheet = getScanMetaSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === 'last_scan_date') {
      const raw = rows[i][1];
      const iso = scanResultsDateCellToIso_(raw);
      if (iso) return iso;
      return String(raw || '').trim();
    }
  }
  return '';
}

function setLastScanDate(dateStr) {
  const sheet = getScanMetaSheet();
  const rows  = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === 'last_scan_date') {
      sheet.getRange(i + 1, 2).setValue(dateStr);
      return;
    }
  }
  sheet.appendRow(['last_scan_date', dateStr]);
}

function fetchDayChange(ticker) {
  // Fetch 5-day data to get previous close vs current
  const url  = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
               '?interval=1d&range=5d&includePrePost=false';
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  const data = JSON.parse(resp.getContentText());
  if (!data.chart || !data.chart.result || !data.chart.result[0]) return null;
  const result = data.chart.result[0];
  const closes = result.indicators.quote[0].close.filter(p => p !== null && !isNaN(p));
  const meta   = result.meta;
  if (closes.length < 2) return null;
  const current  = meta.regularMarketPrice || closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const changePct = ((current - prevClose) / prevClose) * 100;
  const avgVol    = meta.regularMarketVolume || 0;
  return { current, changePct, avgVolume: avgVol };
}

function fetchAvgVolume(ticker) {
  const url  = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
               '?interval=1d&range=3mo&includePrePost=false';
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return 0;
  const data = JSON.parse(resp.getContentText());
  if (!data.chart || !data.chart.result || !data.chart.result[0]) return 0;
  const volumes = data.chart.result[0].indicators.quote[0].volume || [];
  const valid   = volumes.filter(v => v && v > 0);
  if (!valid.length) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/** One Yahoo chart request: 3mo daily — avg volume + day-over-day % change */
function fetchScanMetrics(ticker) {
  const url  = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
               '?interval=1d&range=3mo&includePrePost=false';
  const resp = UrlFetchApp.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return null;
  const data = JSON.parse(resp.getContentText());
  if (!data.chart || !data.chart.result || !data.chart.result[0]) return null;
  const result = data.chart.result[0];
  const quote  = result.indicators.quote[0];
  const closes = (quote.close || []).filter(p => p !== null && !isNaN(p));
  const volumes = quote.volume || [];
  const validVol = volumes.filter(v => v && v > 0);
  if (closes.length < 2) return null;
  const meta = result.meta;
  const current = meta.regularMarketPrice || closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const changePct = ((current - prevClose) / prevClose) * 100;
  const avgVol = validVol.length ? validVol.reduce((a, b) => a + b, 0) / validVol.length : 0;
  return { current: current, changePct: changePct, avgVolume: avgVol };
}

function tryMatchScanTicker(ticker, minAvgVol, dropThreshold, minPriceUsd) {
  try {
    const m = fetchScanMetrics(ticker);
    if (!m || m.avgVolume < minAvgVol) return null;
    if (m.current <= minPriceUsd) return null;
    if (m.changePct > dropThreshold) return null;
    return {
      ticker:       ticker,
      changePct:    +m.changePct.toFixed(2),
      currentPrice: +m.current.toFixed(2),
      avgVolume:    Math.round(m.avgVolume)
    };
  } catch (e) {
    return null;
  }
}

function finalizeScanToSheet(today, results) {
  results.sort(function (a, b) { return a.changePct - b.changePct; });
  const sheet = getScanResultsSheet();
  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    sheet.appendRow([today, r.ticker, r.changePct, r.currentPrice, r.avgVolume]);
  }
  setLastScanDate(today);
  SpreadsheetApp.flush();
}

function scanResponseComplete(today, results) {
  if (results.length === 0) {
    return json({
      message:
`📊 MARKET SCAN COMPLETE

Date: ${today}
No stocks found with price > $${TOP_MOVER_MIN_PRICE_USD}, ≥4M avg volume, and dropped ≥10% today.

Market may be stable today. Try again tomorrow.`,
      scanned:         false,
      scanComplete:    true,
      results:         [],
      date:            today,
      lastUpdatedDate: today,
      count:           0
    });
  }
  const lines = results.slice(0, 10).map(function (r) {
    return r.ticker.padEnd(6) + ' ' + r.changePct.toFixed(1) + '%  $' + r.currentPrice;
  });
  return json({
    message:
`📊 MARKET SCAN COMPLETE

Date: ${today}
Found: ${results.length} stocks (price > $${TOP_MOVER_MIN_PRICE_USD}, dropped ≥10%)
(showing top 10)

${lines.join('\n')}

Use CHECK-TOP-MOVER to see the full list.`,
    scanned:         false,
    scanComplete:    true,
    results:         results,
    date:            today,
    lastUpdatedDate: today,
    count:           results.length
  });
}

/**
 * Read saved chunk state only (no Yahoo calls). For web resume UI after 504 / tab close.
 */
function getMarketScanProgress() {
  const today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  if (getLastScanDate() === today) {
    return json({
      scanInProgress:   false,
      dayScanFinished:  true,
      date:             today,
      processed:        0,
      total:            0,
      progress:         1,
      partialResults:   [],
      message:          'Market scan already finished for today.'
    });
  }
  const props = PropertiesService.getScriptProperties();
  var state = null;
  try {
    state = JSON.parse(props.getProperty(SCAN_SESSION_PROP) || 'null');
  } catch (e) {
    state = null;
  }
  if (!state || state.date !== today || !Array.isArray(state.hits)) {
    return json({
      scanInProgress:  false,
      dayScanFinished: false,
      date:            today,
      processed:       0,
      total:           0,
      progress:        0,
      partialResults:  [],
      chunkMatches:    0,
      message:         'No scan in progress.'
    });
  }
  const list          = getDedupedWatchTickers();
  const partialSorted = state.hits.slice().sort(function (a, b) { return a.changePct - b.changePct; });
  const progress      = list.length ? state.i / list.length : 0;
  return json({
    scanInProgress:   true,
    dayScanFinished:  false,
    date:             today,
    processed:        state.i,
    total:            list.length,
    progress:         progress,
    partialResults:   partialSorted,
    chunkMatches:     state.hits.length,
    status:           'Paused at ' + state.i + ' / ' + list.length + ' tickers — open the web app (signed in as tanaka00) and tap Resume Market Scan.'
  });
}

function persistTopMoverLiveCache_(today, payload) {
  try {
    payload.updatedAtIso = new Date().toISOString();
    CacheService.getScriptCache().put(
      TOP_MOVER_LIVE_CACHE_KEY + today,
      JSON.stringify(payload),
      TOP_MOVER_CACHE_TTL_SEC
    );
  } catch (e) {}
}

function readTopMoverLiveCache_(today) {
  try {
    const hit = CacheService.getScriptCache().get(TOP_MOVER_LIVE_CACHE_KEY + today);
    if (!hit) return null;
    return JSON.parse(hit);
  } catch (e) {
    return null;
  }
}

/** Latest YYYY-MM-DD in column A of scan_results (ignores bad cells). */
function getLatestScanDateFromResultsSheet_() {
  const sheet = getScanResultsSheet();
  if (sheet.getLastRow() <= 1) return '';
  const rows = sheet.getDataRange().getValues().slice(1);
  var maxD = '';
  for (var i = 0; i < rows.length; i++) {
    const d = scanResultsDateCellToIso_(rows[i][0]);
    if (d && d > maxD) maxD = d;
  }
  return maxD;
}

/** Rows from scan_results for one scan date (same rows as stored; no extra price filter). */
function getScanResultsForDate_(scanDateStr) {
  const sheet = getScanResultsSheet();
  if (sheet.getLastRow() <= 1) return [];
  const rows = sheet.getDataRange().getValues().slice(1);
  const out = [];
  for (var i = 0; i < rows.length; i++) {
    const r = rows[i];
    const dateStr = scanResultsDateCellToIso_(r[0]);
    if (!dateStr || dateStr !== scanDateStr) continue;
    const ticker = String(r[1] || '').trim();
    if (!ticker) continue;
    out.push({
      date:         scanDateStr,
      ticker:       ticker,
      changePct:    +r[2],
      currentPrice: +r[3],
      avgVolume:    +r[4]
    });
  }
  out.sort(function (a, b) { return a.changePct - b.changePct; });
  return out;
}

function jsonTopMoverComplete_(scanDateStr, results, todayJakarta, extra) {
  extra = extra || {};
  const n = results.length;
  if (n === 0) {
    return json(Object.assign({
      message:
`📊 TOP MOVER — ${scanDateStr}

No stocks matched the criteria for this scan (price > $${TOP_MOVER_MIN_PRICE_USD}, ≥4M avg volume, dropped ≥10%).`,
      results:           [],
      date:              scanDateStr,
      lastUpdatedDate:   scanDateStr,
      cacheUpdatedAtIso: extra.cacheUpdatedAtIso || null,
      count:             0,
      scanComplete:      true,
      scanInProgress:    false,
      isStaleScan:       scanDateStr !== todayJakarta
    }, extra));
  }
  const lines = results.map(function (r, i) {
    return `${String(i + 1).padStart(2)}. ${r.ticker.padEnd(6)} ${r.changePct.toFixed(1)}%  $${r.currentPrice}`;
  });
  var staleNote = scanDateStr !== todayJakarta
    ? `\n\n📌 Latest saved scan is for ${scanDateStr} (today in scan timezone: ${todayJakarta}).`
    : '';
  return json(Object.assign({
    message:
`🔍 TOP MOVER — ${scanDateStr}

Stocks with price > $${TOP_MOVER_MIN_PRICE_USD}, ≥4M avg volume, dropped ≥10% (scan date ${scanDateStr}; sorted most negative first):

${lines.join('\n')}

Total: ${n} stocks

Use BUY TICKER AMOUNT to analyze any of these.${staleNote}`,
    results:           results,
    date:              scanDateStr,
    lastUpdatedDate:   scanDateStr,
    cacheUpdatedAtIso: extra.cacheUpdatedAtIso || null,
    count:             n,
    scanComplete:      true,
    scanInProgress:    false,
    isStaleScan:       scanDateStr !== todayJakarta
  }, extra));
}

/**
 * One chunk of the market scan. Returns a plain object (not ContentService).
 * State is stored in ScriptProperties when scanComplete is false.
 */
function runMarketScanChunkObject(today) {
  const props         = PropertiesService.getScriptProperties();
  const list          = getDedupedWatchTickers();
  const minAvgVol     = 4000000;
  const dropThreshold = -10;
  const minPriceUsd   = TOP_MOVER_MIN_PRICE_USD;
  let state = null;
  try {
    state = JSON.parse(props.getProperty(SCAN_SESSION_PROP) || 'null');
  } catch (e) {
    state = null;
  }
  if (!state || state.date !== today || !Array.isArray(state.hits)) {
    state = { v: 1, date: today, i: 0, hits: [] };
  }
  const end = Math.min(state.i + SCAN_CHUNK_SIZE, list.length);
  for (let idx = state.i; idx < end; idx++) {
    const hit = tryMatchScanTicker(list[idx], minAvgVol, dropThreshold, minPriceUsd);
    if (hit) state.hits.push(hit);
  }
  state.i = end;
  const partialSorted = state.hits.slice().sort(function (a, b) { return a.changePct - b.changePct; });
  if (state.i >= list.length) {
    persistTopMoverLiveCache_(today, {
      date:           today,
      processed:      list.length,
      total:          list.length,
      partialResults: partialSorted,
      results:        partialSorted,
      scanComplete:   true,
      scanInProgress: false
    });
    props.deleteProperty(SCAN_SESSION_PROP);
    finalizeScanToSheet(today, partialSorted);
    return { scanComplete: true, results: partialSorted };
  }
  props.setProperty(SCAN_SESSION_PROP, JSON.stringify(state));
  const progress = list.length ? state.i / list.length : 1;
  persistTopMoverLiveCache_(today, {
    date:           today,
    processed:      state.i,
    total:          list.length,
    partialResults: partialSorted,
    scanComplete:   false,
    scanInProgress: true
  });
  return {
    scanComplete:   false,
    processed:      state.i,
    total:          list.length,
    progress:       progress,
    status:         'Scanning… ' + state.i + ' / ' + list.length + ' tickers',
    chunkMatches:   state.hits.length,
    partialResults: partialSorted
  };
}

/** Web: one chunk per HTTP request. */
function scanInitWebChunk(today) {
  const o = runMarketScanChunkObject(today);
  if (o.scanComplete) {
    return scanResponseComplete(today, o.results);
  }
  return json({
    scanned:         false,
    scanComplete:    false,
    processed:       o.processed,
    total:           o.total,
    progress:        o.progress,
    status:          o.status,
    chunkMatches:    o.chunkMatches,
    partialResults:  o.partialResults || []
  });
}

/**
 * Market scan (once per calendar day, Asia/Jakarta).
 * Web only: chunked steps — call SCAN-INIT username repeatedly until scanComplete.
 */
function scanInit(username, chatId) {
  const today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const lastDate = getLastScanDate();
  if (lastDate === today) {
    PropertiesService.getScriptProperties().deleteProperty(SCAN_SESSION_PROP);
    return json({
      message:
`✅ SCAN ALREADY DONE TODAY

Market scan was completed for ${today}.

Tap CHECK-TOP-MOVER to see the results.`,
      scanned:      true,
      date:         today,
      scanComplete: true
    });
  }
  return scanInitWebChunk(today);
}

// ══════════════════════════════════════════════
//  CHECK-TOP-MOVER — Live partial + final scan results
// ══════════════════════════════════════════════

function checkTopMover() {
  const today    = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  const lastMeta = getLastScanDate();

  // 1) Script cache first (today’s scan session — partial or finished snapshot)
  const cached = readTopMoverLiveCache_(today);
  if (cached && String(cached.date || '').trim() === today) {
    if (cached.scanInProgress && !cached.scanComplete) {
      const partial = cached.partialResults || [];
      const n       = partial.length;
      const lines   = partial.slice(0, 15).map(function (r, i) {
        return `${String(i + 1).padStart(2)}. ${String(r.ticker).padEnd(6)} ${Number(r.changePct).toFixed(1)}%  $${r.currentPrice}`;
      });
      const more = n > 15 ? '\n… and ' + (n - 15) + ' more (see web Top Mover tab for full table).' : '';
      return json({
        message:
`⏳ TOP MOVER — scan in progress (${cached.processed}/${cached.total})

Partial matches so far (${n}):

${lines.join('\n')}${more}

Tap CHECK-TOP-MOVER again for updates.`,
        results:           partial,
        date:              today,
        lastUpdatedDate:   today,
        cacheUpdatedAtIso: cached.updatedAtIso || null,
        count:             n,
        scanInProgress:    true,
        scanComplete:      false,
        processed:         cached.processed,
        total:             cached.total,
        isStaleScan:       false
      });
    }
    if (cached.scanComplete) {
      const list = (cached.results && cached.results.length)
        ? cached.results
        : (cached.partialResults || []);
      return jsonTopMoverComplete_(today, list, today, { cacheUpdatedAtIso: cached.updatedAtIso || null });
    }
  }

  // 2) Sheet when meta says today (prefer rows whose date column is today)
  if (lastMeta === today) {
    const sh = getScanResultsSheet();
    if (sh.getLastRow() <= 1) {
      return json({
        message:
`📊 TOP MOVER — ${today}

Today's scan found no stocks matching the criteria.`,
        results:          [],
        date:             today,
        lastUpdatedDate:  today,
        count:            0,
        scanComplete:     true,
        scanInProgress:   false,
        isStaleScan:      false
      });
    }
    const resultsToday = getScanResultsForDate_(today);
    if (resultsToday.length > 0) {
      return jsonTopMoverComplete_(today, resultsToday, today, { source: 'sheet' });
    }
  }

  // 3) Fallback: latest date in scan_results (fixes empty/wrong scan_meta)
  const latestSheet = getLatestScanDateFromResultsSheet_();
  if (latestSheet) {
    const results = getScanResultsForDate_(latestSheet);
    if (latestSheet === today && lastMeta !== today) {
      try { setLastScanDate(today); } catch (e) {}
    }
    return jsonTopMoverComplete_(latestSheet, results, today, { source: 'sheet' });
  }

  // 4) In-progress session without cache hit (e.g. cache expired)
  const props = PropertiesService.getScriptProperties();
  var state = null;
  try {
    state = JSON.parse(props.getProperty(SCAN_SESSION_PROP) || 'null');
  } catch (e) {
    state = null;
  }
  if (state && state.date === today && Array.isArray(state.hits)) {
    const list          = getDedupedWatchTickers();
    const partialSorted = state.hits.slice().sort(function (a, b) { return a.changePct - b.changePct; });
    const lines = partialSorted.slice(0, 15).map(function (r, i) {
      return `${String(i + 1).padStart(2)}. ${String(r.ticker).padEnd(6)} ${Number(r.changePct).toFixed(1)}%  $${r.currentPrice}`;
    });
    const more = partialSorted.length > 15 ? '\n… and ' + (partialSorted.length - 15) + ' more.' : '';
    return json({
      message:
`⏳ TOP MOVER — scan in progress (${state.i}/${list.length})

Partial matches (${partialSorted.length}):

${lines.join('\n')}${more}

Tap CHECK-TOP-MOVER again for updates.`,
      results:         partialSorted,
      date:            today,
      lastUpdatedDate: today,
      count:           partialSorted.length,
      scanInProgress:  true,
      scanComplete:    false,
      processed:       state.i,
      total:           list.length,
      isStaleScan:     false
    });
  }

  return json({
    message:
`⚠️ NO TOP MOVER DATA FOR ${today}

No rows in scan_results yet. When the operator runs the market scan on the web app, matches appear here (cache + sheet).

Anyone can use CHECK-TOP-MOVER to follow the list.`,
    results:          [],
    date:             null,
    lastUpdatedDate:  null,
    count:            0,
    scanInProgress:   false,
    scanComplete:     false,
    isStaleScan:      false
  });
}


// ══════════════════════════════════════════════════════════════════
//  AUTO SCHEDULER — runs market scan every weekday at 20:30 WIB
//  Step 1: Run createScanTrigger() ONCE in GAS editor to set up
//  Step 2: Never touch it again — it fires automatically
// ══════════════════════════════════════════════════════════════════

/**
 * ONE-TIME SETUP: Run this function once in GAS editor.
 * Creates a daily trigger at 20:30 WIB (UTC+7) = 13:30 UTC.
 * Weekend guard is inside scheduledMarketScan() itself.
 */
function createScanTrigger() {
  // Remove any existing scheduledMarketScan triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'scheduledMarketScan') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Create a daily trigger at 20:00–21:00 WIB
  // GAS uses the script timezone (Asia/Jakarta = UTC+7) for atHour()
  // nearMinute(30) aims for ~20:30 WIB
  ScriptApp.newTrigger('scheduledMarketScan')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .nearMinute(30)
    .create();

  Logger.log('✅ Trigger created: scheduledMarketScan will run daily at ~20:30 WIB (weekdays only).');
  Logger.log('To verify, go to: Extensions → Apps Script → Triggers (clock icon on left sidebar).');
}

/**
 * Called automatically every day at ~20:30 WIB by the trigger.
 * Skips weekends. Runs the full market scan and saves to sheet.
 */
function scheduledMarketScan() {
  const tz    = 'Asia/Jakarta';
  const now   = new Date();
  const dow   = Utilities.formatDate(now, tz, 'EEEE'); // e.g. "Saturday"
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // Skip weekends — US markets are closed
  if (dow === 'Saturday' || dow === 'Sunday') {
    Logger.log('⏭ Skipping scheduled scan — today is ' + dow + ' (' + today + ')');
    return;
  }

  // Skip if already scanned today (manual or previous trigger run)
  const lastDate = getLastScanDate();
  if (lastDate === today) {
    Logger.log('⏭ Scan already done today (' + today + '). Skipping.');
    return;
  }

  Logger.log('🔍 Starting scheduled market scan for ' + today + ' (' + dow + ')...');

  try {
    // Clear any leftover chunked session from a previous interrupted scan
    PropertiesService.getScriptProperties().deleteProperty(SCAN_SESSION_PROP);

    // Run the full scan — loop chunks until complete (no web timeout here)
    var maxChunks = 50; // safety cap
    var done      = false;

    for (var i = 0; i < maxChunks; i++) {
      var result = JSON.parse(scanInitWebChunk(today).getContent());

      if (result.scanComplete === true) {
        done = true;
        Logger.log('✅ Scheduled scan complete: ' + result.count + ' top mover(s) found for ' + today);
        break;
      }

      if (result.scanComplete === false) {
        // Still chunking — log progress and continue
        Logger.log('  ↳ Progress: ' + result.processed + '/' + result.total + ' tickers, ' + (result.count || 0) + ' match(es) so far...');
        Utilities.sleep(500); // brief pause between chunks
        continue;
      }

      // Unexpected response — break to avoid infinite loop
      Logger.log('⚠️ Unexpected scan response: ' + JSON.stringify(result).substring(0, 200));
      break;
    }

    if (!done) {
      Logger.log('⚠️ Scan did not complete within ' + maxChunks + ' chunks. Check SCAN_SESSION_PROP in script properties.');
    }

  } catch (err) {
    Logger.log('❌ Scheduled scan error: ' + err.toString());
  }
}

/**
 * OPTIONAL UTILITY: Run this in GAS editor to see all current triggers.
 * Useful to verify your trigger is set up correctly.
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers found. Run createScanTrigger() to set one up.');
    return;
  }
  triggers.forEach(function(t) {
    Logger.log(
      'Function: ' + t.getHandlerFunction() +
      ' | Type: '  + t.getEventType() +
      ' | Source: '+ t.getTriggerSource()
    );
  });
}

/**
 * OPTIONAL UTILITY: Run this in GAS editor to remove the scheduled trigger.
 * Only needed if you want to pause or disable the auto-scan.
 */
function deleteScanTrigger() {
  var count = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'scheduledMarketScan') {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  Logger.log(count > 0
    ? '🗑 Deleted ' + count + ' scheduledMarketScan trigger(s).'
    : 'No scheduledMarketScan triggers found.');
}

// ══════════════════════════════════════════════════════════════════
//  AUTO SCHEDULER — runs market scan every weekday at 20:30 WIB
//  Step 1: Run createScanTrigger() ONCE in GAS editor to set up
//  Step 2: Never touch it again — it fires automatically
// ══════════════════════════════════════════════════════════════════

/**
 * ONE-TIME SETUP: Run this function once in GAS editor.
 * Creates a daily trigger at ~20:30 WIB (UTC+7).
 * Weekend guard is inside scheduledMarketScan() itself.
 */
function createScanTrigger() {
  // Remove any existing scheduledMarketScan triggers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'scheduledMarketScan') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // Create a daily trigger at 20:00-21:00 WIB
  // GAS uses the script timezone (Asia/Jakarta = UTC+7) for atHour()
  // nearMinute(30) aims for ~20:30 WIB
  ScriptApp.newTrigger('scheduledMarketScan')
    .timeBased()
    .everyDays(1)
    .atHour(20)
    .nearMinute(30)
    .create();

  Logger.log('✅ Trigger created: scheduledMarketScan runs daily at ~20:30 WIB (weekdays only).');
  Logger.log('Verify: Extensions > Apps Script > Triggers (clock icon on left sidebar).');
}

/**
 * Called automatically every day at ~20:30 WIB by the trigger.
 * Skips weekends. Runs the full market scan and saves to sheet.
 */
function scheduledMarketScan() {
  const tz    = 'Asia/Jakarta';
  const now   = new Date();
  const dow   = Utilities.formatDate(now, tz, 'EEEE');
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // Skip weekends — US markets are closed
  if (dow === 'Saturday' || dow === 'Sunday') {
    Logger.log('Skipping scheduled scan — today is ' + dow + ' (' + today + ')');
    return;
  }

  // Skip if already scanned today
  const lastDate = getLastScanDate();
  if (lastDate === today) {
    Logger.log('Scan already done today (' + today + '). Skipping.');
    return;
  }

  Logger.log('Starting scheduled market scan for ' + today + ' (' + dow + ')...');

  try {
    // Clear any leftover chunked session from a previous interrupted scan
    PropertiesService.getScriptProperties().deleteProperty(SCAN_SESSION_PROP);

    // Loop through chunks until scan is complete
    // GAS triggers have a 6-minute runtime limit — chunking keeps us safe
    var maxChunks = 50;
    var done      = false;

    for (var i = 0; i < maxChunks; i++) {
      var result = JSON.parse(scanInitWebChunk(today).getContent());

      if (result.scanComplete === true) {
        done = true;
        Logger.log('Scan complete: ' + result.count + ' top mover(s) found for ' + today);
        break;
      }

      if (result.scanComplete === false) {
        Logger.log('Progress: ' + result.processed + '/' + result.total + ' tickers, ' + (result.count || 0) + ' match(es)...');
        Utilities.sleep(300);
        continue;
      }

      Logger.log('Unexpected scan response at chunk ' + i);
      break;
    }

    if (!done) {
      Logger.log('Warning: scan did not complete within ' + maxChunks + ' chunks.');
    }

  } catch (err) {
    Logger.log('Scheduled scan error: ' + err.toString());
  }
}

/**
 * UTILITY: Run in GAS editor to list all current triggers.
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('No triggers found. Run createScanTrigger() to set one up.');
    return;
  }
  triggers.forEach(function(t) {
    Logger.log(
      'Function: ' + t.getHandlerFunction() +
      ' | Type: '  + t.getEventType() +
      ' | Source: ' + t.getTriggerSource()
    );
  });
}

/**
 * UTILITY: Run in GAS editor to remove the scheduled trigger.
 */
function deleteScanTrigger() {
  var count = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'scheduledMarketScan') {
      ScriptApp.deleteTrigger(trigger);
      count++;
    }
  });
  Logger.log(count > 0
    ? 'Deleted ' + count + ' scheduledMarketScan trigger(s).'
    : 'No scheduledMarketScan triggers found.');
}
// DEPOSIT / WITHDRAW cash flow tracking
// Deposit: FREE | Withdraw: $5.00 flat
function recordCashFlow(type, amount, username) {
  if (!username) return json({ message: 'Username required.' });
  if (isNaN(amount) || amount <= 0)
    return json({ message: 'Invalid amount. Example: ' + type + ' 500' });
  if (!isValidUser(username))
    return json({ success: false, unauthorized: true, message: 'Please login first.' });

  const fee      = (type === 'WITHDRAW') ? 5.00 : 0;
  const date     = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');

  const ss    = SpreadsheetApp.openById(getSpreadsheetId_());
  let txSheet = ss.getSheetByName('transactions');
  if (!txSheet) {
    txSheet = ss.insertSheet('transactions');
    txSheet.appendRow(['date','username','ticker','type','amount_usd','price','shares','fee']);
  }
  txSheet.appendRow([date, username, 'CASH', type, amount, 1, amount, fee]);

  // initial_balance is the user's fixed capital baseline (set only by BALANCE command)
  // DEPOSIT/WITHDRAW are tracked in transactions only — they do NOT change initial_balance
  SpreadsheetApp.flush();

  if (type === 'DEPOSIT') {
    return json({ message:
`✅ DEPOSIT RECORDED
─────────────────────
User:    ${username}
Amount:  $$${amount.toFixed(2)}
Fee:     FREE
Date:    ${date}
─────────────────────
Balance updated: +$$${amount.toFixed(2)}`,
      success: true, type: type, amount: amount, fee: 0, date: date });
  } else {
    const total = amount + fee;
    return json({ message:
`✅ WITHDRAWAL RECORDED
─────────────────────
User:       ${username}
Withdrawn:  $$${amount.toFixed(2)}
GoTrade fee: -$$${fee.toFixed(2)}
Total out:  $$${total.toFixed(2)}
Date:       ${date}
─────────────────────
Balance updated: -$$${total.toFixed(2)}`,
      success: true, type: type, amount: amount, fee: fee, date: date });
  }
}

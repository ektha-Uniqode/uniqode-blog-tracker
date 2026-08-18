#!/usr/bin/env node
// Weekly GSC position sync — see ../POSITION_TRACKING_SETUP.md for the one-time
// account setup this script depends on (OAuth consent for GSC reads, service account
// for Firebase + Sheets writes, Sheet share).
//
// What it does, every Monday (via .github/workflows/weekly-position-sync.yml):
//   1. Pulls last week's average position per page from Google Search Console.
//   2. For every URL already in the Firebase tracker, updates:
//        position.current   → this week's average position
//        position.previous  → last week's value (so the dashboard can draw ▲/▼)
//        position.best      → all-time lowest position seen
//        position.bestMonth → the month "best" was recorded in
//   3. Appends the same week's numbers as a new column in the Google Sheet log
//      (col A = URL, col B = Best Position (Month), col C+ = one column per week).
//
// Run with --dry-run to print what WOULD change without writing anywhere.

import { google } from 'googleapis';
import admin from 'firebase-admin';

const DRY_RUN = process.argv.includes('--dry-run');

const {
  GCP_SERVICE_ACCOUNT_KEY,   // full JSON key, as a string (GitHub secret) — Firebase + Sheets only
  GSC_OAUTH_CLIENT_ID,       // OAuth client (Desktop app type), same GCP project
  GSC_OAUTH_CLIENT_SECRET,   // paired secret for the OAuth client
  GSC_OAUTH_REFRESH_TOKEN,   // one-time consent (OAuth Playground) → long-lived refresh token, as YOU
  FIREBASE_DATABASE_URL,     // e.g. https://q2-blog-cleanup-default-rtdb.firebaseio.com
  GSC_SITE_URL,              // e.g. sc-domain:uniqode.com (must match GSC property exactly)
  SHEET_ID,                  // Google Sheet ID from its URL
  SHEET_TAB = 'Positions',
} = process.env;

function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function loadServiceAccount() {
  const raw = requireEnv('GCP_SERVICE_ACCOUNT_KEY', GCP_SERVICE_ACCOUNT_KEY);
  return JSON.parse(raw);
}

// GSC reads run as YOU (via OAuth refresh token), not the service account — sidesteps
// needing GSC "Owner" permission to add the service account as a user. Your existing
// siteFullUser access on the property is all that's needed to read search analytics.
function buildGscOAuthClient() {
  const clientId = requireEnv('GSC_OAUTH_CLIENT_ID', GSC_OAUTH_CLIENT_ID);
  const clientSecret = requireEnv('GSC_OAUTH_CLIENT_SECRET', GSC_OAUTH_CLIENT_SECRET);
  const refreshToken = requireEnv('GSC_OAUTH_REFRESH_TOKEN', GSC_OAUTH_REFRESH_TOKEN);
  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// Normalize URLs so tracker entries and GSC's `page` dimension line up
// regardless of trailing slash.
function normalizeUrl(u) {
  if (!u) return u;
  return u.trim().replace(/\/$/, '') || u;
}

function monthLabel(d) {
  return d.toLocaleString('en-US', { month: 'short' }); // "Nov"
}

// Last full Mon–Sun week before "today" (the day the Action runs, i.e. Monday).
function lastFullWeekRange(today = new Date()) {
  const day = today.getDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (day + 6) % 7;
  const thisMonday = new Date(today);
  thisMonday.setHours(0, 0, 0, 0);
  thisMonday.setDate(today.getDate() - daysSinceMonday);
  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  const lastMonday = new Date(lastSunday);
  lastMonday.setDate(lastSunday.getDate() - 6);
  const iso = (d) => d.toISOString().split('T')[0];
  return { startDate: iso(lastMonday), endDate: iso(lastSunday), weekEndDate: lastSunday };
}

async function fetchGscPositions(auth, siteUrl) {
  const { startDate, endDate } = lastFullWeekRange();
  const searchconsole = google.searchconsole({ version: 'v1', auth });
  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: 25000,
    },
  });
  const map = new Map(); // normalizedUrl -> avg position (1dp)
  for (const row of res.data.rows || []) {
    map.set(normalizeUrl(row.keys[0]), Math.round(row.position * 10) / 10);
  }
  return map;
}

async function loadArticles(db) {
  const snap = await db.ref('articles').once('value');
  return snap.val() || {};
}

function computeUpdates(articles, gscMap, weekEndDate) {
  const updates = {}; // id -> new position object
  const monthStr = monthLabel(weekEndDate);
  for (const [id, a] of Object.entries(articles)) {
    const current = gscMap.get(normalizeUrl(a.url));
    if (current == null) continue; // no GSC data for this URL this week — leave untouched

    const prevPos = a.position || {};
    const previous = prevPos.current ?? null;
    let best = prevPos.best;
    let bestMonth = prevPos.bestMonth;
    if (best == null || current < best) {
      best = current;
      bestMonth = monthStr;
    }
    updates[id] = {
      current,
      previous,
      best,
      bestMonth,
      updatedAt: new Date().toISOString(),
    };
  }
  return updates;
}

async function writeToFirebase(db, updates) {
  const multi = {};
  for (const [id, pos] of Object.entries(updates)) {
    multi[`articles/${id}/position`] = pos;
  }
  if (Object.keys(multi).length === 0) return;
  await db.ref().update(multi);
}

// ── Google Sheet log ────────────────────────────────────────────────────────
function colLetter(n) {
  // 1 -> A, 27 -> AA
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function syncSheet(sheetsClient, articles, updates, weekEndDate) {
  const range = `${SHEET_TAB}!A:ZZ`;
  const { data } = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  const grid = data.values || [];
  const header = grid[0] || ['URL', 'Best Position (Month)'];
  if (header.length < 2) { header[0] = 'URL'; header[1] = 'Best Position (Month)'; }

  // URL -> row index (0-based within `grid`, so sheet row = idx+1)
  const rowIndexByUrl = new Map();
  grid.slice(1).forEach((row, i) => {
    if (row[0]) rowIndexByUrl.set(normalizeUrl(row[0]), i + 1);
  });

  const weekColLabel = `Week of ${lastFullWeekRange().startDate}`;
  let weekColIdx = header.indexOf(weekColLabel);
  if (weekColIdx === -1) {
    weekColIdx = header.length;
    header[weekColIdx] = weekColLabel;
  }

  const rowsOut = [header];
  const allUrls = Object.values(articles).map(a => a.url).filter(Boolean);
  const seen = new Set();

  // Preserve existing row order first, then append brand-new URLs at the bottom.
  const orderedUrls = [
    ...[...rowIndexByUrl.keys()],
    ...allUrls.filter(u => !rowIndexByUrl.has(normalizeUrl(u))),
  ];

  for (const rawUrl of orderedUrls) {
    const url = normalizeUrl(rawUrl);
    if (seen.has(url)) continue;
    seen.add(url);
    const article = Object.values(articles).find(a => normalizeUrl(a.url) === url);
    const existingRowIdx = rowIndexByUrl.get(url);
    const existingRow = existingRowIdx != null ? grid[existingRowIdx] : [];
    const row = [...existingRow];
    row[0] = rawUrl;
    const pos = article?.position;
    row[1] = pos?.best != null ? `${pos.best} (${pos.bestMonth})` : (row[1] || '');
    row[weekColIdx] = pos?.current != null ? String(pos.current) : (row[weekColIdx] || '');
    rowsOut.push(row);
  }

  if (DRY_RUN) {
    console.log(`[dry-run] Would write ${rowsOut.length - 1} sheet rows, week column "${weekColLabel}"`);
    return;
  }

  const lastCol = colLetter(header.length);
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:${lastCol}${rowsOut.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: rowsOut },
  });
}

async function main() {
  const key = loadServiceAccount();
  const gscAuth = buildGscOAuthClient();
  const sheetsAuth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheetsAuthClient = await sheetsAuth.getClient();

  admin.initializeApp({
    credential: admin.credential.cert(key),
    databaseURL: requireEnv('FIREBASE_DATABASE_URL', FIREBASE_DATABASE_URL),
  });
  const db = admin.database();

  const siteUrl = requireEnv('GSC_SITE_URL', GSC_SITE_URL);
  const { weekEndDate } = lastFullWeekRange();

  console.log(`Fetching GSC positions for ${siteUrl}, week ending ${weekEndDate.toISOString().split('T')[0]}…`);
  const gscMap = await fetchGscPositions(gscAuth, siteUrl);
  console.log(`GSC returned ${gscMap.size} pages.`);

  const articles = await loadArticles(db);
  const updates = computeUpdates(articles, gscMap, weekEndDate);
  console.log(`${Object.keys(updates).length} tracked URLs matched GSC data.`);

  if (DRY_RUN) {
    console.log('[dry-run] Sample updates:', Object.entries(updates).slice(0, 5));
  } else {
    await writeToFirebase(db, updates);
    console.log('Firebase updated.');
  }

  if (SHEET_ID) {
    const sheetsClient = google.sheets({ version: 'v4', auth: sheetsAuthClient });
    // Merge computed updates into a fresh copy of articles so the sheet reflects this run.
    const merged = Object.fromEntries(
      Object.entries(articles).map(([id, a]) => [id, { ...a, position: updates[id] || a.position }])
    );
    await syncSheet(sheetsClient, merged, updates, weekEndDate);
    console.log(DRY_RUN ? 'Sheet dry-run complete.' : 'Sheet updated.');
  } else {
    console.log('SHEET_ID not set — skipping sheet log.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

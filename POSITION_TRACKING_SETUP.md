# Position tracking — one-time setup

Code side's done (dashboard columns, GitHub Action, sync script). GSC reads now run
as **you** via OAuth — no GSC "Owner" permission needed, your existing `siteFullUser`
access on `sc-domain:uniqode.com` is enough. Firebase + the Sheet log still use a
service account (that part needs your Google Cloud project access, not GSC access).

## 1. Create the service account (Google Cloud Console) — for Firebase + Sheets only

Project: **q2-blog-cleanup** (same project the dashboard's Firebase already lives in).

1. https://console.cloud.google.com/iam-admin/serviceaccounts?project=q2-blog-cleanup
2. Create service account → name it `position-tracker-bot` → Create and Continue.
3. Role: **Firebase Realtime Database Admin** → Done.
4. Open the new service account → Keys tab → Add key → Create new key → JSON.
   A file downloads — you'll paste its contents into a GitHub secret in step 5.
5. https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=q2-blog-cleanup → Enable

## 2. Create an OAuth client — for GSC reads, as you

1. https://console.cloud.google.com/apis/credentials?project=q2-blog-cleanup
2. Enable the API first if not already: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=q2-blog-cleanup → Enable
3. Create Credentials → OAuth client ID → Application type: **Desktop app** → name it anything (e.g. `position-tracker-oauth`) → Create.
4. Note the **Client ID** and **Client Secret** shown — you'll need both in step 3 below.
5. If this is the project's first OAuth client, you'll also be asked to configure the **OAuth consent screen** — External or Internal, doesn't matter for this, just add your own email as a test user if it asks.

## 3. Get a refresh token via OAuth Playground (no code, no terminal)

1. Go to https://developers.google.com/oauthplayground
2. Click the gear icon (top right) → check **"Use your own OAuth credentials"** → paste the Client ID and Client Secret from step 2.
3. In the left panel, scroll to find **Search Console API v1** → check the scope `https://www.googleapis.com/auth/webmasters.readonly` (or paste it manually in the "Input your own scopes" box).
4. Click **Authorize APIs** → sign in with **your own uniqode.com Google account** (the one with GSC access) → allow.
5. Click **Exchange authorization code for tokens** → copy the **Refresh token** field. This is the one that goes in a GitHub secret in step 5 — it doesn't expire on its own and lets the Action read GSC data as you indefinitely.

## 4. Create the Google Sheet log and share it

1. New blank Sheet, rename the tab to `Positions` (or tell me your preferred tab name — it's set as `SHEET_TAB` in the workflow, defaults to `Positions`).
2. Share → add the **service account's** email (from step 1, looks like `position-tracker-bot@q2-blog-cleanup.iam.gserviceaccount.com`) → **Editor**.
3. Copy the Sheet ID from its URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

## 5. Add repo secrets/variables

```bash
gh secret set GCP_SERVICE_ACCOUNT_KEY < path/to/the-downloaded-key.json
gh secret set GSC_OAUTH_CLIENT_ID --body "paste-client-id-here"
gh secret set GSC_OAUTH_CLIENT_SECRET --body "paste-client-secret-here"
gh secret set GSC_OAUTH_REFRESH_TOKEN --body "paste-refresh-token-here"
gh variable set FIREBASE_DATABASE_URL --body "https://q2-blog-cleanup-default-rtdb.firebaseio.com"
gh variable set GSC_SITE_URL --body "sc-domain:uniqode.com"
gh variable set SHEET_ID --body "paste-the-sheet-id-here"
```

`GSC_SITE_URL` is confirmed already — it's the domain property `sc-domain:uniqode.com`, not a URL-prefix property.

## 6. Test it

- Actions tab → "Weekly position sync" → Run workflow (the `workflow_dispatch` trigger
  means you don't have to wait for Monday).
- Check the run logs for `GSC returned N pages` and `M tracked URLs matched GSC data`.
- Refresh the dashboard — Best Position / This Week columns should populate for
  published URLs. Not Started / unpublished URLs stay blank (no GSC data exists for them yet).

To dry-run locally before wiring secrets:
```bash
cd scripts && npm install
GCP_SERVICE_ACCOUNT_KEY="$(cat key.json)" \
GSC_OAUTH_CLIENT_ID="..." \
GSC_OAUTH_CLIENT_SECRET="..." \
GSC_OAUTH_REFRESH_TOKEN="..." \
FIREBASE_DATABASE_URL="https://q2-blog-cleanup-default-rtdb.firebaseio.com" \
GSC_SITE_URL="sc-domain:uniqode.com" \
SHEET_ID="your-sheet-id" \
node sync-positions.mjs --dry-run
```

## What changed from the original plan

The first version of this had you add a service account as a GSC user, which needs
**Owner** permission on the property — you only have `siteFullUser`, so that step was
blocked. Steps 2-3 above replace it: the service account still handles Firebase and
Sheets (those just need your Google Cloud project access, which you do have), but GSC
reads now authenticate as you directly via OAuth, using access you already have.

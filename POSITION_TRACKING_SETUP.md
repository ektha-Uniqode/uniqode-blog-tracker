# Position tracking — one-time setup

Code side's done (dashboard columns, GitHub Action, sync script). These steps are
account/credential work only you can do — I can't click through your Google/Firebase
console for you.

## 1. Create the service account (Google Cloud Console)

Project: **q2-blog-cleanup** (same project the dashboard's Firebase already lives in).

1. https://console.cloud.google.com/iam-admin/serviceaccounts?project=q2-blog-cleanup
2. Create service account → name it `position-tracker-bot` → Create and Continue.
3. Role: **Firebase Realtime Database Admin** → Done.
4. Open the new service account → Keys tab → Add key → Create new key → JSON.
   A file downloads. Keep it — you'll paste its contents into a GitHub secret in step 5.

## 2. Enable the two APIs it needs

1. https://console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=q2-blog-cleanup → Enable
2. https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=q2-blog-cleanup → Enable

## 3. Give it Search Console access

1. https://search.google.com/search-console → pick the `uniqode.com` property → Settings → Users and permissions
2. Add user → paste the service account's email (looks like `position-tracker-bot@q2-blog-cleanup.iam.gserviceaccount.com`, found on the service account's detail page) → permission: **Restricted** (read-only is enough).

## 4. Create the Google Sheet log and share it

1. New blank Sheet, rename the tab to `Positions` (or tell me your preferred tab name — it's set as `SHEET_TAB` in the workflow, defaults to `Positions`).
2. Share → add the service account's email → **Editor**.
3. Copy the Sheet ID from its URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

## 5. Add repo secrets/variables

Run these from the repo root (or use GitHub → Settings → Secrets and variables → Actions):

```bash
gh secret set GCP_SERVICE_ACCOUNT_KEY < path/to/the-downloaded-key.json
gh variable set FIREBASE_DATABASE_URL --body "https://q2-blog-cleanup-default-rtdb.firebaseio.com"
gh variable set GSC_SITE_URL --body "https://www.uniqode.com/"
gh variable set SHEET_ID --body "paste-the-sheet-id-here"
```

Double check `GSC_SITE_URL` matches your GSC property's exact format — if your property
is a domain property rather than URL-prefix, it'll be `sc-domain:uniqode.com` instead.

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
FIREBASE_DATABASE_URL="https://q2-blog-cleanup-default-rtdb.firebaseio.com" \
GSC_SITE_URL="https://www.uniqode.com/" \
SHEET_ID="your-sheet-id" \
node sync-positions.mjs --dry-run
```

# KidPlan Setup Checklist

One-time setup for Tyler. Everything happens under the shared `soleilandtyler@gmail.com` account unless noted. Work top to bottom.

---

## Section 1 — Google Cloud project + Vision API

1. Sign in to https://console.cloud.google.com/ as `soleilandtyler@gmail.com`.
2. Top bar → project selector → "New Project". Name it `kidplan`. Click "Create".
3. Make sure the new project is selected in the top bar.
4. Navigation menu → "APIs & Services" → "Library". Search "Cloud Vision API". Click it → "Enable".
5. Navigation menu → "Billing". Link a billing account to the project. Cloud Vision's free tier is 1,000 units/month; at our expected volume (a handful of calendar photos per week) cost should be $0.
6. Navigation menu → "IAM & Admin" → "Service Accounts" → "Create service account".
   - Name: `kidplan-vision`
   - Click "Create and continue"
   - Role: `Cloud Vision API User`
   - Click "Continue" → "Done"
7. Click the new service account → "Keys" tab → "Add key" → "Create new key" → JSON → "Create". A JSON file downloads. Keep it; you will paste its contents into Script Properties in Section 7.

---

## Section 2 — Google Sheet

1. Go to https://sheets.google.com/ signed in as `soleilandtyler@gmail.com`.
2. Click "Blank" to create a new Sheet. Rename it to `KidPlan`.
3. Copy the Sheet ID from the URL. The ID is the long string between `/d/` and `/edit`:
   - `https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit`
4. Save the ID for Section 7.

Note: the GAS `setupSeedSheet()` function in `gas/sheets.gs` populates the 6 tabs (`Days`, `PlanItems`, `Library`, `Tags`, `Photos`, `Settings`) and their headers automatically (run it once from the editor after deploying). For now just leave the Sheet empty.

---

## Section 3 — Google Drive folder

1. Go to https://drive.google.com/ signed in as `soleilandtyler@gmail.com`.
2. In "My Drive", "New" → "New folder" → name it `KidPlan`. Open it.
3. Inside `KidPlan`, "New" → "New folder" → name it `calendar-photos`. Open it.
4. Copy the folder ID from the URL:
   - `https://drive.google.com/drive/folders/<THIS_IS_THE_ID>`
5. Save the ID for Section 7.

---

## Section 4 — Google Calendar

1. Go to https://calendar.google.com/ signed in as `soleilandtyler@gmail.com`.
2. Find the family calendar. If one does not already exist, in the left sidebar click the `+` next to "Other calendars" → "Create new calendar" → name it `Family - Summer 2026` → "Create calendar".
3. In the left sidebar hover the calendar → click the three-dot menu → "Settings and sharing".
4. Scroll to "Integrate calendar" → copy the value of "Calendar ID" (usually ends in `@group.calendar.google.com` or is the account email for the primary cal). Save it for Section 7 as `FAMILY_CALENDAR_ID`.
5. Also collect read-only calendar IDs for conflict-awareness reads:
   - Tyler's personal Google Calendar ID
   - Soleil's personal Google Calendar ID
   - For each, Settings and sharing → Integrate calendar → Calendar ID.
   - You will need to share each personal cal with `soleilandtyler@gmail.com` at "See all event details" so the GAS script can read them. From the personal account: Settings → that calendar → "Share with specific people or groups" → Add `soleilandtyler@gmail.com` with "See all event details".
6. Save the two personal IDs as a comma-separated string for Section 7 as `READ_ONLY_CALENDAR_IDS`.

---

## Section 5 — clasp install + login

```
npm install -g @google/clasp
clasp login
```

When the browser opens, sign in as `soleilandtyler@gmail.com` and approve.

---

## Section 6 — Create the GAS project

clasp v3 (3.x) removed the `webapp` and `api` project types. Web-app vs standalone is now controlled entirely by `appsscript.json` (ours already declares the `webapp` block and OAuth scopes), so create a `standalone` project:

```
cd /Users/tylergeddes/projects/KidPlan/gas
clasp create-script --type standalone --title "KidPlan API"
```

`clasp create-script` may overwrite the local `appsscript.json` with a bare default. It is committed, so restore ours, then push (answer "yes" if clasp asks to overwrite the remote manifest):

```
git checkout appsscript.json
clasp push
```

After `clasp push`, open the script in the Apps Script editor:

```
clasp open
```

---

## Section 7 — Script Properties

In the Apps Script editor (opened in Section 6):

1. Left sidebar → gear icon "Project Settings".
2. Scroll to "Script Properties" → "Add script property".
3. Add each of these keys with the values you collected:

| Key | Value |
|---|---|
| `API_TOKEN` | A long random shared secret. Generate one with `openssl rand -hex 24`. You and Soleil enter this once per phone in the app (it is stored in the browser's localStorage, never committed to the repo). |
| `SHEET_ID` | Sheet ID from Section 2 |
| `PHOTO_FOLDER_ID` | Drive folder ID from Section 3 |
| `FAMILY_CALENDAR_ID` | Family calendar ID from Section 4 step 4 |
| `READ_ONLY_CALENDAR_IDS` | Comma-separated personal calendar IDs from Section 4 step 6 |
| `VISION_SERVICE_ACCOUNT_JSON` | Paste the entire contents of the JSON key file from Section 1 step 7 as a single string |

Auth model note: the web app deploys as `ANYONE_ANONYMOUS` so the Cloudflare frontend can call it cross-origin without a Google login redirect. `Session.getActiveUser()` is empty on a personal-Gmail web app, so access control is the `API_TOKEN` shared secret, not a Google-identity allowlist. The web app still runs as soleilandtyler@ (execute-as-deployer), so it reads/writes the Sheet, Calendar, and Drive owned by that account.

4. Click "Save script properties".

---

## Section 8 — Deploy the GAS web app

From the local `gas/` directory, create the versioned deployment once:

```
clasp deploy --description "v0.1.0 wave-1"
```

The output includes a deployment ID (`AKfycb...`) and a URL ending in `/exec`. Copy the `/exec` URL for Section 10. Also save the deployment ID somewhere stable (repo README or an npm script).

Important: on every later redeploy, reuse that ID with `-i` so the `/exec` URL stays constant and the Cloudflare frontend keeps working:

```
clasp push
clasp deploy -i <DEPLOYMENT_ID>
```

A bare `clasp deploy` (no `-i`) creates a new deployment with a new URL every time, which silently breaks the frontend's `API_URL`.

In the Apps Script editor, on first deploy you may be prompted to "Review permissions". Authorize as `soleilandtyler@gmail.com` and grant the scopes (Sheets, Drive, Calendar, external URL fetch).

---

## Section 9 — Cloudflare Pages frontend

1. Sign in to https://dash.cloudflare.com/.
2. Left sidebar → "Workers & Pages" → "Create application" → "Pages" tab → "Connect to Git".
3. Authorize Cloudflare to access your GitHub account if you have not already. Select the `hiretyler/kidplan` repo.
4. Set up the build:
   - Production branch: `main`
   - Framework preset: `None`
   - Build command: (leave blank)
   - Build output directory: `web`
5. Click "Save and Deploy".
6. When the deploy finishes, copy the `*.pages.dev` URL.

---

## Section 10 — Wire the frontend to the API

1. Open `/Users/tylergeddes/projects/KidPlan/web/index.html`.
2. Near the top of the `<script>` block, find the `API_URL` constant.
3. Replace its placeholder value with the deployment URL from Section 8.
4. Commit and push. Cloudflare Pages will redeploy automatically.

---

## You're done when

- (a) Opening the Pages URL on your phone shows the KidPlan home screen with real data from the Sheet.
- (b) `?action=ping` against the GAS URL returns `{ok: true, runningAs: "soleilandtyler@gmail.com", tokenOk: false, version: "0.1.0"}`. Test by visiting `<DEPLOYMENT_URL>?action=ping` in any browser (no login needed - it is ANYONE_ANONYMOUS). `runningAs` confirms the deploy executes as the shared account; `tokenOk` is false until you append `&token=<your API_TOKEN>`, which should flip it to true.

---

## Troubleshooting (clasp)

### "Invalid container file type" on `clasp create`
clasp 3.x removed the `webapp` and `api` project types. Create a `standalone` project instead - the web-app config lives in `appsscript.json`, which already declares the `webapp` block and OAuth scopes:

```
clasp create-script --type standalone --title "KidPlan API"
git checkout appsscript.json   # restore our manifest if clasp clobbered it
clasp push
```

### `invalid_grant` / `reauth related error (invalid_rapt)`
clasp's reauth proof token expired (common right after enabling new APIs or adding OAuth scopes on a 2FA account). Re-login:

```
clasp login            # or: clasp login --no-localhost
```

If it recurs immediately, wait a minute and retry the login once.

### Working across multiple Google accounts without constant login/logout
clasp 3.x reads the env var `clasp_config_auth` (a global `-A, --auth <file>` flag) to choose which credential file to use; default is `~/.clasprc.json`. Keep one credential file per account and select per command.

One-time, per account (sign in as the matching account each time):

```
mkdir -p ~/.clasp-accounts
clasp_config_auth=~/.clasp-accounts/soleilandtyler.json clasp login   # soleilandtyler@gmail.com (this project)
clasp_config_auth=~/.clasp-accounts/geddeslabs.json     clasp login   # tyler@geddeslabs.com
clasp_config_auth=~/.clasp-accounts/hiretyler.json      clasp login   # hiretyler@gmail.com (everything else)
```

Then add wrapper functions to `~/.zshrc` so daily use is friction-free:

```zsh
clasp-soleil()     { clasp_config_auth=~/.clasp-accounts/soleilandtyler.json clasp "$@"; }
clasp-geddeslabs() { clasp_config_auth=~/.clasp-accounts/geddeslabs.json     clasp "$@"; }
clasp-hiretyler()  { clasp_config_auth=~/.clasp-accounts/hiretyler.json      clasp "$@"; }
```

For KidPlan, always use `clasp-soleil` (e.g. `clasp-soleil push`, `clasp-soleil deploy -i <id>`). The env-var-prefix form is order-independent, which matters because `--auth` is a global flag clasp is fussy about placing after subcommands.

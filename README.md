# Oracle Access Request Lookup

Electron desktop app for looking up Oracle HCM worker assignments, assigned security roles, auto-provisioning rules, and cost center manager information. It also rebuilds Oracle's search indexes on a non-Production instance after a Prod-to-Test refresh, and posts an alert to Slack if a step fails.

---

## For Windows Users

1. Go to **https://github.com/DavidsonCollege/oracle_role_costcenter_lookup/releases**
2. Under the latest release, download the file ending in `.exe`
3. Run the installer — Windows will show a "Windows protected your PC" SmartScreen warning because the app isn't code-signed; click **More info** → **Run anyway**
4. Follow the installer prompts; choose an install directory if prompted
5. Launch **Oracle Access Request Lookup** from the Start menu
6. Enter your HCM Base URL, username, and password — the URL and username will be remembered next time; the password must be re-entered each session
7. The app requires a connection to the Davidson network (VPN or on-campus) to retrieve security roles. If you reconnect to VPN mid-session and lookups still fail, click the **Reconnect** button in the top-right corner to restart the app
8. When a new version is available, the app will prompt you to install it automatically

---

## For Mac Users

1. Go to **https://github.com/DavidsonCollege/oracle_role_costcenter_lookup/releases**
2. Under the latest release, download the file ending in `.dmg`
3. Open the `.dmg` file and drag **Oracle Access Request Lookup** into your Applications folder
4. Launch **Oracle Access Request Lookup** from your Applications folder
5. Enter your HCM Base URL, username, and password — the URL and username will be remembered next time; the password must be re-entered each session
6. The app requires a connection to the Davidson network (VPN or on-campus) to retrieve security roles. If you reconnect to VPN mid-session and lookups still fail, click the **Reconnect** button in the top-right corner to restart the app
7. When a new version is available, the app will download it automatically and show a dialog at startup — click **Restart Now** to apply the update

---

## Using the App

Enter the environment, username and password at the top. Below them are three tabs; the app remembers which one you used last.

- **Lookups**: person, assignment and security role lookups, cost center reports, and Cost Center Access (add or remove a cost center role).
- **Run Index Jobs**: running the Search Index Rebuild and watching its progress.
- **Indexing Tools**: Check index list, Inspect a request, Find latest, the rebuild config, and Slack alert setup.

### Search Index Rebuild

Use this only after a Prod-to-Test refresh of a non-Production instance. **Don't run it after quarterly updates**: Oracle reingests changed indexes itself during updates.

It submits Oracle's index ingest job for each search index one at a time and waits for each to finish. It then runs **Compute Users ACL**, **Process Access Control Lists for Learning Items for OSCS**, and the Recruiting jobs: **Load and Index Master Geography Hierarchy** (United States), **Load and Index Job Requisitions** and **Load and Index Candidates**. The last two use Indexing Mode **Drop and Recreate Index**. Upgrade Current Index does nothing after a refresh, even though it reports Succeeded. It stops at the first error or warning and alerts the team. It runs as you, with the credentials at the top, so your Oracle account needs permission to submit these jobs.

**Safeguards**
- It refuses to run against Production.
- You must type the instance name (for example `dev1`) to confirm.
- It never submits a step with a blank index name.
- The ACL and Recruiting jobs run only after every index step has succeeded.
- For the Recruiting jobs, the app also reads Oracle's progress counters and the log. A run that processed nothing, had failed items or logged "Job failed" stops with a warning.

**Running it**
1. Pick the environment at the top and open the **Run Index Jobs** tab.
2. Choose a run type:
   - **Full run**: every index, then the ACL jobs. A full run takes about 30 minutes.
   - **Test one step**: runs a single index or ACL job.
   - **Resume a stopped run**: picks up a run that stopped, skipping the steps that already succeeded.
3. Type the instance name to confirm and click **Start**. The table shows each step's status, Oracle request number, rows ingested and times.
4. **Stop after current step** lets the running Oracle job finish and then stops submitting more. It never cancels a job in Oracle. If you close the window during a run, the app asks first.

**When it stops**
- The app shows the reason, posts it to Slack and leaves the remaining steps pending.
- Look at the request in Oracle's **Scheduled Processes**, fix the cause, then use **Resume a stopped run**.
- If Oracle starts retrying a failed request on its own, the app stops right away rather than waiting. Cancel that request in Scheduled Processes if it shouldn't run again.

**What the results mean**
- **recreate only** in the Rows column is expected for some indexes, such as `fa-hcm-acl`, `fa-hcm-learn-acl`, `fnd-recentsearch` and `fa-hcm-person-results`. Oracle rebuilds them empty and fills them as people use the system.
- **Run records** opens the folder where every run is saved, one file per run. Resume reads from these files.
- If your config differs from the one shipped with the app, the tab says so and links to **Rebuild config** on the Indexing Tools tab.

### Indexing Tools

Everything on this tab is read-only in Oracle and works on any instance, including Production.

**Check index list (after the Production quarterly update)**
- Choose Production at the top and click **Check index list**. The app finds Oracle's latest reindex request (FndOSCSReindexJob, submitted by FAADMIN), reads the `Indices (created): [...]` line in its log, and lists:
  - **New in Oracle**: in Production but not in the step list or the exclusion list. Add it to the steps (test it first), or add it to the exclusions with a reason.
  - **Missing from Oracle**: in the step list but not in that log. An index created after the log's date won't be listed until the next reindex run, so check again then. Otherwise check whether Oracle removed or renamed it.
  - **Excluded on purpose**: indexes we deliberately don't rebuild, with the reason.
- The app shows the date of the log it read and warns if it's more than a week old.

**Inspect a request and Find latest**
- **Inspect a request** shows a request's status, parameters and log. Use it to find out why a rebuild step stopped, or to read the parameters a past run used. Each box has a **Copy** button.
- **Find latest** finds the newest request for a job and inspects it, so you don't need the request ID. Use the reindex job (FndOSCSReindexJob) to check that Oracle's own reindex ran after a quarterly update and read its log. Use the index ingest job (FndOSCSIndexIngestJob) to see the most recent single-index ingest, for example one someone ran by hand outside the app.
- If Check index list or Find latest can't find the request, open **How the app searched** under the result and send that text to the app's owner.

**Rebuild config**
- The list of indexes and the job settings come from `oscs-reindex.config.json`, which ships with the app. **Edit config** opens your own copy. If your copy differs from the shipped one after an update, this section shows the differences and a **Replace with shipped config** button. Your old copy is backed up first.
- The **Add to rebuild**, **Skip** and **Remove from rebuild** buttons in the Check index list result change your copy for you.
- When your copy differs from the shipped config, **Email this change to T&I** opens an email to ti@davidson.edu, for Admin Services. It lists each change with its reason and latest test, plus the steps to update the app, and saves your config to Downloads for you to attach. [UPDATING_THE_INDEX_LIST.md](UPDATING_THE_INDEX_LIST.md) covers making the change permanent.

### Slack alerts

Rebuild alerts go to **#team-admin-services-private**. Each computer that runs rebuilds needs the webhook URL entered once:

1. In 1Password, open **Slack webhook – Search Index Rebuild alerts** and copy its credential, a URL starting with `https://hooks.slack.com/services/`. If you can't see the item, ask for access to it.
2. On the **Indexing Tools** tab, paste it into **Slack alerts**, click **Save**, then click **Send test** and check that the message arrives in the channel.

The URL is stored encrypted on your computer, never in the app's settings file or this repository, and it stays through app updates. You'll need to enter it again on a new computer or user account. Treat it like a password: anyone who has it can post to the channel. Don't paste it into chat, email or tickets. **Remove** deletes it from your computer.

Without a webhook, alerts only show in the app. Until one is saved on your computer, the Slack alerts section on Indexing Tools is highlighted, the Run Index Jobs tab shows a note with a **Set up Slack alerts** link, and starting a full run or resume with Slack turned on asks you to confirm first.

**Testing without posting:** clear **Post alerts to Slack for this run** before clicking **Start**. It starts cleared for **Test one step** and ticked for full and resumed runs. Alerts still appear in the app, and the run record notes that Slack was off. **Send test** always posts.

---

## Setting Up for a New Oracle Instance

`PROJECT_NOTES.txt` in the repository root contains a full technical reference — API details, SOAP gotchas, report column names, IPC patterns, and deployment notes useful for anyone developing or adapting this app.

### Prerequisites

- Node.js 18 or later
- Git
- A GitHub account with access to the repository

### 1. Fork the Repository

Fork `DavidsonCollege/oracle_role_costcenter_lookup` to your own GitHub account. This gives you your own copy to modify and build from.

Clone it locally:
```bash
git clone https://github.com/<your-username>/oracle_role_costcenter_lookup.git
cd oracle_role_costcenter_lookup
npm install
```

### 2. Update the Environment URLs

Open `index.html` and find the environment dropdown (search for `saasfaprod1`). Replace `exci` in each URL with your organisation's equivalent segment:

```html
<option value="https://fa-exci-saasfaprod1.fa.ocs.oraclecloud.com">Production</option>
<option value="https://fa-exci-dev1-saasfaprod1.fa.ocs.oraclecloud.com">Dev 1</option>
<option value="https://fa-exci-dev3-saasfaprod1.fa.ocs.oraclecloud.com">Dev 3</option>
<option value="https://fa-exci-test-saasfaprod1.fa.ocs.oraclecloud.com">Test</option>
```

Add or remove environment options to match your own instance — the names (Production, Dev 1, etc.) can be anything meaningful to your team.

### 3. Import the Reports into Your Oracle Instance

Download the `.catalog` report files from the repository and import them into your Oracle BI Publisher instance. Once imported, note the path where each report was saved — you'll need these in the next step.

### 4. Update the Report Paths

Open `main.js` and update the three report paths to match where you imported them. Search for `Custom/Jessamyn`; the paths are for these reports (the other matches are comments):

| Report | File |
|--------|------|
| Cost Center Hierarchy | `AccountHierarchy/CostCenterHierarchy.xdo` |
| Cost Center Manager | `CostCenterManager/DeptCostCenterMgr.xdo` |
| Auto-Provisioning Rules | `Auto-Provisioning Rules/Auto-Provisioning Rules.xdo` |

Replace the paths with your own, keeping the `.xdo` extension:
```js
'/Custom/YourFolder/CostCenterManager/DeptCostCenterMgr.xdo'
'/Custom/YourFolder/Auto-Provisioning Rules/Auto-Provisioning Rules.xdo'
'/Custom/YourFolder/AccountHierarchy/CostCenterHierarchy.xdo'
```

> **Important:** The `.xdo` extension is required. Omitting it causes a misleading permission error from Oracle rather than a "not found" error.

### 5. Configure the Search Index Rebuild

Open `oscs-reindex.config.json` and set:

- `prodHosts`: your Production host name. The rebuild refuses to run against it.
- `nonProdHostPattern`: a pattern matching your non-Production hosts. Its first group is the instance name people type to confirm, such as `dev1`.
- `exclusions`: indexes in Production that you deliberately don't rebuild, each with a reason. Use `index` for one name or `prefix` for a group.
- `indexCheck`: the job name, submitter and number of days Check index list searches.
- `steps`: the indexes to rebuild. Oracle's list varies by instance, so test each one with **Test one step** and remove any that load 0 rows when they shouldn't.

`OSCS_REINDEX_FEATURE.md` has the full spec. For Slack alerts, create your own Slack app with an incoming webhook for your channel, and change the channel name shown on the Indexing Tools tab in `index.html`.

### 6. Test Locally

```bash
npm start
```

Enter one of your environment URLs, your Oracle username, and password. Try looking up a known worker by person number to confirm the connection works before testing name search and reports.

### 7. Set Up Your Release Pipeline

In your forked GitHub repository:
- Go to **Settings** → **Actions** → **General**
- Set Workflow permissions to **Read and write permissions**

Then build and release your first version:
```bash
git add .
git commit -m "v1.0.0: configure for <org name> Oracle instance"
git push origin main
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will build the Mac and Windows installers automatically and publish them as a release.

---

## For the Developer — Releasing a New Version

### Prerequisites (first time only)

Confirm GitHub Actions has permission to publish releases:
- Go to your repo → **Settings** → **Actions** → **General**
- Set Workflow permissions to **Read and write permissions**

### How releases work

Builds are created entirely by **GitHub Actions** — you never run the build commands locally. Pushing a `v*` tag to GitHub triggers the workflow, which builds the Mac DMG and Windows EXE in parallel and publishes them as a GitHub Release automatically. Running `npm run build` locally after pushing a tag will fail because the release already exists.

### If you are working with Claude Code

Tell Claude: **"commit, push, and build"** (or just **"build"** if changes are already committed). Claude will handle everything — bumping the version, committing, pushing main, creating and pushing the tag — which triggers the GitHub Actions release pipeline.

### If you are doing it yourself

1. Make and test your code changes locally with `npm start`
2. Open `package.json` and bump the `"version"` field following semver:
   - Bug fixes: `1.0.0` → `1.0.1`
   - New features: `1.0.0` → `1.1.0`
3. Commit all changes including the version bump, then push main:
   ```bash
   git add .
   git commit -m "v1.1.0"
   git push origin main
   ```
4. Create and push the tag (must start with `v`):
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```
5. GitHub Actions will automatically build both platforms and publish the release — monitor progress at **https://github.com/DavidsonCollege/oracle_role_costcenter_lookup/actions**
6. Once the workflow completes, users on both Mac and Windows will be prompted to update automatically on their next launch

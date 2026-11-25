# Feature spec: Rebuild Oracle Search (OSCS) indexes after a refresh, via REST

**For:** Claude Code, working in this project. Read this whole file before changing code.
**Owner:** Jessamyn Donovan (Davidson College T&I)
**Status:** Ready to build. Items marked **VERIFY** must be confirmed against the Oracle instance or the Oracle REST docs before you rely on them.

---

## 1. Goal

Add a feature that, after a Prod-to-Test (P2T) refresh of an Oracle Fusion non-Prod instance, does the following:

1. Submits Oracle's search index ingest job once per index, **one at a time, in a fixed order**, and waits for each to finish before starting the next.
2. Then runs the two ACL jobs that refill search security data.
3. Records every request ID and result, stops on any error or warning, and alerts the team.

This replaces about 36 manual submissions in Scheduled Processes. A Fusion job set can't do this unattended, because Fusion job sets make the user type each step's parameters at submission.

## 2. Background: why this matters

- Redwood pages (Team Time Cards, Learning Assignments, person search, Expenses and others) search Oracle Search Cloud Service (OSCS) indexes, not the database.
- After a refresh, Oracle says to reingest every index that exists, then recompute the access control lists (ACLs) for all users.
- Rebuilding an ACL index (`fa-hcm-acl`, `fa-hcm-learn-acl`) leaves it **empty** until its ACL job runs. While it's empty, searches return no results for most users. This happened in Prod on 11/21–11/24/2026.

## 3. Hard rules (guardrails)

1. **Never target Prod.** The feature must refuse to run if the selected instance is Prod. Require the user to pick the instance and confirm it by name.
2. **Never submit the ingest job with a blank index name.** A blank name makes Oracle rebuild *every* predefined index. Validate that each index name is non-empty before submitting.
3. **Run serially.** Submit one request, wait until it reaches a final status, then submit the next. Oracle recommends one at a time to avoid overloading OSCS.
4. **Stop on Error or Warning.** Don't continue to the next step. Alert the team (section 8) and leave the rest for a person to review.
5. **ACL jobs run last**, only after every ingest step has succeeded.
6. **Don't run this after quarterly updates.** Oracle reingests changed indexes itself during updates. This feature is for refreshes only. Show this note in the UI.

## 4. Authentication

- Match the app's existing auth. Jessamyn's decision: it runs as the **signed-in person via OAuth**, not a service account.
- That user needs the privilege to submit these jobs: `FND_MANAGE_SCHEDULED_JOB_DEFINITION_PRIV`, plus HCM access for the ACL jobs. **VERIFY** in the target instance before the first run.

## 5. Jobs to run

### 5a. Index ingest job (once per index)

| Field | Value |
|---|---|
| Display name | ESS job to create index definition and perform initial ingest to OSCS |
| Job definition name | `FndOSCSIndexIngestJob` |
| Package / path | `/oracle/apps/ess/fnd/applcore` (confirmed in Manage Job Definitions) |
| ESS application | `FscmEss` (Job Application Name). Effective application for submission is probably `FscmEss` or `EarFscmEss`. **VERIFY**: a custom job set only submitted after `SYS_effectiveApplication` was set |
| Parameter 1 | **Index Name to Reingest**: string, required |
| Parameter 2 | **Use Existing Index**: boolean, required. Use **false**, which matches past successful manual runs. **VERIFY** the format the API expects (`false` or `N`) |

### 5b. ACL jobs (after all ingests succeed, in this order)

| Order | Display name | Job definition name | ESS application | Parameters |
|---|---|---|---|---|
| 1 | Compute Users ACL | `ComputeUsersACL` | `EarHcmEss` (**VERIFY**) | User Population = **All Users** (shows as `ALL_USERS` in its log). **VERIFY** the parameter's internal value and position |
| 2 | Process Access Control Lists for Learning Items for OSCS | `ProcessLearningItemsOSCSACLJob` | `EarHcmEss` (**VERIFY**) | Select Activities = *Refresh OSCS Learning Item ACL Index Only*; Learners per Batch = **1000** (anything lower fails); Concurrent Processes = **5**. **VERIFY** internal values and argument order |

- **Package paths for both ACL jobs: VERIFY.** They're cut off in the screenshots. Get them from Setup and Maintenance > Manage Enterprise Scheduler Job Definitions and Job Sets for Human Capital Management > Path column.
- Don't submit `ComputeUsersACLProcessor` or `ProcessLearningItemsOSCSACLChild…`. The parent jobs start those themselves. Compute Users ACL starts 20 child jobs and finishes after they do.
- **Tip for finding internal parameter values:** read the parameters of a past successful request. Compute Users ACL All Users was request **11288959** in Prod on 11/24/2026, and the Learning ACL job ran the same day. Fetch the request details through the REST API (section 6) and copy the `submit.argumentN` values.

## 6. REST approach

Two Oracle REST options are plausible. Look at what this project already uses for Oracle calls and prefer that. Confirm the endpoint and payload against Oracle's REST docs for this release before writing code.

**Option A: ERP Integrations REST resource (well documented for FscmEss jobs)**
- Submit: `POST /fscmRestApi/resources/11.13.18.05/erpintegrations` with `OperationName` = `submitESSJobRequest`, `JobPackageName`, `JobDefName`, and `ESSParameter` (a comma-separated list of parameter values in order).
- Status: `GET /fscmRestApi/resources/11.13.18.05/erpintegrations?finder=ESSJobStatusRF;requestId=<id>` returns the request status.
- Logs: `OperationName` = `downloadESSJobExecutionDetails`.
- Fits `FndOSCSIndexIngestJob` (FscmEss). **VERIFY** whether it can submit the HCM jobs (EarHcmEss). It may not.

**Option B: ESS scheduler REST API**
- A generic scheduler endpoint (for example under `/ess/rest/scheduler/v1/requests`) that takes the job definition ID, application and request parameters.
- May be needed for the two HCM ACL jobs. **VERIFY** that it exists and is enabled in this instance, and what auth it accepts.

Whichever you use, wrap it in one function: `submitJob(def) -> requestId`, plus `getStatus(requestId)` and `getLog(requestId)`. That way the runner (section 7) doesn't depend on which API is used.

## 7. Runner logic

```
confirm instance is not Prod; user confirms instance name
load ordered step list (section 9); validate every index name is non-empty

for each ingest step in order:
    requestId = submitJob(FndOSCSIndexIngestJob, [indexName, false])
    record {step, requestId, submittedAt}
    poll getStatus every 30–60 s until final (SUCCEEDED / ERROR / WARNING / CANCELLED)
    on SUCCEEDED: fetch log and check (section 7a); if check fails -> treat as WARNING
    on anything else: record, alert (section 8), STOP

submit ComputeUsersACL (All Users); poll; same checks
submit ProcessLearningItemsOSCSACLJob; poll; same checks
mark run complete; post a summary
```

- **Index busy:** if submission fails with "index … is being used by other job(s)", wait about 5 minutes and retry up to 3 times, then stop and alert.
- **Resume:** let the user restart from a chosen step, skipping steps already marked SUCCEEDED in this run.
- **Expected duration:** `fa-hcm-person-results` took about 10 minutes in Prod and most others take under 2. Plan for 30–60 minutes total, plus about 5 minutes for Compute Users ACL.

### 7a. Log checks (a job can say Succeeded but still be wrong)

| Job | Treat as a problem if the log… |
|---|---|
| Ingest | shows rows failed > 0 (`Total number of rows failed in the payload`), shows `number of records not ingested` > 0, or doesn't show the expected index name. A count of 0 rows is a **warning** for indexes tagged "verify", but normal for `fa-prc-pa` (Prod had 0 rows). |
| Compute Users ACL | doesn't contain `Compute Users ACL... done`, or the user count is far below about 4,500 |
| Learning ACL | reports errors, or a learner count far below about 1,380 |

## 8. Alerts and output

- **Slack:** post errors, warnings and the final summary to `#team-admin-services-private`. Include the instance, step, index, request ID, status and a short log excerpt.
- **Run record:** save a per-run file or table with each step's request ID, status, start and end time, and rows processed. If the app has a task tracker, write to it.

## 9. Ordered step list

Keep this as config (JSON or YAML), not hard-coded, so the team can edit it. **Future option** (open item): build the list from the `Indices (created): [...]` line in the latest Prod `FndOSCSReindexJob` log (recurring parent schedule 8102293), then apply this order.

| # | Index | Area | Notes |
|---|---|---|---|
| 1 | `fa-hcm-acl` | HCM security | ACL index, refilled by Compute Users ACL |
| 2 | `fa-hcm-person` | HCM | |
| 3 | `fa-hcm-person-results` | HCM | longest, about 10 min |
| 4 | `fa-hcm-job` | HCM | |
| 5 | `fa-hcm-position` | HCM | |
| 6 | `fa-hcm-location` | HCM | |
| 7 | `fa-hcm-organization` | HCM | |
| 8 | `fa-hcm-personprofile` | HCM | |
| 9 | `fa-hcm-modelprofile` | HCM | |
| 10 | `fa-hcm-personbenefits` | Benefits | |
| 11 | `fa-hcm-timecard` | Time and Labor | |
| 12 | `fa-hcm-requisition` | Recruiting | |
| 13 | `fa-hcm-irc-geohierarchies` | Recruiting | |
| 14 | `fa-hcm-workerjourney` | Journeys | |
| 15 | `fa-hcm-workerjourneytask` | Journeys | |
| 16 | `fa-hcm-savedsearch` | Saved searches | |
| 17 | `fa-hcm-learningitem` | Learning | Oracle's order: learningitem, then learn-acl, then learningrecord |
| 18 | `fa-hcm-learn-acl` | Learning security | ACL index, refilled by the Learning ACL job |
| 19 | `fa-hcm-learningrecord` | Learning | |
| 20 | `fa-hcm-learningassignmentprofile` | Learning | new in 26D |
| 21 | `fa-hcm-mylearningassignments` | Learning | new in 26D |
| 22 | `fa-hcm-learningrecommendation` | Learning | new in 26D |
| 23 | `fa-fin-exm-expenses` | Expenses | |
| 24 | `fa-fin-exm-reports` | Expenses | |
| 25 | `fa-fin-exm-locations` | Expenses | |
| 26 | `fa-prc-shoppingcatalog` | Procurement | |
| 27 | `fa-prc-por` | Procurement | |
| 28 | `fa-prc-pa` | Procurement | 0 rows in Prod is normal |
| 29 | `fa-prc-poi` | Procurement | verify |
| 30 | `fa-prc-suppliers` | Procurement | |
| 31 | `fnd-worklist-approvals` | Platform | verify |
| 32 | `fnd-ao-tasks-and-places` | Platform (Ask Oracle) | verify |
| 33 | `fnd-ao-tasks-and-places-sandbox` | Platform (Ask Oracle) | verify |
| 34 | `fnd-recentsearch` | Platform | verify |

**Leave out** (Oracle-managed or not used at Davidson): `fnd-attachments` (has its own recurring job), `fa-crm-productcatalog`, `fa-scm-rcv-aprcpt`, `fa-scm-msc-lead-time-orders`, `fa-scm-msc-lead-time-insights`, `fa-psc-apo-parcel`.

**"verify" steps:** if one fails or loads 0 rows during testing, remove it from the config.

## 10. Build and test plan

1. Confirm the REST endpoint, auth and payload with a **single** ingest of a small index (`fa-hcm-savedsearch`) in a non-Prod instance. Check its log for the right index name and `Use Existing Index` value.
2. Confirm the ACL jobs' paths and internal parameter values (section 5b), then submit Compute Users ACL by itself.
3. Run the full sequence in non-Prod. Check every log check passes.
4. Test as restricted users, including one who hasn't signed in recently: Team Time Cards (line manager, timekeeper), Learning Assignments, person search, Expenses search.
5. Test failure handling: stop on a forced error, the Slack alert, and resuming from a step.

## 11. Open questions (VERIFY list)

- [ ] Which REST API submits FscmEss jobs and EarHcmEss jobs as the signed-in OAuth user?
- [ ] The `FndOSCSIndexIngestJob` parameter format for Use Existing Index (`false` or `N`).
- [ ] Package paths for `ComputeUsersACL` and `ProcessLearningItemsOSCSACLJob`.
- [ ] Internal values and argument order for the two ACL jobs' parameters.
- [ ] Whether the effective application must be passed explicitly (`FscmEss` or `EarFscmEss`; `EarHcmEss`).

## 12. Sources

- Prod ESS logs, 11/21–11/24/2026: `FndOSCSIndexIngestJob` 11250435 (Oracle's post-update ingest), `FndOSCSReindexJob` 11250382 (full list of Prod indexes), Compute Users ACL 11288299 (logged-in users) and 11288959 (all users), Import User and Role Application Security Data 11285720.
- Oracle docs: [Refresh Indexes After P2T](https://docs.oracle.com/en/cloud/saas/human-resources/faeos/refresh-indexes-after-p2t.html), [Refresh Indexes After Upgrade](https://docs.oracle.com/en/cloud/saas/human-resources/faeos/refresh-indexes-after-upgrade.html), [Run Initial Data Ingestion](https://docs.oracle.com/en/cloud/saas/human-resources/faeos/run-initial-data-ingestion.html), [Job Sets](https://docs.oracle.com/en/cloud/saas/human-resources/faucf/job-sets.html).
- Job set attempt (11/25/2026): a custom job set with this job submits only after `SYS_effectiveApplication` is set, and still needs each step's parameters entered by hand. That's why this feature uses REST.

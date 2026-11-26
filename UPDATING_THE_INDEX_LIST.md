# Updating the shipped index list

What to do once a change to the Search Index Rebuild's index list has been tested and should apply to everyone's future runs. That covers adding an index, skipping one or removing one.

Changes made with the buttons on the Scheduled Processes tab (or **Edit config**) are saved only in that person's copy of the config. To make a change permanent, it goes into the shipped `oscs-reindex.config.json` in this repository and out in a new release.

## 1. Collect the change

Requests usually arrive as a T&I ticket assigned to Admin Services, sent from the app's **Email this change to T&I** button. That email lists each change with its position, area, reason and latest test, the exact entries to copy, and has the requester's config file attached. If it didn't come that way, for each index get:

| What | Example |
|---|---|
| Index name | `fa-hcm-contentitem` |
| Change | Add, skip or remove |
| Position, for an addition | After `fa-hcm-personprofile` |
| Area | `HCM (Talent Profile)` |
| Reason | `Required for Redwood Item Catalogs since 26D (KB937810)` |
| Test request number and environment | `10536700 on dev1, Succeeded, 1,234 rows` |

The person who tested it can see their changes on the Scheduled Processes tab under **Your config differs from the one shipped**. Their config file's location is shown at the top of the same tab, after "steps from your config:".

Copy only the change itself, not their whole config file. Their copy may differ in other ways that shouldn't ship.

## 2. Edit the shipped config

Work on a branch, never directly on `main`:

```bash
git checkout main && git pull
git checkout -b config/<short-description>
```

Open `oscs-reindex.config.json` and make the change.

**Add an index:** add an entry to `steps`, at the agreed position. Index steps run in list order, and the ACL and Recruiting jobs always run after all of them.

```json
{
  "index": "fa-hcm-contentitem",
  "area": "HCM (Talent Profile)",
  "notes": "Required for Redwood Item Catalogs since 26D (KB937810)"
},
```

- Add `"verify": true` if the index should never load 0 rows. The run then stops with a warning if it does.
- If the index was listed in `exclusions`, remove it from there. The config refuses an index that's both a step and an exclusion.

**Skip an index:** add an entry to `exclusions`, with the reason and the evidence. Include the test request number and date if it was tested.

```json
{ "index": "fa-prc-poi", "reason": "0 rows in dev1 (request 10534408, 11/25/2026)" }
```

If the index was a step, remove it from `steps`.

**Remove an index:** delete its entry from `steps`.

- If Oracle removed or renamed it, that's all.
- If it's being dropped because it isn't used or loads nothing, add it to `exclusions` with the reason as well. Otherwise **Check index list** flags it as **New in Oracle** every quarter.

## 3. Update the tests and the spec

1. In `test/smoke.js`, the test `shipped OSCS config is valid, with N unique non-blank indexes` checks the number of index steps. Change both numbers (the test name and `cfg.steps.length`) to the new count.
2. In `OSCS_REINDEX_FEATURE.md`, section 9 ("Ordered step list") has a table of the indexes. Add, remove or move the row, and renumber.
3. Run the tests:

   ```bash
   npm test
   ```

   They check that the shipped config is valid: no blank or duplicate index names, no index that's both a step and an exclusion, and every job complete.

## 4. Check it in the app

1. Run `npm start`.
2. On the Scheduled Processes tab, if it says your config differs from the shipped one, click **Replace with shipped config**. Your current copy is backed up first.
3. Confirm the change shows in the step list for **Test one step**.
4. Choose **Production** and click **Check index list**. The index should no longer appear under **New in Oracle** or **Missing from Oracle**. If it was skipped, it should appear under **Excluded on purpose** with its reason.

## 5. Release it

Follow the release steps in `CLAUDE.md`. In short:

1. Bump `"version"` in `package.json` as a patch, for example `1.6.0` → `1.6.1`. Run `npm install` so `package-lock.json` matches.
2. Commit, push the branch and open a pull request. The PR check runs `npm test`.
3. Merge the pull request, then push the tag from `main`:

   ```bash
   git checkout main && git pull
   git tag v1.6.1 && git push origin v1.6.1
   ```

4. GitHub Actions builds and publishes the release. Never run `npm run build` locally to publish.

If you use Claude Code, you can instead tell it the change from step 1 and say "update the shipped index list and release it".

## 6. After the release

1. Tell the people who run rebuilds that the release is out. Installed apps update themselves.
2. Each of them opens the Scheduled Processes tab. If it says **Your config differs from the one shipped**, they check the list of differences:
   - If it lists only the change that was just released, or nothing they need, they click **Replace with shipped config**. Their old copy is backed up first.
   - If it lists other changes of theirs, those still need to go through steps 1 to 5 before they replace their copy. Otherwise those changes are lost from their config, although the backup keeps them.
3. Record the change in the quarterly record in the How To, with the release version.

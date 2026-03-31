# Oracle Access Request Lookup

Electron desktop app for looking up Oracle HCM worker positions, assigned security roles, auto-provisioning rules, and cost center manager information.

---

## For Windows Users

1. Go to **https://github.com/JessamynR/oracle_tools/releases**
2. Under the latest release, download the file ending in `.exe`
3. Run the installer — Windows will show a "Windows protected your PC" SmartScreen warning because the app isn't code-signed; click **More info** → **Run anyway**
4. Follow the installer prompts; choose an install directory if prompted
5. Launch **Oracle Access Request Lookup** from the Start menu
6. Enter your HCM Base URL, username, and password — the URL and username will be remembered next time; the password must be re-entered each session
7. When a new version is available, the app will prompt you to install it automatically

---

## For Mac Users

1. Go to **https://github.com/JessamynR/oracle_tools/releases**
2. Under the latest release, download the file ending in `.dmg`
3. Open the `.dmg` file and drag **Oracle Access Request Lookup** into your Applications folder
4. On first launch, macOS will block it because the app isn't code-signed — do **not** double-click; instead, **right-click** the app in Applications → **Open** → **Open**
   - You only need to do this once; future launches work normally
5. Enter your HCM Base URL, username, and password — the URL and username will be remembered; the password must be re-entered each session
6. When a new version is available, a notification dialog will appear at startup — click **Download** to open the releases page, then follow steps 2–3 above to update

---

## For the Developer — Releasing a New Version

### Prerequisites (first time only)

Confirm GitHub Actions has permission to publish releases:
- Go to your repo → **Settings** → **Actions** → **General**
- Set Workflow permissions to **Read and write permissions**

### For each new release

1. Make and test your code changes locally with `npm start`
2. Open `package.json` and bump the `"version"` field following semver:
   - Bug fixes: `1.0.0` → `1.0.1`
   - New features: `1.0.0` → `1.1.0`
3. Commit the version bump:
   ```bash
   git add package.json
   git commit -m "v1.1.0"
   ```
4. Create a tag matching the new version (must start with `v`):
   ```bash
   git tag v1.1.0
   ```
5. Push the commit and tag:
   ```bash
   git push origin main --tags
   ```
6. GitHub Actions will automatically build the Mac DMG and Windows EXE in parallel and attach both to a new GitHub Release — monitor progress at **https://github.com/JessamynR/oracle_tools/actions**
7. Once the workflow completes, Windows users will be prompted to update automatically on their next launch; Mac users will see a notification dialog

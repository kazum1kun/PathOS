# Deploy the web app

PathOS is a static, client-only web app. To deploy it, you only need the generated `dist/` files. Game packages and saves are imported on the user's device and stored in IndexedDB. Nothing is uploaded to a server.

## Local use

With Node.js installed, build once from the project root:

```sh
npm run build
python3 -m http.server 8000 --directory dist --bind 0.0.0.0
```

Open `http://localhost:8000` on the same computer. To use the app on a phone, deploy it over HTTPS. A plain `http://YOUR_COMPUTER_IP:8000` address isn't a secure context, and the importer needs Web Crypto to fingerprint versions, so imports will fail there. Offline installation in the browser also requires HTTPS.

Don't open `dist/index.html` directly from disk. The app uses JavaScript modules and storage APIs that only work when served over HTTP(S).

## Production

Upload the contents of `dist/` to a static HTTPS host, and keep the site address the same across releases. Give the app its own host or path if you can, so its service worker caches only the app's own files.

Your server needs to:

- Serve JavaScript files with a JavaScript MIME type and JSON files with a JSON MIME type.
- Serve `index.html`, `sw.js`, and the web manifest without long-lived or immutable caching, because those files control app updates.
- Keep all of the app's files together at the same relative paths.

There's no backend API, authentication service, or database server to set up, and the server doesn't need to accept uploads. Imports go through the browser's file picker, and extracted assets stay in the local library.

For a private installation, add authentication at the hosting layer, then test that offline use still works. Some authentication setups prevent the service worker from caching responses.

## GitHub Actions

The [`Build web app`](../.github/workflows/web.yml) workflow builds on GitHub's standard `ubuntu-24.04` runner with Node.js 22. Push the workflow to the GitHub repository's default branch, then open **Actions → Build web app → Run workflow**, select a branch, and start the run. Leave **Deploy the built website to Cloudflare Pages** unchecked to build without Cloudflare credentials. Download `pathos-web` from the successful run's **Artifacts** section; its ZIP contains the website files ready to serve over HTTPS.

To enable Cloudflare deployment, open **Settings → Secrets and variables → Actions** in the GitHub repository and add:

| Setting | Type | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Repository secret | API token with **Account → Cloudflare Pages → Edit** for the project's account |
| `CLOUDFLARE_ACCOUNT_ID` | Repository variable or secret | The Cloudflare account ID |
| `CLOUDFLARE_PAGES_PROJECT` | Repository variable | The exact Pages project name to create or deploy, such as `pathos` |

Run **Build web app** with the Cloudflare deployment checkbox selected. Leave **Create the configured Pages project if it does not exist** checked for the first deployment. The workflow checks the account's Pages project list and creates a missing project with the repository's default branch as its production branch. Existing projects keep their settings. Disable this option if you only want to deploy to an existing project. Project creation uses the same **Cloudflare Pages → Edit** token permission.

After checks, tests, and the web build pass, the workflow uploads `dist/` using Wrangler 4. It passes the selected branch and commit to Pages. Match your Pages production branch to your release branch (`main` by default); other branches create previews. The deployed URL appears in the Wrangler log. See Cloudflare's [Direct Upload with CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

If Wrangler reports **The Pages project "pathos" does not exist**, check that `CLOUDFLARE_ACCOUNT_ID` selects the account you intend and `CLOUDFLARE_PAGES_PROJECT` is the exact project name. A Worker with that name is a separate resource. Push this workflow update and start a new run with project creation enabled, or create a Pages project manually with Direct Upload. Rerunning the original failed run uses its original workflow revision.

The workflow runs manually and keeps build artifacts for seven days. GitHub's standard runners are free for public repositories; private repositories use the account's included minutes and storage. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). A build without the deployment checkbox doesn't need Cloudflare settings.

## Cloudflare Pages through Codemagic

The `cloudflare-pages` workflow in [`codemagic.yaml`](../codemagic.yaml) runs on Linux with Node.js 22. It installs the web dependencies, runs the checks and tests, builds `dist/`, and deploys that folder with Wrangler 4. Deployment runs only after those steps succeed. See Cloudflare's [Direct Upload with CI guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

Before the first deployment:

1. Create a Cloudflare Pages project using **Direct Upload**, or choose an existing project. Set its production branch to `main` if that is your release branch.
2. Create a Cloudflare API token with **Account → Cloudflare Pages → Edit** permission scoped to the account containing that project.
3. In Codemagic's app environment variables, create a group named `cloudflare_pages` and add:

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The API token; enable **Secret** |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID |
| `CLOUDFLARE_PAGES_PROJECT` | The Pages project name, such as `pathos` |

Commit and push the updated workflow and documentation, then rescan the configuration in Codemagic. Start a build from a repository branch and select **PathOS Cloudflare Pages** (`cloudflare-pages`). The workflow runs manually and prints the deployed URL in the Wrangler log. The built `dist/` files are also available as Codemagic artifacts.

The workflow passes the selected repository branch to Cloudflare. A build from the Pages project's production branch updates the production site; other branches create [preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/). Use the stable production URL for your library: preview URLs have separate browser storage.

Codemagic performs the build, so no Cloudflare build command or output-directory setting is needed for Direct Upload. Keep Pages' default cache behavior; avoid custom rules that give `index.html`, `sw.js`, or the web manifest long cache lifetimes.

## Installing in the browser and storage

On iOS, open the HTTPS site in Safari and tap **Share → Add to Home Screen**. Open the app once while online before testing it offline. Imported games and their assets are stored locally. The service worker only caches the app itself, not a catalog of games.

Browser storage belongs to the full origin: scheme, hostname, and port. A new hostname, a different development port, a different browser profile, and the iOS app each get their own library. Export a backup before moving to a new address or clearing site data. Private browsing and low device storage can also cause data to be cleared.

Where the browser supports it, the app asks for persistent storage, but it can't guarantee that the operating system or browser will keep website data forever. Regular backups give you a copy you can move.

## Updating the website

Build the new source, deploy all of `dist/`, and reopen the site at the same address. Don't rename the IndexedDB database (`story-vault`). Make schema changes through versioned migrations. Updating the app doesn't touch imported game packages or their saves.

To move games and saves between the browser and the iOS app, export a backup. This release intentionally has no sync between devices.

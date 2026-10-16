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

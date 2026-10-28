# Deploying to App Platform

This folder (`ecommerce-image-copy-demo/`) is a complete, self-contained
Node.js web app — `server.js` + `package.json` — ready to deploy as-is.

## 1. Push this code to GitHub (or GitLab)

App Platform deploys from a git repo, not a local folder.

```bash
cd ecommerce-image-copy-demo
git init
git add .
git commit -m "Build it live demo"
git branch -M main
git remote add origin https://github.com/<your-username>/ecommerce-image-copy-demo.git
git push -u origin main
```

With this layout — this folder *is* the repo root — `app.yaml`'s
`source_dir` line should stay commented out/deleted, which it already is.

If you'd rather push this as a subfolder of a bigger repo, uncomment
`source_dir: /ecommerce-image-copy-demo` (or whatever path you used) in
`app.yaml`.

## 2. Fill in `app.yaml`

Edit `app.yaml` in this folder:

- `github.repo`: set to `<your-username>/ecommerce-image-copy-demo`
- `github.branch`: usually `main`
- `MODEL_ACCESS_KEY` value: leave the placeholder for your first deploy —
  `DRY_RUN=true` means it isn't needed yet. Set the real value later via
  the Control Panel or `doctl`, not by committing it to git.
- `AUTH_USERNAME` / `AUTH_PASSWORD`: the spec ships with `solutions` /
  `champs` as requested. Change these to your own values before sharing the
  deployed URL with anyone outside a quick internal demo.

## 3. Deploy

**Using `doctl`:**

```bash
doctl apps create --spec app.yaml
```

This comes up with `DRY_RUN=true` — safe, no key needed, no spend — so you
can confirm the deploy works before adding real credentials.

**Using the Control Panel:**

Apps → Create App → GitHub → pick the repo/branch → App Platform
auto-detects Node.js from `package.json` → on the review screen, paste in
`app.yaml`'s contents (Edit Your App Spec) or set `http_port: 8080`, the
health check path to `/healthz`, and the env vars manually → Create
Resources.

## 4. Verify the dry-run deploy

Open `https://<your-app>.ondigitalocean.app/`:

- Your browser should prompt for a username/password — log in with
  `solutions` / `champs` (or whatever you set).
- You should see the "dry run" badge in the header.
- Type a product idea (or click an example chip) and click **Generate** —
  within a second or two you should see a colorful placeholder image on the
  left and mock marketing copy on the right, each labeled as dry-run.
- Click **Regenerate** on just the image panel, then just the copy panel,
  and confirm each one updates independently without touching the other.
- `/healthz` should return `ok` **without** needing a username/password —
  this route is explicitly exempt from auth so App Platform's own health
  checks don't get locked out.

## 5. Go live

1. Get a real model access key: Control Panel → **Inference** →
   **Model Access Keys** → Create Model Access Key.
2. Confirm the team's Inference & Agents balance is positive (Serverless
   Inference is prepaid). Image generation typically costs more per call
   than chat completions — budget accordingly if you'll be regenerating a
   lot during a live demo.
3. In the app's Settings → `web` component → Environment Variables:
   - Set `MODEL_ACCESS_KEY` to the real key (mark it **Encrypted**).
   - Set `DRY_RUN` to `false`.
   - Optionally set `IMAGE_QUALITY=low` for faster, cheaper turnaround
     during a live, repeated-regeneration demo.
4. Save — App Platform redeploys automatically.
5. Reload the app, log in again, and try it again. This now sends real
   requests to `https://inference.do-ai.run/v1/chat/completions` and
   `https://inference.do-ai.run/v1/images/generations`.

## Notes

- `instance_size_slug: apps-s-1vcpu-1gb` is the smallest paid tier — plenty
  for this app, since all the real work happens on DigitalOcean's inference
  side, not locally.
- `deploy_on_push: true` means every push to `branch` auto-redeploys; turn
  it off in `app.yaml` for manual control.
- The `health_check.http_path: /healthz` entry in `app.yaml` matters here
  specifically because the rest of the app requires Basic Auth — without
  it, App Platform's default health check would hit an authenticated route,
  get a 401, and could mark the app unhealthy.
- Basic Auth credentials are sent with every request over HTTPS (which App
  Platform provides by default), so they aren't sent in the clear — but
  Basic Auth is still a simple gate, not a full auth system. Good enough for
  keeping a demo URL from being stumbled on by search engines or random
  visitors; not a substitute for real access control if this needs to
  protect anything sensitive.

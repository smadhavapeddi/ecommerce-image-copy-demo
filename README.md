# Build It Live — Product Image + Copy Generator

Type a one-line product idea. Watch a studio-style product photo and
marketing copy get generated side by side, each with its own independent
**Regenerate** button — regenerating the image doesn't re-run the copy, and
vice versa.

This is the one demo in this series that exercises DigitalOcean's
**`/v1/images/generations`** endpoint (GPT-IMAGE-2) — none of the others
touch image generation.

Zero external dependencies — Node.js 18+ standard library (`http`, `zlib`,
built-in `fetch`) only. One file, `server.js`, is the whole app. Protected
by HTTP Basic Auth out of the box.

## Login

The whole app sits behind HTTP Basic Auth — your browser will prompt for a
username and password the first time you load the page.

- **Username:** `solutions`
- **Password:** `champs`

Both are configurable via the `AUTH_USERNAME` / `AUTH_PASSWORD` environment
variables — change them before sharing the URL beyond a quick internal demo
(see the Notes section below).

## What it does

- A single text input for a product idea, plus three example chips to load
  a preset idea with one click.
- Clicking **Generate** fires two independent requests in parallel — one to
  generate the image, one to write the copy — so each side of the screen
  fills in as soon as it's ready, instead of both being blocked on whichever
  is slower.
- Each panel (Product Image / Marketing Copy) has its own **Regenerate**
  button, wired to its own backend route (`/api/generate-image` and
  `/api/generate-copy`), so you can keep rolling the dice on just the image
  — or just the copy — without paying for or waiting on the other.
- Marketing copy is requested from the model as structured JSON (name,
  tagline, description, three bullet points) and rendered as a proper
  listing layout, not a wall of text.
- A `DRY_RUN` mode that returns canned mock copy and a locally generated
  placeholder image (a colorful gradient derived from your typed idea — a
  real, valid PNG, just not an AI-generated photo), so you can demo the full
  flow with no API key and no cost.

## Run it locally

```bash
cd ecommerce-image-copy-demo
DRY_RUN=true PORT=8080 node server.js
# open http://localhost:8080 — log in with solutions / champs
```

To hit the real API locally instead:

```bash
export MODEL_ACCESS_KEY=sk-...
PORT=8080 node server.js
```

### Env vars

| Var                   | Default                | Notes                                                                 |
|------------------------|-------------------------|------------------------------------------------------------------------|
| `MODEL_ACCESS_KEY`     | *(none)*               | Required unless `DRY_RUN=true`. Control Panel → Inference → Model Access Keys. |
| `CHAT_MODEL`           | `openai-gpt-oss-120b`  | Writes the marketing copy.                                            |
| `IMAGE_MODEL`          | `openai-gpt-image-2`   | Generates the product photo, per DigitalOcean's `/v1/images/generations` reference. |
| `IMAGE_SIZE`           | `auto`                 | `auto`, `1536x1024` (landscape), or `1024x1536` (portrait).            |
| `IMAGE_QUALITY`        | `auto`                 | `auto`, `high`, `medium`, or `low`. Try `low` for faster/cheaper live demos. |
| `IMAGE_OUTPUT_FORMAT`  | `jpeg`                 | `png`, `webp`, or `jpeg`.                                              |
| `IMAGE_BACKGROUND`     | `opaque`               | `transparent`, `opaque`, or `auto` — `opaque` suits a studio product shot. |
| `AUTH_USERNAME`        | `solutions`            | HTTP Basic Auth username.                                              |
| `AUTH_PASSWORD`        | `champs`               | HTTP Basic Auth password.                                              |
| `DRY_RUN`              | `false`                | `true` = mock copy + placeholder image, no API calls, no cost.        |
| `PORT`                 | `8080`                 | App Platform sets this automatically.                                 |

## Deploying to App Platform

This folder is ready to deploy as-is. See **`DEPLOY.md`** for the full
step-by-step (push to GitHub, fill in `app.yaml`, deploy with `doctl` or the
Control Panel, verify dry-run, then go live with a real key).

Quick version:

```bash
git init && git add . && git commit -m "Build it live demo"
git remote add origin https://github.com/<you>/ecommerce-image-copy-demo.git
git push -u origin main
# fill in github.repo in app.yaml, then:
doctl apps create --spec app.yaml
```

## Customizing for a specific demo

- Edit `EXAMPLE_IDEAS` near the top of `server.js` to swap in product
  categories relevant to the audience you're demoing for.
- Edit `buildImagePrompt()` to change the photography style (lifestyle shot
  instead of studio-white, a specific color palette, etc.).
- Edit `COPY_SYSTEM_PROMPT` to change tone (more playful, more premium/luxury,
  shorter, etc.) or add fields to the JSON shape (e.g. a suggested price).

## Notes

- **Copy is requested as JSON** (name/tagline/description/bullets) but
  language models don't always follow a format perfectly — the server
  tolerates markdown code fences and stray text around the JSON, and falls
  back to showing the raw reply as the description if it truly can't parse
  anything, so the UI never just breaks.
- **Images are real AI generations in live mode** — review before using in
  an actual store listing; treat `revised_prompt` (shown under the image) as
  a transparency nicety, not a guarantee of what's depicted.
- **Default credentials are meant for a quick demo, not production.** If
  this will be reachable by anyone outside your immediate demo audience,
  change `AUTH_USERNAME` / `AUTH_PASSWORD` to something only you know, via
  the Control Panel rather than committing new values to git.
- Image generation is typically slower and pricier per call than chat
  completions or embeddings — the independent regenerate buttons exist
  specifically so you're not forced to pay for a fresh image every time you
  just want to reroll the copy.

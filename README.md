# Long2Short

Turns a long-form YouTube video into short-form 9:16 clips using:

- **Apify** — fetches the source video, transcript, and (if the actor supports it) scene cuts
- **GLM via NVIDIA build.nvidia.com** — acts as the "editor": reads the transcript + your rules
  and outputs a structured edit plan (which moments to clip, caption timing, zoom/pan moves)
- **Remotion** — renders that edit plan into actual 9:16 `.mp4` files with captions and zoom/pan

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Fill in `.env.local`:

- `APIFY_TOKEN` — from your Apify account
- `APIFY_YOUTUBE_ACTOR_ID` — **you need to pick this.** Search the Apify Store for a
  YouTube transcript/scraper actor and paste its actor ID in. Different actors return
  different field names, so open `lib/apify.ts` and adjust the field mapping in
  `fetchVideoIntel()` to match whatever actor you choose.
- `NVIDIA_API_KEY` — from build.nvidia.com
- `NVIDIA_GLM_MODEL` — the exact model slug for the GLM model you have access to on
  build.nvidia.com. **Verify the current slug on the NVIDIA build catalog before running** —
  model names/availability there change, and I can't guarantee the placeholder
  (`zai-org/glm-4.6`) in `.env.local.example` is what's live when you read this.

```bash
npm run dev
```

## Voice Studio (voice over + voice cloning)

The app has two tabs: **Video Studio** (the long-form → short-clip → Buffer pipeline above)
and **Voice Studio**. Voice Studio uses the open-source
[Chatterbox TTS](https://github.com/resemble-ai/chatterbox) engine (Python/PyTorch) that ships
in this repo at `chatterbox-master/` to:

- **Text to speech** — type a script, pick a model (Multilingual / Base / Turbo / Nano),
  optionally upload a **5–10 s reference clip to clone a voice**, tune
  exaggeration/CFG/temperature, and generate a `.wav`.
- **Voice conversion** — upload any audio recording plus a target voice clip, and the `/vc`
  model re-voices the recording.

### How it connects

Next.js is Node, Chatterbox is Python, so a tiny bridge server
(`voice-server/voice_server.py`, Flask) wraps the model. When you open the Voice Studio tab,
the app auto-starts the bridge on `127.0.0.1:8788` (unless `VOICE_SERVER_URL` is set) and
proxies file uploads through `/api/voice/*`. Generated audio is saved to `public/voice/` and
served straight from Next.

### Install the Python dependencies

```bash
# from the project root — on your local machine OR on Railway after you deploy:
python -m pip install -r voice-server/requirements.txt
# which installs flask + chatterbox-tts (torch, etc. — this is a large download,
# roughly 5 GB on first run including the model weights)
```

Then just open the **Voice Studio** tab. The first generation downloads the model weights
into your HuggingFace cache and can take several minutes; afterwards generations are fast.
If the bridge can't start, the tab shows exactly what's missing.

### Voice Studio env knobs (all optional)

Set these only for custom setups — everything auto-detects by default:

- `VOICE_SERVER_URL` — point at a bridge you run yourself (e.g. a separate Railway service),
  e.g. `http://127.0.0.1:8788`.
- `VOICE_PYTHON` — python executable used to spawn the bridge
  (default `python3` on unix / `python` on Windows).
- `VOICE_PORT` — local bridge port (default `8788`).
- `VOICE_AUTO_START` — set to `0` to disable auto-start.

If you deploy to Railway: install `voice-server/requirements.txt` in the same service that
runs `next start` (Railway supports a multi-language build), or run `voice_server.py` as its
own Railway service and set `VOICE_SERVER_URL`. Give the Voice Studio request a generous timeout
— the route exports `maxDuration = 900`.

## How the pipeline works

1. **Analyze** (`/api/analyze`) — you paste a YouTube URL, Apify returns title, duration,
   word-level transcript, and optionally scene cuts.
   - **Or upload a local file** (`/api/upload`) — Step 01 also accepts a video file from
     your computer (mp4/mov/m4v/webm/mkv/avi/mpg/flv/ts). It's saved into `public/uploads`,
     non-mp4 containers are remuxed to mp4, and the duration is read with ffprobe. Uploaded
     files carry no transcript, so the edit planner falls back to visual mode: ffmpeg
     scene-cut analysis (+ vision-model frame notes) picks the strongest moments instead of
     spoken lines. Renders need no download for uploads — the file is already on disk.
2. **Style profile (optional)** (`/api/style-profile`) — paste a sample short whose editing
   technique you want copied. GLM infers a structured "style profile" (cut pacing, caption
   style, zoom rhythm) from that sample's transcript/scene data.
3. **Rules** — free-text instructions plus clip count/length constraints. These live in the
   UI state, not hardcoded, so you can change them between every single run.
4. **Generate edit plan** (`/api/edit-plan`) — for URL videos GLM receives the transcript,
   your current rules, and the optional style profile, and returns a JSON `EditPlan`. For
   **uploaded files (no transcript)** the server first scans the whole video visually
   (ffmpeg scene-cut detection + vision-model frame notes) and *then* plans — so the
   "Generate edit plan" button takes **1–4 minutes** on longer uploads and the browser
   waits up to 300s (the route's `maxDuration`); don't close the tab while it runs.
5. **Render** (`/api/render`) — for each clip, Remotion's renderer (`@remotion/renderer`)
   renders the `ShortClip` composition (`remotion/ShortClip.tsx`) into an `.mp4` using that
   clip's plan: 9:16 crop, burned-in captions, zoom/pan.

6. **Post via Buffer** (`/api/buffer/post`) — once a clip is rendered, pick ANY
   channels across ALL your saved Buffer accounts (checkboxes grouped by account),
   write one caption, choose "add to queue" or "schedule," and post. The route
   fans out concurrently: every selected channel on every selected account gets
   its own post request fired in parallel, so multiple accounts post at the same
   time, not one after another. Per-target results are reported back
   (succeeded/failed counts). Buffer publishes each post out to whichever platform
   that channel is (Instagram, TikTok, YouTube Shorts, X, LinkedIn, etc).

## Multiple Buffer accounts

- Add accounts in the **Buffer accounts** panel of the UI: a display name and
  the account's personal API key (create one at buffer.com → Settings → API).
  The organization ID is **auto-detected from the token** via Buffer's `account`
  GraphQL query — you only paste it manually if one token reaches multiple
  organizations. Every addition is validated live against Buffer, so a revoked
  token or wrong org ID fails right there with a real reason instead of
  mysterious channel-loading errors later.
- Stored server-side in `data/accounts.json` (gitignored); access tokens are
  masked before they're ever sent back to the browser.
- If you've set `BUFFER_ACCESS_TOKEN`/`BUFFER_ORGANIZATION_ID` in `.env.local`
  but haven't saved any accounts yet, they show up as a fallback **Default**
  account so old setups keep working unchanged.
- Posting is simultaneous across accounts — `/api/buffer/post` resolves each
  target's credentials server-side and fires all posts in parallel. One account
  failing or rate-limiting never blocks the others.

## Analytics & growth advice (Buffer)

The **Analytics & growth advice** panel pulls recent sent posts + engagement
numbers for any saved account. Buffer's GraphQL API is in beta and doesn't
expose analytics fields uniformly, so the fetcher tries, in order:

1. GraphQL channel statistics (`statistics { impressions reach ... }`)
2. Buffer's classic REST v1 API (`/profiles/:id/updates/sent.json`), which has
   long exposed per-post statistics
3. Graceful degradation — channel names only, with a clear warning

Whatever it finds is handed to GLM, which returns per-channel advice: what your
top posts have in common, cadence/timing suggestions, caption/format tweaks.
When no real numbers are available it says so and gives test-first guidance
instead of inventing stats.

## Caption coach (Apify + AI)

The **Caption coach** panel takes a topic (and optionally your draft caption):

1. Apify runs a Google SERP actor (default `apify/google-search-scraper`,
   override with `APIFY_SEARCH_ACTOR_ID`) against three queries about your topic
   — viral hooks, trending hashtags, audience-growth content.
2. GLM receives the live search snippets plus your draft caption and the
   platforms you've checked for the target clip, then writes a rewritten
   platform-specific caption (hook first line, CTA), researched hashtags, and
   concrete reach tips. Sources are listed so you can see what informed it.

## Caption & timing pipeline

The model decides **which moments** to clip; code decides everything that has
to be precise (`lib/planNormalize.ts`, `lib/captions.ts`):

- **Real word timing.** YouTube auto-captions carry exact per-word timestamps
  inline (`word<00:00:01.320><c> next</c>`); `lib/subtitles.ts` reads them,
  strips the markup and removes the repeated "rolling" lines. Files without
  word tags fall back to the old even-spread estimate.
- **Captions are verbatim.** Cues are 3–4 word slices of the real transcript
  (fillers like "um"/"uh" and `[Music]` removed), so text always matches the
  audio. Set `CAPTIONS_FROM_TRANSCRIPT=0` to keep the model's own caption text.
- **One time base.** `captions[].startSec/endSec` and `zoomKeyframes[].atSec`
  are **relative to the clip start**. If the model returns absolute source
  times anyway, they're converted automatically.
- **Clean cut points.** Clip edges snap to word boundaries (small lead-in /
  tail), never mid-word, and `minClipSec` / `maxClipSec` are enforced in code.
- **Validation.** Malformed clips are dropped with a reason in
  `editPlan.warnings` instead of crashing the render.
- **Deepgram speech-to-text** (`DEEPGRAM_API_KEY`, see `.env.local.example`).
  With a key set, Deepgram is the speech-to-text engine: when a video has no
  captions (uploads, local files) it transcribes the whole video so the AI can
  pick clips from what is actually said, and it re-transcribes each clip's audio
  for word-accurate burned-in captions. Whole-video transcripts are cached in
  `data/transcripts/` so a retry never pays twice. Failures (bad key, no credit)
  fall back to platform captions. `DEEPGRAM_MODE=fallback` spends credit only on
  videos with no captions at all.
- **Tightened clips.** Pauses longer than ~0.55s are shortened to ~0.28s and
  filler words ("um", "uh") are cut out, so clips play like a hand-edited short.
  Natural short pauses stay, and silent gaps over 4s are left alone (likely
  action, not dead air). Your `minClipSec` is still respected. Needs exact word
  timings (Deepgram, or YouTube word-tagged captions); with only estimated
  timings it waits until Deepgram supplies exact words at render time.
  `TIGHTEN_CLIPS=0` turns it off.
- **Smart reframing.** When a wide video becomes 9:16, the crop follows the
  speaker's face instead of always keeping the middle. Uses a tiny built-in
  face detector (pico.js, MIT — `lib/vendor/`), no API or install. If no face is
  reliably found (screen recordings, no people, already-vertical video) it uses
  the normal centred crop. `SMART_REFRAME=0` turns it off.
- **Renderer.** Pop-in animation, active-word highlight, captions placed above
  the TikTok/Reels/Shorts UI band.

## Buffer setup

1. Connect the social accounts you want to post to inside your actual Buffer account first
   (buffer.com) — this app posts *through* Buffer, it doesn't connect to TikTok/Instagram/etc
   directly.
2. Generate a personal API key at **buffer.com → Settings → API** and set
   `BUFFER_ACCESS_TOKEN`. Buffer can invalidate an API key at any time — if a key
   that worked suddenly stops working, generate a fresh one and update it in the app.
3. `BUFFER_ORGANIZATION_ID` is **optional**: long2short resolves your
   organization from the token automatically via Buffer's `account` query.
   Set it only if one key reaches multiple Buffer organizations and you want
   to pin a specific one.
4. `NEXT_PUBLIC_BASE_URL` should point at your **real deployed domain** when running in
   production — Buffer's API has no file-upload endpoint, it only accepts a public URL and
   fetches the media itself, both when you create the post and again when it publishes
   (which can be hours or days later for scheduled/queued posts), so the render output must
   stay on disk/reachable until the post actually goes out — don't clear `public/renders`
   right after posting.
   **Local development needs no setup**: if `NEXT_PUBLIC_BASE_URL` is unset — or set but the
   video doesn't answer through it — long2short automatically starts an **ngrok tunnel**
   when you post and hands Buffer that URL instead (see `NGROK_AUTHTOKEN` in
   `.env.local.example`; requires the ngrok binary — `winget install ngrok.ngrok`). The
   tunnel lives as long as the dev server does: keep the app running until scheduled posts
   publish. To opt out, set a deployed domain in `NEXT_PUBLIC_BASE_URL` where the renders
   actually exist.
5. Avoid signed/expiring URLs for the video — the static `/renders/*.mp4` path Next.js
   serves from `public/` works fine since it's a plain public file, not a signed link.



GLM itself is a **text** model — it can't watch a sample video's raw frames. There are two
ways this app handles style extraction, toggled by the "Use vision model" checkbox in step 2:

- **Off (default, text-only)** — `extractStyleProfile()` infers cut length/caption/zoom
  patterns from the sample's transcript timing and scene-cut timestamps only.
- **On (vision-based)** — `extractStyleProfileVision()` pulls ~8 evenly-spaced frames from
  the sample video with `ffmpeg` (via `lib/ffmpegFrames.ts`) and sends **each frame in its
  own request** (the hosted endpoint answers 400 "At most 1 image(s) may be provided in one
  prompt" if multiple images are sent together) to a vision-capable model on build.nvidia.com.
  Cut pacing is measured with ffmpeg's scene detector rather than guessed from stills.
  Requires:
  - `ffmpeg` installed and on `PATH` wherever this app runs (not bundled — install it
    separately, e.g. `apt install ffmpeg` / `brew install ffmpeg`).
  - `NVIDIA_VISION_MODEL` set in `.env.local` to a real vision-capable catalog ID. Check
    **build.nvidia.com/models** for what's currently available and confirm the exact ID on
    that model's own page — the catalog changes, so don't trust the placeholder value as-is.

Both paths return the same `StyleProfile` shape, so nothing downstream (the edit-plan prompt,
Remotion) needs to change based on which one you use.

One more limit: even vision-capable models on the shared hosted endpoint
(`integrate.api.nvidia.com`) take **images**, not a raw video stream — that's why frames are
extracted first rather than uploading the `.mp4` directly. True video-token input is
documented for self-hosted NIM containers with video input explicitly enabled, not the
shared hosted catalog endpoint.

## Known gaps to fill in for production

- `lib/apify.ts` coerces the common field-name variants actors use (`title`/`name`,
  `duration`/`lengthSeconds`, `subtitles`/`transcript`/`captions`, …), but an unusual actor may
  still need a field added to `mapItem()`. When it can't read the actor it falls back to
  yt-dlp metadata + captions, and reports that in the `warnings` the UI shows you.
- YouTube video downloads use the current official **yt-dlp** binary (`lib/ytdlp.ts`),
  installed/updated during `npm ci`. Before any YouTube video or caption transfer, the app
  runs a metadata-only check and refuses to transfer bytes unless bgutil reports that it
  generated a PO token for the video. The `bgutil-ytdlp-pot-provider` plugin/server are
  installed during postinstall and the server is started with the app (`lib/potServer.ts`).
  YouTube uses the `mweb` player client by default; `YTDLP_YT_CLIENTS` can override it, but
  the required preflight stops the transfer if `mweb` is removed. A PO token does not
  guarantee a datacenter IP will be accepted by YouTube. `YTDLP_FORMAT` overrides the video
  selector; `YTDLP_SUB_LANGS` controls caption languages (default `en`). Downloaded files
  land in `public/uploads`, so the host needs writable storage.
- Rendering is synchronous in `/api/render` today — for long videos/many clips, move this to
  a background job/queue (e.g. a worker process or `@remotion/lambda`) instead of blocking
  an API route.
- No auth/rate-limiting is included — add it before deploying publicly, since rendering is
  expensive.
- Buffer's GraphQL API is in public beta as of this writing and its schema/rate limits may
  shift — if `createPost`/channel queries in `lib/buffer.ts` start erroring, check
  developers.buffer.com for schema changes before assuming the code is wrong.
- `public/renders` / `public/uploads` still grow between sessions — you can delete old
  clips and stored source videos manually from the UI ("Rendered clips on this machine"
  and "Source videos stored on this machine" panels), but there's no automatic cleanup
  once a post has published (that would require checking Buffer's post status) or on a
  retention schedule.

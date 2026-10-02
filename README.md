# Meetify

Meetify is a single permanent, ten-person room. Supabase Realtime handles presence and signaling; WebRTC carries audio, video, and screen-share media directly between browsers. There is no meeting creation flow, database, login, media server, or host.

```text
Browser A ── WebRTC media ── Browser B/C/D/E
    └──── Supabase Realtime: presence + SDP/ICE signaling ────┘
```

## Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In Project Settings → API, copy the **Project URL** and the browser-safe **Publishable key** beginning with `sb_publishable_` (or the legacy `anon` key). Never put an `sb_secret_` or service-role key in a Vite environment variable: browser code exposes `VITE_` values publicly, and secret keys are rejected by Realtime.
3. Realtime is enabled by default on new projects. No tables, migrations, storage buckets, or authentication configuration are needed: this app uses an ephemeral Realtime channel and presence.
4. In the Realtime settings, leave anonymous broadcast/presence available for the project. For a private friend room, the unguessable URL is the access mechanism. You can add authentication/RLS later if needed.

## Run locally

```bash
npm install
copy .env.example .env.local # PowerShell; use cp on macOS/Linux
# edit .env.local with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

Open the local HTTP address printed by Vite (usually `http://localhost:5173/`). Do not open `index.html` directly from File Explorer; the source uses TypeScript modules that Vite must compile and serve.

Open the local HTTPS-capable development URL (camera permissions require a secure context; `localhost` is allowed by browsers). The first person can join without enabling devices; use “Enable camera & mic” before or after joining as needed.

## Netlify deployment

Import this repository into Netlify. Build command: `npm run build`. Publish directory: `dist`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Site configuration → Environment variables, then redeploy. `netlify.toml` keeps direct SPA URLs working.

## Notes and troubleshooting

- A ten-person mesh keeps infrastructure tiny, but each participant sends media to the other participants, so bandwidth rises as the room fills.
- The initial STUN server is `stun:stun.l.google.com:19302`. Some restrictive networks need a TURN service; add its credentials in `src/lib/webrtc.ts` under `iceServers`.
- If a device is unavailable, the room still works as audio-only or receive-only.
- Keep the browser console open for WebRTC diagnostics. “Could not connect” usually means the Supabase URL/key is wrong or Realtime is blocked; media failures often need TURN.
- The room persists because it is a fixed channel name, not a stored meeting record. Presence disappears when users leave, while the channel remains available for the next visitor.

# ـ٨ﮩﮩـ٨ﮩ 𝕊𝕥𝕒𝕥𝕚𝕔 ﮩ٨ـﮩﮩ٨ـ

ـ٨ﮩﮩـ٨ﮩ 𝕊𝕥𝕒𝕥𝕚𝕔 ﮩ٨ـﮩﮩ٨ـ is a Discord music bot starter with:

- Discord slash commands
- optional prefixed text commands
- high-quality voice playback via `@discordjs/voice`
- URL intake for YouTube, SoundCloud, Spotify, Deezer, Apple Music, Suno, and Amazon Music
- a password-protected web dashboard you can run on your PC or later host on your own `.xyz` domain
- persistent queues, playlists, autoplay, queue cleanup tools, and per-guild permissions

## What "supports these links" means

- YouTube and SoundCloud links can be streamed directly.
- Spotify track links are resolved to track metadata, then matched to a playable audio source.
- Spotify playlist links can be expanded through the Spotify Web API when `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are set in `.env`.
- Deezer, Apple Music, Suno, and Amazon Music links are parsed for metadata and then matched to a playable source.

That approach keeps the bot practical while avoiding brittle direct streaming integrations for providers that do not expose stable public audio streams.

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Copy the example env file and fill it in:

```bash
cp .env.example .env
```

3. Start in development:

```bash
npm run dev
```

4. Open the dashboard:

`http://localhost:3000`

## Run It On Your PC

This project is now set up to run well as a local Windows bot.

1. Copy [`.env.example`](./.env.example) to `.env` at the repo root and fill it in (`.env` is gitignored).
2. Double-click [`start-local.bat`](./start-local.bat)

Or run:

```powershell
.\start-local.ps1
```

That starts:

- the Discord bot on your PC
- the dashboard at `http://localhost:3000`

To keep it working, your PC needs to stay on and connected to the internet.

## Features

- persistent queue state in `data/state.json`
- per-guild settings for prefix, autoplay, vote skip, DJ role, and permission mode
- playlist save/load/delete
- queue cleanup commands: remove absent, remove duplicates, remove last, mass remove, clear
- playback controls: previous, skip to, fast forward, rewind, volume
- optional prefixed commands using the stored guild prefix
- timed cleanup for command messages and public command replies

## Slash commands

- `/play query:<url or search>`
- `/pause`
- `/resume`
- `/stop`
- `/clear`
- `/remove index:<position>`
- `/removelast`
- `/removeduplicates`
- `/removeabsent`
- `/massremove start:<position> count:<count>`
- `/previous`
- `/skip`
- `/skip to:<position>`
- `/queue`
- `/nowplaying`
- `/fastforward seconds:<seconds>`
- `/rewind seconds:<seconds>`
- `/volume percent:<1-150>`
- `/autoplay enabled:<true|false>`
- `/voteskip enabled:<optional boolean>`
- `/prefix show|set`
- `/permissions show|mode|djrole`
- `/playlist save|load|addcurrent|list|delete`
- `/clean amount:<optional>`

## Prefix commands

Once you set a prefix with `/prefix set`, the bot also supports:

- `<prefix>play <query>`
- `<prefix>skip`
- `<prefix>queue`
- `<prefix>nowplaying`
- `<prefix>pause`
- `<prefix>resume`
- `<prefix>clear`

## Discord settings

In the Discord Developer Portal, enable:

- `Server Members Intent`
- `Message Content Intent` if you want prefixed commands to work

## Dashboard hosting

Point your `.xyz` domain to the machine or host running this app, then set:

- `DASHBOARD_PUBLIC_URL=https://your-domain.xyz`
- `DASHBOARD_AUTH_TOKEN` to a long random secret

The dashboard uses a bearer token for control. Put it behind Cloudflare Access, Tailscale Funnel, Caddy basic auth, or another gate if you want an extra security layer.

## Optional Public Dashboard

If you want to control the dashboard from outside your house later, you have three main options:

- keep the bot on your PC and use a tunnel like Cloudflare Tunnel or Tailscale Funnel
- port-forward your dashboard carefully behind a reverse proxy
- split the dashboard and bot onto different hosts

For local-only use, keep:

```env
DASHBOARD_PUBLIC_URL=http://localhost:3000
```

To auto-delete command chatter after a delay, set:

```env
CHAT_COMMAND_DELETE_AFTER_SECONDS=30
```

Set it to `0` if you want to disable that cleanup entirely.

To expand Spotify playlist links through `/play query`, create a Spotify app in the Spotify Developer Dashboard and set:

```env
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
```

## Old Render Notes

For Render:

1. Connect the GitHub repo.
2. Deploy the `render.yaml` blueprint or use a Node web service.
3. Set secrets:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DASHBOARD_AUTH_TOKEN`
   - `DASHBOARD_PUBLIC_URL`
4. After the first deploy, add your custom domain in Render:
   - `Settings -> Custom Domains -> Add Custom Domain`
   - enter `drotunes.xyz` or `dashboard.drotunes.xyz`
5. Copy the DNS target Render gives you and add it at your registrar.
6. Update `DASHBOARD_PUBLIC_URL` to the final `https://...` domain and redeploy.

Render will provision TLS automatically after DNS is correct.

## Notes on audio quality

Playback uses Discord voice at 48 kHz with Opus output from `play-dl` and `@discordjs/voice`. Final quality still depends on the source platform and Discord's own voice transport.

## License

This project is released under the [MIT License](LICENSE).

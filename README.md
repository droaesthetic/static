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
- Apple Music song and album links are parsed for metadata and matched to a playable source; Apple Music playlist links can be expanded by the bundled LavaSrc plugin when local Lavalink is running.
- Deezer, Suno, and Amazon Music links are parsed for metadata and then matched to a playable source.

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
- automatic voice disconnect after 3 minutes with no current track or queued tracks
- Stripe-backed premium subscriptions for $3.99/month with 24/7 voice, personal prefixes, and solo music sessions
- optional prefixed commands using the stored guild prefix
- timed cleanup for command messages and public command replies

## Premium Billing

Premium is handled through Stripe subscriptions only. Create a recurring monthly Stripe Price for **$3.99 USD/month**, enable the Stripe Billing Customer Portal, set `STRIPE_SECRET_KEY`, `STRIPE_PREMIUM_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET`, then point the Stripe webhook endpoint at:

`<DASHBOARD_PUBLIC_URL>/api/stripe/webhook`

Enable these webhook events:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Users subscribe with `/subscribe`. New customers are sent to Stripe Checkout; existing customers are sent to the Stripe Customer Portal to manage or cancel their subscription. The bot unlocks premium when Stripe sends an active subscription event, removes premium on failed payment or cancellation, and restores premium when Stripe reports the subscription active again.

To let exactly one Discord user use `/premium solo` without a premium subscription, set their user ID in:

```env
PREMIUM_SOLO_USER_ID=123456789012345678
```

This only unlocks solo session for that user. It does not grant premium prefix, 24/7 voice, filters, or Stripe premium status.

## Slash commands

- `/play song:<url or search>`
- `/play-file file:<upload>`
- `/insert query query:<url or search>`
- `/insert file file:<upload>`
- `/pause`
- `/resume`
- `/stop`
- `/disconnect`
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
- `/volume percent:<1-150>` (moderators)
- `/autoplay on|off`
- `/voteskip enabled:<optional boolean>`
- `/removeafterplayed on|off`  
- `/sessionsettings`  
- `/restart`  
- `/reboot` (bot owners/managers)    
- `/lavaboot` (bot owners/managers)    
- `/synccommands` (bot owners/managers) 
- `/botstatus` (bot owners/managers) 
- `/subscribe`
- `/247 on|off`
- `/solo on|off`
- `/owner removeaccess|premiumlist|shocklists|shocklistview|shocklistload` (bot owners/managers)    
- `/prefix show|set` 
- `/permissions show|mode|djrole`
- `/shock-list save|load|addcurrent|addlink|addplaylist|view|remove|list|delete`  
- `/clean amount:<optional>` 
- `/purge amount:<optional>` 
 
## Prefix commands 

Once you set a prefix with `/prefix set`, every top-level slash command also supports prefix use:

- `<prefix>play <url or search>` or `<prefix>play` with an uploaded audio/video attachment
- `<prefix>insert <url or search>`
- `<prefix>join`
- `<prefix>pause`
- `<prefix>resume`
- `<prefix>stop`
- `<prefix>disconnect`
- `<prefix>clear`
- `<prefix>queue`
- `<prefix>removeafterplayed <on|off>`  
- `<prefix>sessionsettings`  
- `<prefix>restart`  
- `<prefix>reboot` (bot owners/managers)   
- `<prefix>lavaboot` (bot owners/managers)   
- `<prefix>synccommands` (bot owners/managers) 
- `<prefix>botstatus` (bot owners/managers) 
- `<prefix>nowplaying` or `<prefix>np` 
- `<prefix>search <query>`
- `<prefix>lyrics [query]`
- `<prefix>save`
- `<prefix>volume <1-150>` (moderators)
- `<prefix>skip [queue position]`
- `<prefix>remove <position>`
- `<prefix>move <from> <to>`
- `<prefix>removelast`
- `<prefix>removeduplicates`
- `<prefix>removeabsent`
- `<prefix>massremove <start> <count>`
- `<prefix>previous`
- `<prefix>fastforward <seconds>`
- `<prefix>rewind <seconds>`
- `<prefix>autoplay <on|off>`
- `<prefix>voteskip [on|off]`
- `<prefix>filter <off|bassboost|nightcore|vaporwave|karaoke|trebleboost|8d>`
- `<prefix>subscribe`
- `<prefix>premium subscribe`
- `<prefix>premium prefix [value|clear]`
- `<prefix>premium vc247 <on|off>`
- `<prefix>premium solo <on|off>`
- `<prefix>prefix show`
- `<prefix>prefix set <value>`
- `<prefix>permissions show`
- `<prefix>permissions mode <everyone|dj|admins>`
- `<prefix>permissions djrole <@role|clear>`
- `<prefix>shock-list save|load|addcurrent|addlink|addplaylist|view|remove|list|delete` 
- `<prefix>playlist save|load|addcurrent|addlink|addplaylist|view|remove|list|delete`  
- `<prefix>clean [amount]` 
- `<prefix>purge [amount]`
- `<prefix>moderation show` 
- `<prefix>moderation channelmessages <on|off> [#channel]`
- `<prefix>moderation channelcommands <on|off> [#channel]`
- `<prefix>moderation command <name> <on|off>`
- `<prefix>moderation member <@user> <allow|deny|clear>`
- `<prefix>moderation removeuser <@user>`
- `<prefix>moderation maxsonglength <seconds>`
- `<prefix>moderation maxshocklistlength <tracks>`
- `<prefix>owner removeaccess <user id|mention>`   
- `<prefix>owner premiumlist`   
- `<prefix>owner shocklists`  
- `<prefix>owner shocklistview <owner id|mention> <name>` 
- `<prefix>owner shocklistload <owner id|mention> <name>` 

Prefix aliases:

- `p` -> `play`
- `s` -> `skip`
- `rew` -> `rewind`
- `ff` -> `fastforward`
- `mod` -> `moderation`
- `pl`, `playlist`, `shocklist`, `sl`, `list`, `shock`, `shockl` -> `shock-list` 
- `mremove`, `mr`, `mrem` -> `massremove`
- `r`, `rem` -> `remove` 
- `res` -> `restart` 
- `rb`, `rboot`, `boot` -> `reboot`  
- `lavab`, `lb`, `lboot` -> `lavaboot`  
- `unpause`, `go` -> `resume` 
- `in`, `i`, `next` -> `insert`
- `m` -> `move`
- `dis`, `leave`, `byebye`, `fuckoff`, `adios` -> `disconnect` 
- `vol`, `v` -> `volume`
- `rl`, `reml`, `rlast`, `removel`, `remlast` -> `removelast`
- `rd`, `remd`, `rduplicates`, `removed`, `remdup`, `removedup`, `remduplicates` -> `removeduplicates`
- `ra`, `rema`, `rabsent`, `removea`, `removeabs`, `remabs`, `remabsent` -> `removeabsent`
- `settings`, `serversettings` -> `sessionsettings` 
- `f` -> `fix` 
- `sc`, `sync`, `scommands` -> `synccommands` 
- `botstat`, `bstat`, `stats` -> `botstatus` 
- `q` -> `queue` 

## Discord settings

In the Discord Developer Portal, enable:

- `Server Members Intent`
- `Message Content Intent` if you want prefixed commands to work

## Dashboard hosting

Point your `.xyz` domain to the machine or host running this app, then set:

- `DASHBOARD_PUBLIC_URL=https://your-domain.xyz`
- `DASHBOARD_AUTH_TOKEN` to a long random secret

The dashboard uses a bearer token for control. Put it behind Cloudflare Access, Tailscale Funnel, Caddy basic auth, or another gate if you want an extra security layer.

## Render Hosting

Render can run this app as a Node web service because the server already honors Render's `PORT` environment variable.

Use this when you want the dashboard and bot process on a normal Render service:

1. Push this repo to GitHub.
2. In Render, create a new Web Service from the repo or import the `render.yaml` blueprint in the repo root.
3. Set the required env vars in Render's dashboard, especially:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DASHBOARD_AUTH_TOKEN`
   - `DASHBOARD_PUBLIC_URL`
   - `LAVALINK_URL`
   - `LAVALINK_PASSWORD`
4. Point `DASHBOARD_PUBLIC_URL` at the Render service URL, for example `https://your-service.onrender.com`.
5. Make sure `LAVALINK_URL` points to a separate Lavalink server you control.

Render's free web service tier is only `512 MB` RAM and `0.1 CPU`, so it is too small for the full bot plus Lavalink stack as an always-on setup. It can still be useful for the dashboard or for testing, but for a real 24/7 bot you will usually want a paid Render service or another host for Lavalink.

The `render.yaml` file in this repo is the blueprint for that setup.

## Oracle Cloud Always Free Hosting

Use this when you want the bot, dashboard, and Lavalink to stay online while your computer is off.

The recommended free setup is one Oracle Cloud Infrastructure Ampere A1 VM running Docker Compose:

- `bot`: this Node/Discord app and dashboard
- `lavalink`: private Lavalink v4 service for music playback
- `caddy`: public HTTP/HTTPS reverse proxy for the dashboard and Stripe webhook
- `data/`: persistent bot queues, playlists, premium state, and settings

Oracle's Free Tier currently lists Arm-based Ampere A1 Compute as an Always Free service, and Oracle's OCI docs say Always Free A1 usage for Always Free tenancies is 2 OCPUs and 12 GB RAM total across A1 instances. A practical shape for this bot is:

- Image: Ubuntu 24.04 or 22.04
- Shape: `VM.Standard.A1.Flex`
- OCPUs: `2`
- Memory: `12 GB`
- Boot volume: `50 GB`

Create the VM in your Oracle home region. Add ingress rules in the Oracle VCN security list or network security group for:

- TCP `22` from your IP only, for SSH
- TCP `80` from `0.0.0.0/0`, for Caddy/Let's Encrypt HTTP validation
- TCP `443` from `0.0.0.0/0`, for the dashboard and Stripe webhooks

Do not expose Lavalink port `2333`; Docker keeps it private.

On the VM:

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git static
cd static
sudo bash deploy/oracle/setup-vm.sh
```

Log out and back in so your user gets Docker group access, then create the production env file:

```bash
cp deploy/oracle/.env.oracle.example .env
nano .env
```

At minimum, fill in:

```env
CADDY_DOMAIN=your-dashboard-domain.example
DASHBOARD_PUBLIC_URL=https://your-dashboard-domain.example
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DASHBOARD_AUTH_TOKEN=...
LAVALINK_PASSWORD=...
BOT_OWNERS=...
```

For quick HTTP-only testing by server IP, set `CADDY_DOMAIN=:80` and `DASHBOARD_PUBLIC_URL=http://YOUR_SERVER_IP`. Use a real domain before enabling Stripe live webhooks.

Point your domain DNS `A` record at the VM's public IPv4 address before starting Caddy. Then run:

```bash
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml up -d --build
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml logs -f bot
```

Useful production commands:

```bash
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml ps
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml logs -f lavalink
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml restart bot
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml pull
docker compose --env-file .env -f deploy/oracle/docker-compose.oracle.yml up -d --build
```

Health check:

```bash
curl https://your-dashboard-domain.example/health
```

If you use Stripe live subscriptions, set the webhook endpoint to:

```text
https://your-dashboard-domain.example/api/stripe/webhook
```

Back up the bot's persistent data regularly:

```bash
tar -czf static-data-backup.tgz data .env
```

Keep `.env` private. It contains Discord, Stripe, Lavalink, and dashboard secrets.

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

To minimize background bandwidth, keep low-bandwidth mode enabled:

```env
LOW_BANDWIDTH_MODE=true
IDLE_VOICE_DISCONNECT_SECONDS=45
PLAYBACK_WATCHDOG_INTERVAL_SECONDS=15
STALE_PLAYER_UPDATE_SECONDS=45
NOW_PLAYING_THUMBNAILS=false
PRE_RESOLVE_NEXT_TRACK=true
```

This keeps playback responsive while reducing idle voice time, dashboard polling, player update traffic, Lavalink buffering, request logging, and external artwork downloads. Set `LOW_BANDWIDTH_MODE=false` or override individual values if you want richer/faster updates.

For smoother playback on a local PC, the bundled Lavalink config keeps a larger audio buffer:

```yml
bufferDurationMs: 1000
frameBufferDurationMs: 5000
playerUpdateInterval: 1
useSeekGhosting: false
trackStuckThresholdMs: 30000
```

The bot also pre-resolves the next queued track by default, which reduces gaps between songs. You can tune Lavalink reconnect behavior from `.env`:

```env
LAVALINK_RESUME_TIMEOUT_SECONDS=120
LAVALINK_RECONNECT_TRIES=20
LAVALINK_RECONNECT_INTERVAL_SECONDS=5
LAVALINK_REST_TIMEOUT_SECONDS=30
LAVALINK_VOICE_CONNECTION_TIMEOUT_SECONDS=45
PRE_RESOLVE_NEXT_TRACK=true
```

To expand Spotify playlist links through `/play`, create a Spotify app in the Spotify Developer Dashboard and set:

```env
SPOTIFY_CLIENT_ID=your-spotify-client-id
SPOTIFY_CLIENT_SECRET=your-spotify-client-secret
```

To use the official YouTube Data API for search metadata, enable **YouTube Data API v3** in Google Cloud, create an API key restricted to that API, and set:

```env
YOUTUBE_API_KEY=your-youtube-data-api-key
```

This key is only used for YouTube search/metadata. Playback still goes through Lavalink, so keep the Lavalink settings in `.env` too.

To let Lavalink play YouTube videos that require age verification, enable OAuth for the YouTube source plugin. Use a burner YouTube account:

```env
YOUTUBE_OAUTH_ENABLED=true
YOUTUBE_OAUTH_SKIP_INITIALIZATION=false
```

Start Lavalink once, complete the device-code flow in the Lavalink terminal, then put the emitted refresh token in `.env` and switch startup back to non-interactive:

```env
YOUTUBE_OAUTH_REFRESH_TOKEN=your-refresh-token
YOUTUBE_OAUTH_SKIP_INITIALIZATION=true
```

## Notes on audio quality

Playback uses Discord voice at 48 kHz with Opus output from `play-dl` and `@discordjs/voice`. Final quality still depends on the source platform and Discord's own voice transport.

## License

This project is released under the [MIT License](LICENSE).

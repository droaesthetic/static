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
- Stripe-backed premium subscriptions for $4.99/month with 24/7 voice, personal prefixes, and solo music sessions
- optional prefixed commands using the stored guild prefix
- timed cleanup for command messages and public command replies

## Premium Billing

Premium is handled through Stripe subscriptions only. Create a recurring monthly Stripe Price for **$4.99 USD/month**, set `STRIPE_SECRET_KEY`, `STRIPE_PREMIUM_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET`, then point the Stripe webhook endpoint at:

`<DASHBOARD_PUBLIC_URL>/api/stripe/webhook`

Users subscribe with `/premium subscribe`. The bot unlocks premium when Stripe sends an active subscription event, removes premium on failed payment or cancellation, and restores premium when Stripe reports the subscription active again.

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
- `/premium subscribe|status|prefix|vc247|solo`
- `/owner removeaccess|premiumlist|shocklists|shocklistview|shocklistload` (bot owners/managers)    
- `/prefix show|set` 
- `/permissions show|mode|djrole`
- `/shock-list save|load|addcurrent|addlink|addplaylist|view|remove|list|delete` 
- `/clean amount:<optional>`

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
- `<prefix>premium subscribe`
- `<prefix>premium status`
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
   - enter `static.xyz` or `dashboard.static.xyz`
5. Copy the DNS target Render gives you and add it at your registrar.
6. Update `DASHBOARD_PUBLIC_URL` to the final `https://...` domain and redeploy.

Render will provision TLS automatically after DNS is correct.

## Notes on audio quality

Playback uses Discord voice at 48 kHz with Opus output from `play-dl` and `@discordjs/voice`. Final quality still depends on the source platform and Discord's own voice transport.

## License

This project is released under the [MIT License](LICENSE).

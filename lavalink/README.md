# Local Lavalink

This folder runs a local Lavalink node for Static with:

- **youtube-plugin** — official YouTube source (replaces the deprecated built-in YouTube)
- [**LavaSearch**](https://github.com/topi314/LavaSearch) — richer `/v4/loadsearch` (tracks, albums, artists, playlists, text)
- [**LavaSrc**](https://github.com/topi314/LavaSrc) — Spotify, Apple Music, Deezer, etc. (mirrors to playable sources) + YouTube integration with LavaSearch
- [**LavaLyrics**](https://github.com/topi314/LavaLyrics) — `/v4/.../lyrics` and related lyrics APIs (works with LavaSrc sources)

Plugin JARs are **downloaded automatically** on first startup (Lavalink reads `lavalink.plugins` in `application.yml`). You need Java and outbound HTTPS.

## Requirements

- **Java 17+** (`java -version`)

## Setup

1. Download the server JAR:

```powershell
.\download-lavalink.ps1
```

2. (Optional) Put **Spotify** credentials in the **repo root** `.env` as `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.  
   `start-lavalink.ps1` maps them into LavaSrc env vars so **Spotify source + lyrics** turn on without editing `application.yml`.  
   If those variables are missing, Spotify stays off (YouTube / SoundCloud / lrclib lyrics still work).

3. (Optional) Enable YouTube OAuth for age-restricted videos. Use a burner YouTube account:

```dotenv
YOUTUBE_OAUTH_ENABLED=true
YOUTUBE_OAUTH_SKIP_INITIALIZATION=false
```

Start Lavalink once, complete the device-code flow shown in the Lavalink terminal, then copy the emitted refresh token into `.env`:

```dotenv
YOUTUBE_OAUTH_REFRESH_TOKEN=your-refresh-token
YOUTUBE_OAUTH_SKIP_INITIALIZATION=true
```

`start-lavalink.ps1` maps these values into `PLUGINS_YOUTUBE_OAUTH_*` so the YouTube source plugin can use authenticated clients when a video requires sign-in.

4. Align the bot with this node: in `.env`, set `LAVALINK_PASSWORD` to the same value as `lavalink.server.password` in `application.yml` (default local password is shown in that file).

5. Start the bot from the repo root. The local launcher automatically starts Lavalink if it is not already running and sets the Lavalink Java process to High priority:

```powershell
cd ..
.\start-local.ps1
```

To start only Lavalink, run:

```powershell
.\start-lavalink.ps1
```

## Local connection

- Host: `127.0.0.1:2333`
- Password: must match `lavalink.server.password` in `application.yml` and `LAVALINK_PASSWORD` in `.env`
- Secure: `false`

## Buffering profile

The bundled `application.yml` favors stable local playback over minimum memory use:

```yaml
bufferDurationMs: 1000
frameBufferDurationMs: 5000
playerUpdateInterval: 1
useSeekGhosting: false
trackStuckThresholdMs: 30000
```

Restart Lavalink after changing these values.

## Changing plugin versions

Versions live under `lavalink.plugins` in `application.yml`. After editing, restart Lavalink; it will resolve new artifacts from the default Lavalink plugin repository.

## References

- [Lavalink environment variables](https://lavalink.dev/configuration/config/environment-variables.html) (override any `application.yml` key, e.g. `PLUGINS_LAVASRC_*`)
- [LavaSearch REST](https://github.com/topi314/LavaSearch#lavalink-usage) — `GET /v4/loadsearch`
- [LavaLyrics REST](https://github.com/topi314/LavaLyrics#lavalink-usage) — track lyrics endpoints

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

3. Align the bot with this node: in `.env`, set `LAVALINK_PASSWORD` to the same value as `lavalink.server.password` in `application.yml` (default local password is shown in that file).

4. Start Lavalink:

```powershell
.\start-lavalink.ps1
```

5. In another terminal, start the bot from the repo root:

```powershell
cd ..
.\start-local.ps1
```

## Local connection

- Host: `127.0.0.1:2333`
- Password: must match `lavalink.server.password` in `application.yml` and `LAVALINK_PASSWORD` in `.env`
- Secure: `false`

## Changing plugin versions

Versions live under `lavalink.plugins` in `application.yml`. After editing, restart Lavalink; it will resolve new artifacts from the default Lavalink plugin repository.

## References

- [Lavalink environment variables](https://lavalink.dev/configuration/config/environment-variables.html) (override any `application.yml` key, e.g. `PLUGINS_LAVASRC_*`)
- [LavaSearch REST](https://github.com/topi314/LavaSearch#lavalink-usage) — `GET /v4/loadsearch`
- [LavaLyrics REST](https://github.com/topi314/LavaLyrics#lavalink-usage) — track lyrics endpoints

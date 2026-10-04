# Watch With Friends - Synced Media Player

Watch or listen to a media file together on Windows or Mac, with up to eight people. One person hosts and streams the file. Anyone can play, pause, seek, or switch the audio track, and everyone sees the change.

- Plays almost anything VLC plays (MKV, HEVC, AV1, AC3/DTS/TrueHD audio, XviD, 10-bit, HDR), plus audio files (MP3, FLAC, WAV, M4A, Opus…), because ffmpeg is bundled.
- Pictures (JPG, PNG, GIF, WebP, AVIF, TIFF, PSD…, up to 50 MB) are sent to the other person at full resolution, so you can both look and draw on them.
- Subtitles: tracks inside the file, `.srt`/`.ass`/`.ssa`/`.vtt` files next to the video, or any subtitle file you drop in. Each person picks their own track, or none. Image subtitles (Blu-ray PGS, DVD VobSub) can only be drawn into the picture, so those show for everyone.
- No accounts or port forwarding. Direct connections need no server setup; restrictive networks need a configured TURN relay.
- YouTube videos and public or unlisted playlists play through YouTube's embedded player on each participant's computer, with shared play, pause, seek and loop controls.

## Using it

1. One person clicks **Create a room** and sends the code (e.g. `K7QM-2XPA`) to the other.
2. The other person types the code and clicks **Join**.
3. Whoever clicks **Open media** (or drops a file on the window) hosts it. If the other person opens a file later, they become the host.

You can also paste a YouTube video or playlist URL into the empty player and press **Enter** or click the arrow inside the field. Playlist videos are added in YouTube's order, starting from the first entry even if the link points into the middle of the playlist. Imports must fit within the room's 500-item limit. YouTube entries remain playable when their original contributor is offline, and their progress is saved with the room. Videos must allow embedding and be available to each participant; YouTube may show ads or require interaction before playback.

Hover over the pencil for 150 ms to reveal the eye button with a 150 ms fade. Annotations remain visible by default after you close the drawing tools; turn the eye off to hide them when the tools are closed. This visibility choice only affects your screen.

In the playlist sidebar, click **+** for local files or the adjacent **link icon** for a YouTube URL to add media without interrupting playback. When the player is empty, the first added item loads paused at 0:00. Media opened from the central player also starts paused at 0:00; press Play when ready. Submit a URL with Enter or the arrow inside the field, or drag a YouTube video/playlist link onto the sidebar.

In a room you can also draw together on the whiteboard (pen button in the top bar) and send reactions everyone sees and hears: 📯 air horn, 👏 golf clap, 🦆 quack and 🎉 confetti.

The playlist lives behind the tab on the right edge: click it, or drag it out to the width you like. Anyone can add files, reorder them, and play available items. Opening or dropping media on the player also adds it to the room's playlist. Files stay on their owner's computer. When an owner leaves, their items remain greyed out as **Unavailable** and playback skips them. They become available again when the owner rejoins with the files still present. If the active host leaves during playback, a remaining participant advances to the next available item.

To keep a copy of a shared file, open its **three-dot menu → Download file** and choose where to save it. The original file transfers directly from its owner, even when someone else is hosting playback. The playlist shows download progress; the same menu lets you cancel. The owner must stay in the room with the file available, and both apps need download support. Up to three downloads can run at once. Leaving the room or removing the item stops unfinished transfers and removes their temporary files. You can also save a copy of your own files. YouTube links cannot be downloaded through this feature. **Remove for everyone** is in the three-dot menu too.

Rooms stay under **Your rooms** on the home screen after everyone leaves or restarts the app. Cards show the room name and live participant names; viewing the list does not join those rooms. Use the **×** on a card to leave and remove your saved copy; other participants keep theirs, and if you are the last member the room is gone. Reopening a room restores your last video at the timestamp you last watched, paused and ready to resume. Press **Play** to share playback again. If someone is already hosting, their current playback takes precedence. Local files must still be available on your computer; a file owned by another participant needs that person online. Each playlist item also keeps its shared progress, including items you switched away from. Removing the current item loads the next available item (or the previous one at the end) paused at its saved position. The Open media / URL prompt appears only when the playlist is empty. Playlist order, removals, the current item, room name and loop state are saved too. A finished item starts from the beginning if you choose to replay it.

Each participant saves a local copy and exchanges updates on reconnect. A person who left earlier receives later changes when someone with those changes rejoins. File paths stay local and are scoped to your identity and that room. Moving or deleting a file makes it unavailable; add its new location to share it again. All participants need a build with persistent-room support to meet in these rooms.

Shortcuts: `Space` play/pause · `←`/`→` 10 seconds · `F` fullscreen · `M` mute · `P` playlist · `1`–`4` reactions.

### Friends

The first time the app opens it asks for a username and a display name. The app adds a tag to the username so it's yours alone (e.g. `moviefan#k7qm-x3pa`). Copy the full username as your friend code and send it to a friend. They enter it under **Friends**; you get a request banner and a numbered badge on the Friends button, on Home or in a room. Click **Review**, then **Accept** or **Decline**. Requests are saved until you act on them, including after restarting the app.

The sender sees whether their request is queued or delivered and awaiting acceptance. Delivery needs both apps to be open and able to connect; queued requests resume when the sender reopens the app. A failed connection shows a retrying status rather than claiming delivery.

Once accepted, the friends list shows an online count and each friend's **Online**, **Offline**, **In a room**, or hosting status. Click **Ask to join** next to a friend in a room; if they let you in, you join without needing the room code. Your display name is separate and can be changed any time. Picking a new username means friends have to add you again.

## Installing

**[Download the latest release](https://github.com/onlineslav/watch-with-friends/releases/latest)**

- **Windows:** run `watch-with-friends-…-windows-setup.exe`. If SmartScreen appears, click **More info → Run anyway** (once).
- **Mac:** open the `.dmg` for your Mac (`arm64` = Apple Silicon, `x64` = Intel) and drag the app to Applications. The app isn't notarized, so run this in Terminal once before the first launch:

  ```sh
  xattr -cr "/Applications/Watch With Friends.app"
  ```

## Connection problems

The apps connect directly using WebRTC. Networks that block direct connections need a TURN relay. The desktop uses short-lived credentials from an HTTPS endpoint, renews them before expiry, and retries failed requests in the background. It also attempts reconnection after a network change or waking from sleep.

1. Deploy the small credential service described in [relay/README.md](relay/README.md). The TURN API token stays on that service.
2. Copy `config/turn.example.json` to `config/turn.json` and set its `endpoint` to your service's HTTPS `/credentials` URL.
3. Rebuild. For CI builds, save this endpoint-only JSON as the repository secret `TURN_CONFIG`.

Builds reject configuration containing API tokens or static credentials. Private installations can put a static `iceServers` list in their own application user-data `turn.json`; see the relay setup notes. If a previous release included a minting token, revoke it when migrating.

### Playback and synchronization

Playback quality adjusts automatically for each viewer. Repeated packet loss or freezes lower the video bitrate and resolution; sustained good conditions let them recover. The video ceiling is 10 Mbps per viewer, subject to an 18 Mbps aggregate budget, with a maximum target of 1080p. Receiver buffering targets 250-750 ms. Clock measurements account for control-message transit time, and captions account for estimated media delay. This remains live streaming: viewer delay can vary with the network and decoder, and frame-exact synchronization is not guaranteed.

These are automatic defaults, not controls in Settings. The connection indicator explains packet loss, upload/CPU limits and relay usage. A host that stops responding is shown as stalled after eight seconds; a failed media open produces an error for everyone.

Rooms support up to eight people. Host changes, playlist moves and board clears use logical revisions so computer clock differences do not decide whose changes win. The board holds 256 strokes (clear it to draw more), the playlist retains up to 4,096 current/deleted item IDs per room, and friends and pending requests each have a 100-person limit. Unanswered friend requests expire with a Retry option.

This networking protocol is incompatible with older builds; everyone in a room or friend connection needs the updated app. Existing local identities and friend lists are retained.

## Development

```sh
npm install
npm start        # bundle the renderer and launch the app
npm test         # unit tests (node:test)
npm run test:startup # isolated Electron checks for stalled networking and concurrent app profiles
npm run test:network # three local WebRTC peers: friends, rooms, media, controls and rejoining
npm run test:youtube # live YouTube embed, controls, isolation and playlist import checks
node scripts/electron.js scripts/check-network.js --youtube # shared YouTube controls across three peers (live service)
npm run test:discovery # public Nostr discovery: different startup orders, friends, rooms and rejoining
npm run test:connections # friends can join rooms while discovery is unavailable (release gate)
npm run dist:win # Windows installer in dist/
npm run dist:mac # Mac .dmg in dist/ (must run on a Mac)
```

The app was called *Synced Video Player* up to 0.4.3. Because the user-data folder follows the product name, the first launch of a renamed build copies the old profile across, so your identity, friends and saved rooms carry over. Caches are left behind and the copy happens only once.

`npm start` uses a separate **Watch With Friends Development** profile, so it can run alongside the installed app without locking its settings or cache. The development copy asks you to set up its own username on first launch; your installed app keeps its existing identity and friends. Launching the same profile again focuses its existing window.

Starting the **Build** workflow by hand builds Windows, Apple Silicon and Intel Mac installers as workflow artifacts. Pushing a version tag builds them and publishes a GitHub Release:

```sh
npm version patch   # bumps package.json and creates the tag
git push --follow-tags
```

## What's new in 0.5.4

Faster recovery from blurry streaming, with better diagnostics for connection problems.

Windows users and Mac users on 0.5.3 receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Recover picture quality sooner.** After connection trouble, clean playback reports restore the host's quality ceiling in seconds instead of minutes. Low bandwidth estimates alone no longer force the app to keep a smaller picture; WebRTC continues to adapt to actual congestion.
- **Avoid repeated downgrades.** Each viewer report counts once. Pauses, buffering and missing reports cannot cause false recovery or repeated reductions.
- **Better problem reports.** Diagnostic exports show measured sent and received media bitrate, playback state, feedback age, each quality decision, and whether requested sender settings were applied or failed. Paths and addresses remain redacted.
- **Keep watching through updates.** Downloads wait until you leave your room before installing. Your identity, friends, rooms and settings stay in your existing profile.

## Download

Download the file for your computer from **Assets** below:

| Computer | File |
| --- | --- |
| Windows | `watch-with-friends-...-windows-setup.exe` |
| Mac with Apple Silicon (M1, M2, M3, M4...) | `watch-with-friends-...-mac-arm64.dmg` |
| Mac with Intel | `watch-with-friends-...-mac-x64.dmg` |

Not sure which Mac you have? Open the Apple menu, then **About This Mac**. "Chip: Apple M..." means Apple Silicon; "Processor: Intel" means Intel.

## First launch

- **Windows:** run the installer. If a blue SmartScreen box appears, click **More info**, then **Run anyway**.
- **Mac:** open the `.dmg` and drag the app into **Applications**. Then open **Terminal**, paste this line, and press Enter (only needed once):

  ```sh
  xattr -cr "/Applications/Watch With Friends.app"
  ```

## Watching together

1. Pick a username and display name the first time the app opens.
2. One person clicks **Create a room** and sends the code to the other, or invites them from the friends list.
3. The other person types the code and clicks **Join**.
4. Add local media or a YouTube link. Everyone can pause, seek, and pick their own subtitles for local media.

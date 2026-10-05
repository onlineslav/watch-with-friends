## What's new in 0.5.3

Automatic updates inside the app on Windows and Mac.

**Mac users on an older version:** install this release once using the DMG below. Future versions download and install inside the app, without repeating the DMG process. Windows users receive this release through the existing automatic updater.

- **Updates happen inside the app.** New versions download automatically at launch, while the app stays open, and after waking from sleep. Both Intel and Apple Silicon Macs are supported.
- **Keep watching.** A downloaded update waits until you leave your room before installing and reopening the app. Rejoining cancels a pending restart.
- **Keep your saved data.** Your identity, friends, saved rooms and settings stay in your existing profile.
- **Recover from failed downloads.** Updates retry automatically; Home shows progress and offers **Retry update**. Mac update archives and feeds are checked with our own Ed25519 signatures before installation.
- **Tested real upgrades.** Windows and both Mac architectures passed installer, replacement, relaunch and saved-data checks, alongside tests for tampering, interrupted downloads and room transitions.

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

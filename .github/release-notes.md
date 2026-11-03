## What's new in 0.8.3

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Looped films keep their sound.** With **Loop** on, viewers could lose the sound a few seconds into the second time round. Fixed, for short clips and full-length films alike.
- **Smoother 60fps video.** A 60fps film reached viewers at about 49 frames a second. It now arrives at about 58.
- **Faster recovery after a hiccup.** After a short burst of bad connection the picture went soft for several seconds before coming back to full quality. It now comes back in about a second.
- **Better problem reports.** With **Send telemetry for development** on, the app now also checks your own router and internet connection while you watch, so a stutter can be traced to whoever's connection caused it.

Also in 0.8.2: stereo sound for viewers, the second film has sound, no more dropping out after a few films. See the 0.8.2 release for details.

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

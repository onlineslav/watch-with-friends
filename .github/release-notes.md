## What's new in 0.8.10

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Sound stays in sync after a pause.** After the host paused a film and played it again, viewers could hear the sound drift up to a second or two behind the picture until someone moved the playback bar. The host now keeps sending the sound through a pause, so it stays in step.
- **Bluetooth headphones line up better.** The picture now waits the full delay that headphones report (up to 300 ms, was 200 ms).

Also in 0.8.9: Skip intro, Previous/Next buttons and an on-screen note for every skip. See the 0.8.9 release for details.

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

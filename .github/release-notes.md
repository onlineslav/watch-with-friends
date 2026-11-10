## What's new in 0.8.8

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Skip intro.** A **Skip intro** button appears while a show's intro plays, for everyone in the room. Press it (or **S**) to jump straight to the episode. The app finds the intro from the file's chapters, or by spotting the theme an episode shares with the next or previous episode in the same folder. The first episode in a folder takes a few seconds to check; the rest are instant.
- **Previous and Next buttons** next to the skip buttons. Previous restarts what's playing, or goes back to the earlier item if you're in the first few seconds. Next plays the next item in the playlist. **Shift+P** and **Shift+N** do the same.
- **Skips say what they did.** The 10-second and 30-second skips show "Skipped forward 30s" on screen, and quick presses add up ("Skipped forward 1m 30s").

Also in 0.8.7: files start in your language (Settings → Languages). See the 0.8.7 release for details.

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

## What's new in 0.8.2

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Stereo sound for viewers.** Until now everyone watching heard mono, even though the host was sending stereo. Films and shares now arrive in full stereo. (Watching a host who is still on an older version stays mono until they update.)
- **The second film has sound.** When the host opened another file, or the playlist moved to the next item, viewers could see the picture but hear nothing. Fixed.
- **No more dropping out after a few films.** Every film opened in one evening made the connection a little heavier, and around the seventh one everyone watching got disconnected. That no longer builds up.
- **Smarter audio on a congested connection.** If the host's upload is genuinely full, sound steps down to 128 kbps instead of breaking up, and comes back on its own. With **Keep audio quality** on (the default) it's never lowered.

Also in 0.8.1: sound and picture line up, the **X** key marks a bad moment, and better problem reports. See the 0.8.1 release for details.

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

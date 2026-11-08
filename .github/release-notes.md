## What's new in 0.8.4

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **No more freezes when the host's computer is busy.** If other programs kept the host's PC busy, the stream could freeze for 15-40 seconds or drop out for everyone. On Windows the app now goes ahead of other programs while you're in a room, so a busy computer no longer stalls the stream.
- **Sharp picture again after a bad patch.** After a long connection hiccup the picture could stay stuck at low quality (360p) for a minute even once the connection was fine. It now comes back as soon as the connection does.
- **See where a click on the timeline will jump to.** Hovering over the timeline shows the time, and the time follows the handle while you drag it.

Also in 0.8.3: looped films keep their sound, smoother 60fps video, faster recovery after a hiccup. See the 0.8.3 release for details.

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

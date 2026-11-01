## What's new in 0.7.1

Reliability fixes for watching together.

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Friends no longer sometimes get a black screen.** When someone started playing or sharing, a friend's connection could occasionally miss the video entirely until they left and rejoined. Connections now recover on their own.
- **No more false "The host could not play this media."** Pausing straight after opening a file ended the session with that error; it no longer does.
- **The playlist's ••• menu stays open.** It could close by itself, and keyboard focus could jump, whenever the playlist updated (for example when a friend's progress changed).
- **A tidier diagnostic log.** A harmless network message that could repeat thousands of times per session (on computers with a VPN, for example) is now logged once, so the log keeps what matters when you send it for help.

Also in 0.7.0: share a whole app with its plugin windows, share minimized windows, change window without stopping, and a much smoother app. See the 0.7.0 release for details.

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

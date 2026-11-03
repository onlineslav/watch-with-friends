## What's new in 0.8.1

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Sound and picture line up.** When someone shared a window with its own app's sound, the sound could run well ahead of the picture, or WebRTC's lip-sync could give up entirely. That's fixed. Films are also tighter: sound now lands about 15ms after the picture, down from about 45ms.
- **Mark a bad moment.** Press **X** in a room when something looks or sounds wrong (Shift+X to add a short note, or use the flag button in the controls). The moment is marked for everyone in the room, so the developer can see exactly what happened then.
- **Better problem reports.** With **Send telemetry for development** on (Settings → Having problems?), the developer can now watch the connection live while you're watching together, and the log says more about what went wrong: audio dropouts, your audio device type, crashes, and whether your network or the other person's was the bottleneck. File names, network addresses and people's names in device names are still removed first. It's still off unless you turn it on.

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

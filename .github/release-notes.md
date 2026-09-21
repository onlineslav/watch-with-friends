## What's new in 0.5.1

Fixes for the three things most likely to interrupt a watch, plus a way to send
a log when something still goes wrong.

Windows installs the update automatically; on a Mac, use the download button on the home screen.

- **Pausing a friend's YouTube video now pauses it for them.** The embed reports its state on a timer, so a pause was announced as "still playing" and the viewer started itself again. Using YouTube's own controls as host now reaches everyone at once instead of on the next tick.
- **"Connection unavailable, retrying" no longer appears while you are both online.** One old failed peer used to describe the whole friends list until it went away. A friend who is connected but still proving who they are now reads **Connecting...**.
- **The room name stops saying "Joining room..."** once you have actually joined.
- **Having problems?** Settings can now save a diagnostic log covering the last few hours: what the connection did, and why the picture quality changed. It saves to a file you choose and send yourself, with file paths and addresses stripped out. Nothing is uploaded.

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

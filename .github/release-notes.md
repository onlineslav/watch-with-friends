## What's new in 0.5.2

Save a copy of a friend's local media directly from the room's playlist.

Windows installs the update automatically; on a Mac, use the download button on the home screen.

- **Download original files.** Open the playlist item's **three-dot menu → Download file** and choose where to save it. Video, audio and pictures transfer directly from the person who added them, even when someone else is hosting. Both people need this update, and the owner needs to stay in the room with the file available. YouTube links cannot be downloaded.
- **See progress or cancel.** The playlist shows download progress; the same menu lets you cancel. Leaving the room or removing the item stops the transfer and removes its partial file. A cancelled or failed transfer preserves any existing file at the chosen destination.
- **Safer transfers.** Changes to the original file during a transfer stop the download instead of saving mixed content. Downloads run alongside room playback without changing who is hosting.
- **Friends still connect when the window is hidden.** Startup no longer waits indefinitely for a paint before bringing friends and saved-room presence online.

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

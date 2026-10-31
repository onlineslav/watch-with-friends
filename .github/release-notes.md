## What's new in 0.7.0

Window sharing that shows the whole app, and a much smoother app.

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Share a whole app, plugins and pop-ups included (Windows).** Sharing a window now also shows that app's other windows, such as a DAW's plugin windows or a dialog, laid out the way they are on your screen, and nothing from any other app. A window covering the app no longer hides part of the share. Turn it off with "Include the app's other windows" in the share picker.
- **Share a minimized window (Windows).** It starts right away; friends see a calm "is minimized" card until you restore it, and the same card if you minimize it while sharing.
- **Change window without stopping.** Right-click your own share and choose **Change window…** to switch what you're sharing.
- **Smoother all round.** The app no longer redraws itself 60 times a second while nothing changes, and the share picker no longer freezes the window every time it refreshes. Shares run at a steady frame rate and follow a window as it's resized.
- **Sharper on weak connections.** Films and shares are now scaled down correctly when the connection struggles; 4K films are sent at 1080p instead of 4K.
- **A quieter stop button.** Stop sharing is now a small button in the corner of your own share tile.

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

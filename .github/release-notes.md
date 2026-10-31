## What's new in 0.6.0

Screen sharing, plus better picture and sound.

Windows users and Mac users on 0.5.3 receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Share your screen or a window.** Pick it from the app's own picker. Several people can share at once; everyone sees a grid of tiles, and can click one (or use the tabs) to watch it full size. Each tile has its own mute button.
- **Share just one app's sound.** On Windows and Mac, sharing a window sends only that app's audio by default, so your voice chat doesn't echo back to everyone. Settings also offers system audio, none, or any input device.
- **Share settings.** Resolution, frame rate, audio quality (up to 510 kbps stereo), and a new **Share priority**: Sharp text keeps text readable, Smooth motion keeps games and video fluid, Balanced does a bit of both.
- **Lower delay on shares.** Viewers no longer add a fixed quarter-second buffer to a screen share; it only grows when a connection struggles.
- **Better sound and picture for films.** The host's player now gets lossless audio and a higher-quality picture before it's sent, so what friends receive is compressed once instead of twice.
- **Draw on an empty stage**, and the controls hide when the mouse leaves the window.

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

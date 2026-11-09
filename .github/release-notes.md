## What's new in 0.8.7

Windows users and Mac users on 0.5.3 or later receive this release through the in-app updater. Mac users on 0.5.2 or earlier should install the DMG below once to enable future in-app updates.

- **Files start in your language.** Settings has a new **Languages** section. Pick your language and whether you'd rather watch **Dubbed** (your language when there's a dub, otherwise the original with subtitles) or **Original** (the original audio with subtitles). An anime episode with Japanese audio, an English dub and three subtitle tracks now starts on the right ones instead of whichever came first.
- **Subtitles:** "When I need them", "Always" or "Off", plus options for signs & songs subtitles on dubs and for subtitles with sound descriptions (SDH).
- **Your changes carry over.** Switch a track by hand and the next episode from the same folder starts the same way (you can turn this off).
- **In a room,** the host's settings pick the audio for everyone, and each person's subtitles follow their own settings.
- **The audio and subtitle menus under the video look like the other buttons there**, with an icon each, instead of grey boxes.

Also in 0.8.6: opening the playlist no longer shrinks the volume slider. See the 0.8.6 release for details.

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

// Every keyboard shortcut in a room, grouped for the shortcuts panel (the keyboard button in the
// controls, or ?). The keys themselves are handled in app.js's keydown listener; this is the list
// people read, so a new shortcut there needs a line here.
import {REACTIONS} from './reactions.mjs'

export const SHORTCUTS_KEY = '?'

// `keys` is one combination as separate caps (['Shift', 'N']); `alt` is a second combination that
// does the same thing, shown after "or".
export function shortcutGroups(platform = '') {
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl'
  return [
    {title: 'Playback', items: [
      {keys: ['Space'], label: 'Play or pause'},
      {keys: ['←'], label: 'Back 10 seconds'},
      {keys: ['→'], label: 'Forward 30 seconds'},
      {keys: ['S'], label: 'Skip intro'},
      {keys: ['Shift', 'N'], label: 'Next in the playlist'},
      {keys: ['Shift', 'P'], label: 'Previous'},
      {keys: ['L'], label: 'Loop for everyone'},
    ]},
    {title: 'Sound and view', items: [
      {keys: ['↑'], alt: ['↓'], label: 'Volume up or down'},
      {keys: ['M'], label: 'Mute'},
      {keys: ['F'], label: 'Fullscreen'},
      {keys: ['P'], label: 'Playlist'},
      {keys: [mod, '+'], alt: ['−'], label: 'Zoom in or out'},
      {keys: [mod, '0'], label: 'Zoom to 100%'},
    ]},
    {title: 'Room', items: [
      ...Object.values(REACTIONS).map(({emoji, label, key}) => ({keys: [key.replace('Digit', '')], label: `${emoji} ${label}`})),
      {keys: ['X'], label: 'Mark a bad moment'},
      {keys: ['Shift', 'X'], label: 'Mark it with a note'},
      {keys: [SHORTCUTS_KEY], label: 'Show these shortcuts'},
      {keys: ['Esc'], label: 'Close a panel or menu'},
    ]},
  ]
}

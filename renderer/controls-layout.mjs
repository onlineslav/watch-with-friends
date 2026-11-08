// How the player controls give way when the bar gets narrow (the playlist drawer open, a small
// window). The timeline and the volume keep their size; the language and subtitle dropdowns give
// way first, merged into one dropdown with a section for each, and only then does the timeline
// move onto a row of its own above the buttons.

// Below this the timeline is too short to aim at, so the dropdowns merge.
export const SEEK_ROOM = 240

// The steps, in the order they're tried. Each one stays on once taken.
export const LAYOUT_STEPS = ['merged-tracks', 'stacked']

// The steps to take: as few as needed for the bar to fit with a usable timeline. `measure(steps)`
// applies those steps and returns {seek, overflow} (the timeline's width, and how many pixels the
// bar's contents overrun it). `canMerge` is false when there aren't two dropdowns to merge.
export function fitLayout(measure, canMerge) {
  const steps = []
  let reading = measure(steps)
  for (const step of LAYOUT_STEPS) {
    if (reading.overflow <= 0 && reading.seek >= SEEK_ROOM) break
    if (step === 'merged-tracks' && !canMerge) continue
    steps.push(step)
    reading = measure(steps)
    // Once the timeline has its own row, its width is the whole bar: only overflow matters.
    if (step === 'stacked' && reading.overflow <= 0) break
  }
  return steps
}

export const TRACK_PREFIX = {audio: 'a:', subtitles: 's:'}

// The merged dropdown: a summary line shown while it's closed (the current language and
// subtitles), then a "Language" section and a "Subtitles" section. Values carry a prefix saying
// which of the two original dropdowns they belong to.
export function trackMenu(audio, audioSelected, subtitles, subtitleSelected) {
  const section = (label, prefix, options, selected) => ({
    label,
    options: options.map((o) => ({value: prefix + o.value, label: o.label, current: o.value === selected})),
  })
  const name = (options, selected) => options.find((o) => o.value === selected)?.label ?? options[0]?.label ?? ''
  return {
    summary: [name(audio, audioSelected), name(subtitles, subtitleSelected)].filter(Boolean).join(' · '),
    groups: [section('Language', TRACK_PREFIX.audio, audio, audioSelected), section('Subtitles', TRACK_PREFIX.subtitles, subtitles, subtitleSelected)],
  }
}

// Which original dropdown a merged-dropdown value belongs to, and its value there; null for the summary.
export function parseTrackChoice(value) {
  for (const [kind, prefix] of Object.entries(TRACK_PREFIX)) {
    if (typeof value === 'string' && value.startsWith(prefix)) return {kind, value: value.slice(prefix.length)}
  }
  return null
}

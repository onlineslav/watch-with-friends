// Default audio and subtitle tracks from the person's language settings (Settings → Languages).
// Pure: app.js hands it track descriptions, from the probe on the host and from the state's track
// labels on a viewer, and applies what it picks.
//
// Language detection is the part that has to be robust, because real files are tagged every way:
// ISO 639-1 ("en"), 639-2/B and /T ("fre"/"fra"), BCP 47 ("en-US", "pt-BR"), "und" or nothing at all,
// with the language only in the track's title ("English 2.0", "Eng Signs", "日本語"). The tag wins;
// the title is read only when the tag says nothing.

export const LANGUAGES = [
  {code: 'eng', name: 'English', native: 'English', codes: ['en', 'eng'], words: ['english', 'eng', 'inglés', 'ingles', 'anglais', 'englisch', 'inglese']},
  {code: 'spa', name: 'Spanish', native: 'Español', codes: ['es', 'spa'], words: ['spanish', 'español', 'espanol', 'castellano', 'castilian', 'latino', 'espagnol', 'spanisch']},
  {code: 'fra', name: 'French', native: 'Français', codes: ['fr', 'fra', 'fre'], words: ['french', 'français', 'francais', 'vff', 'vfq', 'französisch']},
  {code: 'deu', name: 'German', native: 'Deutsch', codes: ['de', 'deu', 'ger'], words: ['german', 'deutsch', 'allemand']},
  {code: 'ita', name: 'Italian', native: 'Italiano', codes: ['it', 'ita'], words: ['italian', 'italiano', 'italien']},
  {code: 'por', name: 'Portuguese', native: 'Português', codes: ['pt', 'por'], words: ['portuguese', 'português', 'portugues', 'brazilian', 'brasileiro']},
  {code: 'jpn', name: 'Japanese', native: '日本語', codes: ['ja', 'jpn'], words: ['japanese', 'jap', 'jpn', '日本語', 'nihongo', 'japonais', 'japanisch']},
  {code: 'kor', name: 'Korean', native: '한국어', codes: ['ko', 'kor'], words: ['korean', '한국어', 'coréen']},
  {code: 'zho', name: 'Chinese', native: '中文', codes: ['zh', 'zho', 'chi', 'cmn', 'yue'], words: ['chinese', 'mandarin', 'cantonese', '中文', '简体', '繁體', '繁体', 'chs', 'cht']},
  {code: 'rus', name: 'Russian', native: 'Русский', codes: ['ru', 'rus'], words: ['russian', 'русский']},
  {code: 'ukr', name: 'Ukrainian', native: 'Українська', codes: ['uk', 'ukr'], words: ['ukrainian', 'українська']},
  {code: 'pol', name: 'Polish', native: 'Polski', codes: ['pl', 'pol'], words: ['polish', 'polski']},
  {code: 'nld', name: 'Dutch', native: 'Nederlands', codes: ['nl', 'nld', 'dut'], words: ['dutch', 'nederlands', 'flemish']},
  {code: 'swe', name: 'Swedish', native: 'Svenska', codes: ['sv', 'swe'], words: ['swedish', 'svenska']},
  {code: 'nor', name: 'Norwegian', native: 'Norsk', codes: ['no', 'nor', 'nb', 'nob', 'nn', 'nno'], words: ['norwegian', 'norsk']},
  {code: 'dan', name: 'Danish', native: 'Dansk', codes: ['da', 'dan'], words: ['danish', 'dansk']},
  {code: 'fin', name: 'Finnish', native: 'Suomi', codes: ['fi', 'fin'], words: ['finnish', 'suomi']},
  {code: 'tur', name: 'Turkish', native: 'Türkçe', codes: ['tr', 'tur'], words: ['turkish', 'türkçe', 'turkce']},
  {code: 'ara', name: 'Arabic', native: 'العربية', codes: ['ar', 'ara'], words: ['arabic', 'العربية']},
  {code: 'heb', name: 'Hebrew', native: 'עברית', codes: ['he', 'heb', 'iw'], words: ['hebrew', 'עברית']},
  {code: 'hin', name: 'Hindi', native: 'हिन्दी', codes: ['hi', 'hin'], words: ['hindi', 'हिन्दी']},
  {code: 'tha', name: 'Thai', native: 'ไทย', codes: ['th', 'tha'], words: ['thai', 'ไทย']},
  {code: 'vie', name: 'Vietnamese', native: 'Tiếng Việt', codes: ['vi', 'vie'], words: ['vietnamese', 'tiếng việt']},
  {code: 'ind', name: 'Indonesian', native: 'Bahasa Indonesia', codes: ['id', 'ind', 'in'], words: ['indonesian', 'bahasa indonesia']},
  {code: 'ces', name: 'Czech', native: 'Čeština', codes: ['cs', 'ces', 'cze'], words: ['czech', 'čeština', 'cestina']},
  {code: 'ell', name: 'Greek', native: 'Ελληνικά', codes: ['el', 'ell', 'gre'], words: ['greek', 'ελληνικά']},
  {code: 'hun', name: 'Hungarian', native: 'Magyar', codes: ['hu', 'hun'], words: ['hungarian', 'magyar']},
  {code: 'ron', name: 'Romanian', native: 'Română', codes: ['ro', 'ron', 'rum'], words: ['romanian', 'română', 'romana']},
]

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]))
const BY_TAG = new Map(LANGUAGES.flatMap((l) => l.codes.map((c) => [c, l.code])))
// Three-letter codes are safe to read as whole words in a title ("Eng Signs"); two-letter ones aren't ("it", "de").
const TITLE_WORDS = LANGUAGES.map((l) => ({code: l.code, words: [...new Set([...l.words, ...l.codes.filter((c) => c.length === 3)])]}))

export const languageName = (code) => BY_CODE.get(code)?.name || 'Unknown language'

export function langFromTag(tag) {
  if (typeof tag !== 'string') return null
  const base = tag.trim().toLowerCase().split(/[-_]/)[0]
  return BY_TAG.get(base) || null
}

const LETTER = 'a-z\\u00c0-\\u024f\\u0370-\\u04ff'
const wordPattern = (word) => new RegExp(`(^|[^${LETTER}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^${LETTER}])`, 'u')
const CJK = /[֐-ۿऀ-๿　-鿿가-힯]/
const TITLE_PATTERNS = TITLE_WORDS.map(({code, words}) => ({code, tests: words.map((w) => (CJK.test(w) ? (s) => s.includes(w) : ((re) => (s) => re.test(s))(wordPattern(w))))}))

// The one language a title names, or null when it names none or several ("English / Japanese").
export function langFromTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return null
  const low = title.toLowerCase()
  const found = TITLE_PATTERNS.filter(({tests}) => tests.some((test) => test(low))).map(({code}) => code)
  return found.length === 1 ? found[0] : null
}

const COMMENTARY = /commentary|comentario|kommentar|commentaire/i
const DESCRIBED = /descri(ptive|ption|bed)|\baudio ?description\b|\bAD\b/i
const SIGNS = /signs?\b|songs?\b|forced|karaoke|lyrics|\bS&S\b/i
const SDH = /\bsdh\b|\bcc\b|hearing|closed caption/i
const ORIGINAL = /original|\bVO\b|\bOV\b/i
const DUB = /\bdub(bed)?\b|doblaje|doublage|synchro/i

// A subtitle file beside the video names its language and kind the usual way:
// "Show.S01E01.en.srt", "movie.eng.forced.srt", "film.pt-BR.sdh.ass".
const SIDECAR = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i
const SIDECAR_FLAGS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'full', 'signs'])
export function sidecarFacts(name) {
  if (typeof name !== 'string' || !SIDECAR.test(name)) return null
  const parts = name.replace(SIDECAR, '').split('.').slice(1).map((p) => p.toLowerCase())
  const flags = new Set(parts.filter((p) => SIDECAR_FLAGS.has(p)))
  const language = [...parts].reverse().find((p) => !SIDECAR_FLAGS.has(p) && langFromTag(p) && /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(p)) || null
  return {language, forced: flags.has('forced') || flags.has('signs'), sdh: flags.has('sdh') || flags.has('cc') || flags.has('hi')}
}

// One track as the picker sees it, from the probe's fields (main/plan.js summarizeProbe).
// An external subtitle file has only its file name, passed as the title.
export function describeTrack(track = {}) {
  const title = typeof track.title === 'string' ? track.title : ''
  const sidecar = !track.language ? sidecarFacts(title) : null
  if (sidecar) track = {...track, language: sidecar.language, forced: track.forced || sidecar.forced, sdh: track.sdh || sidecar.sdh}
  const fromTag = langFromTag(track.language)
  const lang = fromTag || (sidecar ? null : langFromTitle(title))
  return {
    lang,
    langFrom: fromTag ? 'tag' : lang ? 'title' : null,
    name: title.trim().toLowerCase(),
    isDefault: track.isDefault === true,
    image: track.image === true,
    original: track.original === true || (!track.dub && ORIGINAL.test(title) && !DUB.test(title)),
    dub: track.dub === true || DUB.test(title),
    commentary: track.commentary === true || COMMENTARY.test(title),
    described: track.described === true || DESCRIBED.test(title),
    signs: track.forced === true || SIGNS.test(title),
    sdh: track.sdh === true || SDH.test(title),
  }
}

// A track as a viewer sees it: only the host's label, built by plan.js trackLabel as
// "<title> · <LANG TAG> · <extra>" (any part may be missing; the tag is upper-cased there).
export function describeLabel(label, {image = false, isDefault = false} = {}) {
  const parts = String(label || '').split(' · ').map((p) => p.trim()).filter(Boolean)
  let language = null
  let forced = false
  let sdh = false
  let commentary = false
  const title = []
  for (const part of parts) {
    if (!language && /^[A-Z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(part) && langFromTag(part)) language = part
    else if (part === 'forced') forced = true
    else if (part === 'SDH') sdh = true
    else if (part === 'commentary') commentary = true
    else if (/^Track \d+$/.test(part)) continue
    else title.push(part)
  }
  return describeTrack({language, title: title.join(' · '), forced, sdh, commentary, image, isDefault})
}

export const DEFAULT_LANGUAGE_PREFS = Object.freeze({lang: 'eng', prefer: 'dub', subtitles: 'need', signs: true, sdh: false, remember: true})

export function defaultLanguage(locale) {
  return langFromTag(locale) || 'eng'
}

export function cleanLanguagePrefs(saved, locale) {
  const s = saved && typeof saved === 'object' ? saved : {}
  return {
    lang: BY_CODE.has(s.lang) ? s.lang : defaultLanguage(locale),
    prefer: s.prefer === 'original' ? 'original' : 'dub',
    subtitles: ['need', 'always', 'off'].includes(s.subtitles) ? s.subtitles : 'need',
    signs: s.signs !== false,
    sdh: s.sdh === true,
    remember: s.remember !== false,
  }
}

const usableAudio = (t) => !t.commentary && !t.described

// The track the film was made in: marked original, else not marked as a dub, else the first.
// Releases put the original first by convention, which is why "first" beats "default" here.
export function originalAudio(tracks) {
  const usable = tracks.map((t, i) => ({t, i})).filter(({t}) => usableAudio(t))
  if (!usable.length) return tracks.length ? 0 : -1
  return (usable.find(({t}) => t.original) || usable.find(({t}) => !t.dub) || usable[0]).i
}

// -> {index, why}. index is into `tracks` (-1 when there are none).
export function pickAudio(tracks, prefs) {
  if (!tracks.length) return {index: -1, why: 'none'}
  const original = originalAudio(tracks)
  const mine = tracks.map((t, i) => ({t, i})).filter(({t}) => usableAudio(t) && t.lang === prefs.lang)
  if (prefs.prefer === 'dub' && mine.length) {
    const pick = (mine.find(({i}) => i === original) || mine.find(({t}) => t.isDefault) || mine[0]).i
    return {index: pick, why: pick === original ? 'original-is-mine' : 'dub'}
  }
  return {index: original, why: prefs.prefer === 'dub' ? 'no-dub' : 'original'}
}

// -> {index, why}; index -1 means subtitles off. `audioLang` is the language actually playing
// (null when unknown, which counts as not understood). Image subtitles are burned in for everyone,
// so only the host may get one (`allowImage`), and only when no text track fits.
export function pickSubtitle(tracks, audioLang, prefs, {allowImage = false} = {}) {
  if (prefs.subtitles === 'off') return {index: -1, why: 'off'}
  const all = tracks.map((t, i) => ({t, i})).filter(({t}) => allowImage || !t.image)
  const mine = all.filter(({t}) => t.lang === prefs.lang)
  const full = mine.filter(({t}) => !t.signs)
  const signs = mine.filter(({t}) => t.signs)
  const rank = (list) => {
    const text = list.filter(({t}) => !t.image)
    const pool = text.length ? text : list
    const wanted = pool.filter(({t}) => t.sdh === prefs.sdh)
    const best = wanted.length ? wanted : pool
    return (best.find(({t}) => t.isDefault) || best[0])?.i ?? -1
  }
  const understood = audioLang && audioLang === prefs.lang
  if (understood) {
    if (prefs.subtitles === 'always' && full.length) return {index: rank(full), why: 'always'}
    if (prefs.signs && signs.length) return {index: rank(signs), why: 'signs'}
    return {index: -1, why: 'understood'}
  }
  if (full.length) return {index: rank(full), why: 'translate'}
  // Nothing in my language: a default track of unknown language is most likely the right one.
  const unknownDefault = all.find(({t}) => !t.lang && t.isDefault && !t.signs)
  if (unknownDefault) return {index: unknownDefault.i, why: 'unknown-default'}
  return {index: -1, why: 'none-in-language'}
}

// "Remember my changes": a track picked by hand is kept as what identifies it, and the next file
// starts on the track that matches (same language and title, else same language and kind).
export function trackSignature(track) {
  if (!track) return {off: true}
  return {lang: track.lang || null, name: track.name || '', signs: track.signs === true, sdh: track.sdh === true, commentary: track.commentary === true}
}

export function matchSignature(tracks, signature) {
  if (!signature || signature.off) return -1
  const exact = tracks.findIndex((t) => t.lang === signature.lang && t.name === signature.name && !t.commentary === !signature.commentary)
  if (exact >= 0) return exact
  if (!signature.lang) return -1
  return tracks.findIndex((t) => t.lang === signature.lang && t.signs === signature.signs && t.sdh === signature.sdh && !t.commentary && !t.described)
}

export const MEMORY_LIMIT = 200

// memory: {[key]: {audio?, subtitle?, at}}. Returns a new object with the oldest entries dropped.
export function remember(memory, key, kind, signature, now = Date.now()) {
  const next = {...(memory && typeof memory === 'object' ? memory : {})}
  next[key] = {...next[key], [kind]: signature, at: now}
  const keys = Object.keys(next)
  if (keys.length > MEMORY_LIMIT) keys.sort((a, b) => (next[a].at || 0) - (next[b].at || 0)).slice(0, keys.length - MEMORY_LIMIT).forEach((k) => delete next[k])
  return next
}

// The folder a file is in, as the memory key for the host ("the next episode from the same folder").
export const folderOf = (filePath) => String(filePath || '').replace(/[\\/][^\\/]*$/, '').toLowerCase()

// Audio and subtitles for a file: remembered choice first (if on), then the preferences.
// -> {audio: {index, why}, subtitle: {index, why}}
export function chooseTracks({audio = [], subtitles = [], prefs, memory = null, allowImage = false, audioLang}) {
  let audioPick = {index: -1, why: 'none'}
  if (audio.length) {
    const remembered = prefs.remember && memory?.audio ? matchSignature(audio, memory.audio) : -1
    audioPick = remembered >= 0 ? {index: remembered, why: 'remembered'} : pickAudio(audio, prefs)
  }
  const playing = audioLang !== undefined ? audioLang : audio[audioPick.index]?.lang ?? null
  let subtitle
  if (prefs.remember && memory && 'subtitle' in memory) {
    const index = memory.subtitle?.off ? -1 : matchSignature(subtitles.map((t) => (allowImage || !t.image ? t : {...t, lang: undefined})), memory.subtitle)
    if (memory.subtitle?.off) subtitle = {index: -1, why: 'remembered'}
    else if (index >= 0) subtitle = {index, why: 'remembered'}
  }
  subtitle ??= pickSubtitle(subtitles, playing, prefs, {allowImage})
  return {audio: audioPick, subtitle}
}

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  langFromTag, langFromTitle, describeTrack, describeLabel, sidecarFacts, cleanLanguagePrefs, pickAudio, pickSubtitle,
  chooseTracks, trackSignature, matchSignature, remember, folderOf, MEMORY_LIMIT, DEFAULT_LANGUAGE_PREFS, originalAudio,
} from '../renderer/languages.mjs'

const prefs = (over = {}) => ({...DEFAULT_LANGUAGE_PREFS, ...over})
const tracks = (list) => list.map(describeTrack)

test('language tags in every form people tag files with', () => {
  for (const tag of ['en', 'eng', 'EN', 'en-US', 'en_GB', 'ENG']) assert.equal(langFromTag(tag), 'eng', tag)
  assert.equal(langFromTag('fre'), 'fra')
  assert.equal(langFromTag('fra'), 'fra')
  assert.equal(langFromTag('ger'), 'deu')
  assert.equal(langFromTag('chi'), 'zho')
  assert.equal(langFromTag('pt-BR'), 'por')
  assert.equal(langFromTag('nob'), 'nor')
  for (const tag of ['und', 'mul', 'zxx', '', null, undefined, 'xx']) assert.equal(langFromTag(tag), null, String(tag))
})

test('a language read from the title only when it names exactly one', () => {
  assert.equal(langFromTitle('English 2.0'), 'eng')
  assert.equal(langFromTitle('Eng Signs'), 'eng')
  assert.equal(langFromTitle('Japanese (Original)'), 'jpn')
  assert.equal(langFromTitle('日本語'), 'jpn')
  assert.equal(langFromTitle('Español (Latinoamérica)'), 'spa')
  assert.equal(langFromTitle('Français'), 'fra')
  assert.equal(langFromTitle('English / Japanese'), null)
  assert.equal(langFromTitle('Stereo'), null)
  assert.equal(langFromTitle('Strength'), null, 'no "eng" inside a word')
  assert.equal(langFromTitle('Signs & Songs'), null)
})

test('the tag wins over the title; the title fills in an untagged track', () => {
  assert.equal(describeTrack({language: 'eng', title: 'Japanese'}).lang, 'eng')
  assert.deepEqual([describeTrack({language: 'und', title: 'Japanese 2.0'}).lang, describeTrack({language: 'und', title: 'Japanese 2.0'}).langFrom], ['jpn', 'title'])
  assert.equal(describeTrack({title: 'Commentary with the director'}).commentary, true)
  assert.equal(describeTrack({title: 'Signs & Songs'}).signs, true)
  assert.equal(describeTrack({title: 'English SDH'}).sdh, true)
  assert.equal(describeTrack({title: 'English Dub'}).dub, true)
  assert.equal(describeTrack({title: 'Japanese (Original)'}).original, true)
})

test('subtitle files beside the video name their language and kind', () => {
  assert.deepEqual(sidecarFacts('Show.S01E01.en.srt'), {language: 'en', forced: false, sdh: false})
  assert.deepEqual(sidecarFacts('movie.eng.forced.srt'), {language: 'eng', forced: true, sdh: false})
  assert.deepEqual(sidecarFacts('film.pt-BR.sdh.ass'), {language: 'pt-br', forced: false, sdh: true})
  assert.equal(sidecarFacts('movie.srt').language, null)
  assert.equal(sidecarFacts('Show Name.mkv'), null)
  assert.equal(describeTrack({title: 'Show.S01E01.en.srt'}).lang, 'eng')
})

test('a viewer reads the same facts from the host label', () => {
  const sub = describeLabel('Signs & Songs · ENG · forced')
  assert.equal(sub.lang, 'eng')
  assert.equal(sub.signs, true)
  assert.equal(sub.name, 'signs & songs')
  assert.equal(describeLabel('Full · ENG · SDH').sdh, true)
  assert.equal(describeLabel('JPN · flac').lang, 'jpn')
  assert.equal(describeLabel('EN-US · aac').lang, 'eng')
  assert.equal(describeLabel('Japanese 2.0 · aac').lang, 'jpn', 'untagged: from the title')
  assert.equal(describeLabel('ENG · commentary · aac').commentary, true)
  assert.equal(describeLabel('Track 3').lang, null)
  assert.equal(describeLabel('Show.S01E01.en.srt').lang, 'eng')
  // The same track, described by the host and by a viewer, gives the same signature.
  assert.deepEqual(trackSignature(describeLabel('Full Subtitles · ENG')), trackSignature(describeTrack({language: 'eng', title: 'Full Subtitles'})))
})

test('settings default to the system language and survive junk', () => {
  assert.deepEqual(cleanLanguagePrefs(null), DEFAULT_LANGUAGE_PREFS, 'English by default, whatever the system language')
  assert.equal(DEFAULT_LANGUAGE_PREFS.lang, 'eng')
  assert.deepEqual(cleanLanguagePrefs({lang: 'jpn', prefer: 'original', subtitles: 'always', signs: false, sdh: true, remember: false}), {lang: 'jpn', prefer: 'original', subtitles: 'always', signs: false, sdh: true, remember: false})
  assert.deepEqual(cleanLanguagePrefs({lang: 'klingon', prefer: 1, subtitles: 'maybe'}), DEFAULT_LANGUAGE_PREFS)
})

const anime = {
  audio: tracks([{language: 'jpn', title: 'Japanese', isDefault: true}, {language: 'eng', title: 'English Dub'}]),
  subtitles: tracks([{language: 'eng', title: 'Signs & Songs', forced: true}, {language: 'eng', title: 'Full Subtitles'}, {language: 'spa', title: 'Español'}]),
}

test('dubbed: the dub plays with signs and songs only', () => {
  const pick = chooseTracks({...anime, prefs: prefs()})
  assert.deepEqual(pick.audio, {index: 1, why: 'dub'})
  assert.deepEqual(pick.subtitle, {index: 0, why: 'signs'})
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({signs: false})}).subtitle, {index: -1, why: 'understood'})
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({subtitles: 'always'})}).subtitle, {index: 1, why: 'always'})
})

test('original: the original plays with full subtitles in my language', () => {
  const pick = chooseTracks({...anime, prefs: prefs({prefer: 'original'})})
  assert.deepEqual(pick.audio, {index: 0, why: 'original'})
  assert.deepEqual(pick.subtitle, {index: 1, why: 'translate'})
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({prefer: 'original', lang: 'spa'})}).subtitle, {index: 2, why: 'translate'})
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({prefer: 'original', subtitles: 'off'})}).subtitle, {index: -1, why: 'off'})
})

test('dubbed with no dub falls back to the original with subtitles', () => {
  const film = {audio: tracks([{language: 'fre', isDefault: true}]), subtitles: tracks([{language: 'eng'}, {language: 'fre', title: 'Français (SDH)'}])}
  const pick = chooseTracks({...film, prefs: prefs()})
  assert.deepEqual(pick.audio, {index: 0, why: 'no-dub'})
  assert.deepEqual(pick.subtitle, {index: 0, why: 'translate'})
})

test('commentary and audio description are never picked; already in my language means no subtitles', () => {
  const movie = {
    audio: tracks([{language: 'eng', title: "Director's Commentary"}, {language: 'eng', title: 'English 5.1', isDefault: true}, {language: 'spa'}, {language: 'eng', described: true}]),
    subtitles: tracks([{language: 'eng', title: 'English SDH'}, {language: 'eng', title: 'English'}]),
  }
  assert.equal(originalAudio(movie.audio), 1)
  for (const prefer of ['dub', 'original']) {
    const pick = chooseTracks({...movie, prefs: prefs({prefer})})
    assert.equal(pick.audio.index, 1, prefer)
    assert.deepEqual(pick.subtitle, {index: -1, why: 'understood'})
  }
  assert.equal(chooseTracks({...movie, prefs: prefs({subtitles: 'always'})}).subtitle.index, 1, 'plain subtitles over SDH by default')
  assert.equal(chooseTracks({...movie, prefs: prefs({subtitles: 'always', sdh: true})}).subtitle.index, 0)
})

test('an original marked in the file beats track order; a track marked as a dub is never the original', () => {
  assert.equal(originalAudio(tracks([{language: 'eng'}, {language: 'jpn', original: true}])), 1)
  assert.equal(originalAudio(tracks([{language: 'eng', title: 'English Dub'}, {language: 'jpn'}])), 1)
  assert.equal(pickAudio([], prefs()).index, -1)
})

test('untagged tracks work from their titles', () => {
  const show = {
    audio: tracks([{language: 'und', title: 'Japanese 2.0', isDefault: true}, {title: 'English 2.0'}]),
    subtitles: tracks([{language: 'und', title: 'Eng Signs'}, {language: 'und', title: 'English'}]),
  }
  assert.deepEqual(chooseTracks({...show, prefs: prefs()}), {audio: {index: 1, why: 'dub'}, subtitle: {index: 0, why: 'signs'}})
  assert.deepEqual(chooseTracks({...show, prefs: prefs({prefer: 'original'})}), {audio: {index: 0, why: 'original'}, subtitle: {index: 1, why: 'translate'}})
})

test('no subtitles in my language: an unknown-language default track, else none', () => {
  const unknown = tracks([{title: 'Track 1'}, {title: 'Track 2', isDefault: true}])
  assert.deepEqual(pickSubtitle(unknown, 'kor', prefs()), {index: 1, why: 'unknown-default'})
  assert.deepEqual(pickSubtitle(tracks([{language: 'kor'}]), 'kor', prefs()), {index: -1, why: 'none-in-language'})
  assert.deepEqual(pickSubtitle([], null, prefs()), {index: -1, why: 'none-in-language'})
})

test('image subtitles only for the host, and only when no text track fits', () => {
  const subs = tracks([{language: 'eng', image: true}, {language: 'eng', title: 'Full'}])
  assert.equal(pickSubtitle(subs, 'jpn', prefs()).index, 1)
  assert.equal(pickSubtitle([subs[0]], 'jpn', prefs()).index, -1)
  assert.equal(pickSubtitle([subs[0]], 'jpn', prefs(), {allowImage: true}).index, 0)
})

test('a viewer picks subtitles for the audio the host is actually playing', () => {
  // The host prefers the original; the viewer prefers dubs but hears Japanese anyway.
  assert.deepEqual(chooseTracks({subtitles: anime.subtitles, prefs: prefs(), audioLang: 'jpn'}).subtitle, {index: 1, why: 'translate'})
  assert.deepEqual(chooseTracks({subtitles: anime.subtitles, prefs: prefs(), audioLang: null}).subtitle, {index: 1, why: 'translate'})
})

test('remembered choices win over the preferences, and only while Remember is on', () => {
  const memory = {audio: trackSignature(anime.audio[0]), subtitle: trackSignature(anime.subtitles[1])}
  assert.deepEqual(chooseTracks({...anime, prefs: prefs(), memory}), {audio: {index: 0, why: 'remembered'}, subtitle: {index: 1, why: 'remembered'}})
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({remember: false}), memory}).audio, {index: 1, why: 'dub'})
  // Subtitles turned off by hand stay off.
  assert.deepEqual(chooseTracks({...anime, prefs: prefs({prefer: 'original'}), memory: {subtitle: {off: true}}}).subtitle, {index: -1, why: 'remembered'})
  // A remembered track the next file doesn't have falls back to the preferences.
  assert.deepEqual(chooseTracks({...anime, prefs: prefs(), memory: {audio: {lang: 'kor', name: '', signs: false, sdh: false}}}).audio, {index: 1, why: 'dub'})
})

test('a remembered track matches by title first, then by language and kind', () => {
  const next = tracks([{language: 'eng', title: 'Signs'}, {language: 'eng', title: 'Dialogue'}])
  assert.equal(matchSignature(next, trackSignature(describeTrack({language: 'eng', title: 'Dialogue'}))), 1)
  assert.equal(matchSignature(next, trackSignature(describeTrack({language: 'eng', title: 'Full Subtitles'}))), 1)
  assert.equal(matchSignature(next, trackSignature(describeTrack({language: 'eng', title: 'Songs', forced: true}))), 0)
  assert.equal(matchSignature(next, {off: true}), -1)
  assert.equal(matchSignature(next, null), -1)
  const commentary = tracks([{language: 'eng', title: 'English'}, {language: 'eng', title: 'Commentary'}])
  assert.equal(matchSignature(commentary, trackSignature(commentary[1])), 1)
})

test('memory keeps the newest folders only', () => {
  let memory = {}
  for (let i = 0; i < MEMORY_LIMIT + 5; i++) memory = remember(memory, `k${i}`, 'audio', {lang: 'eng'}, i)
  assert.equal(Object.keys(memory).length, MEMORY_LIMIT)
  assert.ok(!('k0' in memory) && 'k204' in memory)
  memory = remember(memory, 'k204', 'subtitle', {off: true}, 999)
  assert.deepEqual(memory.k204, {audio: {lang: 'eng'}, subtitle: {off: true}, at: 999})
  assert.equal(folderOf('C:\\Anime\\Frieren\\ep01.mkv'), 'c:\\anime\\frieren')
  assert.equal(folderOf('/Users/x/Shows/ep01.mkv'), '/users/x/shows')
})

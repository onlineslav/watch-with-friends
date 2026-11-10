// Shared playlist: anyone in the room adds files from their own computer. The file stays with the
// person who added it (its owner); playing an item asks the owner's app to host it. The list logic
// is pure, so every app merges the same messages into the same list.
//
// Items are ordered by `position` (ties by id). Anyone can move an item by giving it a new position;
// the latest move wins everywhere (`movedAt`, then `movedBy`), so reorders from two people converge.
import {cleanDisplayName, cleanText} from './profile.mjs'
import {isRevision, finite} from './protocol.mjs'
import {isYouTubeId} from '../shared/youtube.mjs'

export const MAX_ITEMS = 500
export const MAX_REMOVED = 4096
export const MAX_TITLE_LENGTH = 200
const MAX_ID_LENGTH = 100

export const createPlaylist = () => ({items: new Map(), removed: new Set(), pendingMoves: new Map(), progress: new Map(), current: null, revision: 0})

const isId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH
const isNewerMove = (a, b) => (a.movedAt !== b.movedAt ? a.movedAt > b.movedAt : a.movedBy > b.movedBy)

// Adds an item from a peer. `owner` is their persistent, authenticated username. Returns the item, or
// null if it was rejected, already removed, or already there.
export function addItem(playlist, {id, title, position, ownerName, movedAt = 0, movedBy = '', youtubeId}, owner) {
  if (youtubeId !== undefined && !isYouTubeId(youtubeId)) return null
  if (!isId(id) || !isId(owner) || !Number.isFinite(position) || playlist.removed.has(id) || playlist.items.has(id)) return null
  const cleanTitle = cleanText(title, MAX_TITLE_LENGTH)
  if (!cleanTitle || playlist.items.size >= MAX_ITEMS || playlist.removed.size + playlist.items.size >= MAX_REMOVED) return null
  const moved = isRevision(movedAt) && movedAt > 0 && isId(movedBy)
  const item = {id, title: cleanTitle, position, owner, ownerName: cleanDisplayName(ownerName), movedAt: moved ? movedAt : 0, movedBy: moved ? movedBy : ''}
  if (youtubeId) item.youtubeId = youtubeId
  playlist.items.set(id, item)
  playlist.revision = Math.max(playlist.revision, item.movedAt)
  // A move can arrive before the item it moves, when the person who added it is further away.
  const pending = playlist.pendingMoves.get(id)
  playlist.pendingMoves.delete(id)
  if (pending) moveItem(playlist, pending)
  return item
}

// Returns whether the move changed the item.
export function moveItem(playlist, {id, position, movedAt, movedBy}) {
  if (!isId(id) || !Number.isFinite(position) || !isRevision(movedAt) || !isId(movedBy)) return false
  playlist.revision = Math.max(playlist.revision, movedAt)
  const move = {id, position, movedAt, movedBy}
  const item = playlist.items.get(id)
  if (!item) {
    const pending = playlist.pendingMoves.get(id)
    const room = pending || playlist.pendingMoves.size < MAX_ITEMS
    if (!playlist.removed.has(id) && room && (!pending || isNewerMove(move, pending))) playlist.pendingMoves.set(id, move)
    return false
  }
  if (!isNewerMove(move, item)) return false
  Object.assign(item, {position, movedAt, movedBy})
  return true
}

// Removals are remembered, so an item removed here never comes back from someone's older snapshot.
export function removeItem(playlist, id) {
  if (!isId(id)) return
  // Reserve enough history for removing every extant item; never evict tombstones.
  if (!playlist.removed.has(id) && !playlist.items.has(id) && playlist.removed.size + playlist.items.size >= MAX_REMOVED) return
  playlist.removed.add(id)
  playlist.items.delete(id)
  playlist.pendingMoves.delete(id)
  playlist.progress.delete(id)
}

export const playlistSnapshot = (playlist) => ({items: [...playlist.items.values()], removed: [...playlist.removed], progress: [...playlist.progress.values()], current: playlist.current})

// Host claims and their state sequence keep progress ordered even across restarts,
// seeks backwards, delayed snapshots and hosts with different wall clocks.
const newerProgress = (a, b) => !b || a.claimedAt > b.claimedAt || (a.claimedAt === b.claimedAt &&
  (a.hostId > b.hostId || (a.hostId === b.hostId && a.sequence > b.sequence)))

export function cleanProgress(value) {
  if (!value || !isId(value.id) || !isId(value.hostId) || !isRevision(value.claimedAt) || !value.claimedAt ||
      !isRevision(value.sequence) || !finite(value.time, 0, 1e9) || !finite(value.duration, 0, 1e9) ||
      !Number.isFinite(value.position) || typeof value.completed !== 'boolean' || typeof value.loop !== 'boolean') return null
  return {id: value.id, position: value.position, time: Math.min(value.time, value.duration || value.time), duration: value.duration,
    completed: value.completed, loop: value.loop, claimedAt: value.claimedAt, hostId: value.hostId, sequence: value.sequence}
}

export function recordProgress(playlist, value) {
  const progress = cleanProgress(value)
  if (!progress) return false
  playlist.revision = Math.max(playlist.revision, progress.claimedAt)
  // Keep the cursor even if its item was removed, so Next still follows its position.
  if (newerProgress(progress, playlist.current)) playlist.current = progress
  if (playlist.removed.has(progress.id) || (!playlist.progress.has(progress.id) && playlist.progress.size >= MAX_ITEMS) ||
      !newerProgress(progress, playlist.progress.get(progress.id))) return false
  playlist.progress.set(progress.id, progress)
  return true
}

// Someone joining gets a snapshot from everyone already in the room; merging is idempotent.
export function mergePlaylist(playlist, snapshot, {selfId, ownFiles} = {}) {
  for (const id of Array.isArray(snapshot?.removed) ? snapshot.removed.slice(0, MAX_REMOVED) : []) removeItem(playlist, id)
  for (const item of Array.isArray(snapshot?.items) ? snapshot.items.slice(0, MAX_ITEMS) : []) {
    if (item?.owner === selfId && !isYouTubeId(item?.youtubeId) && (!ownFiles?.has(item?.id) || !playlist.items.has(item?.id))) continue
    if (playlist.items.has(item?.id)) moveItem(playlist, item)
    else addItem(playlist, item || {}, item?.owner)
  }
  for (const progress of Array.isArray(snapshot?.progress) ? snapshot.progress.slice(0, MAX_ITEMS) : []) recordProgress(playlist, progress)
  recordProgress(playlist, snapshot?.current)
}

const compare = (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export const orderedItems = (playlist) => [...playlist.items.values()].sort(compare)

// Where a newly added item goes: after everything else.
export const endPosition = (playlist) => Math.max(0, ...[...playlist.items.values()].map((item) => item.position)) + 1

// The position that puts item `id` at `index` among the other items, or null if it's already there.
export function positionAt(playlist, id, index) {
  const ordered = orderedItems(playlist)
  const from = ordered.findIndex((item) => item.id === id)
  const others = ordered.filter((item) => item.id !== id)
  const to = Math.max(0, Math.min(Math.trunc(index) || 0, others.length))
  if (from < 0 || to === from) return null
  const before = others[to - 1]
  const after = others[to]
  if (!before) return after.position - 1
  if (!after) return before.position + 1
  return (before.position + after.position) / 2
}

// Dragging a row to reorder. `tops` are the rows' offsets from before the drag started, `from` is the
// held row's index and `dy` how far it has been dragged.

// Keeps the held row within the list, so dragging past either end can't make the list scroll.
export const clampDrag = (tops, from, dy) => Math.min(tops.at(-1) - tops[from], Math.max(tops[0] - tops[from], dy))

// The slot nearest the held row: it switches halfway between two slots, so no precise aiming is needed.
export function dropIndex(tops, from, dy) {
  const target = tops[from] + dy
  let best = 0
  tops.forEach((top, i) => {
    if (Math.abs(top - target) < Math.abs(tops[best] - target)) best = i
  })
  return best
}

// How far row `i` slides while the held row hovers over slot `to`: one slot towards the gap it left,
// which opens a gap at `to`.
export function slotShift(tops, i, from, to) {
  if (from < to && i > from && i <= to) return tops[i - 1] - tops[i]
  if (from > to && i < from && i >= to) return tops[i + 1] - tops[i]
  return 0
}

// The first playable item after `current` ({id, position}). Follows the item if it has moved since,
// and still works if it has been removed.
export function nextItem(playlist, current, playable = () => true) {
  if (!current) return null
  const from = playlist.items.get(current.id) || current
  return orderedItems(playlist).find((item) => compare(item, from) > 0 && playable(item)) || null
}

// The last playable item before `current`, the same way.
export function previousItem(playlist, current, playable = () => true) {
  if (!current) return null
  const from = playlist.items.get(current.id) || current
  return orderedItems(playlist).findLast((item) => compare(item, from) < 0 && playable(item)) || null
}

// The drawer's tab: dragging it left pulls the panel out, dragging right pushes it back in.
export const DRAWER = {minWidth: 220, maxWidth: 480, closeBelow: 120, defaultWidth: 300}

export const maxDrawerWidth = (roomWidth) => Math.max(DRAWER.minWidth, Math.min(DRAWER.maxWidth, roomWidth - 400))

export const draggedWidth = (startWidth, dx, maxWidth) => Math.min(maxWidth, Math.max(0, startWidth - dx))

// Where the drawer settles on release: closed if it was barely pulled out, otherwise a usable width.
export const settledWidth = (width, maxWidth) => (width < DRAWER.closeBelow ? 0 : Math.min(maxWidth, Math.max(DRAWER.minWidth, width)))

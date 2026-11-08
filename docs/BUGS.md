# Bugs

Filed from Aya's notes in the root `todo.md`. Format: id, what happens, status.

### B1 Settings on Mac only stays open while the right button is held
Status: fixed in 0.8.5 (waiting on a Mac to confirm)
From Aya's notes: "my friend needs to hold right click to keep the settings up on her mac. right click or left
clicking off of the settings should set those settings and close the window." Not reproduced yet; not part of M1.
Aya, 2026-11-08: it's the Save/Discard prompt on clicking off Settings; clicking off should just save, and must not
pause the film. Clicking the backdrop (left or right button) now saves and closes, the click stops there;
`check-network.js` does it with real mouse events while a film plays.

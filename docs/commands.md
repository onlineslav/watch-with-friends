# Commands and build notes

Moved word for word from CLAUDE.md on 2026-11-12 so a session doesn't load it every turn. Every npm script with its full notes. AGENTS.md has the short table; read this before running or changing a script.

```sh
npm install
npm start                        # esbuild-bundles the renderer, then launches Electron
npm test                         # all unit tests (node:test over test/*.test.js and test/*.test.mjs only; work/compat holds old copies of the repo)
node --test test/plan.test.js    # a single test file
npm run bundle                   # renderer/app.js -> renderer/bundle.js (generated, gitignored)
npm run test:logging             # end-to-end check that renderer events reach the log file
npm run test:compat              # this build against a v0.8.0 copy in both directions (film, republish, glare); `-- --tag=v0.7.1` for another release (needs the tag locally; every check runs on 0.7.1 too); `-- --host=new --runs=5` repeats one direction and prints a pass count. `scripts/old-tree.js` prepares the copy in async steps with time limits, the old patch script under ELECTRON_RUN_AS_NODE=1 (without it electron.exe started as an app, never exited and held work/compat/<tag>)
npm run status                   # work/status/index.html: milestone cards, checks waiting on you, bugs, commits, built by hand (no commit hook; the live page is Control Room at http://127.0.0.1:8790/synced-video-player/)
npm run bench                    # A/V sync + audio/video benchmark, film and share, 3 runs each (~15 min); writes work/bench/<version>-<date>.json
npm run dist:win                 # NSIS installer in dist/
npm run dist:mac                 # .dmg in dist/, only works on macOS (CI builds both, see .github/workflows/build.yml)
```

- `renderer/bundle.js` is what the window loads. Re-run `npm run bundle` after editing anything in `renderer/` or `shared/`.
- VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node so `require('electron')` fails. `npm start` goes through `scripts/electron.js`, which removes it; run Electron directly (`electron .`) and you have to unset it yourself.

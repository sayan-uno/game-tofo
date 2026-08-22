# Why this folder exists

`meshopt_decoder.js` is not the console's own code — it belongs to the games.

The replay studio runs the games' real client runtimes, and their models are
meshopt-compressed. Babylon fetches the decoder for that from a fixed
same-origin path, `/meshopt_decoder.js` (see
`frontend/src/game/characterRig.ts`), which the player app serves from its own
`public/`. The console is a **different origin**, so without a copy here the
decoder 404s and every compressed model silently fails to parse — characters
included. The symptom is a replay of name plates running down an empty street.

Keep this file identical to `frontend/public/meshopt_decoder.js`.

## lobby-bg.webp

A copy of `frontend/public/lobby-bg.webp`, and it must stay one.

The party studio replays a party through the game's REAL lobby scene, and that
scene loads its backdrop from a fixed same-origin path. Without this file the
console serves a 404 and Babylon draws its missing-texture checkerboard — a
red-and-black grid behind the characters — while everything else works
perfectly. Exactly the same trap as `meshopt_decoder.js` above.

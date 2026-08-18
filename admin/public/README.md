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

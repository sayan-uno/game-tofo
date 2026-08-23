// Finding the acknowledgement callback, whatever slot the client left it in.
//
// Socket.IO passes the ack as the LAST argument the emitter sent — so a
// handler declared `(payload, ack)` receives the callback as `payload` when a
// client emits with no payload at all, and a handler declared `(ack)` receives
// an object when a client emits one.
//
// That is not a theoretical client. It is any older build, any reconnecting
// page, and anything anybody writes against this socket by hand — and the
// failure it causes is the worst kind: calling an object as a function throws,
// the throw happens inside the handler's own catch block while it is reporting
// the first error, and an unhandled rejection takes THE WHOLE SERVER down.
// Every player on the process is disconnected because one of them emitted an
// argument nobody expected.
//
// So no handler reads the ack positionally. It reads whichever argument is
// actually a function, and gets a no-op when there is none.
export type Ack = (response: object) => void;

const NOOP: Ack = () => {};

/** The callback among these arguments, or a no-op. */
export function ackOf(args: unknown[]): Ack {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === "function") return args[i] as Ack;
  }
  return NOOP;
}

/** The first argument that looks like a payload object, or {}. Pairs with
 *  ackOf so a handler can take `(...args: unknown[])` and still be strict
 *  about what it reads. */
export function payloadOf<T extends object>(args: unknown[]): Partial<T> {
  const first = args[0];
  return first && typeof first === "object" ? (first as Partial<T>) : {};
}

# Call lifecycle

The coordinator reserves a room/transport-session pair before asynchronous identity verification. Reservations count toward the configured capacity, including pending openings. A failed opening releases its reservation.

A successful opening creates a new random conversation UUID. Only configured rooms, agents, and owners are accepted. Every turn rechecks the media participant against current Matrix identity, membership expiry, device verification, and media encryption. These facts must come from the transport's trusted verifier.

One turn may run in a call at a time. Separate calls can run concurrently with independent immutable message arrays, caller context, logical agent selection, and cancellation signals. Conversation history is bounded to 128 successful exchanges.

Closing a call immediately revokes local dispatch and aborts its signal. Late verification and agent output are discarded. Persistence writes are ordered so an in-flight active-state write cannot overwrite closure. Adapters must also honor cancellation at their own host boundary; discarding a reply cannot undo an external tool action that already happened.

Failed turns are not automatically retried and do not append unsuccessful exchanges. A host-session adapter may still have private state from a failed operation. Operators should start a new call when the outcome of an external action is uncertain.

Restart does not resume persisted active records. Fresh Matrix verification and a new conversation are required. An imported record never grants permission to act.

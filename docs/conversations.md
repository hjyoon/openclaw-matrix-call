# Conversation records

The core stores a versioned JSON record with a random UUID, Matrix room identifier, transport session identifier, logical agent identifier, timestamps, lifecycle status, and ordered user/assistant text messages. No OpenClaw session key or provider SDK object is required to read it.

Records contain sensitive conversation text. Export is an explicit application action. Do not log records, commit them, or place them in public package archives.

The in-memory store copies and freezes validated records. Implement the ConversationStore interface to use another database or a local file store. Persistence adapters must protect data access and atomic writes.

Import validates the data format; it does not restore caller authority or resume an active call. A new runtime must verify current Matrix membership and device trust before dispatch. Host-private tool traces and internal model state are outside the portable text record.

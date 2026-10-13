# Local speech worker

The optional speech worker implements the recognition and synthesis ports without requiring a hosted account. It is separate from the Matrix browser worker and agent runtime. This package is under development; adding its audio boundary does not establish a complete speech service or client interoperability.

The engine boundary accepts mono signed PCM, 8–48 kHz, at most ten seconds. Recognition input is converted to 16 kHz using a normalized Hann-windowed sinc filter with sixteen destination-bandwidth zero crossings on either side. Native 16 kHz input is copied. Output duration is rounded to the nearest destination sample, retains at least one sample, and clamps filter overshoot to signed 16-bit range. No buffer ownership is shared with callers.

Engine WAV files use the canonical 44-byte PCM16 header. Compressed, floating-point, stereo, additional-chunk and inconsistent-length files are rejected. The synthesis adapter may explicitly enable the exact streaming length sentinels emitted by the pinned eSpeak NG CLI; this exception does not apply to arbitrary network input. Actual output bytes and duration remain bounded.

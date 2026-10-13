# Public speech fixtures

These files are test inputs, never participant recordings. The manifest pins both derived files and their original sources. They are not included in a runtime image.

`fleurs-ko.wav` comes from the Korean development split of Google's **FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech**, by Alexis Conneau, Min Ma, Simran Khanuja and colleagues (2022). The original archive member and repository revision are recorded in `manifest.json`. The dataset is distributed under [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/), as declared by the [official dataset](https://huggingface.co/datasets/google/fleurs/tree/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/ko_kr). The 4.68-second recording is converted from float32 mono to PCM16 at the original 16 kHz sample rate. This modification does not imply endorsement by the dataset authors or speaker.

`jfk-en.wav` is the first eight seconds of the sample distributed in the [pinned whisper.cpp repository](https://github.com/ggml-org/whisper.cpp/blob/927cfce34f31707e17f2bff35c349632fb9e2c3a/samples/jfk.wav), which carries an [MIT license](https://github.com/ggml-org/whisper.cpp/blob/927cfce34f31707e17f2bff35c349632fb9e2c3a/LICENSE), copyright 2023–2024 The ggml authors. It contains President John F. Kennedy's 1961 inaugural address and is re-encoded as canonical mono PCM16 WAV at 16 kHz.

Recognition checks require a small set of expected words, not an exact transcript. These two clips establish a reproducible service integration check, not a word-error-rate benchmark, accent coverage, noise robustness or natural TTS pronunciation. Model errors remain possible, including proper nouns and Korean syllables.

The combined Matrix check uses peak-normalized playback of the Korean file and seconds 5–8 of the English file. This playback-only transformation selects a continuous English utterance for the bounded half-duplex endpointer and preserves more of the quiet Korean signal. The files and their pinned hashes are unchanged. The original source attribution and licenses continue to apply.

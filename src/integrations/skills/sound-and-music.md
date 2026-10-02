---
name: sound-and-music
description: Use when mixing dialogue, music and sound effects, ducking, cleaning up voices, setting loudness, or choosing and generating music and SFX.
---

# Sound and music

Audio is half the film. Viewers forgive soft pictures; they leave over bad sound.

## Priorities

1. **Dialogue is king.** It must be clear and steady:
   - use enhance/denoise on voice clips (`clip_update` audio);
   - keep levels consistent between speakers and shots;
   - cut out mouth noises and long breaths only when they distract.
2. **Music supports.** It sits well under speech:
   - duck it under dialogue (`duck_music`, about 10–15 dB of reduction, with short, smooth ramps);
   - bring it up in the gaps.
3. **Sound effects add weight to what's on screen:**
   - whooshes on fast moves and transitions;
   - impacts on cuts and text hits;
   - room tone and ambience so silence never sounds like a dropout.

## Levels

- Dialogue peaks around −6 to −3 dBFS. Music under speech sits around −20 to −28 dB; between lines it can rise to around −14.
- Integrated loudness:
  - about −14 LUFS for YouTube and social;
  - −16 for podcasts;
  - −23/−24 for broadcast.
  Measure with analyze_audio; set the export loudness target.
- Fade every audio edit: 2–10 frames at cuts, longer musical fades at the start and end.

## Music editing

- Cut music on the downbeat or at phrase ends. Edits in the middle of a phrase sound like mistakes.
- Find the tempo and beats (detect_beats) and let picture cuts follow the music's structure: intro, build, drop.
- To shorten a track, remove whole bars or phrases and crossfade over 2–6 frames on a beat.
- End on the track's real ending or a clean phrase end with a fade, never a hard cut mid-note.

## Generating

- **Music** (`generate_music`): describe genre, tempo (BPM), mood, instrumentation and structure. For example, "warm lo-fi hip hop, 85 BPM, dusty Rhodes, soft vinyl crackle, no vocals, 60 seconds with a gentle fade-out". Ask for "no vocals" under speech.
- **Sound effects** (`generate_sound_effect` / `add_sound_effect`): describe the source, material, distance and length, e.g. "short soft whoosh, airy, close, 0.4 s".
- **Voiceover** (`list_voices`, `generate_voiceover`): pick a voice that fits the brand. Write for the ear: short sentences, natural rhythm, punctuation for pauses.

## Check

Listen in context: analyze_audio for loudness and silences, and play the section. Make sure no music fights the voice and no levels jump between cuts.

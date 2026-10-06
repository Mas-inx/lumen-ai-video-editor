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

## Sound for motion graphics

A graphic with no sound feels unfinished; a sound a few frames off feels wrong.

- **One cue sheet.** List every visual hit with its timeline time (the clip's start plus the time inside the graphic). Place every sound from that list.
- **Place by the loudest point, not the start.** `at_seconds` is where the sound begins:
  - `pop`, `click`, `hit`, `impact`, `ding`, `shutter`: start on the hit, or 1 frame before it.
  - `whoosh` is loudest about 0.45 s in, `swoosh` about 0.9 s: start them that long before the middle of the move.
  - `riser` peaks at 3.9 s: start it 3.9 s before the hit, and put an `impact` or `hit` on the hit.
  - Generated effects: ask for the length of the move and say where the accent falls ("0.6 s whoosh, loudest at the end").
- **Weight.** The hero moment gets the layered sound (a riser into it, an impact on it). Other hits stay about 6 dB quieter. Never put more than 3 effects on one frame. Vary a run of repeated hits: alternate `pop` and `click`, or drop later ones by 2–3 dB.
- **Music that fits.** Put the tempo in the prompt so beats fall on the cues: BPM = 60 ÷ the seconds between regular hits (0.5 s gives 120). Give the structure in seconds: "builds to 6 s, drop at 6 s, final chord at 8.5 s, 10 s long". Then detect_beats and slide the music so a downbeat sits on the hero moment, or move the cues onto the beats and render again.
- **Level.** Effects sit about 2 dB above the music bed; the music dips about 3 dB under the big hits.
- **Genre.** Take it from the style's "Sound" line in motion-graphic-styles.

## Check

Listen in context: analyze_audio for loudness and silences, and play the section. Make sure no music fights the voice and no levels jump between cuts.

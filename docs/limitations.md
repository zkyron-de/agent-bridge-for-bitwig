# Limitations

What the Controller API cannot do, and Bitwig behavior the bridge works with. Everything here was measured in Bitwig Studio 6.1.7.

## Reach and sizes

The bridge works with fixed windows onto your project, as the Controller API requires.

| What | Limit |
|---|---|
| Main tracks / effect tracks | first 64 / first 16 |
| Sends per track | 8 |
| Devices per track | 32 top-level devices |
| Launcher scenes and slots | 1024 |
| Cue markers | 256 |
| Notes per clip | 4096; read in pages of up to 300 |
| Notes per write or edit request | 750 |
| Clip length and loop | 512 beats; one request covers at most 16384 grid steps |
| Parameters per reply / per change | 200 / 32 |
| Browser results per reply | 200 |
| Scenes per launcher reply | 128 |
| Actions per reply | 200 |
| One reply from Bitwig | 60,000 bytes |

## Not offered

- Arranger clips cannot be edited directly. Launcher clips can be printed into the Arranger with `bitwig_arrange_launcher_clips` (first eight scenes, at most 1024 beats per print).
- Audio clips, automation lanes and per-note pressure. A pressure written through the API does not persist; it is lost when notes are added or changed and on later reads.
- Saving device presets, nesting devices into containers, and devices inside containers: only top-level devices are listed and edited.
- Opening, closing, creating and quitting projects. `bitwig_invoke_action` refuses those actions and answers to open dialogs. `Save` works on a project that has been saved before: it saves without a dialog, and `observedChanges` shows `projectModified` going from `true` to `false`. On a project that was never saved, Bitwig opens its save dialog instead, which only you can answer.
- Devices and launcher clips on effect tracks and the master: device and clip tools work on main tracks only.
- Samples by name. The browser's Devices/Presets/Samples tabs cannot be switched through the API, so samples load only by file path, and only on instrument or hybrid tracks (on an audio track Bitwig would load the file into Convolution as an impulse response).

## Names and identity

- Bitwig numbers default names by position: tracks ("Inst 1" becomes "Inst 2" when a track moves above it) and scenes ("Scene 3"). The name check on an unnamed scene therefore cannot catch a moved scene; name the scenes you work with. Tracks are addressed by id and are not affected.
- Bitwig renames a track that still has its default name when the first instrument or sample lands on it, and back when it goes. Replies report `trackRenamedTo`.
- A scene name cannot be cleared verifiably: the API reports the default "Scene N" for both a cleared and an explicit name.

## Values

- A color counts as set when each channel is within about one 8-bit step of the request. A scene color cannot be reset to "no color": the default gray `#494949` reads back as `#515151`.
- Per-note gain that was never set reads as `gainDb: null`. It plays at 0 dB, but the API reports the same value as for −∞. Track volume and sends report −∞ as `null` too; the lowest level you can set is −120 dB, so use mute or `enabled: false` for silence.
- Velocity 100 is shown as 78.7 % in Bitwig's Inspector; pitch 60 is C3.
- A clip's length is its loop. Note requests cover at most 16384 grid steps (clip span × `stepsPerBeat`).
- Direct device parameters are written in 1/127 steps; remote controls take the full resolution. Some plug-ins report a direct write divided by 16384; the reply names it, and a remote control works instead.

## Browser

- What the browser offers depends on where it opens: instruments at the end of an empty instrument track, audio effects on an audio track, note effects before an instrument.
- Filters are narrowed by the location column (`Devices`, `Presets`, a device's name for its presets, plug-in folders). Device-type and category names follow Bitwig's display language ("Audioeffekt" in German).

## Transport and launcher

- Moving the playhead also moves the play-start marker; while playing, the bridge jumps through the play start because a direct position change is ignored then.
- Stopping the transport turns launcher overdub off. Arranger record switches arranger automation write along with it, as in Bitwig's transport bar. `restart` while stopped starts at beat 0.
- The metronome volume only takes immediate writes; the bridge uses them.
- Launching a clip or scene starts the transport. A launched clip reads `playing` while the transport is stopped. Empty slots and scenes without clips are not launched.

## Actions and selection

- Bitwig does not confirm actions. `bitwig_invoke_action` reports what it saw change in tracks, scenes, selection, transport, undo state and panel layout; view and editor actions usually show nothing there. Action names follow Bitwig's display language; ids do not.
- Device, sample and clip tools select their track for a moment. Your selection comes back afterwards, unless you had the master, an effect track or a track past the first 64 selected.

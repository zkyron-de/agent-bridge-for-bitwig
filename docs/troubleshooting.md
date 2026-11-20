# Troubleshooting

**Tools time out.** Bitwig isn't open, or the controller isn't active. In Bitwig: Settings → Controllers → confirm "Bitwig Agent Bridge" exists and is enabled. `bitwig_status` is the cheapest way to check what the agent sees.

**Requests time out even though Bitwig Agent Bridge is enabled.** The controller script and the MCP server may disagree about the secret, usually because the controller was installed before the current `data/bridge-token`. The bridge ignores requests with the wrong secret without replying, shows a popup in Bitwig the first time, and logs the count. Run setup again (it re-stamps the controller), then reload the controller in Bitwig.

**The controller refuses to start and mentions a missing token.** The repo copy of the controller was installed by hand instead of through setup, so the secret placeholder was never stamped. Run setup; never copy `controller/BitwigAgentBridge.control.js` into Bitwig manually.

**"No track has the id …".** The track was deleted, or it lies beyond the first 64 main or 16 effect tracks the bridge reaches. Track ids stay the same when a track is renamed or moved; list the tracks again with `bitwig_tracks`. Tracks may share a name, and Bitwig renumbers default names such as "Inst 2" when tracks before them move or go away, so use the id, not the name.

**The selected track flickers while a tool runs.** Device, sample and clip tools work through Bitwig's selection, so they select their track for a moment. When the tool finishes, Bitwig Agent Bridge selects your track again, and your device too when the tool worked on that same track. Selection is left alone when your track moved or was deleted, and when you had the master, an effect track or a track past the first 64 selected. `bitwig_create_track` still leaves the new track selected.

**The browser does not offer a device or preset.** Bitwig's browser only lists what fits the insertion point: at the end of an empty instrument track it shows instruments, at the end of an audio track audio effects, before an instrument note effects. Search at the place you want to insert. A location that does not exist there is refused with the list of locations Bitwig offers.

**A sample is not found in the browser.** Bitwig's API cannot switch its browser to the Samples tab, so samples are loaded by file path with `bitwig_insert_sample`.

**A track got renamed after inserting.** Bitwig names a track that still has its default name ("Inst 1") after the first instrument or sample on it. The reply then carries `trackRenamedTo`. The track id stays the same, so tools keep working.

**A direct parameter ends up at a tiny value.** Some plug-ins report a value written through a direct parameter divided by 16384. The reply says so; set that parameter through a remote control instead.

**"Bitwig's answer is … bytes, over the 60000-byte limit for one reply."** Each answer from Bitwig travels in one local network message, capped at 60,000 bytes. Ask for less at once: a smaller `limit`, an `offset`, or a `query` filter.

**"Bitwig could not send the … reply."** macOS refused the message from Bitwig, usually because it was larger than the system allows for one message. Ask for less at once, as above. The Controller Script Console shows the same error with the size.

Still stuck? [Open an issue](https://github.com/zkyron-de/bitwig-agent-bridge/issues/new/choose) with the bug report form.

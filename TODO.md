# TODO / Roadmap — hyprmon

This is a pragmatic roadmap: deliver a usable MVP quickly, then iterate toward “hypr-ish” ergonomics (reorder + resize + optional visuals).

---

## See CHANGELOG.md from project start v0 -> v0.68
At current state v0.68 hyprmon is "daily driveable".

### v0.681-689 Final Touches (?)
- What is missing? 
- Do we have bugs/memory leaks?
- Technical Debt..?
- Windows can be resized "too large" causing other windows not to shrink as small as intended, which may break the tiling behaviour on the workspace. 
- When moving windows from workspace to workspace, occasionally auto-tiling does not correctly resize the window on final target workspace.

### v0.69 Done
- [ ] Done

---

## Technical debt / always-on checklist
- [ ] Avoid event loops (relayout triggering relayout)
- [ ] Throttle relayout under rapid changes
- [ ] Log/diagnostics toggle (debug mode)
- [ ] Unit-test layout engine logic (pure JS tests if possible)
- [ ] Document known limitations (X11, compositor constraints)

---

## “Definition of done” (final vision)
- per-workspace toggleable tiling
- reliable auto-reflow on open/close/move-workspace
- reorder by dragging
- resize with neighbor-aware split ratio updates
- predictable multi-monitor behavior
- no surprise interference with dialogs/popups
- floating windows, sticky windows (stickys staying 'always on top' reliably)
- grow/shrink active window by hotkeys
- change focus/active & swap places with neighbouring tiles by hotkeys
- ?
# Herdr Panels

This note is a Markdown panel. It is loaded from the layout file and refreshed when the file changes.

## This workspace

The **Side by side** layout puts a live Herdr pane next to this note. Drag the divider between them. The new ratio is written back to the layout JSON.

Right-click a panel's title bar to name it, or to turn it into a terminal, a browser, or another note.

## The terminal

The terminal mirrors a Herdr pane. It is not a second PTY: Herdr owns the shell, and this panel sizes that pane to the columns and rows that fit. Text stays at the top, at a fixed size. Right-click the title bar to pick a different pane. Typing here is sent to that pane.

Agent state shows up in the panel header when Herdr reports one.

## Editing

- Layouts live in `layouts/*.json`.
- Notes and HTML panels live next to them, or under a directory listed in `settings.json` `contentRoots`.
- Restart is not required for layout or Markdown edits. A new content root is picked up on the next request; file watching for extra roots starts with the server.

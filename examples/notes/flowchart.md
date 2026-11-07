# Flowchart

A `mermaid` fence in a note is drawn as a diagram. This one is a flowchart.

```mermaid
flowchart LR
  subgraph desk["Desk"]
    Note["Note<br/>Markdown"]
    Term["Terminal<br/>Herdr pane"]
  end
  File["notes/welcome.md"] -.->|"loaded as"| Note
  Herdr["Herdr"] -.->|"owns the shell"| Term
```

The paragraph under the diagram stays text. A fence in another language stays a code block.

```text
notes/flowchart.md
```

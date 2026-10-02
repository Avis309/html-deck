---
description: Open a workspace HTML document (deck, report, page) in the HTML Deck editor
argument-hint: "[file.html]"
---

Open the HTML Deck editor on the current workspace, following the `htmldeck` skill: start it in the
background, read the `HTMLDECK_URL=` line and reply with the URL.

Document to open first: $ARGUMENTS
(If that is empty, start without `--file`.)

---
type: "docs"
title: "Tutorials"
linkTitle: "Tutorials"
weight: 45
description: >
  Hands-on, step-by-step guides for building change-driven applications with the
  @drasi/lib Node.js library.
# These pages are mounted into the Hugo site from the repo-root `tutorials/`
# directory (see website/config.toml [[module.mounts]]). Because the source
# files live outside `website/`, Hugo reports an absolute file path, which would
# break Docsy's "Edit this page" links. Override github_subdir to "" and rewrite
# the absolute path down to its `tutorials/...` tail so the links point at the
# real files. `cascade` applies the same fix to every tutorial page below.
github_subdir: ""
path_base_for_github_subdir:
  from: "^.*/(tutorials/.*)$"
  to: "$1"
cascade:
  github_subdir: ""
  path_base_for_github_subdir:
    from: "^.*/(tutorials/.*)$"
    to: "$1"
---

Work through these tutorials to learn `@drasi/lib` by building complete, runnable
applications. Each tutorial lives in
[`tutorials/`](https://github.com/drasi-project/drasi-nodejs/tree/main/tutorials)
and embeds the Drasi continuous-query engine directly in a Node.js app — real data
sources, continuous queries, and reactions, with no separate server to run.

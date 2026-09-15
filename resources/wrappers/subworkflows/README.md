# subworkflows/

Reserved for agent-facing subworkflow wrappers, following the same layout
as `resources/modules/`:

```text
resources/subworkflows/<provider>/<workflow>/
  main.nf
  meta.yml
  tests/
  wrapper/
    main.nf
    params.json
    wrapper.yaml
```

No subworkflow wrapper exists yet — this directory is scaffolding ahead of
the first one. See docs/design/phi-wrapper-agent-composition-design.md.

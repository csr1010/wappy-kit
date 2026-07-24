# WhatsApp outbound golden payloads (append-only, B4)

One rendered Cloud API `POST /messages` body per SmartMessage shape, generated from
`packages/whatsapp/src/send/render.ts`/`renderReaction`. `render.m4.test.ts` re-renders the same
inputs (see `render.golden.m4.test.ts`) and diffs against these committed files, so a renderer
change that silently alters the wire format is caught. Never hand-edit an existing file; add a new
one instead (see CLAUDE.md).

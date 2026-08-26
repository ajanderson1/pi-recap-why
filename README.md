# pi-recap-why

A concise Pi session recap that regenerates after every completed turn using the active session model. Each recap explains **what happened, why it mattered, and what comes next**.

## Output style

The active session model is instructed to produce one natural, human-readable sentence in this shape:

> Done/Decided/Investigating `<what>` because `<why>`; next, `<action>`.

The recap must cover what happened, why it mattered, and the next direction of travel. Its reason must be supported by the session; when no causal reason is established, it uses the user's goal rather than inventing one.

## Commands

- `/recap` — generate a fresh recap.
- `/recap status` — show active-model and recap state.
- `/recap help` — list commands.

## Model selection

Recaps always use Pi's current active session model. Changing the main session model changes the recap model on the next completed turn.

## Origin

Forked from `@tifan/pi-recap` 0.4.3.

## License

MIT

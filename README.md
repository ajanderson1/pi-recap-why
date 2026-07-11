# pi-recap-why

A concise Pi session recap that explains **what happened and why**, while retaining the original recap extension's session lifecycle, persistence, model picker, and widget behavior.

## Output style

The model prefers:

> Done/Decided/Investigating `<what>` because `<why>`; `<state>`. Next: `<action>`.

The reason must be supported by the session. If no causal reason is established, the recap uses the user's goal or omits the reason rather than inventing a root cause.

## Commands

- `/recap` — generate a fresh recap.
- `/recap status` — show model and recap state.
- `/recap config` — choose the recap model.
- `/recap help` — list commands.

## Configuration

The default model remains `openai-codex/gpt-5.4-mini`. Configure it with `/recap config` or in `~/.config/pi/extensions/pi-recap.json`.

## Origin

Forked from `@tifan/pi-recap` 0.4.3. The customization is intentionally prompt-only; runtime behavior remains otherwise unchanged.

## License

MIT

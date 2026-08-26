import { beforeEach, describe, expect, it, vi } from "vitest"

const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }))

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: completeMock }))

type TestContext = ReturnType<typeof createContext>["ctx"]
type EventHandler = (event: unknown, ctx: TestContext) => unknown

function createContext() {
  const activeModel = { provider: "test-provider", id: "active-model" }
  const messages = [{ role: "user", content: "Recap this session" }]

  return {
    activeModel,
    ctx: {
      hasUI: true,
      model: activeModel,
      modelRegistry: {
        find: vi.fn(),
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({
          ok: true,
          apiKey: "test-key",
        }),
      },
      sessionManager: {
        getBranch: () => [{ id: "turn-1", type: "message" }],
        getLeafId: () => "turn-1",
        buildSessionContext: () => ({ messages }),
      },
      ui: {
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    },
  }
}

async function loadExtension() {
  const events = new Map<string, EventHandler>()
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => unknown }
  >()
  const { default: register } = await import("../src/index.js")

  register({
    on: (name: string, handler: EventHandler) => events.set(name, handler),
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: unknown) => unknown },
    ) => commands.set(name, command),
    appendEntry: vi.fn(),
  } as never)

  return { commands, events }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  completeMock.mockResolvedValue({
    stopReason: "stop",
    content: [{ type: "text", text: "Done: tested the recap; Next: ship it." }],
  })
})

describe("pi-recap-why", () => {
  it("regenerates after each completed turn with the active session model", async () => {
    const { events } = await loadExtension()
    const { activeModel, ctx } = createContext()

    await events.get("session_start")?.({}, ctx)
    completeMock.mockClear()

    await events.get("turn_end")?.({}, ctx)

    expect(completeMock).toHaveBeenCalledTimes(1)
    expect(completeMock.mock.calls[0]?.[0]).toBe(activeModel)
  })

  it("requires a human-readable sentence that says what happened, why, and what is next", async () => {
    const { commands, events } = await loadExtension()
    const { activeModel, ctx } = createContext()
    ctx.modelRegistry.find.mockReturnValue(activeModel)
    ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
      ok: true,
      apiKey: "test-key",
    })
    await events.get("session_start")?.({}, ctx)
    completeMock.mockClear()

    await commands.get("recap")?.handler("", ctx)

    const request = completeMock.mock.calls[0]?.[1] as {
      systemPrompt: string
    }
    expect(request.systemPrompt).toContain("must state what happened")
    expect(request.systemPrompt).toContain("why it mattered")
    expect(request.systemPrompt).toContain("what happens next")
  })
})

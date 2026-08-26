import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { complete, type Message } from "@earendil-works/pi-ai/compat"
import type { ProviderHeaders } from "@earendil-works/pi-ai"
import type { AutocompleteItem } from "@earendil-works/pi-tui"
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent"
import { sanitizeRecapText } from "./sanitize.js"
import {
  clearWidget,
  notifyUser,
  showLoadingWidget,
  showWidget,
} from "./tui.js"

const RECAP_MAX_TOKENS = 160
const RECAP_REQUEST_TIMEOUT_MS = 4_000
const RECAP_ENTRY_TYPE = "pi-recap:state"

interface PersistedRecapState {
  version: 2
  lastRecap: string
  contextLeafId: string | null
}

interface SessionContextReader {
  buildSessionContext(): { messages: AgentMessage[] }
}

function isRecapStateEntry(entry: SessionEntry): boolean {
  return entry.type === "custom" && entry.customType === RECAP_ENTRY_TYPE
}

function getRecapContextLeafId(ctx: ExtensionContext): string | null {
  const contextEntry = ctx.sessionManager
    .getBranch()
    .toReversed()
    .find((entry) => !isRecapStateEntry(entry))

  return contextEntry?.id ?? null
}

const RECAP_SUBCOMMANDS: AutocompleteItem[] = [
  {
    value: "status",
    label: "status",
    description: "Show model and recap status",
  },
  {
    value: "help",
    label: "help",
    description: "List recap commands",
  },
]

const RECAP_SYSTEM_PROMPT = `You write compact recaps for an AI coding-agent session.

Given the current session context, return exactly one natural, human-readable sentence for the user to resume later.
You must state what happened, why it mattered, and what happens next.
Use this shape: Done/Decided/Investigating <what> because <why>; next, <action>.
The reason must be supported by the session: the user's goal, an explicit constraint, a decision rationale, or an evidence-backed root cause. Never invent a reason. If no causal reason is established, use "to <goal>" instead of "because".
Name current state, an important decision, touched file, or blocker only when it helps explain the next direction of travel.
Target 180–240 characters. Stay under 280 characters. Do not add a label or prefix, markdown, or a reference to yourself as "the assistant".

Good: Added session persistence because recaps were lost on restart; next, verify that /recap status restores the latest state.
Bad: Fixed everything because the code was wrong; next, continue.`

interface RecapState {
  sessionActive: boolean
  runId: number
  lastRecap: string
  visible: boolean
  lastRecapCurrent: boolean
  abortController: AbortController | undefined
}

function createRecapState(): RecapState {
  return {
    sessionActive: false,
    runId: 0,
    lastRecap: "",
    visible: false,
    lastRecapCurrent: false,
    abortController: undefined,
  }
}

function abortPendingGeneration(state: RecapState): void {
  state.abortController?.abort()
  state.abortController = undefined
}

function hideRecap(ctx: ExtensionContext, state: RecapState): void {
  state.visible = false
  clearWidget(ctx)
}

function resetRecapSession(ctx: ExtensionContext, state: RecapState): void {
  state.runId++
  state.lastRecap = ""
  state.visible = false
  state.lastRecapCurrent = false
  abortPendingGeneration(state)
  clearWidget(ctx)
}

function extractTextContent(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .filter(
      (item): item is { readonly type: string; readonly text: string } =>
        item.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n")
}

function isPersistedRecapState(data: unknown): data is PersistedRecapState {
  if (!data || typeof data !== "object") return false
  const candidate = data as Partial<PersistedRecapState>
  return (
    candidate.version === 2 &&
    typeof candidate.lastRecap === "string" &&
    (typeof candidate.contextLeafId === "string" ||
      candidate.contextLeafId === null)
  )
}

function restoreRecapState(ctx: ExtensionContext, state: RecapState): void {
  const latestEntry = ctx.sessionManager
    .getBranch()
    .toReversed()
    .find(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RECAP_ENTRY_TYPE &&
        isPersistedRecapState(entry.data),
    )

  if (latestEntry?.type !== "custom") return
  if (!isPersistedRecapState(latestEntry.data)) return

  state.lastRecap = latestEntry.data.lastRecap
  state.lastRecapCurrent =
    latestEntry.id === ctx.sessionManager.getLeafId() &&
    latestEntry.data.contextLeafId === getRecapContextLeafId(ctx)
}

function showRestoredRecap(ctx: ExtensionContext, state: RecapState): boolean {
  if (!state.lastRecap || !state.lastRecapCurrent) return false

  state.visible = true
  showWidget(ctx, state.lastRecap)
  return true
}

function persistRecapState(
  pi: ExtensionAPI,
  state: RecapState,
  contextLeafId: string | null,
): void {
  pi.appendEntry<PersistedRecapState>(RECAP_ENTRY_TYPE, {
    version: 2,
    lastRecap: state.lastRecap,
    contextLeafId,
  })
}

function hasSessionContextReader(
  value: unknown,
): value is SessionContextReader {
  return (
    typeof value === "object" &&
    value !== null &&
    "buildSessionContext" in value &&
    typeof value.buildSessionContext === "function"
  )
}

function getCurrentSessionMessages(
  ctx: ExtensionContext,
  contextLeafId: string | null,
): AgentMessage[] {
  if (
    contextLeafId === ctx.sessionManager.getLeafId() &&
    hasSessionContextReader(ctx.sessionManager)
  ) {
    return ctx.sessionManager.buildSessionContext().messages
  }

  return buildSessionContext(ctx.sessionManager.getEntries(), contextLeafId)
    .messages
}

async function getActiveSessionModelAuth(
  ctx: ExtensionContext,
): Promise<
  | {
      readonly model: NonNullable<ExtensionContext["model"]>
      readonly apiKey: string
      readonly headers: ProviderHeaders | undefined
    }
  | undefined
> {
  if (!ctx.model) return undefined

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model)
  if (!auth.ok || !auth.apiKey) return undefined

  return { model: ctx.model, apiKey: auth.apiKey, headers: auth.headers }
}

function buildPrompt(messages: AgentMessage[]): Message {
  const conversationText = serializeConversation(convertToLlm(messages))
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: ["## Current Session Context", conversationText].join("\n"),
      },
    ],
    timestamp: Date.now(),
  }
}

async function generateRecap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: RecapState,
  options: { manual: boolean },
): Promise<void> {
  if (!ctx.hasUI) return

  const contextLeafId = getRecapContextLeafId(ctx)
  const messages = getCurrentSessionMessages(ctx, contextLeafId)
  if (messages.length === 0) {
    if (options.manual) notifyUser(ctx, "No conversation to recap yet.", "info")
    return
  }

  if (options.manual) showLoadingWidget(ctx)

  const runId = state.runId
  const auth = await getActiveSessionModelAuth(ctx)
  if (runId !== state.runId || !state.sessionActive) return

  if (!auth) {
    if (options.manual) {
      clearWidget(ctx)
      notifyUser(ctx, "No authenticated active session model.", "error")
    }
    return
  }

  const abortController = new AbortController()
  abortPendingGeneration(state)
  state.abortController = abortController

  try {
    const response = await complete(
      auth.model,
      {
        systemPrompt: RECAP_SYSTEM_PROMPT,
        messages: [buildPrompt(messages)],
      },
      {
        apiKey: auth.apiKey,
        ...(auth.headers ? { headers: auth.headers } : {}),
        maxTokens: RECAP_MAX_TOKENS,
        maxRetries: 0,
        cacheRetention: "none",
        timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
        signal: abortController.signal,
      },
    )

    if (runId !== state.runId || !state.sessionActive) return
    if (response.stopReason !== "stop") {
      if (options.manual) {
        clearWidget(ctx)
        notifyUser(ctx, "Recap generation failed.", "error")
      }
      return
    }

    const recap = sanitizeRecapText(extractTextContent(response.content))
    if (!recap) {
      if (options.manual) {
        clearWidget(ctx)
        notifyUser(ctx, "Recap generation returned empty text.", "error")
      }
      return
    }

    state.lastRecap = recap
    state.visible = true
    persistRecapState(pi, state, contextLeafId)
    state.lastRecapCurrent = true
    showWidget(ctx, recap)
  } catch {
    if (options.manual) {
      clearWidget(ctx)
      notifyUser(ctx, "Recap generation failed.", "error")
    }
    // Automatic recaps are best-effort. Keep the previous recap on transient failures.
  } finally {
    if (state.abortController === abortController) {
      state.abortController = undefined
    }
  }
}

function isRecapCommand(text: string): boolean {
  return /^\/recap(?:\s|$)/u.test(text.trimStart())
}

function getRecapArgumentCompletions(
  prefix: string,
): AutocompleteItem[] | null {
  const query = prefix.trimStart().toLowerCase()
  const items = RECAP_SUBCOMMANDS.filter((item) => item.value.startsWith(query))
  return items.length > 0 ? items : null
}

function registerRecapCommand(pi: ExtensionAPI, state: RecapState): void {
  pi.registerCommand("recap", {
    description: "generate a one-line session recap",
    getArgumentCompletions: getRecapArgumentCompletions,
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/u)[0]?.toLowerCase() ?? ""

      if (!action) {
        await generateRecap(pi, ctx, state, { manual: true })
        return
      }

      if (action === "help") {
        notifyUser(
          ctx,
          [
            "pi-recap commands",
            "/recap - generate and show a fresh recap",
            "/recap status - show active-model and recap status",
            "/recap help - show this help",
          ].join("\n"),
          "info",
        )
        return
      }

      if (action === "status") {
        await notifyRecapStatus(ctx, state)
        return
      }

      notifyUser(ctx, "Use /recap [help|status]", "error")
    },
  })
}

async function notifyRecapStatus(
  ctx: ExtensionContext,
  state: RecapState,
): Promise<void> {
  const activeModelLine = ctx.model
    ? `active model: ${ctx.model.provider}/${ctx.model.id}`
    : "active model: none"

  const lastRecapStatus = state.lastRecap
    ? state.lastRecapCurrent
      ? "current"
      : "stale"
    : "none"
  const lastRecapLine = `last recap: ${lastRecapStatus}`
  const visibleLine = `visible: ${state.visible ? "yes" : "no"}`
  notifyUser(
    ctx,
    [
      "pi-recap status",
      "recap model: active session model",
      activeModelLine,
      lastRecapLine,
      visibleLine,
    ].join("\n"),
    "info",
  )
}

export default function (pi: ExtensionAPI): void {
  const state = createRecapState()

  registerRecapCommand(pi, state)

  pi.on("session_start", (_event, ctx) => {
    state.sessionActive = true
    resetRecapSession(ctx, state)
    restoreRecapState(ctx, state)

    showRestoredRecap(ctx, state)
  })

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const }

    if (!isRecapCommand(event.text)) {
      state.lastRecapCurrent = false
      hideRecap(ctx, state)
    }

    return { action: "continue" as const }
  })

  pi.on("agent_start", (_event, ctx) => {
    state.runId++
    state.lastRecapCurrent = false
    abortPendingGeneration(state)
    hideRecap(ctx, state)
  })

  pi.on("turn_end", async (_event, ctx) => {
    if (!state.sessionActive) return
    await generateRecap(pi, ctx, state, { manual: false })
  })

  pi.on("session_shutdown", (_event, ctx) => {
    state.sessionActive = false
    resetRecapSession(ctx, state)
  })
}

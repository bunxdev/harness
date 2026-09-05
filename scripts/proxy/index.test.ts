import { describe, expect, test } from "bun:test"
import {
  handler,
  nonStreamingResponse,
  preparePrompt,
  streamingResponse,
} from "./index"
import { getDiscoverableModels, MODEL_ROUTES, resolveModel } from "./routes"

const gatewayHeaders = {
  authorization: "Bearer sk-ant-opencode-internal",
}

describe("model registry", () => {
  test("advertises only Claude-compatible aliases", () => {
    const models = getDiscoverableModels()

    expect(models).toHaveLength(7)
    expect(models.every(({ id }) => id.includes("claude"))).toBe(true)
    expect(models.map(({ id }) => id)).toEqual(MODEL_ROUTES.map(({ id }) => id))
  })

  test("resolves aliases without allowing arbitrary upstream models", () => {
    expect(resolveModel("sonnet")?.upstreamModel).toBe(
      "nemotron-3.5-lightning-free",
    )
    expect(resolveModel("claude-opus-5")?.upstreamModel).toBe(
      "nemotron-3-ultra-free",
    )
    expect(resolveModel("gpt-5.6-sol")).toBeUndefined()
  })
})

describe("Anthropic request conversion", () => {
  test("preserves tool calls and converts their results", () => {
    const prompt = preparePrompt({
      messages: [
        { role: "user", content: "Check Lima" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_weather",
              name: "get_weather",
              input: { city: "Lima" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_weather",
              content: "20 C",
            },
          ],
        },
      ],
      system: [{ type: "text", text: "Be concise" }],
    })

    expect(prompt.system).toBe("Be concise")
    expect(prompt.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Check Lima" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_weather",
            toolName: "get_weather",
            input: { city: "Lima" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_weather",
            toolName: "get_weather",
            output: { type: "text", value: "20 C" },
          },
        ],
      },
    ])
  })

  test("preserves multimodal tool results", () => {
    const prompt = preparePrompt({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_image",
              name: "read_image",
              input: { path: "image.png" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_image",
              content: [
                { type: "text", text: "Screenshot" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "aW1hZ2U=",
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    expect(prompt.hasToolResultAttachments).toBe(true)
    expect(prompt.hasUserAttachments).toBe(false)
    expect(prompt.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_image",
          toolName: "read_image",
          output: {
            type: "content",
            value: [
              { type: "text", text: "Screenshot" },
              {
                type: "image-data",
                data: "aW1hZ2U=",
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    })
  })

  test("flattens text-only tool result arrays for Chat transports", () => {
    const prompt = preparePrompt({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_text",
              name: "read_file",
              input: { path: "notes.txt" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_text",
              content: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
            },
          ],
        },
      ],
    })

    expect(prompt.hasToolResultAttachments).toBe(false)
    expect(prompt.messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_text",
          toolName: "read_file",
          output: { type: "text", value: "first\nsecond" },
        },
      ],
    })
  })
})

describe("HTTP contract", () => {
  test("does not require credentials for health checks", async () => {
    const response = await handler(new Request("http://gateway/health"))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("requires a gateway credential for model discovery", async () => {
    const response = await handler(new Request("http://gateway/v1/models?limit=1000"))

    expect(response.status).toBe(401)
  })

  test("returns the discovery schema expected by Claude Code", async () => {
    const response = await handler(
      new Request("http://gateway/v1/models?limit=1000", {
        headers: gatewayHeaders,
      }),
    )
    const body = (await response.json()) as { data: unknown[] }

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(7)
  })

  test("rejects models outside the free allowlist before contacting upstream", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Model gpt-5.6-sol is not available",
      },
    })
  })

  test("returns 400 for malformed JSON", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: "{",
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Request body must contain valid JSON",
      },
    })
  })

  test("reports that Zen cannot prewarm with max_tokens zero", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opencode-nemotron-3.5-lightning-free",
          max_tokens: 0,
          messages: [{ role: "user", content: "prewarm" }],
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(
      "OpenCode Zen does not support max_tokens 0 cache prewarming",
    )
  })

  test("rejects duplicate tool names without contacting upstream", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opencode-nemotron-3.5-lightning-free",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
          tools: [
            { name: "read", input_schema: { type: "object" } },
            { name: "read", input_schema: { type: "object" } },
          ],
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Duplicate tool name: read")
  })

  test("rejects unsupported forced tool choice for Responses models", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opencode-muse-spark-1.3-contributor-free",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
          tools: [{ name: "read", input_schema: { type: "object" } }],
          tool_choice: { type: "any" },
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain("supports only auto or none tool_choice")
  })

  test("rejects multimodal tool results for Chat transports", async () => {
    const response = await handler(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: {
          ...gatewayHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opencode-mimo-v2.5-free",
          max_tokens: 16,
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_image",
                  name: "read_image",
                  input: {},
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_image",
                  content: [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "aW1hZ2U=",
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain(
      "does not support attachments in tool results",
    )
  })

  test("maps output_config JSON schemas to Responses text.format", async () => {
    const originalFetch = globalThis.fetch
    let outboundBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: "resp_structured",
          created_at: 1,
          model: "muse-spark-1.3-contributor-free",
          output: [
            {
              type: "message",
              role: "assistant",
              id: "message_structured",
              content: [
                {
                  type: "output_text",
                  text: '{"title":"Gateway title"}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: {
            input_tokens: 4,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    try {
      const schema = {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      }
      const response = await handler(
        new Request("http://gateway/v1/messages", {
          method: "POST",
          headers: {
            ...gatewayHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opencode-muse-spark-1.3-contributor-free",
            max_tokens: 16,
            messages: [{ role: "user", content: "Create a title" }],
            output_config: {
              effort: "low",
              format: { type: "json_schema", schema },
            },
            tools: [
              {
                name: "lookup",
                input_schema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                strict: true,
              },
            ],
            tool_choice: { type: "auto", disable_parallel_tool_use: true },
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect(outboundBody).toMatchObject({
        parallel_tool_calls: false,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            name: "response",
            schema,
          },
        },
        tools: [{ type: "function", name: "lookup", strict: true }],
      })
      expect(await response.text()).toContain('\\"title\\":\\"Gateway title\\"')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("forwards Chat effort, strict tools, and disabled parallel calls", async () => {
    const originalFetch = globalThis.fetch
    let outboundBody: Record<string, unknown> | undefined
    let outboundHeaders: Headers | undefined
    globalThis.fetch = (async (_input, init) => {
      outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      outboundHeaders = new Headers(init?.headers)
      return new Response(
        JSON.stringify({
          id: "chat_options",
          created: 1,
          model: "nemotron-3.5-lightning-free",
          choices: [
            {
              message: { role: "assistant", content: "OPTIONS_OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    try {
      const response = await handler(
        new Request("http://gateway/v1/messages", {
          method: "POST",
          headers: {
            ...gatewayHeaders,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opencode-nemotron-3.5-lightning-free",
            max_tokens: 16,
            messages: [{ role: "user", content: "Use the options" }],
            output_config: { effort: "low" },
            tools: [
              {
                name: "read",
                description: "Read a value",
                input_schema: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                  additionalProperties: false,
                },
                strict: true,
              },
            ],
            tool_choice: { type: "auto", disable_parallel_tool_use: true },
          }),
        }),
      )

      expect(response.status).toBe(200)
      expect(outboundBody).toMatchObject({
        reasoning_effort: "low",
        parallel_tool_calls: false,
        tools: [
          {
            type: "function",
            function: { name: "read", strict: true },
          },
        ],
      })
      expect(outboundHeaders?.has("x-gateway-disable-parallel-tools")).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test("does not expose provider reasoning in non-streaming responses", () => {
  const response = nonStreamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    {
      text: "private reasoningVISIBLE",
      reasoningText: "private reasoning",
      finishReason: "stop",
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "private reasoningVISIBLE" },
      ],
      usage: {
        inputTokens: 2,
        inputTokenDetails: {},
        outputTokens: 3,
        outputTokenDetails: { reasoningTokens: 2 },
      },
    } as never,
  )

  expect(response.content).toEqual([{ type: "text", text: "VISIBLE" }])
})

test("rejects invalid model-generated tool input", () => {
  expect(() =>
    nonStreamingResponse("claude-opencode-nemotron-3.5-lightning-free", {
      text: "",
      reasoningText: undefined,
      finishReason: "tool-calls",
      content: [
        {
          type: "tool-call",
          toolCallId: "toolu_bad",
          toolName: "read",
          input: "not-an-object",
          invalid: true,
        },
      ],
      usage: {
        inputTokens: 2,
        inputTokenDetails: {},
        outputTokens: 3,
        outputTokenDetails: {},
      },
    } as never),
  ).toThrow("Model returned invalid input for tool read")
})

test("preserves non-streaming text and tool block order", () => {
  const response = nonStreamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    {
      text: "beforeafter",
      reasoningText: undefined,
      finishReason: "stop",
      content: [
        { type: "text", text: "before" },
        {
          type: "tool-call",
          toolCallId: "toolu_one",
          toolName: "first_tool",
          input: { value: 1 },
        },
        {
          type: "tool-call",
          toolCallId: "toolu_two",
          toolName: "second_tool",
          input: { value: 2 },
        },
        { type: "text", text: "after" },
      ],
      usage: {
        inputTokens: 2,
        inputTokenDetails: {},
        outputTokens: 3,
        outputTokenDetails: {},
      },
    } as never,
  )

  expect(response.content.map((part) => part.type)).toEqual([
    "text",
    "tool_use",
    "tool_use",
    "text",
  ])
})

test("translates normalized stream parts to Anthropic SSE", async () => {
  async function* fullStream() {
    yield { type: "start" }
    yield { type: "text-start", id: "text-1" }
    yield { type: "text-delta", id: "text-1", text: "hello" }
    yield { type: "text-end", id: "text-1" }
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        inputTokens: 4,
        inputTokenDetails: {
          noCacheTokens: 3,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
        },
        outputTokens: 1,
        outputTokenDetails: { reasoningTokens: 0 },
      },
    }
  }

  const response = streamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    { fullStream: fullStream() } as never,
  )
  const events = await response.text()

  expect(events).toContain("event: message_start")
  expect(events).toContain(
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  )
  expect(events).toContain('"stop_reason":"end_turn"')
  expect(events).toContain('"input_tokens":3')
  expect(events).toContain('"cache_read_input_tokens":1')
  expect(events).toContain("event: message_stop")
})

test("does not duplicate provider reasoning into streamed text", async () => {
  async function* fullStream() {
    yield { type: "start" }
    yield { type: "reasoning-start", id: "reasoning-1" }
    yield { type: "reasoning-delta", id: "reasoning-1", text: "private reasoning" }
    yield { type: "reasoning-end", id: "reasoning-1" }
    yield { type: "text-start", id: "text-1" }
    yield { type: "text-delta", id: "text-1", text: "private reasoning" }
    yield { type: "text-delta", id: "text-1", text: "VISIBLE" }
    yield { type: "text-end", id: "text-1" }
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        inputTokens: 2,
        inputTokenDetails: {},
        outputTokens: 3,
        outputTokenDetails: { reasoningTokens: 2 },
      },
    }
  }

  const response = streamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    { fullStream: fullStream() } as never,
  )
  const events = await response.text()

  expect(events).not.toContain("private reasoning")
  expect(events).toContain('"text":"VISIBLE"')
})

test("closes each streamed block before starting the next", async () => {
  async function* fullStream() {
    yield { type: "start" }
    yield { type: "text-start", id: "text-1" }
    yield { type: "text-delta", id: "text-1", text: "before" }
    yield {
      type: "tool-call",
      toolCallId: "toolu_one",
      toolName: "first_tool",
      input: { value: 1 },
    }
    yield {
      type: "tool-call",
      toolCallId: "toolu_two",
      toolName: "second_tool",
      input: { value: 2 },
    }
    yield { type: "text-delta", id: "text-1", text: "after" }
    yield { type: "text-end", id: "text-1" }
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        inputTokens: 2,
        inputTokenDetails: {},
        outputTokens: 3,
        outputTokenDetails: {},
      },
    }
  }

  const response = streamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    { fullStream: fullStream() } as never,
  )
  const rawEvents = await response.text()
  const events = rawEvents
    .trim()
    .split("\n\n")
    .map((event) => {
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice(6)
      return JSON.parse(data) as {
        type: string
        index?: number
        content_block?: { type: string }
      }
    })
    .filter((event) => event.type.startsWith("content_block_"))
    .map((event) =>
      event.type === "content_block_start"
        ? `${event.type}:${event.index}:${event.content_block?.type}`
        : `${event.type}:${event.index}`,
    )

  expect(events).toEqual([
    "content_block_start:0:text",
    "content_block_delta:0",
    "content_block_stop:0",
    "content_block_start:1:tool_use",
    "content_block_delta:1",
    "content_block_stop:1",
    "content_block_start:2:tool_use",
    "content_block_delta:2",
    "content_block_stop:2",
    "content_block_start:3:text",
    "content_block_delta:3",
    "content_block_stop:3",
  ])
})

test("aborts upstream work when a streaming client disconnects", async () => {
  let releaseStream: () => void = () => {}
  let closeStream: () => void = () => {}
  let aborted = false
  const released = new Promise<void>((resolve) => {
    releaseStream = resolve
  })
  const closed = new Promise<void>((resolve) => {
    closeStream = resolve
  })

  async function* fullStream() {
    yield { type: "start" }
    await released
    yield {
      type: "finish",
      finishReason: "stop",
      totalUsage: {
        inputTokens: 1,
        inputTokenDetails: {},
        outputTokens: 1,
        outputTokenDetails: {},
      },
    }
  }

  const response = streamingResponse(
    "claude-opencode-nemotron-3.5-lightning-free",
    { fullStream: fullStream() } as never,
    {
      onCancel() {
        aborted = true
        releaseStream()
      },
      onClose: closeStream,
    },
  )
  const reader = response.body!.getReader()

  await reader.read()
  await reader.cancel()
  await closed

  expect(aborted).toBe(true)
})

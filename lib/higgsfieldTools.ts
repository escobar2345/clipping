// Higgsfield tool adapter. Converts Higgsfield tools (provided by the CLI
// driver — the Higgsfield CLI installed via `npm i -g @higgsfield/cli` and
// signed in with `higgsfield auth login`) into OpenAI-compatible function
// definitions that the NVIDIA GLM model can call via the standard tool_use /
// function_calling protocol.
//
// When the GLM model emits a tool call, this module routes it to the Higgsfield
// CLI, collects the result (which is a URL to generated media), and returns it
// in the format the model expects.
import {
  listHiggsfieldTools,
  callHiggsfieldTool,
  type McpTool,
} from "./higgsfieldMcp";

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

export interface ToolCallRequest {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResponse {
  tool_call_id: string;
  role: "tool";
  content: string;
}

/**
 * Convert MCP tools to OpenAI function calling format.
 * Higgsfield tools become functions the GLM model can call.
 */
export async function getHiggsfieldToolDefinitions(): Promise<OpenAITool[]> {
  const tools = await listHiggsfieldTools();
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Execute a single tool call from the GLM model against Higgsfield MCP.
 * Returns a tool response message to append to the conversation.
 *
 * The result content is serialized as a string (JSON when possible, raw text
 * otherwise) so it fits the OpenAI tool response format.
 */
export async function executeToolCall(
  call: ToolCallRequest
): Promise<ToolCallResponse> {
  let args: Record<string, any> = {};
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    // Model sent malformed arguments — return error so it can retry
    return {
      tool_call_id: call.id,
      role: "tool",
      content: JSON.stringify({
        error: "Malformed arguments — could not parse as JSON.",
        raw: call.function.arguments,
      }),
    };
  }

  const result = await callHiggsfieldTool(call.function.name, args);

  // Serialize the MCP result into a string for the model
  let content: string;
  if (result.isError) {
    content = JSON.stringify({
      error: true,
      messages: result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
    });
  } else {
    // Extract useful content — prefer structured JSON, fall back to text
    const textParts = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);

    const dataParts = result.content.filter(
      (c) => c.type === "image" || (c.type === "resource" && c.data)
    );

    if (textParts.length === 1) {
      // Single text response — could be a URL, JSON, or plain text
      const txt = textParts[0].trim();
      // Try to parse as JSON for structured responses
      try {
        const parsed = JSON.parse(txt);
        content = JSON.stringify(parsed);
      } catch {
        // Not JSON — return as-is (likely a URL or status message)
        content = txt;
      }
    } else if (textParts.length > 1) {
      content = JSON.stringify({ results: textParts });
    } else if (dataParts.length > 0) {
      // Binary data (base64-encoded image/video)
      content = JSON.stringify({
        data: dataParts.map((d: any) => ({
          type: d.mimeType || "application/octet-stream",
          data: d.data,
        })),
      });
    } else {
      content = JSON.stringify({ status: "completed", raw: result.content });
    }
  }

  return {
    tool_call_id: call.id,
    role: "tool",
    content,
  };
}

/**
 * Execute multiple tool calls in parallel (the model may batch them).
 */
export async function executeToolCalls(
  calls: ToolCallRequest[]
): Promise<ToolCallResponse[]> {
  return Promise.all(calls.map((c) => executeToolCall(c)));
}

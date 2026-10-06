// NVIDIA GLM tool-use loop. Extends the edit-plan generation so the GLM model
// can call Higgsfield MCP tools mid-generation â€” requesting AI-generated
// video clips, images, effects, upscaling, etc. as part of composing the
// short-form edit plan.
//
// How it works:
//   1. The model is given the standard edit-plan prompt PLUS Higgsfield tools
//   2. If the model returns tool_calls instead of a final answer, we execute
//      them against Higgsfield MCP and feed the results back
//   3. The loop repeats until the model emits its final edit plan (no more
//      tool_calls) or we hit the max-rounds safety cap
import OpenAI from "openai";
import { generateEditPlan as generateBaseEditPlan } from "./nvidiaGlm";
import {
  getHiggsfieldToolDefinitions,
  executeToolCalls,
  type OpenAITool,
  type ToolCallRequest,
} from "./higgsfieldTools";
import {
  DEFAULT_EDIT_SYSTEM_PROMPT,
  getSavedSystemPrompt,
} from "./prompts";
import type { VideoIntel, EditRules, StyleProfile, EditPlan } from "./types";

const HIGGSFIELD_SYSTEM_ADDON = `

---
You have access to Higgsfield AI tools for generating supplementary media
(video clips, images, effects) to enhance the short-form clips you create.

TOOLS AVAILABLE:
- Generate AI video clips (B-roll, backgrounds, transitions, visual effects)
- Generate AI images (overlays, title cards, backgrounds)
- Upscale existing footage to higher resolution
- Remove or replace backgrounds
- Reframe footage to different aspect ratios

WHEN TO USE THEM:
- When a clip would benefit from B-roll footage to fill gaps
- When you need a background image or video for a clip
- When you need visual effects (explosions, transitions, overlays)
- When upscaling low-quality source footage
- When removing/replacing backgrounds for cleaner composition

HOW TO USE THEM:
- Call the appropriate tool with a clear, descriptive prompt
- Reference the clipId so generated assets can be matched to clips
- Wait for tool results before finalizing the edit plan
- Include generated asset references in your final edit plan JSON

OUTPUT FORMAT: When using tools, your final edit plan should include a
"generatedAssets" array listing each asset generated:

type GeneratedAsset = {
  assetId: string;
  type: "video" | "image";
  url: string;
  prompt: string;
  toolUsed: string;
  clipIndex?: number;
  purpose: "broll" | "background" | "overlay" | "effect" | "upscale";
};

And clips can reference assets via generatedAssetIds:
type ClipPlan = {
  // ... standard fields ...
  generatedAssetIds?: string[];
};
`;

export interface ToolRound {
  round: number;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, any>;
    result: any;
  }>;
}

export interface EditPlanWithToolsResult {
  editPlan: EditPlan;
  toolRounds: ToolRound[];
  higgsfieldAvailable: boolean;
}

/**
 * Generate an edit plan with optional Higgsfield tool-use loop.
 * If Higgsfield is configured (CLI installed + `higgsfield auth login`), the
 * GLM model can call Higgsfield tools during plan generation. If not
 * configured, this falls back to the standard generateEditPlan.
 */
export async function generateEditPlanWithHiggsfield(
  intel: VideoIntel,
  rules: EditRules,
  styleProfile?: StyleProfile,
  systemPrompt?: string,
  visualContext?: any,
  enableHiggsfield = true,
  maxRounds = 5,
  targetPlatforms?: string[]
): Promise<EditPlanWithToolsResult> {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      "NVIDIA_API_KEY is not set in your environment â€” get a key at build.nvidia.com"
    );
  }

  const hfTools: OpenAITool[] = enableHiggsfield
    ? await getHiggsfieldToolDefinitions()
    : [];

  const higgsfieldAvailable = hfTools.length > 0;

  if (!higgsfieldAvailable) {
    const editPlan = await generateBaseEditPlan(
      intel,
      rules,
      styleProfile,
      systemPrompt,
      visualContext,
      targetPlatforms
    );
    return { editPlan, toolRounds: [], higgsfieldAvailable: false };
  }

  const basePrompt = systemPrompt?.trim() || getSavedSystemPrompt() || DEFAULT_EDIT_SYSTEM_PROMPT;
  const fullSystemPrompt = basePrompt + HIGGSFIELD_SYSTEM_ADDON;

  const userPayload = {
    title: intel.title,
    durationSec: intel.durationSec,
    transcript: intel.transcript,
    rules,
    targetPlatforms: targetPlatforms ?? null,
    styleProfile: styleProfile ?? null,
    visualContext: visualContext
      ? {
          sceneCuts: visualContext.sceneCuts,
          frameNotes: visualContext.frameNotes,
        }
      : null,
    higgsfield: {
      available: true,
      capabilities: hfTools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
      })),
      note: "You MAY call Higgsfield tools to generate supplementary media. The tool results will be fed back to you. After all tools have completed, respond with the final EditPlan JSON only.",
    },
  };

  const client = new OpenAI({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    timeout: 180_000,
    maxRetries: 0,
  });

  const model = process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
  const messages: any[] = [
    { role: "system", content: fullSystemPrompt },
    { role: "user", content: JSON.stringify(userPayload) },
  ];

  const toolRounds: ToolRound[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.4,
      messages,
      tools: hfTools,
      tool_choice: "auto",
    });

    const assistantMsg = response.choices[0]?.message;
    if (!assistantMsg) {
      throw new Error("GLM returned an empty response â€” no message in choices.");
    }

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const raw = (assistantMsg.content ?? "{}").replace(/```json|```/g, "").trim();
      let editPlan: EditPlan;
      try {
        const parsed = JSON.parse(raw);
        editPlan = {
          sourceVideoPath: intel.videoFilePath,
          sourceUrl: intel.sourceUrl,
          clips: parsed.clips || [],
          generatedAssets: parsed.generatedAssets || [],
        };
      } catch (err) {
        throw new Error(`GLM final response was not valid JSON edit plan: ${String(err)}`);
      }
      return { editPlan, toolRounds, higgsfieldAvailable: true };
    }

    const toolCallRequests: ToolCallRequest[] = assistantMsg.tool_calls.map(
      (tc: any) => ({
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      })
    );

    messages.push({
      role: "assistant",
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    const toolResponses = await executeToolCalls(toolCallRequests);

    const roundRecord: ToolRound = {
      round: round + 1,
      toolCalls: toolCallRequests.map((req, i) => ({
        name: req.function.name,
        arguments: safeParseArgs(req.function.arguments),
        result: safeParseContent(toolResponses[i]?.content),
      })),
    };
    toolRounds.push(roundRecord);

    for (const resp of toolResponses) {
      messages.push(resp);
    }
  }

  messages.push({
    role: "user",
    content: "You have reached the maximum number of tool calls. Please now respond ONLY with the final EditPlan JSON â€” no more tool calls.",
  });

  const finalResponse = await client.chat.completions.create({
    model,
    temperature: 0.4,
    messages,
  });

  const raw = (finalResponse.choices[0]?.message?.content ?? "{}")
    .replace(/```json|```/g, "")
    .trim();

  let editPlan: EditPlan;
  try {
    const parsed = JSON.parse(raw);
    editPlan = {
      sourceVideoPath: intel.videoFilePath,
      sourceUrl: intel.sourceUrl,
      clips: parsed.clips || [],
      generatedAssets: parsed.generatedAssets || [],
    };
  } catch (err) {
    throw new Error(`GLM final response (after max rounds) was not valid JSON: ${String(err)}`);
  }

  return { editPlan, toolRounds, higgsfieldAvailable: true };
}

function safeParseArgs(args: string): any {
  try { return JSON.parse(args); } catch { return args; }
}

function safeParseContent(content: string): any {
  try { return JSON.parse(content); } catch { return content; }
}

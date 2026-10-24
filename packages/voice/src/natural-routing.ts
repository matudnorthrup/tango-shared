import {
  extractInlineTopicReference,
  parseSharedTopicSystemCommand,
} from "./topic-routing.js";
import {
  isStrongAddressMatch,
  type ResolvedVoiceAddress,
  stripLeadingWakePhrase,
  type VoiceTargetDirectory,
} from "./address-routing.js";
import { parseSharedProjectSystemCommand } from "./project-routing.js";
import { parseSharedSystemRoutingCommand } from "./system-routing.js";

export type NaturalTextSystemCommand =
  | { type: "status" }
  | { type: "focus-agent"; agentQuery: string }
  | { type: "clear-focus" }
  | { type: "current-agent" }
  | {
      type: "open-topic";
      topicName: string;
      projectName: string | null;
      standalone: boolean;
    }
  | { type: "move-topic-to-project"; topicName: string | null; projectName: string }
  | { type: "detach-topic-from-project"; topicName: string | null }
  | { type: "current-topic" }
  | { type: "clear-topic" }
  | { type: "open-project"; projectName: string }
  | { type: "current-project" }
  | { type: "clear-project" };

export interface NaturalTextRoute {
  explicitAddress: ResolvedVoiceAddress | null;
  promptText: string;
  addressedAgentId: string | null;
  topicName: string | null;
  /** True when the inline topic used the explicit "topic" keyword ("on topic X: ..."). */
  topicExplicit: boolean;
  /** Prompt text before the inline-topic prefix was stripped (equals promptText when no topic matched). */
  promptTextBeforeTopicStrip: string;
  systemCommand: NaturalTextSystemCommand | null;
}

function parseSystemCommand(promptText: string): NaturalTextSystemCommand | null {
  const normalized = promptText
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!?,]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  if (normalized === "status") {
    return { type: "status" };
  }

  const routingCommand = parseSharedSystemRoutingCommand(normalized);
  if (routingCommand) {
    return routingCommand;
  }

  const topicCommand = parseSharedTopicSystemCommand(promptText);
  if (topicCommand) {
    return topicCommand;
  }

  const projectCommand = parseSharedProjectSystemCommand(promptText);
  if (projectCommand) {
    return projectCommand;
  }

  return null;
}

function resolvePromptTopic(promptText: string): {
  topicName: string | null;
  promptText: string;
  topicExplicit: boolean;
  promptTextBeforeTopicStrip: string;
} {
  const inlineTopic = extractInlineTopicReference(promptText);
  if (!inlineTopic) {
    return {
      topicName: null,
      promptText,
      topicExplicit: false,
      promptTextBeforeTopicStrip: promptText,
    };
  }

  return {
    topicName: inlineTopic.topicName,
    promptText: inlineTopic.promptText,
    topicExplicit: inlineTopic.usedTopicKeyword,
    promptTextBeforeTopicStrip: promptText,
  };
}

export function parseNaturalTextRoute(input: {
  text: string;
  voiceTargets: VoiceTargetDirectory;
  focusedAgentId?: string | null;
}): NaturalTextRoute {
  const text = input.text.trim();
  const resolvedAddress = input.voiceTargets.resolveExplicitAddress(text);
  const explicitAddress =
    resolvedAddress?.kind === "agent" &&
    !isStrongAddressMatch(resolvedAddress.matchedName, resolvedAddress.transcript)
      ? null
      : resolvedAddress;
  const focusedAgentId = input.focusedAgentId?.trim() || null;

  if (!explicitAddress) {
    return {
      explicitAddress: null,
      ...resolvePromptTopic(text),
      addressedAgentId: focusedAgentId,
      systemCommand: null,
    };
  }

  const promptText = stripLeadingWakePhrase(explicitAddress.transcript, explicitAddress.agent.callSigns);

  if (explicitAddress.kind === "system") {
    const systemCommand = parseSystemCommand(promptText);
    const topicPrompt = systemCommand
      ? { topicName: null, promptText, topicExplicit: false, promptTextBeforeTopicStrip: promptText }
      : resolvePromptTopic(promptText);
    return {
      explicitAddress,
      promptText: topicPrompt.promptText,
      addressedAgentId: focusedAgentId,
      topicName: topicPrompt.topicName,
      topicExplicit: topicPrompt.topicExplicit,
      promptTextBeforeTopicStrip: topicPrompt.promptTextBeforeTopicStrip,
      systemCommand,
    };
  }

  const topicPrompt = resolvePromptTopic(promptText);

  return {
    explicitAddress,
    promptText: topicPrompt.promptText,
    addressedAgentId: explicitAddress.agent.id,
    topicName: topicPrompt.topicName,
    topicExplicit: topicPrompt.topicExplicit,
    promptTextBeforeTopicStrip: topicPrompt.promptTextBeforeTopicStrip,
    systemCommand: null,
  };
}

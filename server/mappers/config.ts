import type {
  ProviderCatalog,
  ProviderConfigState,
  ProviderMode,
  ProviderModel,
  ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type {
  BridgeCatalogResult,
  BridgeModelInfo,
  BridgeModelSelection,
  BridgeSessionState,
} from "../protocol.ts";

export function encodeModelId(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function mapThinkingOptions(model: BridgeModelInfo): {
  thinkingOptions?: ProviderThinkingOption[];
  defaultThinkingOptionId?: string;
} {
  if (!model.reasoning || model.reasoning.efforts.length === 0) return {};
  const defaultId = model.reasoning.defaultEffort;
  return {
    thinkingOptions: model.reasoning.efforts.map((effort) => ({
      id: effort.id,
      label: effort.name,
      ...(effort.description !== undefined ? { description: effort.description } : {}),
      ...(defaultId === effort.id ? { isDefault: true } : {}),
    })),
    ...(defaultId !== undefined ? { defaultThinkingOptionId: defaultId } : {}),
  };
}

function mapModes(catalog: BridgeCatalogResult): ProviderMode[] {
  if (!catalog.permissionPresets) return [];
  return catalog.permissionPresets.options.map((opt) => ({
    id: opt.id,
    label: opt.name,
    ...(opt.description !== undefined ? { description: opt.description } : {}),
    ...(opt.id === "danger-full-access" ? { isUnattended: true } : {}),
  }));
}

function mapModels(
  catalog: BridgeCatalogResult,
  defaultSelection?: BridgeModelSelection,
): ProviderModel[] {
  const defaultId = defaultSelection
    ? encodeModelId(defaultSelection.provider, defaultSelection.model)
    : undefined;
  const models: ProviderModel[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      const id = encodeModelId(provider.id, model.id);
      const thinking = mapThinkingOptions(model);
      models.push({
        id,
        label: model.name,
        ...(model.description !== undefined ? { description: model.description } : {}),
        ...(defaultId === id ? { isDefault: true } : {}),
        ...(model.contextWindowMaxTokens !== undefined
          ? { contextWindowMaxTokens: model.contextWindowMaxTokens }
          : {}),
        ...thinking,
        metadata: {
          providerId: provider.id,
          providerName: provider.name,
          modelId: model.id,
        },
      });
    }
  }
  return models;
}

export function toProviderCatalog(catalog: BridgeCatalogResult): ProviderCatalog {
  const defaultSelection = catalog.defaultSelection;
  const models = mapModels(catalog, defaultSelection);
  const modes = mapModes(catalog);
  const defaultModel = defaultSelection
    ? encodeModelId(defaultSelection.provider, defaultSelection.model)
    : models[0]?.id;
  const defaultModelInfo = models.find((m) => m.id === defaultModel);
  return {
    models,
    modes,
    ...(defaultModelInfo?.thinkingOptions ? { thinkingOptions: defaultModelInfo.thinkingOptions } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(catalog.permissionPresets?.defaultPreset !== undefined
      ? { defaultMode: catalog.permissionPresets.defaultPreset }
      : {}),
    ...(defaultSelection?.reasoningEffort !== undefined
      ? { defaultThinkingOption: defaultSelection.reasoningEffort }
      : defaultModelInfo?.defaultThinkingOptionId !== undefined
        ? { defaultThinkingOption: defaultModelInfo.defaultThinkingOptionId }
        : {}),
  };
}

export function toProviderConfigState(state: BridgeSessionState): ProviderConfigState {
  const selection = state.selection ?? state.catalog.defaultSelection;
  const models = mapModels(state.catalog, selection);
  const modes = mapModes(state.catalog);
  const currentModelId = selection
    ? encodeModelId(selection.provider, selection.model)
    : models[0]?.id;
  const currentModel = models.find((m) => m.id === currentModelId);
  const thinkingOptions = currentModel?.thinkingOptions ?? [];
  const thinkingOption =
    selection?.reasoningEffort ?? currentModel?.defaultThinkingOptionId;
  return {
    ...(currentModelId !== undefined ? { model: currentModelId } : {}),
    ...(state.mode !== undefined
      ? { mode: state.mode }
      : state.catalog.permissionPresets?.defaultPreset !== undefined
        ? { mode: state.catalog.permissionPresets.defaultPreset }
        : {}),
    ...(thinkingOption !== undefined ? { thinkingOption } : {}),
    models,
    modes,
    thinkingOptions,
    settings: [],
  };
}

import {
  initializeMultiAssetState,
  AssetConfig,
  MultiAssetBotState,
} from 'trading-bot-platform';

type MultiAssetStateWithExtras = MultiAssetBotState & Record<string, unknown>;

export function hydrateMultiAssetState(
  assets: AssetConfig[],
  state: MultiAssetStateWithExtras
): MultiAssetStateWithExtras {
  const fresh = initializeMultiAssetState(assets);
  const existingPositions = Array.isArray(state.assetPositions)
    ? state.assetPositions
    : [];
  const existingMap = new Map(existingPositions.map((pos) => [pos.asset, pos]));
  const mergedPositions = fresh.assetPositions.map(
    (pos) => existingMap.get(pos.asset) || pos
  );

  return {
    ...fresh,
    ...state,
    assetPositions: mergedPositions,
  };
}

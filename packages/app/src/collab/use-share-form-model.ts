import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openShareWorkspaceForm,
  type ShareWorkspaceFormModel,
  type ShareWorkspaceFormSnapshot,
  type ShareWorkspaceFormState,
} from "./share-form-model";

export function useShareWorkspaceFormModel(
  snapshot: ShareWorkspaceFormSnapshot,
): ShareWorkspaceFormModel {
  const [model] = useState(() => openShareWorkspaceForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}

export function useShareWorkspaceFormState(
  model: ShareWorkspaceFormModel,
): ShareWorkspaceFormState {
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}

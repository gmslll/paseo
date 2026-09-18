export function createBrowserPageIdentityCloseBarrier(input: {
  retireRoute: () => Promise<void>;
  unregisterHost: () => Promise<void> | void;
  release: () => void;
  onError?: (error: unknown) => void;
}): (preventDefault: () => void) => void {
  let run: Promise<void> | null = null;
  return (preventDefault) => {
    if (run) {
      preventDefault();
      return;
    }
    preventDefault();
    run = (async () => {
      try {
        await input.retireRoute();
        await input.unregisterHost();
      } catch (error) {
        input.onError?.(error);
      } finally {
        input.release();
      }
    })();
  };
}

export async function closeBrowserPageIdentityLifecycle(input: {
  controllerClose: () => Promise<void>;
  disposer: () => Promise<void>;
  registryClose: () => Promise<void>;
  transportClose: () => Promise<void>;
}): Promise<void> {
  await input.controllerClose();
  await input.disposer();
  await input.registryClose();
  await input.transportClose();
}

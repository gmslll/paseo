export interface AdmissionInvalidationEvent {
  readonly kind: "revoke" | "rotate" | "logout_all";
  readonly credentialIds: readonly string[];
  readonly principalId: string;
  readonly organizationId: string;
  readonly grantVersion: string;
}

export interface AdmissionInvalidationRegistration {
  readonly sessionBindingKey: string;
  readonly generation: string;
  readonly credentialId: string;
  readonly principalId: string;
  readonly organizationId: string;
  readonly grantVersion: string;
  readonly invalidate: (exact: {
    readonly sessionBindingKey: string;
    readonly sessionBindingGeneration: string;
  }) => Promise<void>;
}

export interface AdmissionInvalidationSink {
  register(input: AdmissionInvalidationRegistration): () => void;
  publish(event: AdmissionInvalidationEvent): Promise<void>;
  publishCredentialInvalidation(event: AdmissionInvalidationEvent): Promise<void>;
}

export function createAdmissionInvalidationSink(): AdmissionInvalidationSink {
  const registrations = new Map<string, Map<string, AdmissionInvalidationRegistration>>();
  const validKinds = new Set<AdmissionInvalidationEvent["kind"]>([
    "revoke",
    "rotate",
    "logout_all",
  ]);
  const isValidEvent = (event: AdmissionInvalidationEvent): boolean =>
    validKinds.has(event.kind) &&
    Boolean(event.principalId) &&
    Boolean(event.organizationId) &&
    Boolean(event.grantVersion) &&
    event.credentialIds.length > 0 &&
    new Set(event.credentialIds).size === event.credentialIds.length &&
    event.credentialIds.every((id) => Boolean(id));
  return {
    register(input) {
      if (
        !input.sessionBindingKey ||
        !input.generation ||
        !input.credentialId ||
        !input.principalId ||
        !input.organizationId ||
        !input.grantVersion
      )
        throw new Error("Invalid admission invalidation registration");
      const byGeneration = registrations.get(input.sessionBindingKey) ?? new Map();
      if (byGeneration.has(input.generation))
        throw new Error("Admission binding already registered");
      byGeneration.set(input.generation, Object.freeze({ ...input }));
      registrations.set(input.sessionBindingKey, byGeneration);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        byGeneration.delete(input.generation);
        if (byGeneration.size === 0) registrations.delete(input.sessionBindingKey);
      };
    },
    async publish(event) {
      if (!isValidEvent(event)) return;
      const matches = Array.from(registrations.values())
        .flatMap((byGeneration) => Array.from(byGeneration.values()))
        .filter(
          (registration) =>
            event.credentialIds.includes(registration.credentialId) &&
            registration.principalId === event.principalId &&
            registration.organizationId === event.organizationId &&
            registration.grantVersion === event.grantVersion,
        );
      const errors: unknown[] = [];
      for (const registration of matches) {
        try {
          await registration.invalidate({
            sessionBindingKey: registration.sessionBindingKey,
            sessionBindingGeneration: registration.generation,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Admission invalidation failed", { cause: errors[0] });
    },
    async publishCredentialInvalidation(event) {
      return this.publish(event);
    },
  };
}

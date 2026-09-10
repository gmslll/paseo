export interface AdmissionInvalidationEvent {
  readonly sessionBindingKey: string;
  readonly generation: string;
  readonly credentialId: string;
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
}

export function createAdmissionInvalidationSink(): AdmissionInvalidationSink {
  const registrations = new Map<string, Map<string, AdmissionInvalidationRegistration>>();
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
      const registration = registrations.get(event.sessionBindingKey)?.get(event.generation);
      if (
        !registration ||
        registration.credentialId !== event.credentialId ||
        registration.principalId !== event.principalId ||
        registration.organizationId !== event.organizationId ||
        registration.grantVersion !== event.grantVersion
      )
        return;
      await registration.invalidate({
        sessionBindingKey: registration.sessionBindingKey,
        sessionBindingGeneration: registration.generation,
      });
    },
  };
}

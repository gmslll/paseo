import { timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  BrowserProfileIdSchema,
  BrowserProfileRecordSchema,
  EnterpriseBrowserPageIdentityInvalidationRequestSchema,
  EnterpriseBrowserPageIdentityObservationRequestSchema,
  NodeIdSchema,
  type BrowserProfileRecord,
  type EnterpriseBrowserPageIdentityInvalidationRequest,
  type EnterpriseBrowserPageIdentityObservationRequest,
} from "@getpaseo/protocol/messages";
import { z } from "zod";

const authenticatedHostBrand = Symbol("AuthenticatedBrowserHostSession");
const verificationBrand = Symbol("BrowserPageIdentityVerification");
const verifiedProfileBrand = Symbol("BrowserPageIdentityVerifiedProfile");
const verifierBrand = Symbol("BrowserPageIdentityVerifier");
const authenticatedHosts = new WeakSet<object>();
const registries = new WeakSet<object>();
const verificationRecords = new WeakMap<object, VerificationRecord>();
const verifiedProfiles = new WeakSet<object>();
const verifiers = new WeakSet<object>();

export const BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS = Object.freeze({
  hostSessions: 256,
  browserRegistrationsPerHostSession: 256,
  observationRevisionsPerHostSession: 4_096,
});

const BrowserRegistrationInputSchema = z
  .object({
    browserId: BrowserAutomationBrowserIdSchema,
    browserProfileId: BrowserProfileIdSchema,
    bindingRevision: z.string().min(1),
  })
  .strict();

const VerificationTargetSchema = BrowserRegistrationInputSchema.extend({
  hostClientId: z.string().min(1).optional(),
  hostSessionBindingGeneration: z.string().min(1).optional(),
})
  .strict()
  .refine(
    (target) =>
      (target.hostClientId === undefined) === (target.hostSessionBindingGeneration === undefined),
    { message: "Browser host identity requires both client ID and Session generation." },
  );

export type BrowserPageIdentityFailureReason =
  | "account_label_mismatch"
  | "expected_identity_missing"
  | "hostname_mismatch"
  | "observation_rebound"
  | "observation_replayed"
  | "observation_stale"
  | "observation_unavailable"
  | "profile_changed"
  | "profile_unavailable";

export class BrowserPageIdentityVerificationError extends Error {
  public constructor(
    public readonly reasonCode: BrowserPageIdentityFailureReason,
    options?: ErrorOptions,
  ) {
    super("Browser page identity is unavailable.", options);
    this.name = "BrowserPageIdentityVerificationError";
  }
}

/** W1 mints this value only from an authenticated Session; wire payloads cannot construct it. */
export interface AuthenticatedBrowserHostSession {
  readonly [authenticatedHostBrand]: true;
  readonly clientId: string;
  readonly homeNodeId: string;
  readonly sessionBindingGeneration: string;
}

export interface BrowserPageIdentityVerification {
  readonly [verificationBrand]: true;
  readonly browserId: string;
  readonly browserProfileId: string;
  readonly bindingRevision: string;
  readonly lifecycleGeneration: string;
  readonly hostClientId: string;
  readonly homeNodeId: string;
  readonly browserRegistrationRevision: string;
  readonly observationRevision: string;
}

export interface BrowserPageIdentityVerifiedProfile {
  readonly [verifiedProfileBrand]: true;
  readonly profile: BrowserProfileRecord;
  readonly verification: BrowserPageIdentityVerification;
}

export interface BrowserPageIdentityVerificationTarget {
  readonly browserId: string;
  readonly browserProfileId: string;
  readonly bindingRevision: string;
  readonly hostClientId?: string;
  readonly hostSessionBindingGeneration?: string;
}

export interface BrowserPageIdentityProfileSource {
  get(browserProfileId: string): Promise<BrowserProfileRecord | null>;
}

/** Read-only nominal port consumed by W2, content sources, and other preauthorization callers. */
export interface BrowserPageIdentityVerifier {
  readonly [verifierBrand]: true;
  verify(input: BrowserPageIdentityVerificationTarget): Promise<BrowserPageIdentityVerification>;
  verifyProfile(browserProfileId: string): Promise<BrowserPageIdentityVerification>;
  resolveVerifiedProfile(
    profile: BrowserProfileRecord,
  ): Promise<BrowserPageIdentityVerifiedProfile>;
  recheck(
    verification: BrowserPageIdentityVerification,
    input?: BrowserPageIdentityVerificationTarget,
  ): Promise<void>;
}

interface BrowserRegistrationRecord {
  readonly sequence: number;
  readonly registrationRevision: string;
  readonly host: AuthenticatedBrowserHostSession;
  readonly browserId: string;
  readonly browserProfileId: string;
  readonly bindingRevision: string;
  stale: boolean;
  evidence: BrowserObservationEvidence | null;
  readonly revisionLedger: BrowserObservationRevisionLedger;
}

interface BrowserObservationRevisionLedger {
  readonly acceptedObservationRevisions: Set<string>;
  readonly invalidatedObservationRevisions: Set<string>;
}

interface BrowserHostSessionState {
  readonly host: AuthenticatedBrowserHostSession;
  readonly records: Set<BrowserRegistrationRecord>;
  readonly provisionalObservationsByBrowserId: Map<string, ProvisionalBrowserObservation>;
  readonly revisionLedgersByBrowserId: Map<string, BrowserObservationRevisionLedger>;
  acceptedObservationRevisionCount: number;
  failed: boolean;
}

interface ProvisionalBrowserObservation {
  readonly browserId: string;
  readonly browserProfileId: string;
  readonly bindingRevision: string;
  evidence: BrowserObservationEvidence | null;
  readonly revisionLedger: BrowserObservationRevisionLedger;
}

interface BrowserObservationRoute {
  readonly registration: BrowserRegistrationRecord | null;
  readonly provisional: ProvisionalBrowserObservation | null;
  readonly target: BrowserRegistrationRecord | ProvisionalBrowserObservation | null;
  readonly ledger: BrowserObservationRevisionLedger;
}

interface BrowserObservationEvidence {
  readonly sequence: number;
  readonly hostname: string;
  readonly accountLabelHash?: string;
  readonly observationRevision: string;
  readonly lifecycleGeneration: string;
}

interface VerificationRecord {
  readonly registry: BrowserPageIdentityRegistry;
  readonly registration: BrowserRegistrationRecord;
  readonly evidence: BrowserObservationEvidence;
  readonly profileFingerprint: string;
}

export function createAuthenticatedBrowserHostSession(input: {
  readonly clientId: string;
  readonly homeNodeId: string;
  readonly sessionBindingGeneration: string;
}): AuthenticatedBrowserHostSession {
  const record = readExactStableRecord(
    input,
    ["clientId", "homeNodeId", "sessionBindingGeneration"],
    "Authenticated Browser host Session",
  );
  const clientId = parseNonEmptyString(record.clientId, "clientId");
  const homeNodeId = NodeIdSchema.parse(record.homeNodeId);
  const sessionBindingGeneration = parseNonEmptyString(
    record.sessionBindingGeneration,
    "sessionBindingGeneration",
  );
  const session = Object.freeze({
    [authenticatedHostBrand]: true as const,
    clientId,
    homeNodeId,
    sessionBindingGeneration,
  });
  authenticatedHosts.add(session);
  return session;
}

export function isAuthenticatedBrowserHostSession(
  value: unknown,
): value is AuthenticatedBrowserHostSession {
  return isObject(value) && authenticatedHosts.has(value);
}

export function isBrowserPageIdentityVerification(
  value: unknown,
): value is BrowserPageIdentityVerification {
  return isObject(value) && verificationRecords.has(value);
}

export function isBrowserPageIdentityVerifiedProfile(
  value: unknown,
): value is BrowserPageIdentityVerifiedProfile {
  return isObject(value) && verifiedProfiles.has(value);
}

export function isBrowserPageIdentityRegistry(
  value: unknown,
): value is BrowserPageIdentityRegistry {
  return isObject(value) && registries.has(value);
}

export function createBrowserPageIdentityVerifier(
  registry: BrowserPageIdentityRegistry,
): BrowserPageIdentityVerifier {
  if (!isBrowserPageIdentityRegistry(registry)) {
    throw new Error("Browser page identity registry is invalid.");
  }
  const verifier = Object.freeze({
    [verifierBrand]: true as const,
    verify: registry.verify.bind(registry),
    verifyProfile: registry.verifyProfile.bind(registry),
    resolveVerifiedProfile: registry.resolveVerifiedProfile.bind(registry),
    recheck: registry.recheck.bind(registry),
  });
  verifiers.add(verifier);
  return verifier;
}

export function isBrowserPageIdentityVerifier(
  value: unknown,
): value is BrowserPageIdentityVerifier {
  return isObject(value) && verifiers.has(value);
}

export class BrowserPageIdentityRegistry {
  private readonly records = new Set<BrowserRegistrationRecord>();
  private readonly hostSessions = new Map<string, BrowserHostSessionState>();
  private registrationSequence = 0;
  private evidenceSequence = 0;
  private closed = false;

  public constructor(
    private readonly options: {
      readonly profiles: BrowserPageIdentityProfileSource;
    },
  ) {
    const getProfile = options.profiles?.get;
    if (typeof getProfile !== "function") {
      throw new Error("Browser page identity registry options are invalid.");
    }
    this.options = Object.freeze({
      profiles: Object.freeze({ get: getProfile.bind(options.profiles) }),
    });
    registries.add(this);
  }

  public registerBrowser(input: {
    readonly host: AuthenticatedBrowserHostSession;
    readonly browserId: string;
    readonly browserProfileId: string;
    readonly bindingRevision: string;
  }): string {
    if (this.closed) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const record = readExactStableRecord(
      input,
      ["bindingRevision", "browserId", "browserProfileId", "host"],
      "Browser page registration",
    );
    if (!isAuthenticatedBrowserHostSession(record.host)) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const target = BrowserRegistrationInputSchema.parse({
      browserId: record.browserId,
      browserProfileId: record.browserProfileId,
      bindingRevision: record.bindingRevision,
    });
    const session = this.getHostSession(record.host, true);
    if (!session || session.failed) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const ledger = this.getBrowserRevisionLedger(session, target.browserId, true);
    if (!ledger) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const prior = this.latestRegistrationForHostBrowser(record.host, target.browserId);
    const current = prior && !prior.stale ? prior : null;
    if (
      current &&
      current.browserProfileId === target.browserProfileId &&
      current.bindingRevision === target.bindingRevision
    ) {
      return current.registrationRevision;
    }
    const provisional = session.provisionalObservationsByBrowserId.get(target.browserId);
    if (
      provisional &&
      (current ||
        provisional.browserProfileId !== target.browserProfileId ||
        provisional.bindingRevision !== target.bindingRevision)
    ) {
      this.failHostSession(session);
      throw new BrowserPageIdentityVerificationError("observation_rebound");
    }
    if (prior) {
      prior.stale = true;
      session.records.delete(prior);
      this.records.delete(prior);
    }
    const sequence = ++this.registrationSequence;
    const registration: BrowserRegistrationRecord = {
      sequence,
      registrationRevision: `browser-registration-${sequence}`,
      host: record.host,
      browserId: target.browserId,
      browserProfileId: target.browserProfileId,
      bindingRevision: target.bindingRevision,
      stale: false,
      evidence: provisional?.evidence ?? null,
      revisionLedger: ledger,
    };
    session.provisionalObservationsByBrowserId.delete(target.browserId);
    session.records.add(registration);
    this.records.add(registration);
    return registration.registrationRevision;
  }

  public async observe(
    host: AuthenticatedBrowserHostSession,
    input: EnterpriseBrowserPageIdentityObservationRequest,
  ): Promise<string> {
    if (this.closed) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    if (!isAuthenticatedBrowserHostSession(host)) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    let observation: EnterpriseBrowserPageIdentityObservationRequest;
    try {
      observation = EnterpriseBrowserPageIdentityObservationRequestSchema.parse(
        cloneStableData(input, "Browser page identity observation"),
      );
    } catch (error) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable", { cause: error });
    }
    const session = this.resolveObservationSession(host, observation);
    const route = this.resolveObservationRoute(host, session, observation);
    if (this.isObservationIdempotent(session, route, observation)) {
      return observation.observationRevision;
    }
    return this.recordObservation(session, route, observation);
  }

  public async invalidateObservation(
    host: AuthenticatedBrowserHostSession,
    input: EnterpriseBrowserPageIdentityInvalidationRequest,
  ): Promise<string> {
    if (this.closed || !isAuthenticatedBrowserHostSession(host)) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    let invalidation: EnterpriseBrowserPageIdentityInvalidationRequest;
    try {
      invalidation = EnterpriseBrowserPageIdentityInvalidationRequestSchema.parse(
        cloneStableData(input, "Browser page identity invalidation"),
      );
    } catch (error) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable", { cause: error });
    }
    return this.invalidateCurrentObservation(host, invalidation);
  }

  public async verify(
    input: BrowserPageIdentityVerificationTarget,
  ): Promise<BrowserPageIdentityVerification> {
    const target = snapshotVerificationTarget(input);
    const candidates = [...this.records]
      .filter(
        (record) =>
          record.browserId === target.browserId &&
          record.browserProfileId === target.browserProfileId &&
          record.bindingRevision === target.bindingRevision &&
          (target.hostClientId === undefined ||
            (record.host.clientId === target.hostClientId &&
              record.host.sessionBindingGeneration === target.hostSessionBindingGeneration)),
      )
      .sort((left, right) => right.sequence - left.sequence);
    const registration = candidates[0];
    if (!registration) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    return this.verifyRegistration(registration);
  }

  public async verifyProfile(browserProfileId: string): Promise<BrowserPageIdentityVerification> {
    const profileId = BrowserProfileIdSchema.parse(browserProfileId);
    const registration = [...this.records]
      .filter((record) => record.browserProfileId === profileId)
      .sort((left, right) => {
        const leftSequence = left.evidence?.sequence ?? left.sequence;
        const rightSequence = right.evidence?.sequence ?? right.sequence;
        return rightSequence - leftSequence;
      })[0];
    if (!registration) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    return this.verifyRegistration(registration);
  }

  public async resolveVerifiedProfile(
    input: BrowserProfileRecord,
  ): Promise<BrowserPageIdentityVerifiedProfile> {
    let requested: BrowserProfileRecord;
    try {
      requested = BrowserProfileRecordSchema.strict().parse(
        cloneStableData(input, "Browser Profile"),
      );
    } catch (error) {
      throw new BrowserPageIdentityVerificationError("profile_unavailable", { cause: error });
    }
    const verification = await this.verifyProfile(requested.browserProfileId);
    const proof = verificationRecords.get(verification);
    if (!proof) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const canonical = await readProfile(this.options.profiles, requested.browserProfileId);
    const fingerprint = profileFingerprint(canonical);
    if (fingerprint !== profileFingerprint(requested) || fingerprint !== proof.profileFingerprint) {
      throw new BrowserPageIdentityVerificationError("profile_changed");
    }
    await this.recheck(verification);
    const result = Object.freeze({
      [verifiedProfileBrand]: true as const,
      profile: Object.freeze(
        BrowserProfileRecordSchema.strict().parse(cloneStableData(canonical, "Browser Profile")),
      ),
      verification,
    });
    verifiedProfiles.add(result);
    return result;
  }

  public async recheck(
    verification: BrowserPageIdentityVerification,
    input?: BrowserPageIdentityVerificationTarget,
  ): Promise<void> {
    const proof = isObject(verification) ? verificationRecords.get(verification) : undefined;
    if (!proof || proof.registry !== this) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    if (input) {
      const target = snapshotVerificationTarget(input);
      if (
        proof.registration.browserId !== target.browserId ||
        proof.registration.browserProfileId !== target.browserProfileId ||
        proof.registration.bindingRevision !== target.bindingRevision ||
        (target.hostClientId !== undefined &&
          (proof.registration.host.clientId !== target.hostClientId ||
            proof.registration.host.sessionBindingGeneration !==
              target.hostSessionBindingGeneration))
      ) {
        throw new BrowserPageIdentityVerificationError("observation_rebound");
      }
    }
    const profile = await readProfile(this.options.profiles, proof.registration.browserProfileId);
    if (profileFingerprint(profile) !== proof.profileFingerprint) {
      throw new BrowserPageIdentityVerificationError("profile_changed");
    }
    this.assertCurrentEvidence(proof.registration, proof.evidence);
    assertIdentityMatches(profile, proof.registration.host, proof.evidence);
  }

  public invalidateBrowser(host: AuthenticatedBrowserHostSession, browserId: string): void {
    if (!isAuthenticatedBrowserHostSession(host)) return;
    const parsedBrowserId = BrowserAutomationBrowserIdSchema.parse(browserId);
    this.getHostSession(host, false)?.provisionalObservationsByBrowserId.delete(parsedBrowserId);
    for (const record of this.records) {
      if (sameAuthenticatedHost(record.host, host) && record.browserId === parsedBrowserId) {
        record.stale = true;
        this.records.delete(record);
        this.getHostSession(record.host, false)?.records.delete(record);
      }
    }
  }

  public invalidateBinding(browserProfileId: string, bindingRevision: string): void {
    const target = BrowserRegistrationInputSchema.pick({
      browserProfileId: true,
      bindingRevision: true,
    }).parse({ browserProfileId, bindingRevision });
    for (const record of this.records) {
      if (
        record.browserProfileId === target.browserProfileId &&
        record.bindingRevision === target.bindingRevision
      ) {
        record.stale = true;
        this.records.delete(record);
        this.getHostSession(record.host, false)?.records.delete(record);
      }
    }
    for (const session of this.hostSessions.values()) {
      for (const [browserId, provisional] of session.provisionalObservationsByBrowserId) {
        if (
          provisional.browserProfileId === target.browserProfileId &&
          provisional.bindingRevision === target.bindingRevision
        ) {
          session.provisionalObservationsByBrowserId.delete(browserId);
        }
      }
    }
  }

  public invalidateSession(sessionBindingGeneration: string): void {
    const generation = parseNonEmptyString(sessionBindingGeneration, "sessionBindingGeneration");
    for (const session of this.hostSessions.values()) {
      if (session.host.sessionBindingGeneration === generation) {
        // Keep only a bounded failed-session tombstone until host teardown so a revoked
        // generation cannot regain authority by replaying an observation revision.
        this.failHostSession(session);
      }
    }
  }

  public invalidateHostSession(host: AuthenticatedBrowserHostSession): void {
    if (!isAuthenticatedBrowserHostSession(host)) return;
    const key = authenticatedHostKey(host);
    const session = this.hostSessions.get(key);
    if (session && sameAuthenticatedHost(session.host, host)) {
      this.retireHostSession(key, session);
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, session] of this.hostSessions) this.retireHostSession(key, session);
  }

  private resolveObservationSession(
    host: AuthenticatedBrowserHostSession,
    observation: EnterpriseBrowserPageIdentityObservationRequest,
  ): BrowserHostSessionState {
    if (observation.lifecycleGeneration !== host.sessionBindingGeneration) {
      const currentSession = this.getHostSession(host, false);
      const registration = currentSession
        ? this.currentRegistrationForHostBrowser(host, observation.browser.browserId)
        : null;
      if (registration) registration.stale = true;
      else if (
        currentSession?.provisionalObservationsByBrowserId.has(observation.browser.browserId)
      ) {
        this.failHostSession(currentSession);
      }
      throw new BrowserPageIdentityVerificationError("observation_rebound");
    }
    const session = this.getHostSession(host, true);
    if (!session || session.failed) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    return session;
  }

  private resolveObservationRoute(
    host: AuthenticatedBrowserHostSession,
    session: BrowserHostSessionState,
    observation: EnterpriseBrowserPageIdentityObservationRequest,
  ): BrowserObservationRoute {
    const ledger = this.getBrowserRevisionLedger(session, observation.browser.browserId, true);
    if (!ledger) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const registration = this.currentRegistrationForHostBrowser(
      host,
      observation.browser.browserId,
    );
    const provisional =
      session.provisionalObservationsByBrowserId.get(observation.browser.browserId) ?? null;
    const target = registration ?? provisional;
    if (
      target &&
      (target.browserProfileId !== observation.browser.browserProfileId ||
        target.bindingRevision !== observation.bindingRevision)
    ) {
      if (registration) registration.stale = true;
      else this.failHostSession(session);
      throw new BrowserPageIdentityVerificationError("observation_rebound");
    }
    return { registration, provisional, target, ledger };
  }

  private isObservationIdempotent(
    session: BrowserHostSessionState,
    route: BrowserObservationRoute,
    observation: EnterpriseBrowserPageIdentityObservationRequest,
  ): boolean {
    try {
      return (
        classifyObservation(route.target?.evidence ?? null, route.ledger, observation) ===
        "idempotent"
      );
    } catch (error) {
      if (route.registration) route.registration.stale = true;
      else this.failHostSession(session);
      throw error;
    }
  }

  private recordObservation(
    session: BrowserHostSessionState,
    route: BrowserObservationRoute,
    observation: EnterpriseBrowserPageIdentityObservationRequest,
  ): string {
    if (
      session.acceptedObservationRevisionCount >=
      BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.observationRevisionsPerHostSession
    ) {
      this.failHostSession(session);
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    route.ledger.acceptedObservationRevisions.add(observation.observationRevision);
    session.acceptedObservationRevisionCount += 1;
    const evidence = Object.freeze({
      sequence: ++this.evidenceSequence,
      hostname: observation.hostname,
      ...(observation.accountLabelHash !== undefined
        ? { accountLabelHash: observation.accountLabelHash }
        : {}),
      observationRevision: observation.observationRevision,
      lifecycleGeneration: observation.lifecycleGeneration,
    });
    if (route.registration) route.registration.evidence = evidence;
    else if (route.provisional) route.provisional.evidence = evidence;
    else {
      session.provisionalObservationsByBrowserId.set(observation.browser.browserId, {
        browserId: observation.browser.browserId,
        browserProfileId: observation.browser.browserProfileId,
        bindingRevision: observation.bindingRevision,
        evidence,
        revisionLedger: route.ledger,
      });
    }
    return observation.observationRevision;
  }

  private invalidateCurrentObservation(
    host: AuthenticatedBrowserHostSession,
    invalidation: EnterpriseBrowserPageIdentityInvalidationRequest,
  ): string {
    const session = this.getHostSession(host, false);
    if (!session || session.failed) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    const registration = this.currentRegistrationForHostBrowser(
      host,
      invalidation.browser.browserId,
    );
    const provisional =
      session.provisionalObservationsByBrowserId.get(invalidation.browser.browserId) ?? null;
    const target = registration ?? provisional;
    if (!target) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    this.assertInvalidationMatches(session, registration, provisional, target, host, invalidation);
    return this.applyInvalidation(session, registration, provisional, target, invalidation);
  }

  private assertInvalidationMatches(
    session: BrowserHostSessionState,
    registration: BrowserRegistrationRecord | null,
    provisional: ProvisionalBrowserObservation | null,
    target: BrowserRegistrationRecord | ProvisionalBrowserObservation,
    host: AuthenticatedBrowserHostSession,
    invalidation: EnterpriseBrowserPageIdentityInvalidationRequest,
  ): void {
    if (
      target.browserProfileId !== invalidation.browser.browserProfileId ||
      target.bindingRevision !== invalidation.bindingRevision ||
      invalidation.lifecycleGeneration !== host.sessionBindingGeneration
    ) {
      if (provisional && !registration) this.failHostSession(session);
      throw new BrowserPageIdentityVerificationError("observation_rebound");
    }
  }

  private applyInvalidation(
    session: BrowserHostSessionState,
    registration: BrowserRegistrationRecord | null,
    provisional: ProvisionalBrowserObservation | null,
    target: BrowserRegistrationRecord | ProvisionalBrowserObservation,
    invalidation: EnterpriseBrowserPageIdentityInvalidationRequest,
  ): string {
    const evidence = target.evidence;
    if (evidence?.observationRevision === invalidation.observationRevision) {
      if (evidence.lifecycleGeneration !== invalidation.lifecycleGeneration) {
        if (provisional && !registration) this.failHostSession(session);
        throw new BrowserPageIdentityVerificationError("observation_rebound");
      }
      target.evidence = null;
      target.revisionLedger.invalidatedObservationRevisions.add(invalidation.observationRevision);
      return invalidation.observationRevision;
    }
    if (
      evidence === null &&
      target.revisionLedger.invalidatedObservationRevisions.has(invalidation.observationRevision)
    ) {
      return invalidation.observationRevision;
    }
    if (
      target.revisionLedger.acceptedObservationRevisions.has(invalidation.observationRevision) ||
      target.revisionLedger.invalidatedObservationRevisions.has(invalidation.observationRevision)
    ) {
      if (provisional && !registration) this.failHostSession(session);
      throw new BrowserPageIdentityVerificationError("observation_replayed");
    }
    throw new BrowserPageIdentityVerificationError(
      evidence ? "observation_rebound" : "observation_unavailable",
    );
  }

  private async verifyRegistration(
    registration: BrowserRegistrationRecord,
  ): Promise<BrowserPageIdentityVerification> {
    if (this.closed) {
      throw new BrowserPageIdentityVerificationError("observation_stale");
    }
    const expectedProfile = await readProfile(this.options.profiles, registration.browserProfileId);
    const evidence = registration.evidence;
    this.assertCurrentEvidence(registration, evidence);
    assertIdentityMatches(expectedProfile, registration.host, evidence);
    const currentProfile = await readProfile(this.options.profiles, registration.browserProfileId);
    const fingerprint = profileFingerprint(expectedProfile);
    if (profileFingerprint(currentProfile) !== fingerprint) {
      throw new BrowserPageIdentityVerificationError("profile_changed");
    }
    this.assertCurrentEvidence(registration, evidence);
    const verification = Object.freeze({
      [verificationBrand]: true as const,
      browserId: registration.browserId,
      browserProfileId: registration.browserProfileId,
      bindingRevision: registration.bindingRevision,
      lifecycleGeneration: evidence.lifecycleGeneration,
      hostClientId: registration.host.clientId,
      homeNodeId: registration.host.homeNodeId,
      browserRegistrationRevision: registration.registrationRevision,
      observationRevision: evidence.observationRevision,
    });
    verificationRecords.set(verification, {
      registry: this,
      registration,
      evidence,
      profileFingerprint: fingerprint,
    });
    return verification;
  }

  private assertCurrentEvidence(
    registration: BrowserRegistrationRecord,
    evidence: BrowserObservationEvidence | null,
  ): asserts evidence is BrowserObservationEvidence {
    if (registration.stale) {
      throw new BrowserPageIdentityVerificationError("observation_stale");
    }
    if (!evidence) {
      throw new BrowserPageIdentityVerificationError("observation_unavailable");
    }
    if (registration.evidence !== evidence) {
      throw new BrowserPageIdentityVerificationError("observation_stale");
    }
  }

  private currentRegistrationForHostBrowser(
    host: AuthenticatedBrowserHostSession,
    browserId: string,
  ): BrowserRegistrationRecord | null {
    const registration = this.latestRegistrationForHostBrowser(host, browserId);
    return registration && !registration.stale ? registration : null;
  }

  private latestRegistrationForHostBrowser(
    host: AuthenticatedBrowserHostSession,
    browserId: string,
  ): BrowserRegistrationRecord | null {
    const session = this.getHostSession(host, false);
    if (!session || session.failed) return null;
    return [...session.records].find((record) => record.browserId === browserId) ?? null;
  }

  private getHostSession(
    host: AuthenticatedBrowserHostSession,
    create: boolean,
  ): BrowserHostSessionState | null {
    const key = authenticatedHostKey(host);
    const existing = this.hostSessions.get(key);
    if (existing) return existing;
    if (!create || this.hostSessions.size >= BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.hostSessions) {
      return null;
    }
    const session: BrowserHostSessionState = {
      host,
      records: new Set(),
      provisionalObservationsByBrowserId: new Map(),
      revisionLedgersByBrowserId: new Map(),
      acceptedObservationRevisionCount: 0,
      failed: false,
    };
    this.hostSessions.set(key, session);
    return session;
  }

  private getBrowserRevisionLedger(
    session: BrowserHostSessionState,
    browserId: string,
    create: boolean,
  ): BrowserObservationRevisionLedger | null {
    const existing = session.revisionLedgersByBrowserId.get(browserId);
    if (existing) return existing;
    if (
      !create ||
      session.revisionLedgersByBrowserId.size >=
        BROWSER_PAGE_IDENTITY_REGISTRY_LIMITS.browserRegistrationsPerHostSession
    ) {
      if (create) this.failHostSession(session);
      return null;
    }
    const ledger = {
      acceptedObservationRevisions: new Set<string>(),
      invalidatedObservationRevisions: new Set<string>(),
    };
    session.revisionLedgersByBrowserId.set(browserId, ledger);
    return ledger;
  }

  private failHostSession(session: BrowserHostSessionState): void {
    session.failed = true;
    for (const record of session.records) {
      record.stale = true;
      this.records.delete(record);
    }
    session.records.clear();
    session.provisionalObservationsByBrowserId.clear();
    session.revisionLedgersByBrowserId.clear();
    session.acceptedObservationRevisionCount = 0;
  }

  private retireHostSession(key: string, session: BrowserHostSessionState): void {
    for (const record of session.records) {
      record.stale = true;
      this.records.delete(record);
    }
    session.records.clear();
    session.provisionalObservationsByBrowserId.clear();
    session.revisionLedgersByBrowserId.clear();
    session.acceptedObservationRevisionCount = 0;
    session.failed = true;
    this.hostSessions.delete(key);
  }
}

function classifyObservation(
  evidence: BrowserObservationEvidence | null,
  revisionLedger: BrowserObservationRevisionLedger,
  observation: EnterpriseBrowserPageIdentityObservationRequest,
): "idempotent" | "new" {
  if (evidence !== null && evidence.lifecycleGeneration !== observation.lifecycleGeneration) {
    throw new BrowserPageIdentityVerificationError("observation_rebound");
  }
  if (evidence?.observationRevision === observation.observationRevision) {
    if (!sameObservation(evidence, observation)) {
      throw new BrowserPageIdentityVerificationError("observation_rebound");
    }
    return "idempotent";
  }
  if (
    revisionLedger.acceptedObservationRevisions.has(observation.observationRevision) ||
    revisionLedger.invalidatedObservationRevisions.has(observation.observationRevision)
  ) {
    throw new BrowserPageIdentityVerificationError("observation_replayed");
  }
  return "new";
}

async function readProfile(
  profiles: BrowserPageIdentityProfileSource,
  browserProfileId: string,
): Promise<BrowserProfileRecord> {
  try {
    const profile = await profiles.get(browserProfileId);
    if (!profile) throw new Error("Browser Profile is unavailable.");
    return BrowserProfileRecordSchema.strict().parse(cloneStableData(profile, "Browser Profile"));
  } catch (error) {
    if (error instanceof BrowserPageIdentityVerificationError) throw error;
    throw new BrowserPageIdentityVerificationError("profile_unavailable", { cause: error });
  }
}

function assertIdentityMatches(
  profile: BrowserProfileRecord,
  host: AuthenticatedBrowserHostSession,
  evidence: BrowserObservationEvidence,
): void {
  if (profile.homeNodeId !== host.homeNodeId) {
    throw new BrowserPageIdentityVerificationError("observation_rebound");
  }
  const expected = profile.expectedIdentity;
  if (!expected) {
    throw new BrowserPageIdentityVerificationError("expected_identity_missing");
  }
  const hostname = normalizeExpectedHostname(evidence.hostname);
  if (!expected.hostnames.map(normalizeExpectedHostname).includes(hostname)) {
    throw new BrowserPageIdentityVerificationError("hostname_mismatch");
  }
  if (
    expected.accountLabelHash !== undefined &&
    (evidence.accountLabelHash === undefined ||
      !constantTimeEqual(expected.accountLabelHash, evidence.accountLabelHash))
  ) {
    throw new BrowserPageIdentityVerificationError("account_label_mismatch");
  }
}

function normalizeExpectedHostname(value: string): string {
  const trimmed = value.trim();
  const withoutTrailingDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  const ascii = domainToASCII(withoutTrailingDot.toLowerCase());
  const labels = ascii.split(".");
  if (
    trimmed !== value ||
    !ascii ||
    ascii.length > 253 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new BrowserPageIdentityVerificationError("hostname_mismatch");
  }
  return ascii;
}

function sameObservation(
  evidence: BrowserObservationEvidence,
  observation: EnterpriseBrowserPageIdentityObservationRequest,
): boolean {
  return (
    evidence.hostname === observation.hostname &&
    evidence.accountLabelHash === observation.accountLabelHash &&
    evidence.lifecycleGeneration === observation.lifecycleGeneration
  );
}

function sameAuthenticatedHost(
  left: AuthenticatedBrowserHostSession,
  right: AuthenticatedBrowserHostSession,
): boolean {
  return (
    left.clientId === right.clientId &&
    left.homeNodeId === right.homeNodeId &&
    left.sessionBindingGeneration === right.sessionBindingGeneration
  );
}

function authenticatedHostKey(host: AuthenticatedBrowserHostSession): string {
  return JSON.stringify([host.clientId, host.homeNodeId, host.sessionBindingGeneration]);
}

function snapshotVerificationTarget(
  input: BrowserPageIdentityVerificationTarget,
): BrowserPageIdentityVerificationTarget {
  try {
    return Object.freeze(
      VerificationTargetSchema.parse(
        cloneStableData(input, "Browser page identity verification target"),
      ),
    );
  } catch (error) {
    throw new BrowserPageIdentityVerificationError("observation_unavailable", { cause: error });
  }
}

function profileFingerprint(profile: BrowserProfileRecord): string {
  return JSON.stringify(profile);
}

function constantTimeEqual(expected: string, observed: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const observedBytes = Buffer.from(observed, "utf8");
  return (
    expectedBytes.length === observedBytes.length && timingSafeEqual(expectedBytes, observedBytes)
  );
}

function readExactStableRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isObject(input) || typeof input === "function" || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an invalid prototype.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} has invalid fields.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function cloneStableData(value: unknown, label: string, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw new Error(`${label} contains invalid data.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) throw new Error(`${label} contains invalid fields.`);
    const output = value.map((_item, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error(`${label} contains unstable data.`);
      }
      return cloneStableData(descriptor.value, label, seen);
    });
    seen.delete(value);
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} contains an invalid object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} contains invalid fields.`);
  }
  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be a stable data property.`);
    }
    output[key] = cloneStableData(descriptor.value, label, seen);
  }
  seen.delete(value);
  return output;
}

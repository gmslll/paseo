import type { EnterpriseIdentitySnapshot } from "@getpaseo/client/internal/enterprise-identity-lifecycle";

export function isEnterpriseWorkbenchSignedIn(
  snapshot: EnterpriseIdentitySnapshot | null,
): snapshot is EnterpriseIdentitySnapshot & {
  state: "signed_in";
  projection: NonNullable<EnterpriseIdentitySnapshot["projection"]>;
} {
  return (
    snapshot?.state === "signed_in" &&
    typeof snapshot.projection?.organizationId === "string" &&
    snapshot.projection.organizationId.length > 0
  );
}

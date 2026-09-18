# Paseo Enterprise Management Plane

This W8 service manages organization identities, Grants, node relationships, Placement,
cross-node fenced leases, and the global audit index. Workspace files, Timeline bodies, Provider
credentials, and Browser cookies stay on each Paseo node.

The service requires Node 22 and TLS. It listens on `17443` in the first deployment. Build the
single-file runtime with:

```bash
npm run bundle --workspace=@getpaseo/enterprise-management
```

Required environment variables:

```text
PASEO_MANAGEMENT_DATA_DIR=/var/lib/paseo-management
PASEO_MANAGEMENT_LISTEN=0.0.0.0:17443
PASEO_MANAGEMENT_TLS_CERT=/run/secrets/tls.crt
PASEO_MANAGEMENT_TLS_KEY=/run/secrets/tls.key
PASEO_MANAGEMENT_ORGANIZATION_ID=org_<16hex>
PASEO_MANAGEMENT_ORGANIZATION_NAME=<name>
PASEO_MANAGEMENT_ISSUER=https://<host>:17443
PASEO_MANAGEMENT_BOOTSTRAP_SECRET=<at least 24 characters>
```

Open `/` over HTTPS for the initial administration page. `POST /v1/bootstrap` consumes the
bootstrap secret only while the database has no Principal and returns the first administrator PAT
once. Remove the bootstrap secret from operator notes after bootstrap. The database and signing
keys are created with private permissions under `PASEO_MANAGEMENT_DATA_DIR`.

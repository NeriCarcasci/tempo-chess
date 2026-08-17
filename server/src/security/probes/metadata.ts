/**
 * Deployment metadata probes.
 *
 * These read Cloud Run's description of the serving revision and compare it
 * against the frozen contract. They compare; they never repair. There is no
 * code path here that deploys, shifts traffic, edits configuration, or touches
 * Secret Manager beyond reading metadata.
 *
 * The secret's *value* is never inspected by anything in this file. Only the
 * binding — which secret, which version — is checked.
 */

import { PRODUCTION, ROLE_MARKER_ENV, SECRET_BINDING } from "../contract.js";

export interface SecretKeyRef {
  name: string;
  key: string;
}

export interface CloudRunEnvEntry {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: SecretKeyRef };
}

export interface CloudRunContainer {
  image?: string;
  env?: readonly CloudRunEnvEntry[];
}

export interface CloudRunMetadata {
  env: readonly CloudRunEnvEntry[];
}

export function findEnv(metadata: CloudRunMetadata, name: string): CloudRunEnvEntry | undefined {
  return metadata.env.find((entry) => entry.name === name);
}

export class MetadataMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataMismatch";
  }
}

/**
 * `DATABASE_URL` must arrive as a Secret Manager reference to the pinned secret
 * and version, never as a literal.
 */
export function assertSecretBinding(metadata: CloudRunMetadata): string {
  const entry = findEnv(metadata, SECRET_BINDING.envName);
  if (!entry) throw new MetadataMismatch(`${SECRET_BINDING.envName} is not present on the revision`);
  if (entry.value !== undefined) {
    throw new MetadataMismatch(`${SECRET_BINDING.envName} carries a literal value`);
  }
  const ref = entry.valueFrom?.secretKeyRef;
  if (!ref) throw new MetadataMismatch(`${SECRET_BINDING.envName} is not a secretKeyRef`);
  if (ref.name !== SECRET_BINDING.secretName) {
    throw new MetadataMismatch(
      `${SECRET_BINDING.envName} references secret ${ref.name}, contract pins ${SECRET_BINDING.secretName}`,
    );
  }
  if (ref.key !== SECRET_BINDING.secretKey) {
    throw new MetadataMismatch(
      `${SECRET_BINDING.envName} references key ${ref.key}, contract pins ${SECRET_BINDING.secretKey}`,
    );
  }
  return `${SECRET_BINDING.envName} secretKeyRef name=${ref.name} key=${ref.key}; no literal value`;
}

/** The pinned version marker must be exact. */
export function assertVersionMarker(metadata: CloudRunMetadata): string {
  const entry = findEnv(metadata, SECRET_BINDING.versionMarkerEnv);
  if (!entry || entry.value === undefined) {
    throw new MetadataMismatch(`${SECRET_BINDING.versionMarkerEnv} is not present on the revision`);
  }
  if (entry.value !== SECRET_BINDING.versionMarker) {
    throw new MetadataMismatch(
      `${SECRET_BINDING.versionMarkerEnv} is not the pinned version marker`,
    );
  }
  return `${SECRET_BINDING.versionMarkerEnv} equals the pinned version-1 marker`;
}

export type RoleMarkerStatus = "absent" | "matching" | "mismatched";

/**
 * The role marker's live state.
 *
 * Absence on the serving revision is observed configuration drift owned by E05,
 * not a probe failure and not evidence that the branch invariant is deployed.
 * The caller decides what to do with each state; this function only reports.
 */
export function roleMarkerStatus(metadata: CloudRunMetadata): RoleMarkerStatus {
  const entry = findEnv(metadata, ROLE_MARKER_ENV);
  if (!entry) return "absent";
  return entry.value === "forma_api" ? "matching" : "mismatched";
}

/**
 * The pinned E01 observation requires truthful absence. A matching marker is a
 * different live state, not an interchangeable success, because it would make
 * the retained observation false just as surely as a mismatched value would.
 */
export function assertRoleMarkerAbsent(metadata: CloudRunMetadata): string {
  const status = roleMarkerStatus(metadata);
  if (status !== "absent") {
    throw new MetadataMismatch(`${ROLE_MARKER_ENV} must be absent for the pinned E01 observation; observed ${status}`);
  }
  return `${ROLE_MARKER_ENV} is absent from the serving revision (observed live configuration drift, owned by E05; the branch invariant is not deployed)`;
}

export interface ServingRevisionFacts {
  revision: string;
  latestReadyRevision: string;
  imageDigest: string;
  buildId: string;
  sourceGeneration: string;
  serviceAccount: string;
  trafficPercent: number;
  trafficRevision: string;
}

export function assertServiceAccount(serviceAccount: string): string {
  if (serviceAccount.endsWith(PRODUCTION.defaultComputeServiceAccountSuffix)) {
    throw new MetadataMismatch("the revision runs as the default Compute service account");
  }
  if (serviceAccount !== PRODUCTION.serviceAccount) {
    throw new MetadataMismatch(
      `service account is ${serviceAccount}, contract pins ${PRODUCTION.serviceAccount}`,
    );
  }
  return `service account is ${PRODUCTION.serviceAccount} and is not default Compute`;
}

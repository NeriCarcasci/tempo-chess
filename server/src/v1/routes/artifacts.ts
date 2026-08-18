/**
 * `GET /v1/artifacts/:artifactId/download`.
 *
 * Returns a short-lived signed URL rather than redirecting to one. A redirect
 * would put the URL in the browser's history and the referrer chain, and the
 * client cannot see when it expires; returning it with its lifetime lets a
 * caller decide whether to use it or ask again.
 *
 * A caller who does not own the artifact gets the same 404 as one asking for an
 * artifact that does not exist. Distinguishing them would confirm that a given
 * id belongs to somebody, which is the fact being protected.
 */

import { z } from "zod";
import { signArtifactDownload } from "../../artifacts/lifecycle.js";
import {
  ArtifactStoreUnavailable,
  artifactStorageConfigured,
  resolveArtifactStore,
} from "../../artifacts/resolve.js";
import { client } from "../../db/client.js";
import { ProblemError } from "../problem.js";
import type { RouteDefinition } from "../registry.js";

const downloadSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number(),
});

const downloadRoute: RouteDefinition<never, never, z.infer<typeof downloadSchema>> = {
  method: "GET",
  path: "/v1/artifacts/:artifactId/download",
  operationId: "downloadArtifact",
  summary: "A short-lived signed URL for an artifact the caller owns",
  description:
    "The URL expires in 120 seconds by default. An artifact that is not ready, or is not owned by the caller, is indistinguishable from one that does not exist.",
  kind: "read",
  auth: "required",
  // Revocation matters: this hands out a bearer token for a private body, so
  // the answer must reflect a revoked actor rather than a cached claim.
  revocationSensitive: true,
  envelope: "resource",
  successStatus: 200,
  dataSchema: downloadSchema,
  // Never cached: the response contains a credential with a deadline.
  cacheControl: "private, no-store",
  async handler({ auth, params }) {
    if (!artifactStorageConfigured()) {
      // Truthfully unavailable rather than a 404 that implies the artifact is
      // missing: the operator needs to be able to tell these apart.
      throw new ProblemError("PROVIDER_UNAVAILABLE", {
        detail: "Artifact storage is not configured for this deployment.",
      });
    }

    let signed: { url: string; expiresInSeconds: number } | null = null;
    try {
      signed = await signArtifactDownload(
        client,
        resolveArtifactStore(),
        params.artifactId,
        auth!.subjects,
      );
    } catch (error) {
      if (error instanceof ArtifactStoreUnavailable) {
        throw new ProblemError("PROVIDER_UNAVAILABLE", {
          detail: "Artifact storage is not configured for this deployment.",
        });
      }
      throw error;
    }

    if (!signed) {
      throw new ProblemError("NOT_FOUND", {
        detail: "No downloadable artifact with that id is available to this actor.",
      });
    }
    return { data: signed };
  },
};

export const ARTIFACT_ROUTES = [downloadRoute] as unknown as RouteDefinition<never, never, never>[];

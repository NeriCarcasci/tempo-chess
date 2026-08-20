/**
 * Testing Library only registers its own cleanup when a global `afterEach`
 * exists, and `globals` stays off so `"vitest/globals"` need not go into
 * tsconfig's explicit `types` array. So it is registered here, once.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);

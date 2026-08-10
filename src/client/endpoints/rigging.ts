import { TaskEndpoint, type HttpFetch } from "./base.js";

/** Note: Meshy does not expose a list endpoint for rigging. */
export class RiggingEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/rigging");
  }
}

import { TaskEndpoint, type HttpFetch } from "./base.js";

/** POST /openapi/v1/animations — plural path. */
export class AnimateEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/animations");
  }
}

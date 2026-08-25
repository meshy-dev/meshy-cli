import { TaskEndpoint, type HttpFetch } from "./base.js";

/** POST/GET/LIST/DELETE /openapi/v1/text-to-motion. */
export class TextToMotionEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/text-to-motion");
  }
}

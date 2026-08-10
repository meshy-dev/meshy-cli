import { TaskEndpoint, type HttpFetch } from "./base.js";

/** POST /openapi/v2/text-to-3d — the only v2-hosted endpoint. */
export class TextTo3DEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/text-to-3d");
  }
}

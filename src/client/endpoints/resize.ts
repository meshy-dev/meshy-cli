import { TaskEndpoint, type HttpFetch } from "./base.js";

export class ResizeEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/resize");
  }
}

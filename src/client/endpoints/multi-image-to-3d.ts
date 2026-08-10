import { TaskEndpoint, type HttpFetch } from "./base.js";

export class MultiImageTo3DEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/multi-image-to-3d");
  }
}

import { TaskEndpoint, type HttpFetch } from "./base.js";

export class RemeshEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/remesh");
  }
}

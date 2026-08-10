import { TaskEndpoint, type HttpFetch } from "./base.js";

export class ConvertEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/convert");
  }
}

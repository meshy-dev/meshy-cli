import { TaskEndpoint, type HttpFetch } from "./base.js";

export class AnalyzePrintabilityEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/print/analyze");
  }
}

import { TaskEndpoint, type HttpFetch } from "./base.js";

export class RepairPrintabilityEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/print/repair");
  }
}

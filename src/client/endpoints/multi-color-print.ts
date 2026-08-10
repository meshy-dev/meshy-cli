import { TaskEndpoint, type HttpFetch } from "./base.js";

export class MultiColorPrintEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/print/multi-color");
  }
}

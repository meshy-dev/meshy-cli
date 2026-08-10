import { TaskEndpoint, type HttpFetch } from "./base.js";

export class RetextureEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/retexture");
  }
}

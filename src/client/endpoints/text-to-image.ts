import { TaskEndpoint, type HttpFetch } from "./base.js";

export class TextToImageEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/text-to-image");
  }
}

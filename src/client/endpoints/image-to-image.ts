import { TaskEndpoint, type HttpFetch } from "./base.js";

export class ImageToImageEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/image-to-image");
  }
}

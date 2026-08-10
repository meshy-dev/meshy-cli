import { TaskEndpoint, type HttpFetch } from "./base.js";

export class ImageTo3DEndpoint extends TaskEndpoint {
  constructor(http: HttpFetch) {
    super(http, "/image-to-3d");
  }
}
